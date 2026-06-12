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
    rows = await db.fetch(
        """SELECT cse.id AS juror_ec_id, c.name
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
            WHERE cse.event_id = $1 AND cse.role = 'jury'
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
    pkgs = [dict(p) for p in await db.fetch(
        "SELECT * FROM tournament_packages WHERE event_id=$1 AND is_active ORDER BY sort_order, id", event_id)]
    pkg_ids = [p["id"] for p in pkgs]

    crits = []
    if pkg_ids:
        if stage_id is None:
            crit_rows = await db.fetch(
                "SELECT * FROM tournament_criteria WHERE package_id = ANY($1::bigint[]) AND is_active ORDER BY sort_order, id", pkg_ids)
        else:
            # критерии этого этапа + общие (stage_id IS NULL)
            crit_rows = await db.fetch(
                "SELECT * FROM tournament_criteria WHERE package_id = ANY($1::bigint[]) AND is_active AND (stage_id=$2 OR stage_id IS NULL) ORDER BY sort_order, id",
                pkg_ids, stage_id)
        crits = [dict(c) for c in crit_rows]
    # пакеты, у которых есть критерии на этом этапе
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

    # распределение жюри
    assigns = await db.fetch(
        "SELECT juror_ec_id, subject_kind, subject_id FROM tournament_jury_assignments WHERE event_id=$1", event_id)
    assigned_by = {}
    for a in assigns:
        assigned_by.setdefault(_skey(a["subject_kind"], a["subject_id"]), set()).add(a["juror_ec_id"])

    # плоский список критериев-колонок (в порядке пакетов)
    columns = []
    for p in pkgs:
        for c in crits_by_pkg.get(p["id"], []):
            columns.append({"criterion_id": c["id"], "title": c["title"], "scorer": c["scorer"],
                            "auto_kind": c["auto_kind"], "scale_max": float(c["scale_max"]),
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
    for i, r in enumerate(table):
        r["place"] = i + 1

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


@router.post("/packages", summary="Создать пакет")
async def create_package(event_id: int, data: PackageIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    if not data.title.strip():
        raise HTTPException(status_code=422, detail="Название пакета обязательно")
    p = await db.fetchrow(
        """INSERT INTO tournament_packages (event_id, title, weight, normalize, sort_order)
           VALUES ($1,$2,$3,$4,$5) RETURNING *""",
        event_id, data.title.strip(), data.weight, data.normalize, data.sort_order)
    return {"package": dict(p)}


class PackageUpdate(BaseModel):
    title: Optional[str] = None
    weight: Optional[float] = None
    normalize: Optional[bool] = None
    sort_order: Optional[int] = None


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

@router.get("/assignments", summary="Матрица распределения участников по жюри")
async def get_assignments(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    subjects = await _subjects(event_id, db)
    jurors = await _jurors(event_id, db)
    rows = await db.fetch("SELECT juror_ec_id, subject_kind, subject_id FROM tournament_jury_assignments WHERE event_id=$1", event_id)
    pairs = {(r["juror_ec_id"], _skey(r["subject_kind"], r["subject_id"])) for r in rows}
    return {
        "subjects": [{"key": s["key"], "name": s["name"], "is_speaker": s["is_speaker"]} for s in subjects],
        "jurors": [{"juror_ec_id": j["juror_ec_id"], "name": j["name"]} for j in jurors],
        "pairs": [{"juror_ec_id": p[0], "key": p[1]} for p in pairs],
    }


class AssignIn(BaseModel):
    juror_ec_id: int
    key: str
    assigned: bool


@router.post("/assignments", summary="Назначить/снять одну пару")
async def set_assignment(event_id: int, data: AssignIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    kind, sid = data.key.split(":", 1)
    if data.assigned:
        await db.execute(
            """INSERT INTO tournament_jury_assignments (event_id, juror_ec_id, subject_kind, subject_id)
               VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING""",
            event_id, data.juror_ec_id, kind, int(sid))
    else:
        await db.execute(
            "DELETE FROM tournament_jury_assignments WHERE event_id=$1 AND juror_ec_id=$2 AND subject_kind=$3 AND subject_id=$4",
            event_id, data.juror_ec_id, kind, int(sid))
    return {"ok": True}


@router.post("/assignments/all", summary="Назначить всех всем / очистить")
async def set_all_assignments(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db), clear: bool = False):
    await _check_access(event_id, int(client["sub"]), db)
    await db.execute("DELETE FROM tournament_jury_assignments WHERE event_id=$1", event_id)
    if not clear:
        subjects = await _subjects(event_id, db)
        jurors = await _jurors(event_id, db)
        for j in jurors:
            for s in subjects:
                await db.execute(
                    "INSERT INTO tournament_jury_assignments (event_id, juror_ec_id, subject_kind, subject_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
                    event_id, j["juror_ec_id"], s["kind"], s["sid"])
    return {"ok": True}


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
    if row["role"] != "jury":
        raise HTTPException(status_code=403, detail="Этот раздел только для жюри")
    return dict(row)


@jury_router.get("/me", summary="Кабинет жюри: мои участники + критерии")
async def jury_me(stage_id: Optional[int] = None, session: dict = Depends(_cab_session), db: asyncpg.Connection = Depends(get_db)):
    juror = await _ensure_juror(session, db)
    event_id = juror["event_id"]; juror_ec_id = juror["id"]

    # привязанные субъекты (ec + ep)
    assigns = await db.fetch(
        "SELECT subject_kind, subject_id FROM tournament_jury_assignments WHERE event_id=$1 AND juror_ec_id=$2",
        event_id, juror_ec_id)
    assigned_keys = {_skey(a["subject_kind"], a["subject_id"]) for a in assigns}
    all_subjects = await _subjects(event_id, db)
    subjects = [s for s in all_subjects if s["key"] in assigned_keys]

    # jury-критерии (по этапу)
    pkgs = await db.fetch("SELECT id FROM tournament_packages WHERE event_id=$1 AND is_active", event_id)
    pkg_ids = [p["id"] for p in pkgs]
    jcrits = []
    if pkg_ids:
        if stage_id is None:
            jcrits = await db.fetch(
                "SELECT id, title, description, scale_max FROM tournament_criteria WHERE package_id=ANY($1::bigint[]) AND is_active AND scorer='jury' ORDER BY sort_order, id", pkg_ids)
        else:
            jcrits = await db.fetch(
                "SELECT id, title, description, scale_max FROM tournament_criteria WHERE package_id=ANY($1::bigint[]) AND is_active AND scorer='jury' AND (stage_id=$2 OR stage_id IS NULL) ORDER BY sort_order, id",
                pkg_ids, stage_id)

    my_scores = await db.fetch(
        "SELECT criterion_id, subject_kind, subject_id, value_number FROM tournament_scores WHERE event_id=$1 AND juror_ec_id=$2",
        event_id, juror_ec_id)
    my_fb = await db.fetch(
        "SELECT subject_kind, subject_id, body, stage_id FROM tournament_feedback WHERE event_id=$1 AND juror_ec_id=$2",
        event_id, juror_ec_id)
    stages = await db.fetch("SELECT id, title FROM conf_stages WHERE event_id=$1 ORDER BY sort_order, id", event_id)

    return {
        "juror_name": juror["name"],
        "subjects": [{"key": s["key"], "name": s["name"], "material": s["material"]} for s in subjects],
        "criteria": [{**dict(c), "scale_max": float(c["scale_max"])} for c in jcrits],
        "my_scores": [{"criterion_id": s["criterion_id"], "key": _skey(s["subject_kind"], s["subject_id"]), "value_number": float(s["value_number"])} for s in my_scores],
        "my_feedback": [{"key": _skey(f["subject_kind"], f["subject_id"]), "body": f["body"], "stage_id": f["stage_id"]} for f in my_fb],
        "stages": [dict(s) for s in stages],
    }


class JuryScoreIn(BaseModel):
    criterion_id: int
    key: str
    value: float


@jury_router.post("/score", summary="Кабинет жюри: поставить балл")
async def jury_score(data: JuryScoreIn, session: dict = Depends(_cab_session), db: asyncpg.Connection = Depends(get_db)):
    juror = await _ensure_juror(session, db)
    event_id = juror["event_id"]; juror_ec_id = juror["id"]
    crit = await db.fetchrow("SELECT scorer FROM tournament_criteria WHERE id=$1 AND event_id=$2", data.criterion_id, event_id)
    if not crit or crit["scorer"] != "jury":
        raise HTTPException(status_code=422, detail="Критерий не для оценки жюри")
    kind, sid = data.key.split(":", 1)
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


@jury_router.get("/my-results", summary="Кабинет спикера: мои оценки и комментарии")
async def my_results(session: dict = Depends(_cab_session), db: asyncpg.Connection = Depends(get_db)):
    se_id = int(session["se_id"]); event_id = int(session["e_id"])
    ev = await db.fetchrow("SELECT module_slug FROM events WHERE id=$1", event_id)
    if not ev or ev["module_slug"] != "turnir":
        return {"is_tournament": False}
    result = await _compute(event_id, None, db)
    mykey = _skey("ec", se_id)
    me = next((r for r in result["table"] if r["key"] == mykey), None)
    if not me:
        return {"is_tournament": True, "has_results": False}
    fb = await db.fetch(
        """SELECT f.body, jc.name AS juror_name
             FROM tournament_feedback f
             JOIN event_collaborators jec ON jec.id = f.juror_ec_id
             JOIN collaborators jc ON jc.id = jec.speaker_id
            WHERE f.event_id=$1 AND f.subject_kind='ec' AND f.subject_id=$2""",
        event_id, se_id)
    # колонки с названиями
    cols = [{"criterion_id": c["criterion_id"], "title": c["title"], "package_title": c["package_title"]} for c in result["columns"]]
    return {"is_tournament": True, "has_results": True, "place": me["place"], "total": me["total"],
            "cells": me["cells"], "columns": cols, "feedback": [dict(f) for f in fb]}
