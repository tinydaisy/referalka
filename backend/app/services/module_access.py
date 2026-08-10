"""
Гейт платных модулей события: «смотреть можно, менять нельзя» (2026-08-10).

Зачем. Модули «Конференции» и «Премии/Турниры» покупаются отдельно. Когда
клиент не продлил модуль, раньше происходило худшее из возможного: раздел
молча пропадал из меню (и событие становилось ненаходимым — конференции
отфильтрованы из общего списка), а при этом ВСЁ продолжало работать — API
пускал и на чтение, и на запись, спикерские рассылки уходили участникам,
программа и спикеры рендерились на публичном лендинге. То есть клиент терял
доступ к своим данным и одновременно бесплатно пользовался платным модулем.

Правило теперь одно и простое:
  • ЧИТАТЬ своё — можно всегда. Данные клиента, он за них заплатил.
  • ПИСАТЬ (создавать, менять, удалять, отправлять) — только с подключённым
    модулем.
  • ПУБЛИЧНОЕ для участников — работает всегда: они не виноваты, что
    организатор не продлил, и отбирать у них программу прошедшего события
    неправильно.

⚠️ Гейт ставится по тому, КТО зовёт, а не по типу запроса:
  • роуты кабинета клиента (`Depends(get_current_client)`) — гейтим запись;
  • публичные роуты Mini App и участников — не гейтим ВООБЩЕ, даже если это
    POST (ввод кодового слова, билет розыгрыша, правка карточки спикером);
  • три GET-роута конференции реально ОТПРАВЛЯЮТ сообщения в Telegram
    (карточка спикера, расписание, подарки розыгрыша) — их гейтим, хотя они
    и выглядят как чтение.

⚠️ Кабинеты жюри и спикера гейтим ТОЛЬКО на запись. У них своя сессия без
client_id — клиента резолвим через событие. Текст сообщения для них общий
(BLOCKED_EXTERNAL_MSG): они не знают слова «модуль» и не понимают, что
случилось, поэтому объясняем и отправляем к организатору.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import HTTPException

from app.services.features import client_has_feature

logger = logging.getLogger(__name__)

# module_slug события → (slug фичи, название модуля для текста)
MODULE_FEATURE: dict[str, tuple[str, str]] = {
    "conference": ("conference", "Конференции"),
    "turnir":     ("tournaments", "Премии и Турниры"),
}

# ⚠️ Не путать: `turnir` — это module_slug СОБЫТИЯ, `tournaments` — slug ФИЧИ.
# Опечатка здесь не даст ошибки и молча отключит (или не отключит) гейт.

# Текст для внешних людей — жюри и спикеров. Одинаковый для всех: они не
# знают, из чего собран продукт, и слово «модуль» им ничего не говорит.
# Главное — снять страх «я всё заполнил, и оно пропало» и дать понятное
# действие вместо тупика.
BLOCKED_EXTERNAL_MSG = (
    "Пока нельзя сохранять изменения — у организатора приостановлена подписка "
    "на этот раздел. Ваши данные сохранены. Напишите организатору события, "
    "он всё восстановит."
)


def _owner_msg(module_title: str) -> str:
    """Текст для самого клиента — ему говорим прямо, что делать."""
    return (
        f"Модуль «{module_title}» не подключён. Данные события сохранены — "
        f"их видно. Чтобы вносить изменения, подключите модуль в разделе «Подписка»."
    )


async def module_write_allowed(db, *, client_id: int, module_slug: str | None) -> bool:
    """Можно ли клиенту МЕНЯТЬ данные этого модуля.

    True и для типов вне списка (обычное мероприятие, конкурс) — там своих
    платных модулей нет, ограничивать нечего.
    """
    entry = MODULE_FEATURE.get((module_slug or "").strip())
    if not entry:
        return True
    feature_slug, _ = entry
    return await client_has_feature(db, client_id, feature_slug)


async def assert_module_write(db, *, client_id: int, module_slug: str | None) -> None:
    """Разрешить запись или отказать с понятным текстом (для кабинета клиента)."""
    entry = MODULE_FEATURE.get((module_slug or "").strip())
    if not entry:
        return
    feature_slug, title = entry
    if await client_has_feature(db, client_id, feature_slug):
        return
    raise HTTPException(status_code=403, detail=_owner_msg(title))


async def assert_module_write_by_event(db, *, event_id: int) -> None:
    """То же, но клиент резолвится по событию — для кабинетов жюри и спикера.

    У них своя сессия (JWT кабинета) без client_id, поэтому владельца ищем
    через event_owners. Текст — общий BLOCKED_EXTERNAL_MSG.
    """
    row = await db.fetchrow(
        """
        SELECT e.module_slug,
               (SELECT eo.client_id FROM event_owners eo
                 WHERE eo.event_id = e.id AND eo.status = 'accepted'
                 ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id
          FROM events e WHERE e.id = $1
        """,
        event_id,
    )
    if not row or not row["client_id"]:
        return  # владельца не нашли — не запрещаем, иначе сломаем на пустом месте

    entry = MODULE_FEATURE.get((row["module_slug"] or "").strip())
    if not entry:
        return
    feature_slug, _ = entry
    if await client_has_feature(db, row["client_id"], feature_slug):
        return
    raise HTTPException(status_code=403, detail=BLOCKED_EXTERNAL_MSG)


async def module_write_allowed_by_event(db, *, event_id: int) -> bool:
    """Флаг для интерфейса кабинетов жюри и спикера — показать плашку заранее,
    не дожидаясь, пока человек нажмёт кнопку и упрётся в отказ."""
    row = await db.fetchrow(
        """
        SELECT e.module_slug,
               (SELECT eo.client_id FROM event_owners eo
                 WHERE eo.event_id = e.id AND eo.status = 'accepted'
                 ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id
          FROM events e WHERE e.id = $1
        """,
        event_id,
    )
    if not row or not row["client_id"]:
        return True
    return await module_write_allowed(
        db, client_id=row["client_id"], module_slug=row["module_slug"]
    )


# Типы рассылок, которые существуют только благодаря платному модулю:
# они про спикеров и дни программы. Уходить без оплаченного модуля не должны.
#
# ⚠️ Проверять НЕ ТОЛЬКО тип, но и module_slug события: `5min_before` и
# `day_live` доступны и обычным мероприятиям (см. TURNIR_EXTRA в broadcasts.py).
# Гейт только по типу сломал бы рассылки обычным событиям.
MODULE_BROADCAST_TYPES: frozenset[str] = frozenset({
    "5min_before", "speaker_intro", "gift", "day_end", "expert_day", "day_live",
})


async def broadcast_blocked_by_module(db, *, client_id: int, module_slug: str | None,
                                      broadcast_type: str | None) -> Optional[str]:
    """Причина, по которой рассылку нельзя отправлять. None — можно.

    Возвращает готовый текст для error_log, чтобы клиент в очереди понял,
    почему рассылка не ушла, а не гадал.
    """
    if (broadcast_type or "") not in MODULE_BROADCAST_TYPES:
        return None
    entry = MODULE_FEATURE.get((module_slug or "").strip())
    if not entry:
        return None
    feature_slug, title = entry
    if await client_has_feature(db, client_id, feature_slug):
        return None
    return (
        f"Не отправлено: модуль «{title}» не подключён. "
        f"Подключите модуль в разделе «Подписка» — и рассылку можно будет запустить снова."
    )
