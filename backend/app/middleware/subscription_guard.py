"""
Заморозка кабинета: без действующей подписки любая запись (POST/PATCH/PUT/DELETE)
отдаёт 403. Смотреть кабинет можно всегда — GET не трогаем.

⚠️⚠️ ПУТИ СРАВНИВАЮТСЯ РОВНО, А НЕ «НАЧИНАЕТСЯ НА» (исправлено 2026-08-22).
Раньше список был из префиксов, и это тихо открывало лишнее:

  «/api/v1/event»    — писалось ради ОДНОЙ кнопки участника в Mini App,
                       а открывало ВЕСЬ раздел «/api/v1/events…»: создание и
                       правку событий, подарки, тарифы, розыгрыш, лендинг,
                       программу турнира, воронки догрева. То есть клиент с
                       истёкшей подпиской мог заводить события и продавать
                       на них тарифы.
  «/api/v1/referral» — открывало всю реферальную программу событий,
                       а нужен был только вебхук конверсий.

Поэтому: для участников и вебхуков — ТОЧНЫЕ адреса, а разделы, которые
открываются целиком (Mini App, публичные страницы), остаются префиксами
и перечислены явно.

⚠️ Коллабораторная работает и при замороженном кабинете — намеренно: человек
должен продолжать общаться с партнёрами и иметь путь обратно к оплате. Но
только у того, у кого модуль ОПЛАЧЕН (`collab_hub`), а не у всех подряд.
"""
import re

from fastapi import Request
from fastapi.responses import JSONResponse
from jose import JWTError, jwt
from app.config import settings


SAFE_METHODS = {"GET", "OPTIONS", "HEAD"}

# Разделы, которые открываются целиком: вход, админка, публичные страницы,
# приём данных снаружи, площадочные вебхуки. Тут префикс — по смыслу.
PASSTHROUGH_PREFIXES = (
    "/api/v1/auth/",
    "/api/v1/admin/",
    "/api/v1/public/",
    "/api/v1/integrations/",
    # ⚠️⚠️ ПОДПИСКА И ПАРТНЁРКА ОТКРЫТЫ ВСЕГДА (2026-08-26).
    # Заморозка блокировала «/api/v1/subscriptions/order» — то есть, чтобы
    # продлить подписку, требовалась действующая подписка. Клиент нажимал
    # «Оплатить картой» и получал «Подписка истекла. Продлите тариф».
    # Оплатить не мог никто: на момент находки 80 кабинетов с истёкшей
    # подпиской и ОДИН заказ за 30 дней. Сюда же покупка модулей — она живёт
    # на той же странице «Подписка».
    # Партнёрская программа доступна всем и всегда, независимо от тарифа и
    # модулей: это способ заработать на оплату, отбирать его за неоплату
    # бессмысленно.
    # Ничего платного этим не открывается: заказ без оплаты ничего не даёт,
    # доступ выдаёт вебхук платёжки после реальных денег.
    "/api/v1/subscriptions/",
    "/api/v1/addons/",
    "/api/v1/referrals/",
    "/api/v1/participants",   # действия участников в Mini App
    "/api/v1/vk/",            # VK Mini App + вебхук
    "/api/v1/max/",           # MAX Mini App + вебхук
    "/r/",
    "/m/",
    "/p/",
    "/health",
)

# Точечные адреса. ⚠️ Сравниваются ЦЕЛИКОМ — дописать сюда «/api/v1/event»
# значит снова открыть весь раздел событий.
PASSTHROUGH_EXACT = frozenset({
    "/api/v1/event",                 # участник открыл событие в Mini App
    "/api/v1/event/link-click",      # участник нажал «смотреть эфир»
    "/api/v1/event/share-to-bot",    # участник отправил себе текст в бота
    "/api/v1/referral/conversion",   # вебхук конверсии
    # Те же разделы без хвостового слэша — иначе префикс их не поймает.
    "/api/v1/subscriptions",
    "/api/v1/addons",
    "/api/v1/referrals",
})


