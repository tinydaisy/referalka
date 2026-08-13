"""
Уведомление человека о доступе к продукту (миграция 290).

Решение владельца: слать во ВСЕ каналы сразу — и в бот той площадки, где
человек есть, и на почту. Человек не должен гадать, куда пришёл его доступ.

⚠️ Ссылка на кабинет собирается через домен клиента (`client_public_link`),
а не литералом: иначе клиент, купивший свой домен, раздаёт наш адрес.

⚠️ Формулировки берутся из словаря продукта (`products.wording_preset`).
У консультационного пресета в письме не должно быть ни «урока», ни «обучения»,
ни «ученика» — одно такое слово в автоматическом письме сводит на нет
аккуратные формулировки на витрине.
"""
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Порядок обхода площадок: где нашли живую идентичность — туда и шлём.
_PLATFORM_ORDER = ("telegram", "max", "vk")


def wording(preset: Optional[str]) -> dict:
    """Как называть части продукта. Дефолт — консультационный (безопаснее)."""
    if preset == "education":
        return {"unit": "урок", "units": "уроки", "cabinet": "Обучение",
                "product": "курс"}
    return {"unit": "материал", "units": "материалы", "cabinet": "Мои материалы",
            "product": "продукт"}


async def _load(db, client_id: int, contact_id: int, product_id: int) -> Optional[dict]:
    row = await db.fetchrow(
        """SELECT p.id, p.title, p.slug, p.wording_preset,
                  c.name AS contact_name,
                  cl.name AS client_name, cl.brand_name,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    ORDER BY pe.id LIMIT 1) AS email
             FROM products p
             JOIN clients  cl ON cl.id = p.client_id
             JOIN contacts c  ON c.id = $2
            WHERE p.id = $3 AND p.client_id = $1""",
        client_id, contact_id, product_id,
    )
    return dict(row) if row else None


async def notify_product_access(db, *, client_id: int, contact_id: int,
                                product_id: int,
                                tariff_id: Optional[int] = None) -> dict:
    """Сообщить, что доступ открыт. Возвращает, куда получилось доставить.

    Ошибка доставки НЕ роняет выдачу доступа: доступ важнее уведомления.
    """
    info = await _load(db, client_id, contact_id, product_id)
    if not info:
        return {"bot": False, "email": False}

    from app.services.client_domains import client_public_link
    cabinet_url = await client_public_link(db, client_id, f"/my/{info['slug']}")
    W = wording(info["wording_preset"])
    brand = info["brand_name"] or info["client_name"]
    name = (info["contact_name"] or "").strip()

    html = (
        f"✅ <b>Доступ открыт</b>\n\n"
        f"«{info['title']}» — {W['units']} уже ждут вас:\n"
        f"{cabinet_url}\n\n"
        f"Ссылку можно сохранить: по ней вы всегда попадёте в «{W['cabinet']}»."
    )

    sent_bot = await _send_to_bot(db, client_id, contact_id, html)
    sent_mail = await _send_email(
        db, client_id, contact_id, info, cabinet_url, W, brand, name
    )
    return {"bot": sent_bot, "email": sent_mail}


async def send_cabinet_code(db, *, client_id: int, contact_id: int,
                            email: str, code: str) -> bool:
    """Одноразовый код входа в кабинет — письмом и в бот, если он есть.

    ⚠️ В бот шлём тоже: почта иногда идёт минутами и попадает в спам, а
    человек стоит перед формой входа и ждёт. Если бот есть — код придёт мгновенно.
    """
    brand_row = await db.fetchrow(
        "SELECT name, brand_name FROM clients WHERE id = $1", client_id)
    brand = (brand_row["brand_name"] or brand_row["name"]) if brand_row else "ПЛЮСОН"

    await _send_to_bot(
        db, client_id, contact_id,
        f"🔑 Код для входа: <b>{code}</b>\n\nОн действует 15 минут.",
    )

    channel = await _email_channel(db, client_id)
    if not channel:
        return False
    try:
        from app.services.email_sender import EmailSender
        from app.services.unsubscribe_token import make_email_unsubscribe_token
        from app.services.client_domains import client_mail_domain, client_public_url

        channel_dict = dict(channel)
        mail = await client_mail_domain(db, client_id)
        if mail:
            channel_dict["email_domain"] = mail["domain"]
            channel_dict["email_from_local"] = mail["local"]
            if mail["from_name"]:
                channel_dict["email_from_name"] = mail["from_name"]

        EmailSender().send(
            channel=channel_dict,
            client_brand_name=brand,
            to_email=email,
            subject=f"Код для входа: {code}",
            body_text=(f"Ваш код для входа: {code}\n\n"
                       f"Он действует 15 минут.\n\n"
                       f"Если вы не запрашивали код — просто не отвечайте на письмо.\n\n"
                       f"{brand}"),
            unsubscribe_token=make_email_unsubscribe_token(
                client_id=client_id, contact_id=contact_id,
                client_channel_id=channel["client_channel_id"],
            ),
            public_base_url=await client_public_url(db, client_id),
        )
        return True
    except Exception as e:
        logger.warning("Код входа в кабинет не отправлен: %s", e)
        return False


