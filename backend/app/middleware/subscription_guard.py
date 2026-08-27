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


# ── Оплаченный модуль работает и без подписки (2026-08-26) ────────────────
#
# Модули «Конференции», «Премии/Турниры» и «Премии» покупаются ОТДЕЛЬНО от
# тарифа. До этой правки купивший модуль без Профи/Экстра не мог им
# пользоваться вовсе: фича у него есть, раздел виден, а любая правка —
# 403 «Подписка истекла». То есть человек заплатил за модуль и получил
# read-only. Теперь модуль работает; под замком остаются только платные
# возможности САМОЙ платформы, перечисленные ниже.
PAID_MODULE_FEATURES = ("conference", "tournaments", "awards")

# ⚠️ Что остаётся замороженным даже с оплаченным модулем. Это не части модуля,
# а то, за что платят подпиской: продающая страница, рассылки по базе, эфирная
# комната, реферальная механика, розыгрыш, догрев, приветственное письмо и
# приём денег. Иначе тариф можно было бы не продлевать вовсе: купил модуль
# за раз — и пользуйся платформой целиком.
#
# Хвосты внутри события: /api/v1/events/37/broadcasts/… и т.д.
MODULE_FROZEN_EVENT_TAILS = (
    "/landing",       # конструктор лендинга
    "/broadcasts",    # рассылки события
    "/webinar",       # вебинарная комната
    "/raffle",        # розыгрыш
    "/nurture",       # догрев (покрывает и /nurture-reg)
    "/referral",      # реферальная программа
    "/tariffs",       # платные тарифы события
    "/orders",        # заказы
)

# Разделы вне события.
MODULE_FROZEN_PREFIXES = (
    "/api/v1/broadcasts",                  # общие рассылки по базе
    "/api/v1/clients/me/payment-settings", # приём платежей
)

# ⚠️ Приветственное письмо отдельным адресом НЕ живёт — это поля внутри общего
# `PATCH /api/v1/events/{id}`. Закрыть его здесь, «по пути», невозможно;
# проверка стоит в самом `update_event` (app/api/events.py).


# ── Что остаётся доступным с оплаченной Коллабораторной ───────────────────
#
# Смысл: человек купил модуль и должен им пользоваться, даже если тариф
# кончился. Ему нужна не только сама Коллабораторная, но и то, что делает
# его видимым для партнёров: карточка бренда, основатель, фото и логотип —
# без них карточка в каталоге пустая, и модуль превращается в трату впустую.
COLLAB_PREFIXES = (
    "/api/v1/collab/",        # запросы, принятие, отзывы, выход из события
    "/api/v1/collab-hub/",    # своя карточка в каталоге, публикация
    # ⚠️ Визитка ПРЕФИКСОМ, а не точным адресом (2026-08-27). Точный адрес не
    # ловил `/clients/me/profile/resolve-telegram-chat-id` — резолв канала
    # основателя, без которого TG-каналы в визитку не добавить. Человек с
    # оплаченной Коллабораторной упирался в «Подписка истекла» на ровном
    # месте, заполняя собственную карточку.
    "/api/v1/clients/me/profile",
)

COLLAB_EXACT = frozenset({
    "/api/v1/collab",
    "/api/v1/collab-hub",
    "/api/v1/uploads",              # фото бренда, логотип, фото основателя
    "/api/v1/uploads/by-url",       # снять уже загруженное фото
})

# Файл удаляют по адресу вида /api/v1/uploads/17
_UPLOAD_DELETE_RE = re.compile(r"^/api/v1/uploads/\d+$")

# Правка события: /api/v1/events/37 и всё, что внутри него.
_EVENT_RE = re.compile(r"^/api/v1/events/(\d+)(/.*)?$")

