"""Приглашение в партнёрскую программу через бота — метка `bpr_<client_id>`.

Зачем. Ссылка на веб-страницу `/become-partner/{id}` работает, но у клиента
аудитория чаще в мессенджерах: там человека не надо просить вводить почту —
он уже опознан площадкой, и его контакт у клиента обычно есть.

⚠️⚠️ ПРЕФИКС `bpr_`, а НЕ `prt_`/`prtc_`/`prtp_`. Те три заняты регистрацией
партнёров во ВНЕШНЕЙ системе клиента (GetCourse и подобные, миграция 105) —
это совсем другая механика, и пересечение увело бы человека не туда.

⚠️ Ветка разбора обязана быть в боте КАЖДОЙ площадки, где показываем ссылку.
Ссылка без разбора хуже её отсутствия: человек жмёт и попадает в общее
приветствие, не понимая, что произошло.

⚠️ Партнёром здесь СРАЗУ НЕ ДЕЛАЕМ. Вход осознанный (решение № 14): нужен
акцепт оферты и налоговый статус, а собирать это кнопками в мессенджере
нельзя — юридически значимое согласие должно быть на странице, где виден
текст. Бот показывает приглашение и ведёт на страницу.
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

PREFIX = "bpr_"


def parse_invite_payload(payload: str) -> Optional[int]:
    """`bpr_<client_id>` → client_id. Не наша метка → None."""
    if not payload or not payload.startswith(PREFIX):
        return None
    rest = payload[len(PREFIX):].split("_")[0]
    try:
        cid = int(rest)
    except (TypeError, ValueError):
        return None
    return cid if cid > 0 else None


async def build_invite_message(db, client_id: int, *,
                               contact_id: Optional[int] = None) -> Optional[dict]:
    """Текст приглашения + адрес кнопки. None — если партнёрки у клиента нет.

    ⚠️ Гейт по фиче здесь обязателен: метку могут прислать вручную, а звать в
    программу, которой у клиента нет, — значит обещать несуществующее.

    ⚠️ `contact_id` уезжает в адрес (`?c=`), чтобы страница узнала человека и
    не просила вводить почту заново. Именно ввод другой почты и рождает
    второй контакт, из-за которого потом теряются приведённые.
    """
    from app.services.features import client_has_feature
    from app.services.client_domains import client_public_link

    if not await client_has_feature(db, client_id, "partner_program"):
        return None

    row = await db.fetchrow(
        "SELECT COALESCE(NULLIF(brand_name, ''), name) AS brand FROM clients WHERE id = $1",
        client_id,
    )
    brand = (row["brand"] if row else "") or ""

    url = await client_public_link(db, client_id, f"/become-partner/{client_id}")
    if contact_id:
        url = f"{url}{'&' if '?' in url else '?'}c={contact_id}"

    text = (
        f"<b>Партнёрская программа{f' «{brand}»' if brand else ''}</b>\n\n"
        "Рекомендуйте события и продукты — и получайте вознаграждение с каждой "
        "покупки по вашей ссылке.\n\n"
        "Нажмите кнопку, чтобы посмотреть условия и присоединиться."
    )
    return {"text": text, "url": url, "button": "СТАТЬ ПАРТНЁРОМ"}


async def already_partner(db, client_id: int, contact_id: Optional[int]) -> bool:
    """Человек уже партнёр — тогда зовём не «стать», а «в кабинет»."""
    if not contact_id:
        return False
    return bool(await db.fetchval(
        "SELECT 1 FROM client_partners WHERE client_id = $1 AND contact_id = $2 "
        "AND is_active = TRUE",
        client_id, contact_id,
    ))


async def build_cabinet_message(db, client_id: int) -> dict:
    """Приглашение для того, кто УЖЕ партнёр: ведём в кабинет, а не по кругу."""
    from app.services.client_domains import client_public_link

    url = await client_public_link(db, client_id, "/my")
    return {
        "text": ("<b>Вы уже партнёр</b>\n\n"
                 "Ваши ссылки, продажи и приведённые люди — в личном кабинете."),
        "url": url,
        "button": "ОТКРЫТЬ КАБИНЕТ",
    }
