"""
CRM лид-магнита: люди по этапам воронки, колонками.

Раньше клик по цифрам вёл в «Контакты» с фильтром — человек уходил со
страницы лид-магнитов и терял контекст, а увидеть все этапы разом было
нельзя. Теперь этапы стоят рядом колонками, и видно, где люди отваливаются.

⚠️ Колонок ДВЕ или ТРИ — зависит от того, стоит ли перед подарком анкета:

    без анкеты   перешли → подписались и получили подарок
    с анкетой    перешли → подписались и получили анкету → заполнили и получили

Общий модуль на магниты и пакеты: логика у них одинаковая, отличается
только колонка связи (`lead_magnet_id` либо `package_id`). Две копии
неминуемо разъехались бы — они уже разъехались в подсчёте цифр.
"""

from __future__ import annotations

import asyncpg


# Этапы забега, на которых человек уже «зашёл по ссылке».
_REACHED = ("landed", "started", "subscribed", "delivered")


async def lead_magnet_crm(
    db: asyncpg.Connection, *, client_id: int,
    lead_magnet_id: int | None = None, package_id: int | None = None,
) -> dict:
    """Колонки с людьми по этапам воронки одного лид-магнита или пакета."""
    if lead_magnet_id:
        owner_sql = "SELECT name, require_survey_id FROM lead_magnets WHERE id=$1 AND client_id=$2"
        link_col = "fr.lead_magnet_id"
        ref_id = lead_magnet_id
    else:
        owner_sql = ("SELECT name, require_survey_id FROM lead_magnet_packages "
                     "WHERE id=$1 AND client_id=$2")
        link_col = "fr.package_id"
        ref_id = package_id

    owner = await db.fetchrow(owner_sql, ref_id, client_id)
    if not owner:
        return {}

    survey_id = owner["require_survey_id"]

    # ⚠️ Параметры нумеруем ПОДРЯД: без анкеты запрос короче на один, и
    # фиксированные номера оставляли бы дыру ($3 не используется) — asyncpg
    # тогда падает «could not determine data type of parameter $3».
    params: list = [ref_id, client_id, list(_REACHED)]
    if survey_id:
        params.append(survey_id)
        survey_expr = ("EXISTS (SELECT 1 FROM survey_responses sr "
                       "WHERE sr.contact_id = c.id AND sr.survey_id = $4)")
    else:
        survey_expr = "FALSE"

    # ⚠️ Люди, а не забеги: у человека может быть несколько заходов по одной
    # ссылке, и в списке он должен быть один раз. Цифра на плитке в списке
    # лид-магнитов считается так же (`known`), поэтому они сойдутся.
    rows = await db.fetch(
        f"""SELECT DISTINCT ON (c.id)
                   c.id, c.name,
                   fr.stage,
                   (SELECT COALESCE(pu.username, pu.platform_user_id)
                      FROM platform_users pu
                     WHERE pu.contact_id = c.id AND pu.platform_slug='telegram'
                     LIMIT 1) AS telegram,
                   (SELECT COALESCE(pu.username, pu.platform_user_id)
                      FROM platform_users pu
                     WHERE pu.contact_id = c.id AND pu.platform_slug='vk'
                     LIMIT 1) AS vk,
                   (SELECT COALESCE(pu.username, pu.platform_user_id)
                      FROM platform_users pu
                     WHERE pu.contact_id = c.id AND pu.platform_slug='max'
                     LIMIT 1) AS max_nick,
                   {survey_expr} AS filled_survey
              FROM funnel_runs fr
              JOIN contacts c ON c.id = fr.contact_id
                             AND c.is_active = TRUE AND c.client_id = $2
             WHERE {link_col} = $1 AND fr.stage = ANY($3::text[])
             ORDER BY c.id,
                      -- самый дальний этап человека: если он в одном забеге
                      -- дошёл до конца, а в другом бросил — считаем дошедшим
                      CASE fr.stage WHEN 'delivered' THEN 0 WHEN 'subscribed' THEN 1
                                    WHEN 'started' THEN 2 ELSE 3 END""",
        *params,
    )

    people = [dict(r) for r in rows]
    reached = people
    delivered = [p for p in people if p["stage"] == "delivered"]
    total = len(reached)

    def pct(n: int) -> float:
        return round(n * 100.0 / total, 1) if total else 0.0

    def strip(items: list[dict]) -> list[dict]:
        return [{k: v for k, v in p.items() if k not in ("stage", "filled_survey")}
                for p in items]

    if not survey_id:
        columns = [
            {"key": "reached", "title": "Перешли на лид-магнит",
             "count": total, "percent": pct(total), "people": strip(reached)},
            {"key": "delivered", "title": "Подписались и получили лид-магнит",
             "count": len(delivered), "percent": pct(len(delivered)),
             "people": strip(delivered)},
        ]
    else:
        # С анкетой: подарок отдаётся только после её заполнения, поэтому
        # средняя колонка — «дошли до анкеты», последняя — «заполнили».
        filled = [p for p in people if p["filled_survey"]]
        got_survey = [p for p in people
                      if p["stage"] in ("subscribed", "delivered") or p["filled_survey"]]
        columns = [
            {"key": "reached", "title": "Перешли на лид-магнит",
             "count": total, "percent": pct(total), "people": strip(reached)},
            {"key": "survey", "title": "Подписались и получили анкету",
             "count": len(got_survey), "percent": pct(len(got_survey)),
             "people": strip(got_survey)},
            {"key": "filled", "title": "Заполнили анкету и получили лид-магнит",
             "count": len(filled), "percent": pct(len(filled)),
             "people": strip(filled)},
        ]

    return {"title": owner["name"], "has_survey": bool(survey_id),
            "total": total, "columns": columns}
