"""
Универсальная система оценки участников турнира (миграция 132).

Модель «Пакеты → Критерии → Баллы»:
  • Пакет    — смысловая группа критериев (название, вес, этап, нормализация).
  • Критерий — внутри пакета, всегда даёт число. scorer = кто ставит балл:
      'jury'   — каждое жюри ставит свой балл, итог критерия = среднее по жюри;
      'vote'   — народное голосование (одно число, ввожу руками);
      'manual' — ручной ввод организатором (одно число);
      'auto'   — считается само (auto_kind: 'referrals' | 'lead_magnet').
  • Балл     — сырое значение в tournament_scores.

Расчёт итога:
  балл критерия:  jury → AVG по жюри; vote/manual → введённое число; auto → из БД.
  балл пакета:    если normalize=TRUE — каждый критерий = доля от лучшего по турниру,
                  потом взвешенное среднее; иначе — взвешенное среднее сырых баллов.
  итог участника: Σ (балл пакета × вес пакета). Сортировка по итогу убыванием.

Распределение (tournament_jury_assignments) — жюри видит только привязанных.

Два набора эндпоинтов:
  • Клиентские (дашборд)  — /api/v1/events/{event_id}/tournament/...  (get_current_client)
  • Кабинет жюри          — /api/v1/public/tournament-jury/...         (JWT кабинета спикера)
"""
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timezone
import asyncpg
import jwt

from app.auth import get_current_client
from app.database import get_db
from app.config import settings

router = APIRouter(prefix="/events/{event_id}/tournament", tags=["Турнир — оценки"])
jury_router = APIRouter(prefix="/api/v1/public/tournament-jury", tags=["Турнир — кабинет жюри"])

_CAB_AUD = "speaker-cabinet"  # тот же JWT, что у кабинета спикера

# Дефолтные критерии экспертизы (auto-seed при первом открытии вкладки)
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
        "SELECT id, module_slug FROM events WHERE id = $1 AND client_id = $2",
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
    """Auto-seed: при первом открытии создаём 2 пакета с дефолтными критериями."""
    cnt = await db.fetchval(
        "SELECT COUNT(*) FROM tournament_packages WHERE event_id = $1", event_id
    )
    if cnt:
        return
    # Пакет 1 — Оценка жюри (6 критериев экспертизы)
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
    # Пакет 2 — Вовлечение (2 авто-критерия), нормализованный
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


async def _subjects(event_id: int, db: asyncpg.Connection) -> List[dict]:
    """Оцениваемые участники турнира = коллабораторы-спикеры события.
    Сортировка: сначала спикеры/хедлайнеры (по фамилии-имени), организаторы внизу."""
    rows = await db.fetch(
        """SELECT cse.id AS subject_ec_id, cse.role, c.id AS collaborator_id,
                  c.name, ct.ref_code, ct.id AS contact_id,
                  c.video_url, c.video_folder_url
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
             LEFT JOIN contacts ct ON ct.id = c.contact_id
            WHERE cse.event_id = $1
              AND cse.role IN ('speaker', 'headliner')
            ORDER BY split_part(c.name, ' ', 1), c.name, cse.id""",
        event_id,
    )
    return [dict(r) for r in rows]


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
    """Авто-значения: 'referrals' (event_participants по ref_code) | 'lead_magnet' (funnel_runs)."""
    if not contact_id:
        return 0.0
    if auto_kind == "referrals":
        if not ref_code:
            return 0.0
        v = await db.fetchval(
            """SELECT COUNT(*) FROM event_participants
                WHERE event_id = $1 AND referrer_ref_code = $2""",
            event_id, ref_code,
        )
        return float(v or 0)
    if auto_kind == "lead_magnet":
        v = await db.fetchval(
            "SELECT COUNT(*) FROM funnel_runs WHERE referrer_contact_id = $1",
            contact_id,
        )
        return float(v or 0)
    return 0.0


# ───────────────────────── расчёт leaderboard ─────────────────────────