async def _email_channel(db, client_id: int):
    """Активный email-канал клиента. None → письмо слать нечем."""
    return await db.fetchrow(
        """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                  ch.email_subdomain, ch.email_from_local, ch.email_from_name
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND cc.is_active = TRUE
              AND ch.platform_slug = 'email'
            LIMIT 1""",
        client_id,
    )


async def _send_to_bot(db, client_id: int, contact_id: int, html: str) -> bool:
    """Сообщение в бот той площадки, где у человека есть живая идентичность.

    ⚠️ Псевдо-записи `@ник` пропускаем: боту нужен числовой id, по нику он
    написать не может (правило проекта — идентичность дорастает при первом
    заходе человека в бота).
    """
    plain = html.replace("<b>", "").replace("</b>", "")

    for p in _PLATFORM_ORDER:
        ident = await db.fetchval(
            """SELECT platform_user_id FROM platform_users
                WHERE contact_id = $1 AND platform_slug = $2
                  AND platform_user_id !~ '^@' LIMIT 1""",
            contact_id, p,
        )
        if not ident:
            continue
        try:
            if p == "telegram":
                import httpx
                from app.services.channels import get_client_telegram_token
                from app.services.message_builder import send_telegram_message
                token = await get_client_telegram_token(client_id, db)
                if not token:
                    continue
                async with httpx.AsyncClient(timeout=30) as http:
                    await send_telegram_message(http, token, str(ident), html)
                return True
            if p == "max":
                from app.services.channels import get_client_max_token
                from app.services.max_api import send_message as max_send
                token = await get_client_max_token(client_id, db)
                if not token:
                    continue
                await max_send(int(ident), plain, token=token, recipient_kind="user")
                return True
            if p == "vk":
                from app.services.funnel_service import _vk_token_for_client
                from app.services.vk_api import send_message as vk_send
                token = await _vk_token_for_client(client_id, db)
                if not token:
                    continue
                await vk_send(int(ident), plain, token=token)
                return True
        except Exception:
            logger.exception("Доступ к продукту: отправка в %s не удалась", p)
            continue
    return False


async def _send_email(db, client_id: int, contact_id: int, info: dict,
                      cabinet_url: str, W: dict, brand: str, name: str) -> bool:
    """Письмо о доступе.

    ⚠️ Это ТРАНЗАКЦИОННОЕ письмо (подтверждение действия самого человека),
    поэтому уходит и тем, кто отписан от рассылок. Не шлём только на мёртвые
    адреса — там письмо всё равно не дойдёт.
    """
    if not info["email"]:
        return False

    is_dead = await db.fetchval(
        """SELECT pu.email_is_dead FROM platform_users pu
            WHERE pu.contact_id = $1 AND pu.platform_slug = 'email' LIMIT 1""",
        contact_id,
    )
    if is_dead:
        return False

    channel = await _email_channel(db, client_id)
    if not channel:
        return False

    try:
        from app.services.email_sender import EmailSender
        from app.services.unsubscribe_token import make_email_unsubscribe_token
        from app.services.client_domains import client_mail_domain, client_public_url

        channel_dict = dict(channel)
        # Свой почтовый домен клиента (миграция 270): письмо от него, отписка
        # на тот же домен. Не подключён — всё как раньше.
        mail = await client_mail_domain(db, client_id)
        if mail:
            channel_dict["email_domain"] = mail["domain"]
            channel_dict["email_from_local"] = mail["local"]
            if mail["from_name"]:
                channel_dict["email_from_name"] = mail["from_name"]

        body = (
            f"{'Здравствуйте, ' + name + '!' if name else 'Здравствуйте!'}\n\n"
            f"Доступ к «{info['title']}» открыт.\n\n"
            f"{W['units'].capitalize()} здесь:\n{cabinet_url}\n\n"
            f"Ссылку можно сохранить — по ней вы всегда попадёте "
            f"в «{W['cabinet']}».\n\n"
            f"{brand}"
        )

        EmailSender().send(
            channel=channel_dict,
            client_brand_name=brand,
            to_email=info["email"],
            subject=f"Доступ к «{info['title']}» открыт",
            body_text=body,
            unsubscribe_token=make_email_unsubscribe_token(
                client_id=client_id,
                contact_id=contact_id,
                client_channel_id=channel["client_channel_id"],
            ),
            public_base_url=await client_public_url(db, client_id),
        )
        return True
    except Exception as e:
        logger.warning("Письмо о доступе к продукту %s не ушло: %s", info["id"], e)
        return False
