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

# Подпись ссылки из бота. ⚠️ Без неё показать человеку ЕГО ПОЧТУ нельзя:
# номер контакта виден в адресе и подбирается перебором, то есть по чужому
# номеру утекли бы чужие данные. Токен доказывает, что ссылку выдал наш бот
# конкретному человеку — а он в боте уже опознан аккаунтом площадки.
_INVITE_AUD = "partner-invite"
_INVITE_TTL_DAYS = 30


def make_invite_token(client_id: int, contact_id: int) -> str:
    """Подпись «этому человеку ссылку выдал бот этого клиента»."""
    import jwt
    from datetime import datetime, timedelta, timezone
    from app.config import settings

    return jwt.encode(
        {
            "aud": _INVITE_AUD,
            "cl_id": int(client_id),
            "ct_id": int(contact_id),
            "exp": datetime.now(timezone.utc) + timedelta(days=_INVITE_TTL_DAYS),
        },
        settings.jwt_secret, algorithm="HS256",
    )


def invite_contact_id(token: Optional[str], client_id: int) -> Optional[int]:
    """contact_id из подписи, если она наша и для ЭТОГО кабинета. Иначе None.

    ⚠️ Мусорный или чужой токен = None, а не исключение: человек с битой
    ссылкой должен просто увидеть обычную форму, а не ошибку.
    """
    if not token:
        return None
    try:
        import jwt
        from app.config import settings

        data = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"],
                          audience=_INVITE_AUD)
        if int(data["cl_id"]) != int(client_id):
            return None
        return int(data["ct_id"])
    except Exception:  # noqa: BLE001
        return None


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
        # ⚠️ Кладём ПОДПИСЬ, а не голый номер: по ней страница покажет человеку
        # его настоящую почту («не помню, под какой регистрировалась»), и при
        # этом чужие данные по подобранному номеру не утекут.
        token = make_invite_token(client_id, contact_id)
        sep = '&' if '?' in url else '?'
        url = f"{url}{sep}c={contact_id}&t={token}"

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


async def build_cabinet_message(db, client_id: int,
                                contact_id: Optional[int] = None) -> dict:
    """Приглашение для того, кто УЖЕ партнёр: ведём в кабинет, а не по кругу."""
    from app.services.client_domains import client_public_link

    # ⚠️ Номер кабинета ОБЯЗАТЕЛЕН в ссылке. На общем домене `pluson.ru/my`
    # определить клиента нечем, и вход отвечал «Не удалось определить кабинет»
    # — человек упирался в тупик, не понимая, при чём тут кабинет.
    url = await client_public_link(db, client_id, f"/my?client_id={client_id}")
    if contact_id:
        # ⚠️ ТА ЖЕ ПОДПИСЬ, что у ссылки регистрации: в боте человек уже опознан
        # аккаунтом площадки, и заставлять его вспоминать почту незачем — он
        # впишет другую и не войдёт вовсе. Форма входа подставит её сама.
        token = make_invite_token(client_id, contact_id)
        url = f"{url}&c={contact_id}&t={token}"
    return {
        "text": ("<b>Вы уже партнёр</b>\n\n"
                 "Ваши ссылки, продажи и приведённые люди — в личном кабинете."),
        "url": url,
        "button": "ОТКРЫТЬ КАБИНЕТ",
    }