async def _compute(event_id: int, stage_id: Optional[int], db: asyncpg.Connection) -> dict:
    """Вычисляет турнирную таблицу на лету. Возвращает структуру для фронта/снимка."""
    # Пакеты (фильтр по этапу: показываем пакеты этапа + общие stage_id IS NULL)
    if stage_id is None:
        pkgs = await db.fetch(
            "SELECT * FROM tournament_packages WHERE event_id = $1 AND is_active ORDER BY sort_order, id",
            event_id,
        )
    else:
        pkgs = await db.fetch(
            """SELECT * FROM tournament_packages
                WHERE event_id = $1 AND is_active AND (stage_id = $2 OR stage_id IS NULL)
                ORDER BY sort_order, id""",
            event_id, stage_id,
        )
    pkgs = [dict(p) for p in pkgs]
    pkg_ids = [p["id"] for p in pkgs]

    crits = []
    if pkg_ids:
        crit_rows = await db.fetch(
            "SELECT * FROM tournament_criteria WHERE package_id = ANY($1::bigint[]) AND is_active ORDER BY sort_order, id",
            pkg_ids,
        )
        crits = [dict(c) for c in crit_rows]
    crits_by_pkg = {}
    for c in crits:
        crits_by_pkg.setdefault(c["package_id"], []).append(c)

    subjects = await _subjects(event_id, db)
    jurors = await _jurors(event_id, db)

    # Все сырые баллы события одним запросом
    score_rows = await db.fetch(
        "SELECT criterion_id, subject_ec_id, juror_ec_id, scorer, value_number FROM tournament_scores WHERE event_id = $1",
        event_id,
    )
    # crit_id -> subject_ec_id -> {jury: {juror_ec_id: val}, single: val}
    raw = {}
    for s in score_rows:
        cid = s["criterion_id"]; sub = s["subject_ec_id"]
        raw.setdefault(cid, {}).setdefault(sub, {"jury": {}, "single": None})
        if s["juror_ec_id"] is not None:
            raw[cid][sub]["jury"][s["juror_ec_id"]] = float(s["value_number"])
        else:
            raw[cid][sub]["single"] = float(s["value_number"])

    # Балл критерия по участнику (среднее жюри / введённое / авто)
    async def crit_value(crit, subj):
        sub_id = subj["subject_ec_id"]
        cell = raw.get(crit["id"], {}).get(sub_id)
        if crit["scorer"] == "jury":
            if cell and cell["jury"]:
                vals = list(cell["jury"].values())
                return sum(vals) / len(vals)
            return None  # никто не оценил
        if crit["scorer"] == "auto":
            return await _auto_value(event_id, subj["contact_id"], subj["ref_code"], crit["auto_kind"] or "", db)
        # vote / manual
        return cell["single"] if cell and cell["single"] is not None else None

    # Для нормализации нужны максимумы по критерию среди всех участников
    crit_raw_values = {}  # crit_id -> {subject_ec_id: value}
    for c in crits:
        crit_raw_values[c["id"]] = {}
        for subj in subjects:
            crit_raw_values[c["id"]][subj["subject_ec_id"]] = await crit_value(c, subj)
    crit_max = {}
    for cid, vals in crit_raw_values.items():
        nums = [v for v in vals.values() if v is not None]
        crit_max[cid] = max(nums) if nums else 0.0

    # Прогресс оценивания: для каждого участника сколько назначенных жюри оценили
    assigns = await db.fetch(
        "SELECT juror_ec_id, subject_ec_id FROM tournament_jury_assignments WHERE event_id = $1",
        event_id,
    )
    assigned_by_subject = {}
    for a in assigns:
        assigned_by_subject.setdefault(a["subject_ec_id"], set()).add(a["juror_ec_id"])

    # Сборка строк
    table = []
    for subj in subjects:
        sub_id = subj["subject_ec_id"]
        packages_out = []
        total = 0.0
        for p in pkgs:
            p_crits = crits_by_pkg.get(p["id"], [])
            crit_out = []
            weighted_sum = 0.0
            weight_total = 0.0
            for c in p_crits:
                val = crit_raw_values[c["id"]].get(sub_id)
                disp = val
                if p["normalize"]:
                    mx = crit_max[c["id"]]
                    norm = (val / mx) if (val is not None and mx > 0) else (0.0 if val is not None else None)
                    use = norm
                else:
                    use = val
                w = float(c["weight"])
                if use is not None:
                    weighted_sum += use * w
                    weight_total += w
                # детализация по жюри для критерия
                jury_detail = []
                if c["scorer"] == "jury":
                    cell = raw.get(c["id"], {}).get(sub_id)
                    for jr in jurors:
                        jv = cell["jury"].get(jr["juror_ec_id"]) if cell else None
                        if jv is not None:
                            jury_detail.append({"juror_ec_id": jr["juror_ec_id"], "juror_name": jr["name"], "value": jv})
                crit_out.append({
                    "criterion_id": c["id"], "title": c["title"], "scorer": c["scorer"],
                    "auto_kind": c["auto_kind"], "scale_max": float(c["scale_max"]),
                    "value": disp, "jury_detail": jury_detail,
                })
            pkg_score = (weighted_sum / weight_total) if weight_total > 0 else 0.0
            total += pkg_score * float(p["weight"])
            packages_out.append({
                "package_id": p["id"], "title": p["title"], "weight": float(p["weight"]),
                "normalize": p["normalize"], "score": round(pkg_score, 3), "criteria": crit_out,
            })
        # прогресс
        assigned = assigned_by_subject.get(sub_id, set())
        done = 0
        for jr_id in assigned:
            # жюри считается «оценившим», если поставил хоть один jury-балл этому участнику
            if any(raw.get(c["id"], {}).get(sub_id, {}).get("jury", {}).get(jr_id) is not None
                   for c in crits if c["scorer"] == "jury"):
                done += 1
        table.append({
            "subject_ec_id": sub_id, "collaborator_id": subj["collaborator_id"],
            "name": subj["name"], "role": subj["role"],
            "packages": packages_out, "total": round(total, 3),
            "assigned_jury": len(assigned), "done_jury": done,
        })

    table.sort(key=lambda r: r["total"], reverse=True)
    for i, r in enumerate(table):
        r["place"] = i + 1

    return {
        "packages": [{"id": p["id"], "title": p["title"], "weight": float(p["weight"]),
                      "normalize": p["normalize"]} for p in pkgs],
        "jurors": [{"juror_ec_id": j["juror_ec_id"], "name": j["name"]} for j in jurors],
        "table": table,
    }


