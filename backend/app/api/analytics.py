"""
API аналитики по UTM-меткам.

Два источника UTM в системе:
1. `funnel_runs.utm` (JSONB) — полный набор меток на каждый заход по лид-магниту.
   Тут есть воронка: зашёл в бот (started) → получил файл (delivered).
2. `contacts.utm_source` — одна метка «откуда контакт вообще появился в базе».
   Тут воронки нет, только распределение всей базы по источникам.

Метрики намеренно НЕ показывают стадию `landed` (клик по ссылке) — начинаем
сразу с «Зашло в бот» (`started`), потому что до бота человек мог не дойти.
"""
from fastapi import APIRouter, Depends, Query
from app.auth import get_current_client
from app.database import get_db

router = APIRouter(prefix="/analytics", tags=["Аналитика"])

# Ключи UTM, по которым можно группировать funnel-сводку.
_UTM_KEYS = {"utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"}


@router.get("/utm", summary="Сводка по UTM: воронка лид-магнитов + база контактов")
async def utm_summary(
    group_by: str = Query(
        default="utm_source",
        description="По какой метке группировать воронку: utm_source|utm_medium|utm_campaign|utm_content|utm_term",
    ),
    lead_magnet_id: int | None = Query(default=None, description="Фильтр по одному лид-магниту"),
    package_id: int | None = Query(default=None, description="Фильтр по одному пакету"),
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """
    Возвращает:
    - `funnel[]` — по каждому значению выбранной UTM-метки: сколько людей зашло
      в бот (`started`, distinct contact_id), сколько получили файл (`delivered`)
      и конверсия. Источник — `funnel_runs`.
    - `contacts_by_source[]` — распределение ВСЕЙ базы контактов по `contacts.utm_source`.
    - `totals` — суммарные цифры воронки.
    - `lead_magnets[]` / `packages[]` — списки для селектора фильтра.
    """
    client_id = int(client["sub"])

    key = group_by if group_by in _UTM_KEYS else "utm_source"

    # ── Воронка по лид-магнитам, сгруппированная по значению UTM-метки ──
    # started  = distinct contact_id на стадии started/subscribed/delivered
    # delivered = distinct contact_id на стадии delivered
    # Забеги без contact_id (анонимные) в distinct-подсчёт не попадают, поэтому
    # started берём как «дошедшие до бота с известным контактом».
    filt = "WHERE fr.client_id = $1"
    params: list = [client_id]
    if lead_magnet_id is not None:
        params.append(lead_magnet_id)
        filt += f" AND fr.lead_magnet_id = ${len(params)}"
    if package_id is not None:
        params.append(package_id)
        filt += f" AND fr.package_id = ${len(params)}"

    funnel_rows = await db.fetch(
        f"""
        SELECT
            COALESCE(NULLIF(fr.utm->>'{key}', ''), '(без метки)') AS source,
            COUNT(DISTINCT fr.contact_id)
                FILTER (WHERE fr.stage IN ('started','subscribed','delivered')
                        AND fr.contact_id IS NOT NULL)                         AS started,
            COUNT(DISTINCT fr.contact_id)
                FILTER (WHERE fr.stage = 'delivered'
                        AND fr.contact_id IS NOT NULL)                         AS delivered,
            COUNT(*) FILTER (WHERE fr.stage IN ('started','subscribed','delivered')) AS started_runs
        FROM funnel_runs fr
        {filt}
        GROUP BY source
        ORDER BY started DESC, source
        """,
        *params,
    )

    funnel = []
    tot_started = tot_delivered = 0
    for r in funnel_rows:
        started = r["started"] or 0
        delivered = r["delivered"] or 0
        tot_started += started
        tot_delivered += delivered
        funnel.append({
            "source": r["source"],
            "started": started,          # зашло в бот
            "delivered": delivered,      # получили файл
            "conversion": round(delivered / started * 100) if started else 0,
        })

    # ── Распределение всей базы контактов по utm_source ──
    contacts_rows = await db.fetch(
        """
        SELECT COALESCE(NULLIF(utm_source, ''), '(без метки)') AS source,
               COUNT(*) AS cnt
        FROM contacts
        WHERE client_id = $1 AND is_active = TRUE
        GROUP BY source
        ORDER BY cnt DESC, source
        """,
        client_id,
    )
    contacts_total = sum(r["cnt"] for r in contacts_rows)
    contacts_by_source = [
        {
            "source": r["source"],
            "count": r["cnt"],
            "share": round(r["cnt"] / contacts_total * 100) if contacts_total else 0,
        }
        for r in contacts_rows
    ]

    # ── Списки для селектора фильтра ──
    lm_rows = await db.fetch(
        "SELECT id, name FROM lead_magnets WHERE client_id = $1 ORDER BY name",
        client_id,
    )
    pkg_rows = await db.fetch(
        "SELECT id, name FROM lead_magnet_packages WHERE client_id = $1 ORDER BY name",
        client_id,
    )

    return {
        "group_by": key,
        "funnel": funnel,
        "totals": {
            "started": tot_started,
            "delivered": tot_delivered,
            "conversion": round(tot_delivered / tot_started * 100) if tot_started else 0,
        },
        "contacts_by_source": contacts_by_source,
        "contacts_total": contacts_total,
        "lead_magnets": [{"id": r["id"], "name": r["name"]} for r in lm_rows],
        "packages": [{"id": r["id"], "name": r["name"]} for r in pkg_rows],
    }


@router.get("/platforms", summary="Медийные активы: подписано / всего по площадкам")
async def platforms_summary(client=Depends(get_current_client), db=Depends(get_db)):
    """Размер базы клиента ПО ПЛОЩАДКАМ: сколько людей подписано и сколько всего.

    ⚠️ Общее число контактов («5800») ничего не говорит: за ним и почта, и три
    бота, причём один человек часто есть сразу в нескольких — сумма по площадкам
    БОЛЬШЕ общего числа, и это не ошибка. Партнёру и самому клиенту нужна
    разбивка: где база живая, а где половина отписалась.

    «Подписан» = у идентичности нет ни одной отписки. Отписавшиеся показаны
    отдельно, а не выброшены: разрыв между «всего» и «подписано» — это и есть
    та цифра, ради которой блок делается.
    """
    client_id = int(client["sub"])
    rows = await db.fetch(
        """
        SELECT pu.platform_slug AS slug,
               count(DISTINCT pu.contact_id) AS total,
               count(DISTINCT pu.contact_id) FILTER (
                   WHERE NOT EXISTS (SELECT 1 FROM platform_user_channels puc
                                      WHERE puc.platform_user_id = pu.id
                                        AND puc.is_unsubscribed)
               ) AS subscribed
          FROM platform_users pu
          JOIN contacts c_own ON c_own.id = pu.contact_id
         WHERE c_own.client_id = $1
         GROUP BY pu.platform_slug
         ORDER BY total DESC
        """,
        client_id,
    )
    titles = {"telegram": "Telegram-боты", "email": "Емейлы", "max": "МАКС-боты", "vk": "ВК-боты"}
    # Людей считаем БЕЗ повторов: один человек с почтой и телеграмом — один контакт.
    unique_total = await db.fetchval(
        "SELECT count(DISTINCT pu.contact_id) FROM platform_users pu "
        "JOIN contacts c_own ON c_own.id = pu.contact_id WHERE c_own.client_id=$1", client_id) or 0
    # ⚠️ Подписчики КАНАЛОВ считаются отдельной строкой рядом с ботами: у
    # канала подписчиков обычно больше, чем у бота, и без них картина неполная.
    # Цифру отдают сами площадки (бот в канале админ) — подделать нельзя.
    from app.services.channel_audience import channel_audience
    social = await db.fetchval("SELECT social_links FROM clients WHERE id=$1", client_id)
    import json as _json
    if isinstance(social, str):
        try: social = _json.loads(social)
        except Exception: social = {}
    ch = await channel_audience(db, client_id, social or {})
    ch_titles = {"plusson_tg_ch": "Telegram-каналы",
                 "plusson_max_ch": "МАКС-каналы",
                 "plusson_vk_ch": "ВК-сообщества"}
    channel_rows = [
        {"slug": k, "title": t, "total": ch.get(k, 0), "subscribed": ch.get(k, 0), "unsubscribed": 0}
        for k, t in ch_titles.items() if ch.get(k, 0) > 0
    ]

    platforms = channel_rows + [
        {
            "slug": r["slug"],
            "title": titles.get(r["slug"], r["slug"]),
            "total": r["total"],
            "subscribed": r["subscribed"],
            "unsubscribed": r["total"] - r["subscribed"],
        }
        for r in rows
    ]
    # По убыванию: сверху то, где аудитории больше — иначе каналы всегда
    # оказывались первыми просто потому, что добавлены раньше.
    platforms.sort(key=lambda p: -p["subscribed"])

    # ⚠️ Свод ПО ПЛОЩАДКАМ — то, что нужно в первую очередь: «сколько у меня
    # в Telegram» это бот + канал вместе. Раздельные строки заставляют
    # складывать в уме. Детализация остаётся ниже, в `platforms`.
    GROUPS = [
        ("Telegram",  ("telegram", "plusson_tg_ch")),
        ("MAX",       ("max", "plusson_max_ch")),
        ("ВКонтакте", ("vk", "plusson_vk_ch")),
        ("Email",     ("email",)),
    ]
    by_slug = {p["slug"]: p for p in platforms}
    groups = []
    for title, slugs in GROUPS:
        n = sum(by_slug.get(sl, {}).get("subscribed", 0) for sl in slugs)
        if n > 0:
            groups.append({
                "title": title,
                "subscribed": n,
                # Из чего сложилось — чтобы цифра не была «чёрным ящиком».
                "parts": [{"title": by_slug[sl]["title"], "subscribed": by_slug[sl]["subscribed"]}
                          for sl in slugs if by_slug.get(sl, {}).get("subscribed", 0) > 0],
            })
    groups.sort(key=lambda g: -g["subscribed"])

    return {"groups": groups, "platforms": platforms, "unique_total": unique_total}
