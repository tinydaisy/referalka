"""
Согласия человека — ОДНА точка записи.

⚠️ До 10.09.2026 формы заказа (события и продукта) принимали `consent_marketing`
и НИКУДА его не писали: человек ставил галочку, а согласие терялось. Писала
согласия только публичная анкета — своим кодом. Отсюда общая функция: точек
сбора уже три, и каждая своя копия неминуемо разъедется.

⚠️⚠️ ОДНА ГАЛОЧКА — ДВА СОГЛАСИЯ (решение владельца 10.09.2026). В форме
написано «согласен на рассылки и звонки», значит и в базе должно проставиться
оба: `contacts.consent_marketing_at` (письма и сообщения) и снятая отписка от
звонков `contacts.calls_unsubscribed_at`. Записать только первое — обещать
человеку одно, а хранить другое; для звонков по 38-ФЗ нужно согласие именно
на звонки.

⚠️ Отказаться человек вправе ОТДЕЛЬНО: отписался от писем — звонки остаются,
и наоборот (см. раздел про автообзвоны в CLAUDE.md). Здесь только выдача
согласия, отписки живут своими механизмами.
"""
import logging
from typing import Optional

import asyncpg

logger = logging.getLogger(__name__)


async def save_consents(
    db: asyncpg.Connection,
    *,
    contact_id: Optional[int],
    consent_pd: bool = False,
    consent_marketing: bool = False,
    ip: Optional[str] = None,
    policy_version: Optional[int] = None,
) -> None:
    """Записать согласия контакту.

    ⚠️ `COALESCE(..., NOW())` — согласие фиксируется ОДИН раз, первой датой.
    Перезаписывать её нельзя: это доказательство, когда человек согласился, и
    при споре важна первая отметка, а не последняя.

    ⚠️ Не бросает исключений: сбой записи согласия не должен ронять заказ —
    деньги важнее, а согласие видно в логах и восстановимо.
    """
    if not contact_id:
        return

    ip = (ip or "")[:64] or None

    try:
        if consent_pd:
            await db.execute(
                """UPDATE contacts
                      SET consent_pd_at  = COALESCE(consent_pd_at, NOW()),
                          consent_pd_ip  = COALESCE(consent_pd_ip, $2),
                          consent_pd_policy_ver =
                              COALESCE(consent_pd_policy_ver, $3)
                    WHERE id = $1""",
                contact_id, ip, policy_version)

        if consent_marketing:
            # ⚠️ Обе половины ОДНОЙ галочки: письма/сообщения И звонки.
            # `calls_unsubscribed_at = NULL` — снятие отписки от звонков:
            # человек согласился, значит звонить можно (миграция 359).
            await db.execute(
                """UPDATE contacts
                      SET consent_marketing_at = COALESCE(consent_marketing_at, NOW()),
                          consent_marketing_ip = COALESCE(consent_marketing_ip, $2),
                          consent_marketing_policy_ver =
                              COALESCE(consent_marketing_policy_ver, $3),
                          calls_unsubscribed_at = NULL
                    WHERE id = $1""",
                contact_id, ip, policy_version)
    except Exception as e:  # noqa: BLE001
        logger.warning("Согласия контакта %s не записаны: %s", contact_id, e)


def client_ip(request) -> Optional[str]:
    """IP человека для отметки согласия.

    ⚠️ За nginx `request.client.host` — это сам сервер, поэтому сначала
    смотрим `X-Forwarded-For` (там первый адрес — настоящий клиент).
    """
    try:
        fwd = request.headers.get("x-forwarded-for") or ""
        if fwd:
            return fwd.split(",")[0].strip()
        return request.client.host if request.client else None
    except Exception:  # noqa: BLE001
        return None