# ════════════════════════ КЛИЕНТСКИЕ ЭНДПОИНТЫ (дашборд) ════════════════════════

# ── Пакеты + критерии (конструктор) ──

@router.get("/criteria", summary="Все пакеты с критериями (конструктор)")
async def list_criteria(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    await _seed_defaults_if_empty(event_id, db)
    pkgs = await db.fetch(
        "SELECT * FROM tournament_packages WHERE event_id = $1 ORDER BY sort_order, id", event_id
    )
    out = []
    for p in pkgs:
        crits = await db.fetch(
            "SELECT * FROM tournament_criteria WHERE package_id = $1 ORDER BY sort_order, id", p["id"]
        )
        d = dict(p)
        d["weight"] = float(d["weight"])
        d["criteria"] = [{**dict(c), "scale_max": float(c["scale_max"]), "weight": float(c["weight"])} for c in crits]
        out.append(d)
    stages = await db.fetch(
        "SELECT id, title FROM conf_stages WHERE event_id = $1 ORDER BY sort_order, id", event_id
    )
    return {"packages": out, "stages": [dict(s) for s in stages]}


class PackageIn(BaseModel):
    title: str
    stage_id: Optional[int] = None
    weight: float = 1
    normalize: bool = False
    sort_order: int = 0


@router.post("/packages", summary="Создать пакет")
async def create_package(event_id: int, data: PackageIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    if not data.title.strip():
        raise HTTPException(status_code=422, detail="Название пакета обязательно")
    p = await db.fetchrow(
        """INSERT INTO tournament_packages (event_id, title, stage_id, weight, normalize, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *""",
        event_id, data.title.strip(), data.stage_id, data.weight, data.normalize, data.sort_order,
    )
    return {"package": dict(p)}


class PackageUpdate(BaseModel):
    title: Optional[str] = None
    stage_id: Optional[int] = None
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
        await db.execute(
            f"UPDATE tournament_packages SET {sets}, updated_at = now() WHERE id = $1 AND event_id = $2",
            package_id, event_id, *payload.values(),
        )
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
        """INSERT INTO tournament_criteria (package_id, event_id, title, description, scorer, auto_kind, scale_max, weight, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *""",
        data.package_id, event_id, data.title.strip(), data.description, data.scorer,
        data.auto_kind if data.scorer == "auto" else None, data.scale_max, data.weight, data.sort_order,
    )
    return {"criterion": dict(c)}


class CriterionUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    scorer: Optional[str] = None
    auto_kind: Optional[str] = None
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
        await db.execute(
            f"UPDATE tournament_criteria SET {sets}, updated_at = now() WHERE id=$1 AND event_id=$2",
            criterion_id, event_id, *payload.values(),
        )
    c = await db.fetchrow("SELECT * FROM tournament_criteria WHERE id=$1 AND event_id=$2", criterion_id, event_id)
    if not c:
        raise HTTPException(status_code=404, detail="Критерий не найден")
    return {"criterion": dict(c)}


@router.delete("/criteria/{criterion_id}", summary="Удалить критерий")
async def delete_criterion(event_id: int, criterion_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    await db.execute("DELETE FROM tournament_criteria WHERE id=$1 AND event_id=$2", criterion_id, event_id)
    return {"ok": True}


# ── Распределение участник ↔ жюри ──

@router.get("/assignments", summary="Матрица распределения участников по жюри")
async def get_assignments(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    subjects = await _subjects(event_id, db)
    jurors = await _jurors(event_id, db)
    rows = await db.fetch(
        "SELECT juror_ec_id, subject_ec_id FROM tournament_jury_assignments WHERE event_id = $1", event_id
    )
    pairs = {(r["juror_ec_id"], r["subject_ec_id"]) for r in rows}
    return {
        "subjects": [{"subject_ec_id": s["subject_ec_id"], "name": s["name"], "role": s["role"]} for s in subjects],
        "jurors": [{"juror_ec_id": j["juror_ec_id"], "name": j["name"]} for j in jurors],
        "pairs": [{"juror_ec_id": p[0], "subject_ec_id": p[1]} for p in pairs],
    }


class AssignIn(BaseModel):
    juror_ec_id: int
    subject_ec_id: int
    assigned: bool


@router.post("/assignments", summary="Назначить/снять одну пару")
async def set_assignment(event_id: int, data: AssignIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    if data.assigned:
        await db.execute(
            """INSERT INTO tournament_jury_assignments (event_id, juror_ec_id, subject_ec_id)
               VALUES ($1,$2,$3) ON CONFLICT (juror_ec_id, subject_ec_id) DO NOTHING""",
            event_id, data.juror_ec_id, data.subject_ec_id,
        )
    else:
        await db.execute(
            "DELETE FROM tournament_jury_assignments WHERE event_id=$1 AND juror_ec_id=$2 AND subject_ec_id=$3",
            event_id, data.juror_ec_id, data.subject_ec_id,
        )
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
                    "INSERT INTO tournament_jury_assignments (event_id, juror_ec_id, subject_ec_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
                    event_id, j["juror_ec_id"], s["subject_ec_id"],
                )
    return {"ok": True}


# ── Турнирная таблица (живой расчёт) ──

@router.get("/leaderboard", summary="Турнирная таблица (живой расчёт)")
async def leaderboard(event_id: int, stage_id: Optional[int] = None, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    return await _compute(event_id, stage_id, db)


# ── Ручной/народный ввод балла организатором ──

class ManualScoreIn(BaseModel):
    criterion_id: int
    subject_ec_id: int
    value: float


@router.post("/manual-score", summary="Ручной/народный балл (организатор)")
async def set_manual_score(event_id: int, data: ManualScoreIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    crit = await db.fetchrow("SELECT scorer FROM tournament_criteria WHERE id=$1 AND event_id=$2", data.criterion_id, event_id)
    if not crit:
        raise HTTPException(status_code=404, detail="Критерий не найден")
    if crit["scorer"] not in ("vote", "manual"):
        raise HTTPException(status_code=422, detail="Этот критерий не для ручного ввода")
    await db.execute(
        """INSERT INTO tournament_scores (event_id, criterion_id, subject_ec_id, juror_ec_id, scorer, value_number)
           VALUES ($1,$2,$3,NULL,$4,$5)
           ON CONFLICT (criterion_id, subject_ec_id) WHERE juror_ec_id IS NULL
           DO UPDATE SET value_number = EXCLUDED.value_number, updated_at = now()""",
        event_id, data.criterion_id, data.subject_ec_id, crit["scorer"], data.value,
    )
    return {"ok": True}


# ── Обратная связь (просмотр организатором) ──

@router.get("/feedback", summary="Вся обратная связь жюри (организатор)")
async def list_feedback(event_id: int, stage_id: Optional[int] = None, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        """SELECT f.subject_ec_id, f.juror_ec_id, f.body, f.stage_id,
                  jc.name AS juror_name
             FROM tournament_feedback f
             JOIN event_collaborators jec ON jec.id = f.juror_ec_id
             JOIN collaborators jc ON jc.id = jec.speaker_id
            WHERE f.event_id = $1 AND ($2::bigint IS NULL OR f.stage_id IS NOT DISTINCT FROM $2)
            ORDER BY f.subject_ec_id, jc.name""",
        event_id, stage_id,
    )
    return {"feedback": [dict(r) for r in rows]}


# ── Снимки отчётов ──

@router.get("/snapshots", summary="Список снимков отчётов")
async def list_snapshots(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        "SELECT id, stage_id, title, frozen_at FROM tournament_snapshots WHERE event_id=$1 ORDER BY frozen_at DESC", event_id
    )
    return {"snapshots": [dict(r) for r in rows]}


class SnapshotIn(BaseModel):
    title: Optional[str] = None
    stage_id: Optional[int] = None


@router.post("/snapshots", summary="Сохранить отчёт (снимок результатов)")
async def create_snapshot(event_id: int, data: SnapshotIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    result = await _compute(event_id, data.stage_id, db)
    feedback = await db.fetch(
        """SELECT f.subject_ec_id, f.body, jc.name AS juror_name
             FROM tournament_feedback f
             JOIN event_collaborators jec ON jec.id = f.juror_ec_id
             JOIN collaborators jc ON jc.id = jec.speaker_id
            WHERE f.event_id = $1""",
        event_id,
    )
    fb_by_subject = {}
    for f in feedback:
        fb_by_subject.setdefault(f["subject_ec_id"], []).append({"juror_name": f["juror_name"], "body": f["body"]})

    snap_id = await db.fetchval(
        "INSERT INTO tournament_snapshots (event_id, stage_id, title) VALUES ($1,$2,$3) RETURNING id",
        event_id, data.stage_id, (data.title or "").strip(),
    )
    for row in result["table"]:
        # строка-итог
        await db.execute(
            """INSERT INTO tournament_snapshot_rows (snapshot_id, subject_ec_id, subject_name, package_id, package_title, package_score, total_score, place)
               VALUES ($1,$2,$3,NULL,'',NULL,$4,$5)""",
            snap_id, row["subject_ec_id"], row["name"], row["total"], row["place"],
        )
        for pkg in row["packages"]:
            await db.execute(
                """INSERT INTO tournament_snapshot_rows (snapshot_id, subject_ec_id, subject_name, package_id, package_title, package_score, total_score, place)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)""",
                snap_id, row["subject_ec_id"], row["name"], pkg["package_id"], pkg["title"], pkg["score"], row["total"], row["place"],
            )
            for c in pkg["criteria"]:
                if c["jury_detail"]:
                    for jd in c["jury_detail"]:
                        await db.execute(
                            """INSERT INTO tournament_snapshot_scores (snapshot_id, subject_ec_id, subject_name, package_title, criterion_title, juror_name, value_number, feedback_body)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,NULL)""",
                            snap_id, row["subject_ec_id"], row["name"], pkg["title"], c["title"], jd["juror_name"], jd["value"],
                        )
                else:
                    await db.execute(
                        """INSERT INTO tournament_snapshot_scores (snapshot_id, subject_ec_id, subject_name, package_title, criterion_title, juror_name, value_number, feedback_body)
                           VALUES ($1,$2,$3,$4,$5,NULL,$6,NULL)""",
                        snap_id, row["subject_ec_id"], row["name"], pkg["title"], c["title"], c["value"],
                    )
        # комментарии
        for fb in fb_by_subject.get(row["subject_ec_id"], []):
            await db.execute(
                """INSERT INTO tournament_snapshot_scores (snapshot_id, subject_ec_id, subject_name, package_title, criterion_title, juror_name, value_number, feedback_body)
                   VALUES ($1,$2,$3,'Обратная связь','',$4,NULL,$5)""",
                snap_id, row["subject_ec_id"], row["name"], fb["juror_name"], fb["body"],
            )
    return {"snapshot_id": snap_id}


@router.get("/snapshots/{snapshot_id}", summary="Содержимое снимка")
async def get_snapshot(event_id: int, snapshot_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    snap = await db.fetchrow("SELECT * FROM tournament_snapshots WHERE id=$1 AND event_id=$2", snapshot_id, event_id)
    if not snap:
        raise HTTPException(status_code=404, detail="Снимок не найден")
    rows = await db.fetch("SELECT * FROM tournament_snapshot_rows WHERE snapshot_id=$1 ORDER BY place, package_id NULLS FIRST", snapshot_id)
    scores = await db.fetch("SELECT * FROM tournament_snapshot_scores WHERE snapshot_id=$1 ORDER BY subject_ec_id", snapshot_id)
    return {"snapshot": dict(snap), "rows": [dict(r) for r in rows], "scores": [dict(s) for s in scores]}


@router.delete("/snapshots/{snapshot_id}", summary="Удалить снимок")
async def delete_snapshot(event_id: int, snapshot_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    await db.execute("DELETE FROM tournament_snapshots WHERE id=$1 AND event_id=$2", snapshot_id, event_id)
    return {"ok": True}


# ════════════════════════ КАБИНЕТ ЖЮРИ (JWT кабинета спикера) ════════════════════════

async def _ensure_juror(session: dict, db: asyncpg.Connection) -> dict:
    se_id = int(session["se_id"]); event_id = int(session["e_id"])
    row = await db.fetchrow(
        """SELECT cse.id, cse.event_id, cse.role, c.name, e.module_slug
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
             JOIN events e ON e.id = cse.event_id
            WHERE cse.id = $1""",
        se_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    if row["role"] != "jury":
        raise HTTPException(status_code=403, detail="Этот раздел только для жюри")
    return dict(row)


@jury_router.get("/me", summary="Кабинет жюри: мои участники + критерии")
async def jury_me(stage_id: Optional[int] = None, session: dict = Depends(_cab_session), db: asyncpg.Connection = Depends(get_db)):
    juror = await _ensure_juror(session, db)
    event_id = juror["event_id"]; juror_ec_id = juror["id"]

    # привязанные участники
    subjects = await db.fetch(
        """SELECT cse.id AS subject_ec_id, c.name, c.video_url, c.video_folder_url
             FROM tournament_jury_assignments a
             JOIN event_collaborators cse ON cse.id = a.subject_ec_id
             JOIN collaborators c ON c.id = cse.speaker_id
            WHERE a.event_id = $1 AND a.juror_ec_id = $2
            ORDER BY split_part(c.name, ' ', 1), c.name""",
        event_id, juror_ec_id,
    )

    # jury-критерии (по этапу)
    if stage_id is None:
        pkgs = await db.fetch(
            "SELECT * FROM tournament_packages WHERE event_id=$1 AND is_active ORDER BY sort_order, id", event_id
        )
    else:
        pkgs = await db.fetch(
            "SELECT * FROM tournament_packages WHERE event_id=$1 AND is_active AND (stage_id=$2 OR stage_id IS NULL) ORDER BY sort_order, id",
            event_id, stage_id,
        )
    pkg_ids = [p["id"] for p in pkgs]
    jcrits = []
    if pkg_ids:
        jcrits = await db.fetch(
            "SELECT id, package_id, title, description, scale_max, sort_order FROM tournament_criteria WHERE package_id = ANY($1::bigint[]) AND is_active AND scorer='jury' ORDER BY sort_order, id",
            pkg_ids,
        )

    # текущие баллы этого жюри
    my_scores = await db.fetch(
        """SELECT s.criterion_id, s.subject_ec_id, s.value_number
             FROM tournament_scores s
            WHERE s.event_id=$1 AND s.juror_ec_id=$2""",
        event_id, juror_ec_id,
    )
    my_feedback = await db.fetch(
        "SELECT subject_ec_id, body, stage_id FROM tournament_feedback WHERE event_id=$1 AND juror_ec_id=$2",
        event_id, juror_ec_id,
    )
    stages = await db.fetch("SELECT id, title FROM conf_stages WHERE event_id=$1 ORDER BY sort_order, id", event_id)

    return {
        "juror_name": juror["name"],
        "subjects": [dict(s) for s in subjects],
        "criteria": [{**dict(c), "scale_max": float(c["scale_max"])} for c in jcrits],
        "my_scores": [dict(s) for s in my_scores],
        "my_feedback": [dict(f) for f in my_feedback],
        "stages": [dict(s) for s in stages],
    }


class JuryScoreIn(BaseModel):
    criterion_id: int
    subject_ec_id: int
    value: float


@jury_router.post("/score", summary="Кабинет жюри: поставить балл")
async def jury_score(data: JuryScoreIn, session: dict = Depends(_cab_session), db: asyncpg.Connection = Depends(get_db)):
    juror = await _ensure_juror(session, db)
    event_id = juror["event_id"]; juror_ec_id = juror["id"]
    crit = await db.fetchrow("SELECT scorer FROM tournament_criteria WHERE id=$1 AND event_id=$2", data.criterion_id, event_id)
    if not crit or crit["scorer"] != "jury":
        raise HTTPException(status_code=422, detail="Критерий не для оценки жюри")
    # проверка что участник назначен этому жюри
    ok = await db.fetchval(
        "SELECT 1 FROM tournament_jury_assignments WHERE event_id=$1 AND juror_ec_id=$2 AND subject_ec_id=$3",
        event_id, juror_ec_id, data.subject_ec_id,
    )
    if not ok:
        raise HTTPException(status_code=403, detail="Этот участник вам не назначен")
    await db.execute(
        """INSERT INTO tournament_scores (event_id, criterion_id, subject_ec_id, juror_ec_id, scorer, value_number)
           VALUES ($1,$2,$3,$4,'jury',$5)
           ON CONFLICT (criterion_id, subject_ec_id, juror_ec_id) WHERE juror_ec_id IS NOT NULL
           DO UPDATE SET value_number = EXCLUDED.value_number, updated_at = now()""",
        event_id, data.criterion_id, data.subject_ec_id, juror_ec_id, data.value,
    )
    return {"ok": True}


class JuryFeedbackIn(BaseModel):
    subject_ec_id: int
    body: str
    stage_id: Optional[int] = None


@jury_router.post("/feedback", summary="Кабинет жюри: обратная связь участнику")
async def jury_feedback(data: JuryFeedbackIn, session: dict = Depends(_cab_session), db: asyncpg.Connection = Depends(get_db)):
    juror = await _ensure_juror(session, db)
    event_id = juror["event_id"]; juror_ec_id = juror["id"]
    ok = await db.fetchval(
        "SELECT 1 FROM tournament_jury_assignments WHERE event_id=$1 AND juror_ec_id=$2 AND subject_ec_id=$3",
        event_id, juror_ec_id, data.subject_ec_id,
    )
    if not ok:
        raise HTTPException(status_code=403, detail="Этот участник вам не назначен")
    if data.stage_id is None:
        await db.execute(
            """INSERT INTO tournament_feedback (event_id, stage_id, juror_ec_id, subject_ec_id, body)
               VALUES ($1,NULL,$2,$3,$4)
               ON CONFLICT (juror_ec_id, subject_ec_id) WHERE stage_id IS NULL
               DO UPDATE SET body = EXCLUDED.body, updated_at = now()""",
            event_id, juror_ec_id, data.subject_ec_id, data.body,
        )
    else:
        await db.execute(
            """INSERT INTO tournament_feedback (event_id, stage_id, juror_ec_id, subject_ec_id, body)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (juror_ec_id, subject_ec_id, stage_id) WHERE stage_id IS NOT NULL
               DO UPDATE SET body = EXCLUDED.body, updated_at = now()""",
            event_id, data.stage_id, juror_ec_id, data.subject_ec_id, data.body,
        )
    return {"ok": True}


# ── Результаты участника (для вкладки «Мои результаты» в кабинете спикера) ──

@jury_router.get("/my-results", summary="Кабинет спикера: мои оценки и комментарии")
async def my_results(session: dict = Depends(_cab_session), db: asyncpg.Connection = Depends(get_db)):
    se_id = int(session["se_id"]); event_id = int(session["e_id"])
    ev = await db.fetchrow("SELECT module_slug FROM events WHERE id=$1", event_id)
    if not ev or ev["module_slug"] != "turnir":
        return {"is_tournament": False}
    result = await _compute(event_id, None, db)
    me = next((r for r in result["table"] if r["subject_ec_id"] == se_id), None)
    if not me:
        return {"is_tournament": True, "has_results": False}
    fb = await db.fetch(
        """SELECT f.body, jc.name AS juror_name
             FROM tournament_feedback f
             JOIN event_collaborators jec ON jec.id = f.juror_ec_id
             JOIN collaborators jc ON jc.id = jec.speaker_id
            WHERE f.event_id=$1 AND f.subject_ec_id=$2""",
        event_id, se_id,
    )
    return {
        "is_tournament": True, "has_results": True,
        "place": me["place"], "total": me["total"], "packages": me["packages"],
        "feedback": [dict(f) for f in fb],
    }
