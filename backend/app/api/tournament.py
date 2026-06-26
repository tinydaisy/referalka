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
  балл пакета:    normalize=TRUE — каждый критерий = доля от лучшего СРЕДИ ВСЕХ УЧАСТНИКОВ
                  (val / max_по_столбцу, лидер=1.0), потом взвеш.среднее;
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
    seen_contacts: set = set()  # contact_id, уже добавленные строкой-участником (ep)
    # ── Участники (ep). Исключаем только организаторов/жюри/партнёров —
    #    их в таблице оцениваемых быть не должно. СПИКЕРЫ остаются: человек,
    #    который сдавал задания как участник, показывается строкой-участником
    #    со своими ep-баллами (даже если его потом записали спикером).
    ep_rows = await db.fetch(
        """SELECT ep.id AS sid, ct.name, ct.ref_code, ct.id AS contact_id,
                  (SELECT pu.username FROM platform_users pu
                     WHERE pu.contact_id = ct.id AND pu.username IS NOT NULL
                     ORDER BY CASE pu.platform_slug WHEN 'telegram' THEN 1 WHEN 'vk' THEN 2 WHEN 'max' THEN 3 ELSE 4 END
                     LIMIT 1) AS username
             FROM event_participants ep
             JOIN contacts ct ON ct.id = ep.contact_id
            WHERE ep.event_id = $1 AND ep.is_registered = TRUE
              AND ct.is_staff = FALSE
              AND NOT EXISTS (
                SELECT 1 FROM event_collaborators ec2
                 JOIN collaborators c2 ON c2.id = ec2.speaker_id
                WHERE ec2.event_id = ep.event_id AND c2.contact_id = ct.id
                  AND ec2.role IN ('organizer', 'jury', 'general_partner', 'partner')
              )
            ORDER BY ct.name, ep.id""",
        event_id,
    )
    for r in ep_rows:
        d = dict(r)
        if d["contact_id"] is not None:
            seen_contacts.add(d["contact_id"])
        out.append({"kind": "ep", "sid": d["sid"], "key": _skey("ep", d["sid"]),
                    "name": d["name"] or "Без имени", "username": d.get("username"),
                    "ref_code": d["ref_code"], "contact_id": d["contact_id"],
                    "material": None, "is_speaker": False})
    # ── Спикеры/хедлайнеры (ec). Добавляем ТОЛЬКО тех, кого ещё нет среди
    #    участников — иначе один человек (и спикер, и участник) задвоится.
    #    Его ep-строка уже содержит баллы; пустую спикерскую не плодим.
    ec_rows = await db.fetch(
        """SELECT cse.id AS sid, c.name, ct.ref_code, ct.id AS contact_id,
                  c.video_url, c.video_folder_url,
                  (SELECT pu.username FROM platform_users pu
                     WHERE pu.contact_id = ct.id AND pu.username IS NOT NULL
                     ORDER BY CASE pu.platform_slug WHEN 'telegram' THEN 1 WHEN 'vk' THEN 2 WHEN 'max' THEN 3 ELSE 4 END
                     LIMIT 1) AS username
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
             LEFT JOIN contacts ct ON ct.id = c.contact_id
            WHERE cse.event_id = $1 AND cse.role IN ('speaker', 'headliner')
            ORDER BY split_part(c.name, ' ', 1), c.name, cse.id""",
        event_id,
    )
    for r in ec_rows:
        d = dict(r)
        if d["contact_id"] is not None and d["contact_id"] in seen_contacts:
            continue  # уже есть строкой-участником
        out.append({"kind": "ec", "sid": d["sid"], "key": _skey("ec", d["sid"]),
                    "name": d["name"] or "Без имени", "username": d.get("username"),
                    "ref_code": d["ref_code"], "contact_id": d["contact_id"],
                    "material": d["video_url"] or d["video_folder_url"], "is_speaker": True})
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


