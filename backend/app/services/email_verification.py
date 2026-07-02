"""
Подтверждение email клиента.

При регистрации и по запросу «отправить письмо заново» клиенту уходит
письмо со ссылкой https://pluson.ru/verify-email?token=... От имени
«iViSiON: ПЛЮСОН». В письме — просьба подтвердить email и отметить письмо
как «не спам».

Токен: 32 байта urlsafe, в БД хранится sha256-хеш, живёт 7 дней.
"""
import hashlib
import logging
import secrets
from datetime import datetime, timedelta

import asyncpg

logger = logging.getLogger(__name__)

TOKEN_TTL_DAYS = 7


async def create_verify_token(db: asyncpg.Connection, client_id: int) -> str:
    """Генерирует новый токен подтверждения, пишет хеш в БД, возвращает сырой токен."""
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    expires_at = datetime.utcnow() + timedelta(days=TOKEN_TTL_DAYS)
    await db.execute(
        """INSERT INTO email_verify_tokens (client_id, token_hash, expires_at)
           VALUES ($1, $2, $3)""",
        client_id, token_hash, expires_at,
    )
    return token


async def send_verification_email(db: asyncpg.Connection, client_id: int) -> bool:
    """
    Отправляет клиенту письмо с подтверждением email.
    Возвращает True если письмо ушло, False если пропущено (нет email-канала,
    email уже подтверждён, SMTP-ошибка). Никогда не бросает исключение —
    вызывающему коду (регистрация) падать нельзя.
    """
    try:
        client = await db.fetchrow(
            "SELECT id, email, name, brand_name, email_verified FROM clients WHERE id = $1",
            client_id,
        )
        if not client or not client["email"]:
            return False
        if client["email_verified"]:
            return False

        # Системный email-канал ПЛЮСОНа для этого клиента
        ch = await db.fetchrow(
            """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                      ch.email_subdomain, ch.email_from_local
                 FROM client_channels cc
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE cc.client_id = $1
                  AND ch.platform_slug = 'email'
                  AND ch.is_system = TRUE
                LIMIT 1""",
            client_id,
        )
        if not ch:
            return False

        token = await create_verify_token(db, client_id)

        from app.config import settings as _s
        from app.services.email_sender import EmailSender
        from app.services.unsubscribe_token import make_email_unsubscribe_token

        verify_url = f"{_s.frontend_url.rstrip('/')}/verify-email?token={token}"
        channel_dict = dict(ch)
        channel_dict["email_from_name"] = "iViSiON: ПЛЮСОН"

        fake_unsub = make_email_unsubscribe_token(
            client_id=client_id, contact_id=0,
            client_channel_id=ch["client_channel_id"],
        )

        name = (client["name"] or "").strip()
        greeting = f"Здравствуйте, {name}!" if name else "Здравствуйте!"

        body_text = (
            f"{greeting}\n\n"
            f"Вы зарегистрировались в iViSiON: ПЛЮСОН — платформе для организаторов и экспертов.\n\n"
            f"Пожалуйста, подтвердите свой email — просто перейдите по ссылке:\n"
            f"{verify_url}\n\n"
            f"Ссылка действует 7 дней.\n\n"
            f"Важно: чтобы наши письма (ссылки для входа, восстановление пароля, "
            f"уведомления) не попадали в «Спам» — отметьте это письмо как «Не спам» "
            f"и, если можно, добавьте наш адрес в контакты.\n\n"
            f"Если вы не регистрировались в ПЛЮСОНе — просто проигнорируйте это письмо.\n\n"
            f"— Команда iViSiON: ПЛЮСОН"
        )

        sender = EmailSender()
        sender.send(
            channel=channel_dict,
            client_brand_name="iViSiON: ПЛЮСОН",
            to_email=client["email"],
            subject="Подтвердите email — iViSiON: ПЛЮСОН",
            body_text=body_text,
            unsubscribe_token=fake_unsub,
        )
        return True
    except Exception as e:
        logger.warning(f"send_verification_email failed for client {client_id}: {e!r}")
        return False


async def confirm_verify_token(db: asyncpg.Connection, token: str) -> bool:
    """
    Проверяет токен, помечает email клиента подтверждённым.
    Возвращает True при успехе, False если токен недействителен/устарел/использован.
    """
    token_hash = hashlib.sha256((token or "").encode()).hexdigest()
    row = await db.fetchrow(
        """SELECT id, client_id FROM email_verify_tokens
            WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
            LIMIT 1""",
        token_hash,
    )
    if not row:
        return False

    async with db.transaction():
        await db.execute(
            "UPDATE clients SET email_verified = TRUE, email_verified_at = NOW() WHERE id = $1",
            row["client_id"],
        )
        await db.execute(
            "UPDATE email_verify_tokens SET used_at = NOW() WHERE id = $1",
            row["id"],
        )
    return True
