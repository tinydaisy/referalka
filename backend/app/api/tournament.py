"""
Универсальная система оценки участников турнира (миграции 132, 133).

Модель «Пакеты → Критерии → Баллы»:
  • Пакет    — смысловая группа критериев (название, вес, нормализация).
  • Критерий — внутри пакета, всегда даёт число. Привязан к ЭТАПУ (stage_id, NULL=весь
    турнир). scorer = кто ставит балл:
      'jury'   — каждое жюри ставит свой балл, итог критерия = среднее по жюри;
      'vote'   — народное голосование (одно число, ввожу руками);
      'manual' — ручной ввод организатором (одно число);
      'auto'   — считается само (auto_kind: 'referrals' | 'lead_magnet').
  • Балл     — сырое значение в tournament_scores.

Оцениваемые (subject) — ПОЛИМОРФНЫ (миграция 133):
  subject_kind ∈ 'ec' (event_collaborators.id, спикеры) | 'ep' (event_participants.id).
  В таблице — ВСЕ зарегистрированные участники + спикеры-коллабораторы.
  Жюри всегда коллаборатор (juror_ec_id = event_collaborators.id).

Расчёт итога:
  балл критерия:  jury → AVG по жюри; vote/manual → введённое число; auto → из БД.
  балл пакета:    normalize=TRUE — каждый критерий = доля от лучшего, потом взвеш.среднее;
                  иначе — взвешенное среднее сырых баллов.
  итог участника: Σ (балл пакета × вес пакета). Сортировка по итогу убыванием.

Распределение (tournament_jury_assignments) — жюри видит только привязанных.
"""
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from typing import Optional, List
import asyncpg
import jwt

from app.auth import get_current_client
from app.database import get_db
from app.config import settings

router = APIRouter(prefix="/events/{event_id}/tournament", tags=["Турнир — оценки"])
jury_router = APIRouter(prefix="/api/v1/public/tournament-jury", tags=["Турнир — кабинет жюри"])

_CAB_AUD = "speaker-cabinet"

DEFAULT_EXPERTISE_CRITERIA = [
    "Уровень экспертизы в профессиональной области",
    "Авторский метод / уникальная концепция / методология",
    "Положительные отзывы клиентов / количество учеников",
    "Миссия, социальная польза / актуальность",
    "Социальная сеть эксперта (контент, подписчики, вовлечённость)",
    "Медийные артефакты (публикации, награды, выступления)",
]


# ───────────────────────── вспомогательное ─────────────────────────

async def _check_access(event_id: int, client_id: int, db: asyncpg.Connection):
    ev = await db.fetchrow(
        "SELECT id, module_slug FROM events WHERE id = $1 AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')",
        event_id, client_id,
    )
    if not ev:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return ev