async def _auto_value(event_id: int, contact_id, ref_code, auto_kind: str,
                      db: asyncpg.Connection, subj: dict | None = None) -> float:
    # 'lead_magnet' — считаем переходы (funnel_runs) в лид-магнит/пакет,
    # который спикер выбрал «подарком после эфира» (event_collaborators).
    # Привязка живёт на ec → считаем только для субъектов-спикеров (kind='ec').
    # «Просто зашло» = любой funnel_run (без фильтра по stage и по рефереру).
    if auto_kind == "lead_magnet":
        if not subj or subj.get("kind") != "ec":
            return 0.0
        link = await db.fetchrow(
            "SELECT gift_lead_magnet_id, gift_package_id FROM event_collaborators WHERE id = $1",
            subj["sid"],
        )
        if not link:
            return 0.0
        if link["gift_lead_magnet_id"]:
            v = await db.fetchval(
                "SELECT COUNT(*) FROM funnel_runs WHERE lead_magnet_id = $1",
                link["gift_lead_magnet_id"],
            )
            return float(v or 0)
        if link["gift_package_id"]:
            v = await db.fetchval(
                "SELECT COUNT(*) FROM funnel_runs WHERE package_id = $1",
                link["gift_package_id"],
            )
            return float(v or 0)
        return 0.0
    if not contact_id:
        return 0.0
    if auto_kind == "referrals":
        if not ref_code:
            return 0.0
        # Считаем приведённых ТОЧНО так же, как рефералка выдаёт подарки —
        # по event_referral_settings.gift_count_mode (registered/visited/clicked_link).
        gift_mode = await db.fetchval(
            "SELECT gift_count_mode FROM event_referral_settings WHERE event_id = $1",
            event_id,
        ) or "registered"
        if gift_mode == "visited":
            cond = ""
        elif gift_mode == "clicked_link":
            cond = " AND link_clicked_at IS NOT NULL"
        else:  # registered
            cond = " AND is_registered = TRUE"
        v = await db.fetchval(
            f"SELECT COUNT(*) FROM event_participants "
            f"WHERE event_id = $1 AND referrer_ref_code = $2{cond}",
            event_id, ref_code,
        )
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
    # ── Фильтр «кого отображать в таблице» — по настройке этапа listen_audiences ──
    #   speakers → показываем спикеров (ec); all/registered → участников (ep).
    #   Если этап не выбран или настройка пустая/не задана — показываем всех (как было).
    if stage_id is not None:
        st_aud = await db.fetchval(
            "SELECT listen_audiences FROM conf_stages WHERE id=$1 AND event_id=$2",
            stage_id, event_id)
        aud = set(st_aud or [])
        if aud:  # пустой массив = «показывать всех» (обратная совместимость)
            show_ep = bool(aud & {"all", "registered"})
            show_ec = "speakers" in aud
            subjects = [s for s in subjects
                        if (s["kind"] == "ep" and show_ep) or (s["kind"] == "ec" and show_ec)]
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
            return await _auto_value(event_id, subj["contact_id"], subj["ref_code"],
                                     crit["auto_kind"] or "", db, subj=subj)
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
                            "weight": float(c["weight"]),
                            "description": c.get("description"),
                            "code_phrase": c.get("code_phrase"),
                            "package_id": p["id"], "package_title": p["title"]})

    # ── Схема расчёта пакета (поле tournament_packages.scheme):
    #   s1 «Сырая ÷ лидера»     pkg = Σ(знач×вес) / сумма_лидера × 10        [0..10]
    #   s2 «Доля от лучшего»    pkg = Σ(доля×вес) / Σвесов × 10              [0..10]
    #   s3 «Среднее значений»   pkg = Σ(знач×вес) / Σвесов                   (жюри: 0..10)
    #   s4 «Чистая сумма»       pkg = Σ(знач×вес), без деления               (задания)
    # Совместимость для старых пакетов без scheme: normalize/aggregate → схема.
    def _scheme_of(p):
        s = p.get("scheme")
        if s in ("s1", "s2", "s3", "s4"):
            return s
        if p.get("aggregate") == "sum":
            return "s4"
        if p.get("normalize"):
            return "s2"
        return "s3"

    # ── ПРЕДРАСЧЁТ для схемы 1: сырая сумма пакета у каждого subject + рекорд (лидер).
    #    pkg_raw_sum[pkg_id][skey] = Σ(сырое_значение × вес) по критериям пакета.
    pkg_raw_sum = {}      # pkg_id -> skey -> сырая взвешенная сумма
    for p in pkgs:
        pid = p["id"]
        pkg_raw_sum[pid] = {}
        for subj in subjects:
            s = 0.0
            for c in crits_by_pkg.get(pid, []):
                v = crit_raw[c["id"]].get(subj["key"])
                if v is not None:
                    s += v * float(c["weight"])
            pkg_raw_sum[pid][subj["key"]] = s
    # рекорд суммы пакета (для s1) + кто лидер
    pkg_leader = {}       # pkg_id -> {"key","name","username","value"}  (для вывода над таблицей)
    pkg_sum_max = {}      # pkg_id -> max сырой суммы
    subj_by_key = {s["key"]: s for s in subjects}
    for p in pkgs:
        pid = p["id"]
        best_key, best_val = None, 0.0
        for k, v in pkg_raw_sum[pid].items():
            if v > best_val:
                best_val, best_key = v, k
        pkg_sum_max[pid] = best_val
        if _scheme_of(p) == "s1" and best_key is not None and best_val > 0:
            ls = subj_by_key.get(best_key, {})
            pkg_leader[pid] = {"key": best_key, "name": ls.get("name"),
                               "username": ls.get("username"), "value": round(best_val, 3)}
    # лидеры по каждому критерию — ТОЛЬКО для пакетов со схемой 2 (нормализация).
    # У s1 лидер показывается под колонкой суммы пакета, у s3/s4 лидеров по критериям нет.
    s2_crit_ids = {c["id"] for p in pkgs if _scheme_of(p) == "s2"
                   for c in crits_by_pkg.get(p["id"], [])}
    crit_leader = {}      # crit_id -> {"name","username","value"}
    for cid, vals in crit_raw.items():
        if cid not in s2_crit_ids:
            continue
        mx = crit_max.get(cid, 0.0)
        if mx > 0:
            for k, v in vals.items():
                if v is not None and v == mx:
                    ls = subj_by_key.get(k, {})
                    crit_leader[cid] = {"key": k, "name": ls.get("name"), "username": ls.get("username"),
                                        "value": round(mx, 3)}
                    break

    table = []
    for subj in subjects:
        cells = {}            # criterion_id -> value (для колонок-критериев)
        cells_norm = {}       # criterion_id -> нормализованная доля (для s2: значение ÷ макс)
        jury_detail = {}      # criterion_id -> [{juror_name, value}]
        package_scores = {}   # package_id -> балл пакета
        total = 0.0
        for p in pkgs:
            scheme = _scheme_of(p)
            weighted_sum = 0.0; weight_total = 0.0   # для s2/s3/s4 (s2 — по долям)
            for c in crits_by_pkg.get(p["id"], []):
                val = crit_raw[c["id"]].get(subj["key"])
                cells[c["id"]] = val
                if scheme == "s2":   # доля от лучшего по критерию
                    mx = crit_max[c["id"]]
                    use = (val / mx) if (val is not None and mx > 0) else (0.0 if val is not None else None)
                    cells_norm[c["id"]] = round(use, 3) if use is not None else None
                else:                # s1/s3/s4 — сырое значение
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
            if scheme == "s1":
                # сырая сумма ÷ рекорд суммы пакета × 10
                smax = pkg_sum_max.get(p["id"], 0.0)
                raw_sum = pkg_raw_sum[p["id"]].get(subj["key"], 0.0)
                pkg_score = (raw_sum / smax * 10.0) if smax > 0 else 0.0
            elif scheme == "s2":
                # средневзвешенное долей × 10
                pkg_score = (weighted_sum / weight_total * 10.0) if weight_total > 0 else 0.0
            elif scheme == "s4":
                # чистая взвешенная сумма, без деления
                pkg_score = weighted_sum
            else:  # s3 — среднее значений (÷ сумму весов)
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
            "name": subj["name"], "username": subj.get("username"), "is_speaker": subj["is_speaker"],
            "cells": {str(k): v for k, v in cells.items()},
            # нормализованные доли по критериям (для схемы 2: значение ÷ макс критерия)
            "cells_norm": {str(k): v for k, v in cells_norm.items()},
            "package_scores": {str(k): v for k, v in package_scores.items()},
            # сырая взвешенная сумма по пакету (Σ критерий×вес) — для колонки «Σ» при схеме 1
            "package_raw_sums": {str(p["id"]): round(pkg_raw_sum[p["id"]].get(subj["key"], 0.0), 3) for p in pkgs},
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

    # Позиция (rank) лидера в итоговом рейтинге — чтобы под колонкой показать
    # «ФИО (место N)»: лидер по критерию может быть не первым в общем итоге.
    place_by_key = {r["key"]: r["place"] for r in table}
    for _ld in pkg_leader.values():
        _ld["rank"] = place_by_key.get(_ld.get("key"))
    for _ld in crit_leader.values():
        _ld["rank"] = place_by_key.get(_ld.get("key"))

    return {
        "packages": [{"id": p["id"], "title": p["title"], "weight": float(p["weight"]),
                      "normalize": p["normalize"], "aggregate": p.get("aggregate", "avg"),
                      "scheme": _scheme_of(p),
                      "leader": pkg_leader.get(p["id"])} for p in pkgs],
        "columns": [{**col, "leader": crit_leader.get(col["criterion_id"])} for col in columns],
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
    stages = await db.fetch(
        "SELECT id, title, COALESCE(listen_audiences, ARRAY['registered']::text[]) AS listen_audiences "
        "FROM conf_stages WHERE event_id=$1 ORDER BY sort_order, id", event_id)
    return {"packages": out, "stages": [dict(s) for s in stages]}


_VALID_SCHEMES = ("s1", "s2", "s3", "s4")


class PackageIn(BaseModel):
    title: str
    weight: float = 1
    scheme: str = "s3"   # s1/s2/s3/s4 — см. _compute
    normalize: bool = False
    aggregate: str = "avg"  # legacy, держим в синхроне со scheme
    sort_order: int = 0
    stage_id: Optional[int] = None  # этап пакета (NULL = весь турнир)


def _legacy_from_scheme(scheme: str):
    """Держим старые normalize/aggregate в синхроне со scheme (на случай кода, читающего их)."""
    if scheme == "s2":
        return True, "avg"
    if scheme == "s4":
        return False, "sum"
    # s1, s3 — нормализации по критериям нет, агрегат среднее (s1 делит на лидера в _compute)
    return False, "avg"


@router.post("/packages", summary="Создать пакет")
async def create_package(event_id: int, data: PackageIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    if not data.title.strip():
        raise HTTPException(status_code=422, detail="Название пакета обязательно")
    if data.scheme not in _VALID_SCHEMES:
        raise HTTPException(status_code=422, detail="scheme должен быть s1/s2/s3/s4")
    norm, agg = _legacy_from_scheme(data.scheme)
    p = await db.fetchrow(
        """INSERT INTO tournament_packages (event_id, title, weight, scheme, normalize, aggregate, sort_order, stage_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *""",
        event_id, data.title.strip(), data.weight, data.scheme, norm, agg, data.sort_order, data.stage_id)
    # Схема 3 = жюри: все критерии пакета становятся jury-типа (но при создании их ещё нет)
    return {"package": dict(p)}


class PackageUpdate(BaseModel):
    title: Optional[str] = None
    weight: Optional[float] = None
    scheme: Optional[str] = None
    normalize: Optional[bool] = None
    aggregate: Optional[str] = None
    sort_order: Optional[int] = None
    stage_id: Optional[int] = None


@router.patch("/packages/{package_id}", summary="Обновить пакет")
async def update_package(event_id: int, package_id: int, data: PackageUpdate, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    payload = data.model_dump(exclude_unset=True)
    if payload.get("scheme") and payload["scheme"] not in _VALID_SCHEMES:
        raise HTTPException(status_code=422, detail="scheme должен быть s1/s2/s3/s4")
    if payload.get("aggregate") and payload["aggregate"] not in ("avg", "sum"):
        raise HTTPException(status_code=422, detail="aggregate должен быть avg или sum")
    # при смене схемы держим legacy normalize/aggregate в синхроне
    if payload.get("scheme"):
        norm, agg = _legacy_from_scheme(payload["scheme"])
        payload.setdefault("normalize", norm)
        payload.setdefault("aggregate", agg)
    if payload:
        cols = list(payload.keys())
        sets = ", ".join(f"{c} = ${i+3}" for i, c in enumerate(cols))
        await db.execute(f"UPDATE tournament_packages SET {sets}, updated_at=now() WHERE id=$1 AND event_id=$2",
                         package_id, event_id, *payload.values())
    # Схема 3 = жюри: все критерии этого пакета автоматически становятся jury-типа
    if payload.get("scheme") == "s3":
        await db.execute(
            "UPDATE tournament_criteria SET scorer='jury', auto_kind=NULL WHERE package_id=$1 AND scorer<>'jury'",
            package_id)
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
    code_phrase: Optional[str] = None  # для manual: кодовая фраза авто-зачёта по чату


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
        """INSERT INTO tournament_criteria (package_id, event_id, title, description, scorer, auto_kind, stage_id, scale_max, weight, sort_order, code_phrase)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *""",
        data.package_id, event_id, data.title.strip(), data.description, data.scorer,
        data.auto_kind if data.scorer == "auto" else None, data.stage_id, data.scale_max, data.weight, data.sort_order,
        (data.code_phrase.strip() if (data.code_phrase and data.scorer == "manual") else None))
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
    code_phrase: Optional[str] = None


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
        item = {"key": s["key"], "name": s["name"], "username": s.get("username"), "is_speaker": s["is_speaker"],
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
        # ЗАПРЕТ снимать жюри с участника, если оно уже поставило балл по критерию
        # этого этапа — иначе балл «осиротеет» (останется в scores, но без назначения).
        already = await db.fetchval(
            """SELECT 1
                 FROM tournament_scores ts
                 JOIN tournament_criteria cr ON cr.id = ts.criterion_id
                 JOIN tournament_packages p  ON p.id = cr.package_id
                WHERE ts.event_id=$1 AND ts.juror_ec_id=$2
                  AND ts.subject_kind=$3 AND ts.subject_id=$4
                  AND ($5::bigint IS NOT DISTINCT FROM p.stage_id)
                LIMIT 1""",
            event_id, data.juror_ec_id, kind, int(sid), data.stage_id)
        if already:
            raise HTTPException(status_code=409, detail="Это жюри уже выставило оценку этому участнику — снять с распределения нельзя. Сначала удалите его оценку.")
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
    stage_id: Optional[int] = None   # для пересчёта таблицы текущего этапа в ответе


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
    # Возвращаем пересчитанную таблицу — фронт обновит её без отдельного GET и мигания.
    board = await _compute(event_id, data.stage_id, db)
    return {"ok": True, "board": board}


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


# ════════════════════════ КОНТРОЛЬ ЗАДАНИЙ ════════════════════════

async def _chat_listen_status(event_id: int, db: asyncpg.Connection) -> list[dict]:
    """Статус «умею ли слушать» по каждой соцсети события.

    Умею если: у события задан chat_id этой площадки И у клиента есть бот/сообщество
    на ней (или системный для TG). Иначе — нет, со ссылкой-подсказкой на настройку.
    """
    import json as _json
    ev = await db.fetchrow(
        "SELECT tg_chat_id, vk_chat_id, max_chat_id, chat_listen_check FROM events WHERE id=$1", event_id)
    # Сохранённые результаты последней проверки (по платформам), чтобы статус
    # «прилипал» после перезагрузки страницы, а не сбрасывался в «не проверено».
    raw = ev["chat_listen_check"] if ev else None
    checks = raw if isinstance(raw, dict) else (_json.loads(raw) if raw else {})
    out = []
    for plat, label, cid in (
        ("telegram", "Telegram", ev["tg_chat_id"] if ev else None),
        ("vk", "ВКонтакте", ev["vk_chat_id"] if ev else None),
        ("max", "MAX", ev["max_chat_id"] if ev else None),
    ):
        has_chat = bool((cid or "").strip())
        chk = checks.get(plat) if isinstance(checks, dict) else None
        # Результат прошлой проверки актуален только если ID не менялся с тех пор.
        checked_ok = None
        checked_at = None
        checked_msg = None
        if chk and isinstance(chk, dict) and (chk.get("chat_id") or "") == (cid or ""):
            checked_ok = bool(chk.get("ok"))
            checked_at = chk.get("at")
            checked_msg = chk.get("message")
        out.append({
            "platform": plat,
            "label": label,
            # Зелёная галка — только если ПОСЛЕДНЯЯ проверка для текущего ID была ok.
            "ok": bool(checked_ok),
            "has_id": has_chat,
            "chat_id": cid or "",
            "checked": checked_ok is not None,   # проверяли ли вообще этот ID
            "checked_at": checked_at,
            "checked_message": checked_msg,
            "hint": (
                (checked_msg or f"Проверено: бот слушает {label}.") if checked_ok else
                (checked_msg or f"Проверка показала проблему — бот не слушает {label}.") if checked_ok is False else
                f"ID чата {label} задан. Нажмите «Проверить», чтобы убедиться, что бот реально его слушает."
                if has_chat else
                f"Не указан ID чата {label}. Добавьте бота в чат, напишите /chatid и впишите ID в настройках чатов события."
            ),
        })
    return out


@router.get("/task-control", summary="Контроль заданий: статус + список выкладок")
async def task_control(
    event_id: int,
    criterion_id: Optional[int] = None,
    subject: Optional[str] = None,          # 'ec:N' | 'ep:N' — фильтр по участнику
    recognized: Optional[str] = None,       # 'yes' | 'no' | None
    sort: str = "date_desc",                # date_desc | date_asc
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db),
):
    await _check_access(event_id, int(client["sub"]), db)
    enabled = await db.fetchval("SELECT task_listen_enabled FROM events WHERE id=$1", event_id)
    status = await _chat_listen_status(event_id, db)

    where = ["ts.event_id = $1"]
    params: list = [event_id]
    if criterion_id:
        params.append(criterion_id); where.append(f"ts.criterion_id = ${len(params)}")
    if subject and ":" in subject:
        sk, sid = subject.split(":", 1)
        if sk in ("ec", "ep") and sid.isdigit():
            params.append(sk); where.append(f"ts.subject_kind = ${len(params)}")
            params.append(int(sid)); where.append(f"ts.subject_id = ${len(params)}")
    if recognized == "yes":
        where.append("ts.recognized = TRUE")
    elif recognized == "no":
        where.append("ts.recognized = FALSE")
    order = "ts.sent_at DESC" if sort != "date_asc" else "ts.sent_at ASC"

    rows = await db.fetch(
        f"""
        SELECT ts.*, tc.title AS criterion_title,
               CASE ts.subject_kind
                 WHEN 'ec' THEN (SELECT c.name FROM event_collaborators ec
                                   JOIN collaborators c ON c.id=ec.speaker_id WHERE ec.id=ts.subject_id)
                 WHEN 'ep' THEN (SELECT c.name FROM event_participants ep
                                   JOIN contacts c ON c.id=ep.contact_id WHERE ep.id=ts.subject_id)
               END AS participant_name
          FROM task_submissions ts
          LEFT JOIN tournament_criteria tc ON tc.id = ts.criterion_id
         WHERE {' AND '.join(where)}
         ORDER BY {order}
         LIMIT 1000
        """,
        *params,
    )
    items = []
    for r in rows:
        d = dict(r)
        d["sent_at"] = d["sent_at"].isoformat() if d.get("sent_at") else None
        d["created_at"] = d["created_at"].isoformat() if d.get("created_at") else None
        items.append(d)
    return {"enabled": bool(enabled), "channels": status, "submissions": items}


class TaskListenToggle(BaseModel):
    enabled: bool


@router.patch("/task-control", summary="Контроль заданий: вкл/выкл слушание")
async def task_control_toggle(event_id: int, data: TaskListenToggle, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    await db.execute("UPDATE events SET task_listen_enabled=$2 WHERE id=$1", event_id, data.enabled)
    return {"ok": True, "enabled": data.enabled}


@router.post("/task-control/verify-chat", summary="Контроль заданий: реальная проверка, что бот слушает чат")
async def task_control_verify_chat(
    event_id: int,
    platform: str,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Проверяет НАСТОЯЩУЮ готовность слушания, а не просто «вписан ли ID».

    Telegram: перебираем всех TG-ботов клиента + системный @pluson_bot, для каждого
    getChatMember(chat_id, bot_id). Бот должен быть В чате (member/administrator) И,
    чтобы видеть обычные сообщения (хештеги), либо быть админом, либо иметь выключенный
    privacy mode. Программно privacy для НЕ-админа проверить нельзя, поэтому:
      • админ → читает всё всегда → ✓
      • просто участник → читает только если privacy off → ⚠ предупреждаем.
    VK/MAX: проверяем только что chat_id задан (их слушание устроено иначе).
    """
    import httpx
    await _check_access(event_id, int(client["sub"]), db)
    cid_client = int(client["sub"])

    col = {"telegram": "tg_chat_id", "vk": "vk_chat_id", "max": "max_chat_id"}.get(platform)
    if not col:
        raise HTTPException(status_code=422, detail="Неверная площадка")
    import json as _json
    from datetime import datetime, timezone

    chat_id = await db.fetchval(f"SELECT {col} FROM events WHERE id=$1", event_id)
    chat_id = (chat_id or "").strip()

    async def _save_and_return(result: dict):
        """Сохраняет результат проверки в events.chat_listen_check[platform],
        чтобы статус «прилипал» после перезагрузки страницы."""
        entry = {
            "ok": bool(result.get("ok")),
            "chat_id": chat_id,
            "at": datetime.now(timezone.utc).isoformat(),
            "message": result.get("message"),
        }
        await db.execute(
            "UPDATE events SET chat_listen_check = "
            "  COALESCE(chat_listen_check, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb) "
            "WHERE id = $1",
            event_id, platform, _json.dumps(entry, ensure_ascii=False),
        )
        return result

    if not chat_id:
        return await _save_and_return({"ok": False, "reason": "no_chat_id",
                "message": "ID чата не задан. Впишите его в настройках чатов события и сохраните."})

    if platform != "telegram":
        # VK/MAX: getChatMember недоступен. Не врём зелёной галкой — ok=False,
        # но честно поясняем что проверить членство нельзя.
        return await _save_and_return({"ok": False, "reason": "chat_id_set",
                "message": f"ID чата {chat_id} задан. Для {('ВКонтакте' if platform=='vk' else 'MAX')} автопроверка членства бота недоступна — убедитесь вручную, что сообщество добавлено в беседу администратором и приходят сообщения."})

    # все TG-боты клиента + системный
    bots = await db.fetch(
        """SELECT ch.handle, ch.bot_token, ch.is_system
             FROM client_channels cc JOIN channels ch ON ch.id=cc.channel_id
            WHERE cc.client_id=$1 AND ch.platform_slug='telegram'
              AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
            ORDER BY ch.is_system ASC""",
        cid_client,
    )
    sys_token = (settings.telegram_bot_token or "").strip()
    seen_tokens = {b["bot_token"] for b in bots}
    bot_list = [dict(b) for b in bots]
    if sys_token and sys_token not in seen_tokens:
        bot_list.append({"handle": "@pluson_bot", "bot_token": sys_token, "is_system": True})

    checked = []
    found_admin = None
    found_member = None
    async with httpx.AsyncClient(timeout=10) as http:
        for b in bot_list:
            token = b["bot_token"]
            bot_id = token.split(":", 1)[0]
            try:
                r = await http.get(
                    f"https://api.telegram.org/bot{token}/getChatMember",
                    params={"chat_id": chat_id, "user_id": bot_id})
                data = r.json()
            except Exception:
                continue
            if not data.get("ok"):
                checked.append({"handle": b["handle"], "status": "not_in_chat",
                                "error": data.get("description")})
                continue
            res = data.get("result", {})
            status = res.get("status")
            can_read = res.get("can_read_all_group_messages")
            checked.append({"handle": b["handle"], "status": status, "can_read": can_read})
            if status in ("administrator", "creator"):
                found_admin = found_admin or b["handle"]
            elif status in ("member", "restricted"):
                found_member = found_member or b["handle"]

    if found_admin:
        return await _save_and_return({"ok": True, "reason": "admin",
                "message": f"✅ Бот {found_admin} — администратор чата {chat_id}. Видит все сообщения, слушание работает.",
                "checked": checked})
    if found_member:
        return await _save_and_return({"ok": False, "reason": "member_not_admin",
                "message": (f"⚠️ Бот {found_member} в чате {chat_id}, но НЕ администратор. "
                            "Если у него включён privacy mode — он не увидит обычные сообщения с хештегами. "
                            "Сделайте бота администратором ИЛИ выключите Group Privacy в @BotFather и перезайдите в чат."),
                "checked": checked})
    return await _save_and_return({"ok": False, "reason": "bot_not_in_chat",
            "message": (f"❌ Ни один ваш бот не состоит в чате {chat_id}. "
                        "Добавьте бота в чат и сделайте администратором, затем проверьте снова."),
            "checked": checked})


class StageAudienceUpdate(BaseModel):
    # Множественный выбор: 'all' | 'registered' | 'speakers' | 'jury'. Пусто = не слушать.
    listen_audiences: List[str]


_AUDIENCE_VALUES = {"all", "registered", "speakers", "jury"}


@router.patch("/stages/{stage_id}/listen-audience", summary="Кого слушаем в этапе")
async def stage_listen_audience(event_id: int, stage_id: int, data: StageAudienceUpdate, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_access(event_id, int(client["sub"]), db)
    # нормализуем: уникальные валидные значения. Пустой набор = не слушать.
    auds = [a for a in dict.fromkeys(data.listen_audiences) if a in _AUDIENCE_VALUES]
    # ось «участники»: 'all' (зарег+незарег) и 'registered' (только зарег) — оставляем 'all'.
    if "all" in auds:
        auds = [a for a in auds if a != "registered"]
    await db.execute("UPDATE conf_stages SET listen_audiences=$3::text[] WHERE id=$1 AND event_id=$2",
                     stage_id, event_id, auds)
    return {"ok": True, "listen_audiences": auds}


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