# ⚠️ Что остаётся закрытым даже в ОБЩЕМ событии (решение владельца 2026-08-27).
# Это не части Коллабораторной, а платные возможности САМОЙ платформы: работа
# по базе (рассылки, догрев, реферальная механика), эфирная комната и приём
# денег. Всё остальное в коллабе — состав, программа, афиши, лендинг, карточки
# организаторов, чаты — работает без тарифа.
#
# ⚠️ Ссылку на сторонний эфир (Zoom и подобное) это НЕ закрывает: она живёт
# полем `events.stream_url` внутри общего `PATCH /api/v1/events/{id}`. Закрыта
# именно наша вебинарная комната (`/webinar`).
#
# ⚠️ `/nurture` покрывает и `/nurture-reg` — сравнение идёт по началу строки.
_EVENT_STILL_FROZEN = (
    "/broadcasts",   # рассылки события
    "/webinar",      # вебинарная комната
    "/referral",     # реферальная программа: пороги, подарки, тексты шеринга
    "/nurture",      # воронки догрева (+ /nurture-reg)
    "/tariffs",      # платные тарифы события — приём денег
    "/orders",       # заказы
)


# ── Тексты отказа ────────────────────────────────────────────────────────
#
# ⚠️ Текст говорит, что именно закрыто, а не «ничего не работает». У человека с
# оплаченным модулем общее «Подписка истекла» читалось как приговор всему
# кабинету: он переставал пробовать и писал, что модуль не работает вовсе.
DEFAULT_FROZEN_MSG = (
    "Тариф истёк — этот раздел пока закрыт. Продлите подписку, чтобы вернуть доступ."
)
MODULE_FROZEN_MSG = (
    "Ваш модуль работает, но этот раздел входит в тариф: рассылки, лендинг, "
    "вебинарная комната, реферальная программа, догрев и приём оплат. "
    "Продлите подписку, чтобы им пользоваться."
)
COLLAB_FROZEN_MSG = (
    "Коллабораторная у вас работает. Закрыты только разделы из тарифа: рассылки, "
    "реферальная программа, догрев, вебинарная комната и приём оплат. "
    "Ссылку на сторонний эфир (Zoom и подобное) можно указать в настройках события."
)


def _is_collab_path(path: str) -> bool:
    return (
        path in COLLAB_EXACT
        or path.startswith(COLLAB_PREFIXES)
        or bool(_UPLOAD_DELETE_RE.match(path))
    )


def _event_tail_frozen(path: str) -> bool:
    """Адрес — раздел внутри события, закрытый даже в общей коллабе."""
    m = _EVENT_RE.match(path)
    if not m:
        return False
    tail = m.group(2) or ""
    return any(tail.startswith(x) for x in _EVENT_STILL_FROZEN)


def _module_path_frozen(path: str) -> bool:
    """True — этот адрес остаётся закрытым даже у владельца оплаченного модуля."""
    if path.startswith(MODULE_FROZEN_PREFIXES):
        return True
    m = _EVENT_RE.match(path)
    if m:
        tail = m.group(2) or ""
        return any(tail.startswith(x) for x in MODULE_FROZEN_EVENT_TAILS)
    return False


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

        from app.services.features import get_client_features
        features = await get_client_features(db, client_id)

        # Подписки нет. Случай первый — оплаченный модуль (Конференции,
        # Премии, Турниры): им пользуются как обычно, кроме того, за что
        # платят подпиской.
        if any(f in features for f in PAID_MODULE_FEATURES):
            if _module_path_frozen(path):
                return _frozen(MODULE_FROZEN_MSG)
            return await call_next(request)

        # Случай второй — оплаченная Коллабораторная.
        has_collab = "collab_hub" in features
        event_id = _collab_event_id(path)

        # Общее событие, но раздел из платных: объясняем ИМЕННО это, а не
        # «подписка истекла» — иначе человек с оплаченным модулем решает, что
        # у него не работает вообще ничего, и перестаёт пробовать.
        if has_collab and event_id is None and _event_tail_frozen(path):
            return _frozen(COLLAB_FROZEN_MSG)

        if not _is_collab_path(path) and event_id is None:
            return _frozen()

        if not has_collab:
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


def _frozen(detail: str = DEFAULT_FROZEN_MSG) -> JSONResponse:
    return JSONResponse(status_code=403, content={"detail": detail})