def _cab_session(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Нет токена сессии")
    token = authorization.split(" ", 1)[1].strip()
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"], audience=_CAB_AUD)
    except jwt.PyJWTError as e:
        raise HTTPException(status_code=401, detail=f"Сессия истекла или невалидна ({e})")


async def _seed_defaults_if_empty(event_id: int, db: asyncpg.Connection):
    cnt = await db.fetchval("SELECT COUNT(*) FROM tournament_packages WHERE event_id = $1", event_id)
    if cnt:
        return
    pkg_jury = await db.fetchval(
        """INSERT INTO tournament_packages (event_id, title, weight, normalize, sort_order)
           VALUES ($1, 'Оценка жюри', 3, FALSE, 0) RETURNING id""",
        event_id,
    )
    for i, title in enumerate(DEFAULT_EXPERTISE_CRITERIA):
        await db.execute(
            """INSERT INTO tournament_criteria (package_id, event_id, title, scorer, scale_max, weight, sort_order)
               VALUES ($1, $2, $3, 'jury', 10, 1, $4)""",
            pkg_jury, event_id, title, i,
        )
    pkg_eng = await db.fetchval(
        """INSERT INTO tournament_packages (event_id, title, weight, normalize, sort_order)
           VALUES ($1, 'Вовлечение', 1, TRUE, 1) RETURNING id""",
        event_id,
    )
    await db.execute(
        """INSERT INTO tournament_criteria (package_id, event_id, title, scorer, auto_kind, scale_max, weight, sort_order)
           VALUES ($1, $2, 'Привёл по реф-ссылке', 'auto', 'referrals', 1, 1, 0)""",
        pkg_eng, event_id,
    )
    await db.execute(
        """INSERT INTO tournament_criteria (package_id, event_id, title, scorer, auto_kind, scale_max, weight, sort_order)
           VALUES ($1, $2, 'Пришло в лид-магнит', 'auto', 'lead_magnet', 1, 1, 1)""",
        pkg_eng, event_id,
    )


def _skey(kind: str, sid: int) -> str:
    return f"{kind}:{sid}"


async def _subjects(event_id: int, db: asyncpg.Connection) -> List[dict]:
    """Оцениваемые = спикеры-коллабораторы (ec) + ВСЕ зарегистрированные участники (ep).
    Сортировка: спикеры (по фамилии-имени) → участники (по имени)."""
    out: List[dict] = []
    # спикеры/хедлайнеры
    ec_rows = await db.fetch(
        """SELECT cse.id AS sid, c.name, ct.ref_code, ct.id AS contact_id,
                  c.video_url, c.video_folder_url
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
             LEFT JOIN contacts ct ON ct.id = c.contact_id
            WHERE cse.event_id = $1 AND cse.role IN ('speaker', 'headliner')
            ORDER BY split_part(c.name, ' ', 1), c.name, cse.id""",
        event_id,
    )
    for r in ec_rows:
        d = dict(r)
        out.append({"kind": "ec", "sid": d["sid"], "key": _skey("ec", d["sid"]),
                    "name": d["name"] or "Без имени", "ref_code": d["ref_code"], "contact_id": d["contact_id"],
                    "material": d["video_url"] or d["video_folder_url"], "is_speaker": True})
    # зарегистрированные участники — БЕЗ тех, кто является коллаборатором события
    # (жюри, организаторы, партнёры, спикеры) — их в таблице оцениваемых быть не должно.
    ep_rows = await db.fetch(
        """SELECT ep.id AS sid, ct.name, ct.ref_code, ct.id AS contact_id
             FROM event_participants ep
             JOIN contacts ct ON ct.id = ep.contact_id
            WHERE ep.event_id = $1 AND ep.is_registered = TRUE
              AND NOT EXISTS (
                SELECT 1 FROM event_collaborators ec2
                 JOIN collaborators c2 ON c2.id = ec2.speaker_id
                WHERE ec2.event_id = ep.event_id AND c2.contact_id = ct.id
              )
            ORDER BY ct.name, ep.id""",
        event_id,
    )
    for r in ep_rows:
        d = dict(r)
        out.append({"kind": "ep", "sid": d["sid"], "key": _skey("ep", d["sid"]),
                    "name": d["name"] or "Без имени", "ref_code": d["ref_code"], "contact_id": d["contact_id"],
                    "material": None, "is_speaker": False})
    return out


async def _jurors(event_id: int, db: asyncpg.Connection) -> List[dict]:
    # Оценщики = жюри И организаторы (организатор тоже выставляет баллы).
    rows = await db.fetch(
        """SELECT cse.id AS juror_ec_id, c.name, ct.ref_code, cse.role
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
             LEFT JOIN contacts ct ON ct.id = c.contact_id
            WHERE cse.event_id = $1 AND cse.role IN ('jury', 'organizer')
            ORDER BY split_part(c.name, ' ', 1), c.name, cse.id""",
        event_id,
    )
    return [dict(r) for r in rows]


async def _auto_value(event_id: int, contact_id, ref_code, auto_kind: str, db: asyncpg.Connection) -> float:
    if not contact_id:
        return 0.0
    if auto_kind == "referrals":
        if not ref_code:
            return 0.0
        v = await db.fetchval(
            "SELECT COUNT(*) FROM event_participants WHERE event_id = $1 AND referrer_ref_code = $2",
            event_id, ref_code,
        )
        return float(v or 0)
    if auto_kind == "lead_magnet":
        v = await db.fetchval("SELECT COUNT(*) FROM funnel_runs WHERE referrer_contact_id = $1", contact_id)
        return float(v or 0)
    return 0.0


# ───────────────────────── расчёт leaderboard ─────────────────────────

async def _compute(event_id: int, stage_id: Optional[int], db: asyncpg.Connection) -> dict:
    # Этап живёт на уровне ПАКЕТА (tournament_packages.stage_id):
    #   • выбран конкретный этап → пакеты этого этапа + общие (stage_id IS NULL);
    #   • stage_id is None («весь турнир») → все пакеты.
    if stage_id is None:
        pkgs = [dict(p) for p in await db.fetch(
            "SELECT * FROM tournament_packages WHERE event_id=$1 AND is_active ORDER BY sort_order, id", event_id)]
    else:
        pkgs = [dict(p) for p in await db.fetch(
            "SELECT * FROM tournament_packages WHERE event_id=$1 AND is_active AND (stage_id=$2 OR stage_id IS NULL) ORDER BY sort_order, id",
            event_id, stage_id)]
    pkg_ids = [p["id"] for p in pkgs]

    crits = []
    if pkg_ids:
        crit_rows = await db.fetch(
            "SELECT * FROM tournament_criteria WHERE package_id = ANY($1::bigint[]) AND is_active ORDER BY sort_order, id", pkg_ids)
        crits = [dict(c) for c in crit_rows]
    # пакеты, у которых есть хотя бы один критерий
    used_pkg_ids = {c["package_id"] for c in crits}
    pkgs = [p for p in pkgs if p["id"] in used_pkg_ids]
    crits_by_pkg = {}
    for c in crits:
        crits_by_pkg.setdefault(c["package_id"], []).append(c)

    subjects = await _subjects(event_id, db)
    jurors = await _jurors(event_id, db)

    # сырые баллы (по subject_kind+subject_id)
    score_rows = await db.fetch(
        "SELECT criterion_id, subject_kind, subject_id, juror_ec_id, value_number FROM tournament_scores WHERE event_id=$1", event_id)
    raw = {}  # crit_id -> skey -> {jury:{juror:val}, single:val}
    for s in score_rows:
        cid = s["criterion_id"]; key = _skey(s["subject_kind"], s["subject_id"])
        raw.setdefault(cid, {}).setdefault(key, {"jury": {}, "single": None})
        if s["juror_ec_id"] is not None:
            raw[cid][key]["jury"][s["juror_ec_id"]] = float(s["value_number"])
        else:
            raw[cid][key]["single"] = float(s["value_number"])

    async def crit_value(crit, subj):
        cell = raw.get(crit["id"], {}).get(subj["key"])
        if crit["scorer"] == "jury":
            if cell and cell["jury"]:
                vals = list(cell["jury"].values())
                return sum(vals) / len(vals)
            return None
        if crit["scorer"] == "auto":
            return await _auto_value(event_id, subj["contact_id"], subj["ref_code"], crit["auto_kind"] or "", db)
        return cell["single"] if cell and cell["single"] is not None else None

    # сырые значения критерия по всем участникам (для нормализации + колонок)
    crit_raw = {}  # crit_id -> skey -> value
    for c in crits:
        crit_raw[c["id"]] = {}
        for subj in subjects:
            crit_raw[c["id"]][subj["key"]] = await crit_value(c, subj)
    crit_max = {}
    for cid, vals in crit_raw.items():
        nums = [v for v in vals.values() if v is not None]
        crit_max[cid] = max(nums) if nums else 0.0

    # распределение жюри (по выбранному этапу)
    if stage_id is None:
        assigns = await db.fetch(
            "SELECT juror_ec_id, subject_kind, subject_id FROM tournament_jury_assignments WHERE event_id=$1 AND stage_id IS NULL", event_id)
    else:
        assigns = await db.fetch(
            "SELECT juror_ec_id, subject_kind, subject_id FROM tournament_jury_assignments WHERE event_id=$1 AND stage_id=$2", event_id, stage_id)
    assigned_by = {}
    for a in assigns:
        assigned_by.setdefault(_skey(a["subject_kind"], a["subject_id"]), set()).add(a["juror_ec_id"])

    # плоский список критериев-колонок (в порядке пакетов)
    columns = []
    for p in pkgs:
        for c in crits_by_pkg.get(p["id"], []):
            columns.append({"criterion_id": c["id"], "title": c["title"], "scorer": c["scorer"],
                            "auto_kind": c["auto_kind"], "scale_max": float(c["scale_max"]),
                            "description": c.get("description"),
                            "package_id": p["id"], "package_title": p["title"]})

    table = []
    for subj in subjects:
        cells = {}            # criterion_id -> value (для колонок-критериев)
        jury_detail = {}      # criterion_id -> [{juror_name, value}]
        package_scores = {}   # package_id -> балл пакета
        total = 0.0
        for p in pkgs:
            weighted_sum = 0.0; weight_total = 0.0
            for c in crits_by_pkg.get(p["id"], []):
                val = crit_raw[c["id"]].get(subj["key"])
                cells[c["id"]] = val
                if p["normalize"]:
                    mx = crit_max[c["id"]]
                    use = (val / mx) if (val is not None and mx > 0) else (0.0 if val is not None else None)
                else:
                    use = val
                w = float(c["weight"])
                if use is not None:
                    weighted_sum += use * w; weight_total += w
                if c["scorer"] == "jury":
                    cell = raw.get(c["id"], {}).get(subj["key"])
                    det = []
                    for jr in jurors:
                        jv = cell["jury"].get(jr["juror_ec_id"]) if cell else None
                        if jv is not None:
                            det.append({"juror_name": jr["name"], "value": jv})
                    if det:
                        jury_detail[c["id"]] = det
            pkg_score = (weighted_sum / weight_total) if weight_total > 0 else 0.0
            package_scores[p["id"]] = round(pkg_score, 3)
            total += pkg_score * float(p["weight"])
        # прогресс жюри
        assigned = assigned_by.get(subj["key"], set())
        done = 0
        for jr_id in assigned:
            if any(raw.get(c["id"], {}).get(subj["key"], {}).get("jury", {}).get(jr_id) is not None
                   for c in crits if c["scorer"] == "jury"):
                done += 1
        table.append({
            "subject_kind": subj["kind"], "subject_id": subj["sid"], "key": subj["key"],
            "name": subj["name"], "is_speaker": subj["is_speaker"],
            "cells": {str(k): v for k, v in cells.items()},
            "package_scores": {str(k): v for k, v in package_scores.items()},
            "jury_detail": {str(k): v for k, v in jury_detail.items()},
            "total": round(total, 3), "assigned_jury": len(assigned), "done_jury": done,
        })

    table.sort(key=lambda r: r["total"], reverse=True)
    # Плотное ранжирование: одинаковый ИТОГ → одно место, БЕЗ пропусков.
    # (1,1,2,3,4 — два первых, следующий второй). Сравниваем по округлённому
    # значению, как показывается в таблице.
    prev_total = None
    place = 0
    for r in table:
        cur = round(r["total"], 3)
        if prev_total is None or cur != prev_total:
            place += 1
            prev_total = cur
        r["place"] = place

    return {
        "packages": [{"id": p["id"], "title": p["title"], "weight": float(p["weight"]), "normalize": p["normalize"]} for p in pkgs],
        "columns": columns,
        "jurors": [{"juror_ec_id": j["juror_ec_id"], "name": j["name"]} for j in jurors],
        "table": table,
    }


# ════════════════════════ КЛИЕНТСКИЕ ЭНДПОИНТЫ (дашборд) ════════════════════════

@router.get("/criteria", summary="Все пакеты с критериями (конструктор)")
async def list_criteria(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    await _seed_defaults_if_empty(event_id, db)
    pkgs = await db.fetch("SELECT * FROM tournament_packages WHERE event_id=$1 ORDER BY sort_order, id", event_id)
    out = []
    for p in pkgs:
        crits = await db.fetch("SELECT * FROM tournament_criteria WHERE package_id=$1 ORDER BY sort_order, id", p["id"])
        d = dict(p); d["weight"] = float(d["weight"])
        d["criteria"] = [{**dict(c), "scale_max": float(c["scale_max"]), "weight": float(c["weight"])} for c in crits]
        out.append(d)
    stages = await db.fetch("SELECT id, title FROM conf_stages WHERE event_id=$1 ORDER BY sort_order, id", event_id)
    return {"packages": out, "stages": [dict(s) for s in stages]}


class PackageIn(BaseModel):
    title: str
    weight: float = 1
    normalize: bool = False
    sort_order: int = 0
    stage_id: Optional[int] = None  # этап пакета (NULL = весь турнир)


@router.post("/packages", summary="Создать пакет")
async def create_package(event_id: int, data: PackageIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    if not data.title.strip():
        raise HTTPException(status_code=422, detail="Название пакета обязательно")
    p = await db.fetchrow(
        """INSERT INTO tournament_packages (event_id, title, weight, normalize, sort_order, stage_id)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *""",
        event_id, data.title.strip(), data.weight, data.normalize, data.sort_order, data.stage_id)
    return {"package": dict(p)}


class PackageUpdate(BaseModel):
    title: Optional[str] = None
    weight: Optional[float] = None
    normalize: Optional[bool] = None
    sort_order: Optional[int] = None
    stage_id: Optional[int] = None


@router.patch("/packages/{package_id}", summary="Обновить пакет")
async def update_package(event_id: int, package_id: int, data: PackageUpdate, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    payload = data.model_dump(exclude_unset=True)
    if payload:
        cols = list(payload.keys())
        sets = ", ".join(f"{c} = ${i+3}" for i, c in enumerate(cols))
        await db.execute(f"UPDATE tournament_packages SET {sets}, updated_at=now() WHERE id=$1 AND event_id=$2",
                         package_id, event_id, *payload.values())
    p = await db.fetchrow("SELECT * FROM tournament_packages WHERE id=$1 AND event_id=$2", package_id, event_id)
    if not p:
        raise HTTPException(status_code=404, detail="Пакет не найден")
    return {"package": dict(p)}


@router.delete("/packages/{package_id}", summary="Удалить пакет")
async def delete_package(event_id: int, package_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    await db.execute("DELETE FROM tournament_packages WHERE id=$1 AND event_id=$2", package_id, event_id)
    return {"ok": True}


class CriterionIn(BaseModel):
    package_id: int
    title: str
    description: Optional[str] = None
    scorer: str = "jury"
    auto_kind: Optional[str] = None
    stage_id: Optional[int] = None
    scale_max: float = 10
    weight: float = 1
    sort_order: int = 0


@router.post("/criteria", summary="Создать критерий")
async def create_criterion(event_id: int, data: CriterionIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    if not data.title.strip():
        raise HTTPException(status_code=422, detail="Название критерия обязательно")
    if data.scorer not in ("jury", "vote", "manual", "auto"):
        raise HTTPException(status_code=422, detail="Неверный тип оценщика")
    pkg = await db.fetchrow("SELECT id FROM tournament_packages WHERE id=$1 AND event_id=$2", data.package_id, event_id)
    if not pkg:
        raise HTTPException(status_code=404, detail="Пакет не найден")
    c = await db.fetchrow(
        """INSERT INTO tournament_criteria (package_id, event_id, title, description, scorer, auto_kind, stage_id, scale_max, weight, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *""",
        data.package_id, event_id, data.title.strip(), data.description, data.scorer,
        data.auto_kind if data.scorer == "auto" else None, data.stage_id, data.scale_max, data.weight, data.sort_order)
    return {"criterion": dict(c)}


class CriterionUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    scorer: Optional[str] = None
    auto_kind: Optional[str] = None
    stage_id: Optional[int] = None
    scale_max: Optional[float] = None
    weight: Optional[float] = None
    sort_order: Optional[int] = None


@router.patch("/criteria/{criterion_id}", summary="Обновить критерий")
async def update_criterion(event_id: int, criterion_id: int, data: CriterionUpdate, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    payload = data.model_dump(exclude_unset=True)
    if payload:
        cols = list(payload.keys())
        sets = ", ".join(f"{c} = ${i+3}" for i, c in enumerate(cols))
        await db.execute(f"UPDATE tournament_criteria SET {sets}, updated_at=now() WHERE id=$1 AND event_id=$2",
                         criterion_id, event_id, *payload.values())
    c = await db.fetchrow("SELECT * FROM tournament_criteria WHERE id=$1 AND event_id=$2", criterion_id, event_id)
    if not c:
        raise HTTPException(status_code=404, detail="Критерий не найден")
    return {"criterion": dict(c)}


@router.delete("/criteria/{criterion_id}", summary="Удалить критерий")
async def delete_criterion(event_id: int, criterion_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    await db.execute("DELETE FROM tournament_criteria WHERE id=$1 AND event_id=$2", criterion_id, event_id)
    return {"ok": True}


# ── Распределение ──

@router.get("/assignments", summary="Матрица распределения участников по жюри (по этапу)")
async def get_assignments(event_id: int, stage_id: Optional[int] = None, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    subjects = await _subjects(event_id, db)
    jurors = await _jurors(event_id, db)
    if stage_id is None:
        rows = await db.fetch(
            "SELECT juror_ec_id, subject_kind, subject_id FROM tournament_jury_assignments WHERE event_id=$1 AND stage_id IS NULL", event_id)
    else:
        rows = await db.fetch(
            "SELECT juror_ec_id, subject_kind, subject_id FROM tournament_jury_assignments WHERE event_id=$1 AND stage_id=$2", event_id, stage_id)
    pairs = {(r["juror_ec_id"], _skey(r["subject_kind"], r["subject_id"])) for r in rows}

    # «Кого привело жюри»: реферер участника (event_participants.referrer_ref_code)
    # совпал с ref_code контакта какого-то жюри → конфликт интересов.
    # ref_code жюри → его juror_ec_id (у одного контакта-жюри один ref_code).
    juror_refcode_to_ec: dict[str, int] = {}
    for j in jurors:
        rc = j.get("ref_code")
        if rc:
            juror_refcode_to_ec[rc] = j["juror_ec_id"]

    # реферер каждого ep-участника + имя реферера
    ep_ids = [s["sid"] for s in subjects if s["kind"] == "ep"]
    referrer_by_sid: dict[int, dict] = {}
    if ep_ids:
        ref_rows = await db.fetch(
            """SELECT ep.id AS sid, ep.referrer_ref_code,
                      rc.name AS referrer_name, ep.referrer_ref_code AS rcode
                 FROM event_participants ep
                 LEFT JOIN contacts rc
                   ON rc.ref_code = ep.referrer_ref_code
                  AND rc.merged_into IS NULL
                WHERE ep.id = ANY($1::int[])""",
            ep_ids,
        )
        for r in ref_rows:
            if r["referrer_ref_code"]:
                referrer_by_sid[r["sid"]] = {
                    "name": r["referrer_name"],
                    "ref_code": r["referrer_ref_code"],
                }

    # обогащаем subjects: имя реферода + список жюри-рефоводов (конфликтных)
    subjects_out = []
    for s in subjects:
        item = {"key": s["key"], "name": s["name"], "is_speaker": s["is_speaker"],
                "referrer_name": None, "referrer_juror_ec_ids": []}
        if s["kind"] == "ep":
            ref = referrer_by_sid.get(s["sid"])
            if ref:
                item["referrer_name"] = ref["name"]
                jec = juror_refcode_to_ec.get(ref["ref_code"])
                if jec is not None:
                    item["referrer_juror_ec_ids"] = [jec]
        subjects_out.append(item)

    stages = await db.fetch("SELECT id, title FROM conf_stages WHERE event_id=$1 ORDER BY sort_order, id", event_id)
    return {
        "subjects": subjects_out,
        "jurors": [{"juror_ec_id": j["juror_ec_id"], "name": j["name"]} for j in jurors],
        "pairs": [{"juror_ec_id": p[0], "key": p[1]} for p in pairs],
        "stages": [dict(s) for s in stages],
    }


class AssignIn(BaseModel):
    juror_ec_id: int
    key: str
    assigned: bool
    stage_id: Optional[int] = None


@router.post("/assignments", summary="Назначить/снять одну пару (на этапе)")
async def set_assignment(event_id: int, data: AssignIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    kind, sid = data.key.split(":", 1)
    if data.assigned:
        await db.execute(
            """INSERT INTO tournament_jury_assignments (event_id, juror_ec_id, subject_kind, subject_id, stage_id)
               VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING""",
            event_id, data.juror_ec_id, kind, int(sid), data.stage_id)
    else:
        if data.stage_id is None:
            await db.execute(
                "DELETE FROM tournament_jury_assignments WHERE event_id=$1 AND juror_ec_id=$2 AND subject_kind=$3 AND subject_id=$4 AND stage_id IS NULL",
                event_id, data.juror_ec_id, kind, int(sid))
        else:
            await db.execute(
                "DELETE FROM tournament_jury_assignments WHERE event_id=$1 AND juror_ec_id=$2 AND subject_kind=$3 AND subject_id=$4 AND stage_id=$5",
                event_id, data.juror_ec_id, kind, int(sid), data.stage_id)
    return {"ok": True}


class AssignAllIn(BaseModel):
    stage_id: Optional[int] = None
    clear: bool = False


@router.post("/assignments/all", summary="Назначить всех всем / очистить (на этапе)")
async def set_all_assignments(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db), clear: bool = False, stage_id: Optional[int] = None):
    await _check_access(event_id, int(client["sub"]), db)
    if stage_id is None:
        await db.execute("DELETE FROM tournament_jury_assignments WHERE event_id=$1 AND stage_id IS NULL", event_id)
    else:
        await db.execute("DELETE FROM tournament_jury_assignments WHERE event_id=$1 AND stage_id=$2", event_id, stage_id)
    if not clear:
        subjects = await _subjects(event_id, db)
        jurors = await _jurors(event_id, db)
        for j in jurors:
            for s in subjects:
                await db.execute(
                    "INSERT INTO tournament_jury_assignments (event_id, juror_ec_id, subject_kind, subject_id, stage_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
                    event_id, j["juror_ec_id"], s["kind"], s["sid"], stage_id)
    return {"ok": True}


class AutoAssignIn(BaseModel):
    include_speakers: bool = False
    include_participants: bool = True
    per_juror: Optional[int] = None  # сколько субъектов на 1 жюри; None → авто-рекомендация
    stage_id: Optional[int] = None   # этап, на котором распределяем


@router.get("/assignments/auto-suggest", summary="Рекомендация по распределению")
async def auto_assign_suggest(event_id: int, include_speakers: bool = False,
                              include_participants: bool = True,
                              client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    subjects = await _subjects(event_id, db)
    jurors = await _jurors(event_id, db)
    pool = [s for s in subjects
            if (s["is_speaker"] and include_speakers) or (not s["is_speaker"] and include_participants)]
    n_subj = len(pool)
    n_jury = len(jurors)
    import math
    # рекомендация: чтобы каждого субъекта оценило ~3 жюри (или меньше, если жюри мало)
    target_views = min(3, n_jury) if n_jury else 0
    per_juror = math.ceil(n_subj * target_views / n_jury) if n_jury else 0
    return {
        "subjects_count": n_subj, "jurors_count": n_jury,
        "recommended_per_juror": per_juror,
        "recommended_views_per_subject": target_views,
    }


@router.post("/assignments/auto", summary="Автораспределение участников по жюри")
async def auto_assign(event_id: int, data: AutoAssignIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    subjects = await _subjects(event_id, db)
    jurors = await _jurors(event_id, db)
    if not jurors:
        raise HTTPException(status_code=400, detail="Нет жюри для распределения")

    pool = [s for s in subjects
            if (s["is_speaker"] and data.include_speakers) or (not s["is_speaker"] and data.include_participants)]
    if not pool:
        raise HTTPException(status_code=400, detail="Не выбраны типы участников или их нет")

    # ref_code жюри → ec_id (для избегания конфликта «жюри оценивает того, кого привело»)
    juror_refcode_to_ec = {j["ref_code"]: j["juror_ec_id"] for j in jurors if j.get("ref_code")}
    # реферер каждого ep-субъекта
    ep_ids = [s["sid"] for s in pool if s["kind"] == "ep"]
    conflict_juror_by_key: dict[str, set] = {}
    if ep_ids:
        ref_rows = await db.fetch(
            "SELECT id AS sid, referrer_ref_code FROM event_participants WHERE id = ANY($1::int[])",
            ep_ids)
        for r in ref_rows:
            jec = juror_refcode_to_ec.get(r["referrer_ref_code"])
            if jec is not None:
                conflict_juror_by_key[_skey("ep", r["sid"])] = {jec}

    import math
    n_subj = len(pool); n_jury = len(jurors)
    per_juror = data.per_juror
    if not per_juror or per_juror <= 0:
        target_views = min(3, n_jury)
        per_juror = math.ceil(n_subj * target_views / n_jury)
    cap = n_subj  # жюри не может оценить больше, чем есть субъектов
    per_juror = min(per_juror, cap)

    # Сносим прежнее распределение ТОЛЬКО для выбранных типов НА ЭТОМ ЭТАПЕ.
    kinds_to_clear = []
    if data.include_speakers: kinds_to_clear.append("ec")
    if data.include_participants: kinds_to_clear.append("ep")
    if data.stage_id is None:
        await db.execute(
            "DELETE FROM tournament_jury_assignments WHERE event_id=$1 AND subject_kind = ANY($2::text[]) AND stage_id IS NULL",
            event_id, kinds_to_clear)
    else:
        await db.execute(
            "DELETE FROM tournament_jury_assignments WHERE event_id=$1 AND subject_kind = ANY($2::text[]) AND stage_id=$3",
            event_id, kinds_to_clear, data.stage_id)

    # Жадное равномерное распределение: для каждого жюри добираем per_juror субъектов,
    # выбирая тех, у кого меньше всего назначений, пропуская конфликтных (если есть выбор).
    load_by_key = {s["key"]: 0 for s in pool}
    assignments: list[tuple[int, str, int]] = []  # (juror_ec_id, kind, sid)
    for j in jurors:
        jec = j["juror_ec_id"]
        chosen = 0
        # кандидаты — без конфликта, отсортированы по текущей нагрузке
        def pick_candidates(allow_conflict: bool):
            cands = []
            for s in pool:
                if allow_conflict is False and jec in conflict_juror_by_key.get(s["key"], set()):
                    continue
                cands.append(s)
            return sorted(cands, key=lambda s: load_by_key[s["key"]])
        used_keys = set()
        for allow_conflict in (False, True):  # сначала без конфликта, потом если не хватило
            for s in pick_candidates(allow_conflict):
                if chosen >= per_juror:
                    break
                if s["key"] in used_keys:
                    continue
                used_keys.add(s["key"])
                assignments.append((jec, s["kind"], s["sid"]))
                load_by_key[s["key"]] += 1
                chosen += 1
            if chosen >= per_juror:
                break

    for jec, kind, sid in assignments:
        await db.execute(
            "INSERT INTO tournament_jury_assignments (event_id, juror_ec_id, subject_kind, subject_id, stage_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            event_id, jec, kind, sid, data.stage_id)

    return {"ok": True, "per_juror": per_juror, "assigned_pairs": len(assignments),
            "subjects_count": n_subj, "jurors_count": n_jury}


# ── Турнирная таблица ──

@router.get("/leaderboard", summary="Турнирная таблица (живой расчёт)")
async def leaderboard(event_id: int, stage_id: Optional[int] = None, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    return await _compute(event_id, stage_id, db)


# ── Ручной/народный ввод балла организатором (в ячейку таблицы) ──

class ManualScoreIn(BaseModel):
    criterion_id: int
    key: str
    value: float


@router.post("/manual-score", summary="Ручной/народный балл (организатор)")
async def set_manual_score(event_id: int, data: ManualScoreIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    if data.value < 0:
        raise HTTPException(status_code=422, detail="Балл не может быть отрицательным")
    crit = await db.fetchrow("SELECT scorer FROM tournament_criteria WHERE id=$1 AND event_id=$2", data.criterion_id, event_id)
    if not crit:
        raise HTTPException(status_code=404, detail="Критерий не найден")
    if crit["scorer"] not in ("vote", "manual"):
        raise HTTPException(status_code=422, detail="Этот критерий не для ручного ввода")
    kind, sid = data.key.split(":", 1)
    await db.execute(
        """INSERT INTO tournament_scores (event_id, criterion_id, subject_kind, subject_id, juror_ec_id, scorer, value_number)
           VALUES ($1,$2,$3,$4,NULL,$5,$6)
           ON CONFLICT (criterion_id, subject_kind, subject_id) WHERE juror_ec_id IS NULL
           DO UPDATE SET value_number = EXCLUDED.value_number, updated_at = now()""",
        event_id, data.criterion_id, kind, int(sid), crit["scorer"], data.value)
    return {"ok": True}


# ── Обратная связь (организатор) ──

@router.get("/feedback", summary="Вся обратная связь жюри (организатор)")
async def list_feedback(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        """SELECT f.subject_kind, f.subject_id, f.body, jc.name AS juror_name
             FROM tournament_feedback f
             JOIN event_collaborators jec ON jec.id = f.juror_ec_id
             JOIN collaborators jc ON jc.id = jec.speaker_id
            WHERE f.event_id = $1 ORDER BY jc.name""",
        event_id)
    return {"feedback": [{"key": _skey(r["subject_kind"], r["subject_id"]), "body": r["body"], "juror_name": r["juror_name"]} for r in rows]}


# ── Снимки отчётов ──

@router.get("/snapshots", summary="Список снимков отчётов")
async def list_snapshots(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    rows = await db.fetch("SELECT id, stage_id, title, frozen_at FROM tournament_snapshots WHERE event_id=$1 ORDER BY frozen_at DESC", event_id)
    return {"snapshots": [dict(r) for r in rows]}


class SnapshotIn(BaseModel):
    title: Optional[str] = None
    stage_id: Optional[int] = None


@router.post("/snapshots", summary="Сохранить отчёт (снимок результатов)")
async def create_snapshot(event_id: int, data: SnapshotIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    result = await _compute(event_id, data.stage_id, db)
    fb = await db.fetch(
        """SELECT f.subject_kind, f.subject_id, f.body, jc.name AS juror_name
             FROM tournament_feedback f
             JOIN event_collaborators jec ON jec.id = f.juror_ec_id
             JOIN collaborators jc ON jc.id = jec.speaker_id
            WHERE f.event_id=$1""", event_id)
    fb_by = {}
    for f in fb:
        fb_by.setdefault(_skey(f["subject_kind"], f["subject_id"]), []).append({"juror_name": f["juror_name"], "body": f["body"]})
    col_by_id = {c["criterion_id"]: c for c in result["columns"]}

    snap_id = await db.fetchval(
        "INSERT INTO tournament_snapshots (event_id, stage_id, title) VALUES ($1,$2,$3) RETURNING id",
        event_id, data.stage_id, (data.title or "").strip())
    for row in result["table"]:
        await db.execute(
            """INSERT INTO tournament_snapshot_rows (snapshot_id, subject_ec_id, subject_kind, subject_name, package_id, package_title, package_score, total_score, place)
               VALUES ($1,$2,$3,$4,NULL,'',NULL,$5,$6)""",
            snap_id, row["subject_id"], row["subject_kind"], row["name"], row["total"], row["place"])
        for cid_str, val in row["cells"].items():
            col = col_by_id.get(int(cid_str))
            if not col:
                continue
            det = row["jury_detail"].get(cid_str)
            if det:
                for jd in det:
                    await db.execute(
                        """INSERT INTO tournament_snapshot_scores (snapshot_id, subject_ec_id, subject_kind, subject_name, package_title, criterion_title, juror_name, value_number)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)""",
                        snap_id, row["subject_id"], row["subject_kind"], row["name"], col["package_title"], col["title"], jd["juror_name"], jd["value"])
            else:
                await db.execute(
                    """INSERT INTO tournament_snapshot_scores (snapshot_id, subject_ec_id, subject_kind, subject_name, package_title, criterion_title, juror_name, value_number)
                       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7)""",
                    snap_id, row["subject_id"], row["subject_kind"], row["name"], col["package_title"], col["title"], val)
        for f in fb_by.get(row["key"], []):
            await db.execute(
                """INSERT INTO tournament_snapshot_scores (snapshot_id, subject_ec_id, subject_kind, subject_name, package_title, criterion_title, juror_name, value_number, feedback_body)
                   VALUES ($1,$2,$3,$4,'Обратная связь','',$5,NULL,$6)""",
                snap_id, row["subject_id"], row["subject_kind"], row["name"], f["juror_name"], f["body"])
    return {"snapshot_id": snap_id}


@router.get("/snapshots/{snapshot_id}", summary="Содержимое снимка")
async def get_snapshot(event_id: int, snapshot_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    snap = await db.fetchrow("SELECT * FROM tournament_snapshots WHERE id=$1 AND event_id=$2", snapshot_id, event_id)
    if not snap:
        raise HTTPException(status_code=404, detail="Снимок не найден")
    rows = await db.fetch("SELECT * FROM tournament_snapshot_rows WHERE snapshot_id=$1 ORDER BY place", snapshot_id)
    scores = await db.fetch("SELECT * FROM tournament_snapshot_scores WHERE snapshot_id=$1 ORDER BY subject_name", snapshot_id)
    return {"snapshot": dict(snap), "rows": [dict(r) for r in rows], "scores": [dict(s) for s in scores]}


@router.delete("/snapshots/{snapshot_id}", summary="Удалить снимок")
async def delete_snapshot(event_id: int, snapshot_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    await db.execute("DELETE FROM tournament_snapshots WHERE id=$1 AND event_id=$2", snapshot_id, event_id)
    return {"ok": True}


# ════════════════════════ КАБИНЕТ ЖЮРИ ════════════════════════

async def _ensure_juror(session: dict, db: asyncpg.Connection) -> dict:
    se_id = int(session["se_id"]); event_id = int(session["e_id"])
    row = await db.fetchrow(
        """SELECT cse.id, cse.event_id, cse.role, c.name
             FROM event_collaborators cse JOIN collaborators c ON c.id = cse.speaker_id
            WHERE cse.id = $1""", se_id)
    if not row:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    if row["role"] not in ("jury", "organizer"):
        raise HTTPException(status_code=403, detail="Этот раздел только для жюри и организаторов")
    return dict(row)


@jury_router.get("/me", summary="Кабинет жюри: мои участники + критерии")
async def jury_me(stage_id: Optional[int] = None, session: dict = Depends(_cab_session), db: asyncpg.Connection = Depends(get_db)):
    juror = await _ensure_juror(session, db)
    event_id = juror["event_id"]; juror_ec_id = juror["id"]

    # Этапы, на которых у ЭТОГО жюри есть назначенные люди (задача: пустые этапы не показываем).
    stage_rows = await db.fetch(
        """SELECT DISTINCT a.stage_id, cs.title, cs.sort_order
             FROM tournament_jury_assignments a
             LEFT JOIN conf_stages cs ON cs.id = a.stage_id
            WHERE a.event_id=$1 AND a.juror_ec_id=$2 AND a.stage_id IS NOT NULL
            ORDER BY cs.sort_order, a.stage_id""",
        event_id, juror_ec_id)
    stages = [{"id": r["stage_id"], "title": r["title"]} for r in stage_rows]
    # если назначений вообще нет — этапов нет (фронт покажет «нет участников»)

    # привязанные субъекты НА ВЫБРАННОМ ЭТАПЕ
    if stage_id is None:
        assigns = await db.fetch(
            "SELECT subject_kind, subject_id FROM tournament_jury_assignments WHERE event_id=$1 AND juror_ec_id=$2 AND stage_id IS NULL",
            event_id, juror_ec_id)
    else:
        assigns = await db.fetch(
            "SELECT subject_kind, subject_id FROM tournament_jury_assignments WHERE event_id=$1 AND juror_ec_id=$2 AND stage_id=$3",
            event_id, juror_ec_id, stage_id)
    assigned_keys = {_skey(a["subject_kind"], a["subject_id"]) for a in assigns}
    all_subjects = await _subjects(event_id, db)
    subjects = [s for s in all_subjects if s["key"] in assigned_keys]

    # jury-критерии: пакеты выбранного этапа (+ общие stage_id IS NULL), затем их jury-критерии
    if stage_id is None:
        pkgs = await db.fetch("SELECT id FROM tournament_packages WHERE event_id=$1 AND is_active", event_id)
    else:
        pkgs = await db.fetch(
            "SELECT id FROM tournament_packages WHERE event_id=$1 AND is_active AND (stage_id=$2 OR stage_id IS NULL)",
            event_id, stage_id)
    pkg_ids = [p["id"] for p in pkgs]
    jcrits = []
    if pkg_ids:
        jcrits = await db.fetch(
            "SELECT id, title, description, scale_max FROM tournament_criteria WHERE package_id=ANY($1::bigint[]) AND is_active AND scorer='jury' ORDER BY sort_order, id", pkg_ids)

    my_scores = await db.fetch(
        "SELECT criterion_id, subject_kind, subject_id, value_number FROM tournament_scores WHERE event_id=$1 AND juror_ec_id=$2",
        event_id, juror_ec_id)
    my_fb = await db.fetch(
        "SELECT subject_kind, subject_id, body, stage_id FROM tournament_feedback WHERE event_id=$1 AND juror_ec_id=$2",
        event_id, juror_ec_id)

    # фиксация по КАЖДОМУ участнику на этом этапе (locked_keys — set ключей)
    if stage_id is None:
        lock_rows = await db.fetch(
            "SELECT subject_kind, subject_id FROM tournament_jury_locks WHERE event_id=$1 AND juror_ec_id=$2 AND stage_id IS NULL AND subject_id IS NOT NULL",
            event_id, juror_ec_id)
    else:
        lock_rows = await db.fetch(
            "SELECT subject_kind, subject_id FROM tournament_jury_locks WHERE event_id=$1 AND juror_ec_id=$2 AND stage_id=$3 AND subject_id IS NOT NULL",
            event_id, juror_ec_id, stage_id)
    locked_keys = [_skey(r["subject_kind"], r["subject_id"]) for r in lock_rows]

    # итоговая средняя по каждому участнику = среднее моих баллов по jury-критериям этапа
    crit_ids = {c["id"] for c in jcrits}
    avg_by_key: dict = {}
    tmp: dict = {}
    for s in my_scores:
        if s["criterion_id"] in crit_ids:
            k = _skey(s["subject_kind"], s["subject_id"])
            tmp.setdefault(k, []).append(float(s["value_number"]))
    for k, vals in tmp.items():
        avg_by_key[k] = round(sum(vals) / len(vals), 2) if vals else None

    return {
        "juror_name": juror["name"],
        "subjects": [{"key": s["key"], "name": s["name"], "material": s["material"]} for s in subjects],
        "criteria": [{**dict(c), "scale_max": float(c["scale_max"])} for c in jcrits],
        "my_scores": [{"criterion_id": s["criterion_id"], "key": _skey(s["subject_kind"], s["subject_id"]), "value_number": float(s["value_number"])} for s in my_scores],
        "my_feedback": [{"key": _skey(f["subject_kind"], f["subject_id"]), "body": f["body"], "stage_id": f["stage_id"]} for f in my_fb],
        "stages": stages,
        "locked_keys": locked_keys,
        "my_avg_by_key": avg_by_key,
    }


class JuryScoreIn(BaseModel):
    criterion_id: int
    key: str
    value: float


@jury_router.post("/score", summary="Кабинет жюри: поставить балл")
async def jury_score(data: JuryScoreIn, session: dict = Depends(_cab_session), db: asyncpg.Connection = Depends(get_db)):
    juror = await _ensure_juror(session, db)
    event_id = juror["event_id"]; juror_ec_id = juror["id"]
    if data.value < 0:
        raise HTTPException(status_code=422, detail="Балл не может быть отрицательным")
    crit = await db.fetchrow(
        """SELECT cr.scorer, cr.scale_max, p.stage_id
             FROM tournament_criteria cr
             JOIN tournament_packages p ON p.id = cr.package_id
            WHERE cr.id=$1 AND cr.event_id=$2""",
        data.criterion_id, event_id)
    if not crit or crit["scorer"] != "jury":
        raise HTTPException(status_code=422, detail="Критерий не для оценки жюри")
    # балл не может быть выше максимума критерия
    _sm = float(crit["scale_max"])
    if data.value > _sm:
        _sm_str = str(int(_sm)) if _sm == int(_sm) else str(_sm)
        raise HTTPException(status_code=422, detail=f"Балл не может быть выше {_sm_str}")
    kind, sid = data.key.split(":", 1)
    cr_stage = crit["stage_id"]
    # если жюри уже зафиксировал ЭТОГО участника на этом этапе — править нельзя
    if cr_stage is None:
        locked = await db.fetchval(
            "SELECT 1 FROM tournament_jury_locks WHERE event_id=$1 AND juror_ec_id=$2 AND subject_kind=$3 AND subject_id=$4 AND stage_id IS NULL",
            event_id, juror_ec_id, kind, int(sid))
    else:
        locked = await db.fetchval(
            "SELECT 1 FROM tournament_jury_locks WHERE event_id=$1 AND juror_ec_id=$2 AND subject_kind=$3 AND subject_id=$4 AND stage_id=$5",
            event_id, juror_ec_id, kind, int(sid), cr_stage)
    if locked:
        raise HTTPException(status_code=403, detail="Вы уже зафиксировали оценку этому участнику — править нельзя")
    ok = await db.fetchval(
        "SELECT 1 FROM tournament_jury_assignments WHERE event_id=$1 AND juror_ec_id=$2 AND subject_kind=$3 AND subject_id=$4",
        event_id, juror_ec_id, kind, int(sid))
    if not ok:
        raise HTTPException(status_code=403, detail="Этот участник вам не назначен")
    await db.execute(
        """INSERT INTO tournament_scores (event_id, criterion_id, subject_kind, subject_id, juror_ec_id, scorer, value_number)
           VALUES ($1,$2,$3,$4,$5,'jury',$6)
           ON CONFLICT (criterion_id, subject_kind, subject_id, juror_ec_id) WHERE juror_ec_id IS NOT NULL
           DO UPDATE SET value_number = EXCLUDED.value_number, updated_at = now()""",
        event_id, data.criterion_id, kind, int(sid), juror_ec_id, data.value)
    return {"ok": True}


class JuryLockIn(BaseModel):
    key: str                          # фиксируем оценку КОНКРЕТНОГО участника
    stage_id: Optional[int] = None


@jury_router.post("/lock", summary="Кабинет жюри: зафиксировать оценку участнику")
async def jury_lock(data: JuryLockIn, session: dict = Depends(_cab_session), db: asyncpg.Connection = Depends(get_db)):
    juror = await _ensure_juror(session, db)
    event_id = juror["event_id"]; juror_ec_id = juror["id"]
    kind, sid = data.key.split(":", 1)
    await db.execute(
        """INSERT INTO tournament_jury_locks (event_id, juror_ec_id, stage_id, subject_kind, subject_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING""",
        event_id, juror_ec_id, data.stage_id, kind, int(sid))
    return {"ok": True, "locked": True}


class JuryFeedbackIn(BaseModel):
    key: str
    body: str
    stage_id: Optional[int] = None


@jury_router.post("/feedback", summary="Кабинет жюри: обратная связь участнику")
async def jury_feedback(data: JuryFeedbackIn, session: dict = Depends(_cab_session), db: asyncpg.Connection = Depends(get_db)):
    juror = await _ensure_juror(session, db)
    event_id = juror["event_id"]; juror_ec_id = juror["id"]
    kind, sid = data.key.split(":", 1)
    ok = await db.fetchval(
        "SELECT 1 FROM tournament_jury_assignments WHERE event_id=$1 AND juror_ec_id=$2 AND subject_kind=$3 AND subject_id=$4",
        event_id, juror_ec_id, kind, int(sid))
    if not ok:
        raise HTTPException(status_code=403, detail="Этот участник вам не назначен")
    if data.stage_id is None:
        await db.execute(
            """INSERT INTO tournament_feedback (event_id, stage_id, juror_ec_id, subject_kind, subject_id, body)
               VALUES ($1,NULL,$2,$3,$4,$5)
               ON CONFLICT (juror_ec_id, subject_kind, subject_id) WHERE stage_id IS NULL
               DO UPDATE SET body = EXCLUDED.body, updated_at = now()""",
            event_id, juror_ec_id, kind, int(sid), data.body)
    else:
        await db.execute(
            """INSERT INTO tournament_feedback (event_id, stage_id, juror_ec_id, subject_kind, subject_id, body)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (juror_ec_id, subject_kind, subject_id, stage_id) WHERE stage_id IS NOT NULL
               DO UPDATE SET body = EXCLUDED.body, updated_at = now()""",
            event_id, data.stage_id, juror_ec_id, kind, int(sid), data.body)
    return {"ok": True}


@jury_router.get("/my-results", summary="Кабинет спикера: мои оценки и комментарии по этапам")
async def my_results(session: dict = Depends(_cab_session), db: asyncpg.Connection = Depends(get_db)):
    se_id = int(session["se_id"]); event_id = int(session["e_id"])
    ev = await db.fetchrow("SELECT module_slug FROM events WHERE id=$1", event_id)
    if not ev or ev["module_slug"] != "turnir":
        return {"is_tournament": False}
    mykey = _skey("ec", se_id)

    # все этапы события (+ виртуальный «весь турнир» если этапов нет)
    stages = await db.fetch("SELECT id, title FROM conf_stages WHERE event_id=$1 ORDER BY sort_order, id", event_id)
    stage_list = [{"id": s["id"], "title": s["title"]} for s in stages] or [{"id": None, "title": "Турнир"}]

    # комментарии жюри (с привязкой к этапу)
    fb_rows = await db.fetch(
        """SELECT f.body, f.stage_id, jc.name AS juror_name
             FROM tournament_feedback f
             JOIN event_collaborators jec ON jec.id = f.juror_ec_id
             JOIN collaborators jc ON jc.id = jec.speaker_id
            WHERE f.event_id=$1 AND f.subject_kind='ec' AND f.subject_id=$2""",
        event_id, se_id)
    fb_by_stage: dict = {}
    for f in fb_rows:
        fb_by_stage.setdefault(f["stage_id"], []).append({"juror_name": f["juror_name"], "body": f["body"]})

    # по каждому этапу считаем мою строку
    stages_out = []
    any_results = False
    for st in stage_list:
        result = await _compute(event_id, st["id"], db)
        me = next((r for r in result["table"] if r["key"] == mykey), None)
        cols = [{"criterion_id": c["criterion_id"], "title": c["title"],
                 "package_id": c["package_id"], "package_title": c["package_title"],
                 "description": c.get("description")}
                for c in result["columns"]]
        has = me is not None and (me["total"] or any(v for v in (me["cells"] or {}).values()))
        if has:
            any_results = True
        stages_out.append({
            "stage_id": st["id"], "stage_title": st["title"],
            "has_results": bool(has),
            "place": me["place"] if me else None,
            "total": me["total"] if me else None,
            "cells": me["cells"] if me else {},
            "package_scores": me.get("package_scores") if me else {},
            "jury_detail": me.get("jury_detail") if me else {},
            "columns": cols,
            "packages": result.get("packages", []),
            "feedback": fb_by_stage.get(st["id"], []),
        })

    return {"is_tournament": True, "event_id": event_id, "has_results": any_results, "stages": stages_out}