# ── Что остаётся доступным с оплаченной Коллабораторной ───────────────────
#
# Смысл: человек купил модуль и должен им пользоваться, даже если тариф
# кончился. Ему нужна не только сама Коллабораторная, но и то, что делает
# его видимым для партнёров: карточка бренда, основатель, фото и логотип —
# без них карточка в каталоге пустая, и модуль превращается в трату впустую.
COLLAB_PREFIXES = (
    "/api/v1/collab/",        # запросы, принятие, отзывы, выход из события
    "/api/v1/collab-hub/",    # своя карточка в каталоге, публикация
)

COLLAB_EXACT = frozenset({
    "/api/v1/collab",
    "/api/v1/collab-hub",
    "/api/v1/clients/me/profile",   # бренд + основатель (визитка)
    "/api/v1/uploads",              # фото бренда, логотип, фото основателя
    "/api/v1/uploads/by-url",       # снять уже загруженное фото
})

# Файл удаляют по адресу вида /api/v1/uploads/17
_UPLOAD_DELETE_RE = re.compile(r"^/api/v1/uploads/\d+$")

# Правка события: /api/v1/events/37 и всё, что внутри него.
_EVENT_RE = re.compile(r"^/api/v1/events/(\d+)(/.*)?$")

# ⚠️ Даже в ОБЩЕМ событии это остаётся закрытым: приём денег и рассылка по базе
# — платные возможности платформы, а не «участие в нетворке». Иначе тариф можно
# было бы не продлевать вовсе: завёл коллабу и продавай.
_EVENT_STILL_FROZEN = ("/tariffs", "/broadcasts", "/orders")


def _is_collab_path(path: str) -> bool:
    return (
        path in COLLAB_EXACT
        or path.startswith(COLLAB_PREFIXES)
        or bool(_UPLOAD_DELETE_RE.match(path))
    )


def _collab_event_id(path: str) -> "int | None":
    """Номер события, если адрес — правка конкретного события, которую
    владельцу общей коллабы разрешено делать без подписки."""
    m = _EVENT_RE.match(path)
    if not m:
        return None
    tail = m.group(2) or ""
    if any(tail.startswith(x) for x in _EVENT_STILL_FROZEN):
        return None
    return int(m.group(1))


async def subscription_guard_middleware(request: Request, call_next):
    if request.method in SAFE_METHODS:
        return await call_next(request)

    path = request.url.path
    if path in PASSTHROUGH_EXACT or path.startswith(PASSTHROUGH_PREFIXES):
        return await call_next(request)

    auth_header = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth_header or not auth_header.lower().startswith("bearer "):
        return await call_next(request)

    token = auth_header.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return await call_next(request)

    if payload.get("role") == "admin":
        return await call_next(request)

    sub = payload.get("sub")
    if not sub:
        return await call_next(request)

    try:
        client_id = int(sub)
    except (TypeError, ValueError):
        return await call_next(request)

    from app.database import get_pool
    pool = await get_pool()
    async with pool.acquire() as db:
        is_active = await db.fetchval(
            """SELECT 1 FROM client_subscriptions
                WHERE client_id = $1 AND status = 'active' AND expires_at > NOW()
                LIMIT 1""",
            client_id,
        )
        if is_active:
            return await call_next(request)

        # Подписки нет. Остаётся один случай — оплаченная Коллабораторная.
        event_id = _collab_event_id(path)
        if not _is_collab_path(path) and event_id is None:
            return _frozen()

        from app.services.features import client_has_feature
        if not await client_has_feature(db, client_id, "collab_hub"):
            return _frozen()

        # ⚠️ Событие правим ТОЛЬКО общее (`is_collab`). Свои обычные события
        # клиент без подписки вести не может — иначе заморозка ничего не
        # значит: заводи события и продавай тарифы бесплатно.
        if event_id is not None:
            is_collab = await db.fetchval(
                """SELECT e.is_collab FROM events e
                    JOIN event_owners eo ON eo.event_id = e.id
                   WHERE e.id = $1 AND eo.client_id = $2 AND eo.status = 'accepted'""",
                event_id, client_id,
            )
            if not is_collab:
                return _frozen()

    return await call_next(request)


def _frozen() -> JSONResponse:
    return JSONResponse(
        status_code=403,
        content={"detail": "Подписка истекла. Продлите тариф для возобновления работы."},
    )
