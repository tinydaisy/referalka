"""
Middleware: ограничивает действия пользователя с role='assistant'.

⚠️ Четыре уровня доступа (`assistant_grants.access_level`, миграции 209/342/484):
  · 'full'    — ассистент = владелец кабинета по правам. Middleware пропускает ВСЁ,
                кроме ЛИЧНОГО владельца (OWNER_ONLY_ALWAYS_*): раздел управления
                ассистентом (иначе сменит себе пароль / удалит себя), админка,
                смена пароля владельца и письмо на его email. Рабочие настройки
                (PATCH /auth/me, каналы, лид-магниты, оплата) — доступны.
  · 'limited' — исторический набор прав, описанный ниже (default).
  · 'orders'  — «Менеджер заказов»: только «Контакты» и «Анкеты», но ВСЕ
                контакты кабинета (ORDERS_ALLOWED_PREFIXES).
  · 'leads'   — «Менеджер лидов»: «Контакты» и CRM событий, но ТОЛЬКО
                закреплённые за ним люди (LEADS_ALLOWED_PREFIXES).
                ⚠️ Список путей решает «в какие разделы пущен». Каких ЛЮДЕЙ
                он видит — режется фильтром по `contact_assignments` в самих
                выборках (contacts.py, events.py), не здесь.
Уровень читается из БД на каждый запрос ассистента — переключение тумблера
владельцем применяется сразу, без перелогина.

Семантика прав ОГРАНИЧЕННОГО ассистента (фиксировано 2026-05-24):
  ✅ Контакты, коллабораторы, события, участники — читать + править (PATCH/POST/DELETE
     внутри контента: пороги реф-программы, материалы шеринга, шаблоны рассылок,
     шаги nurture, сессии конференции, призы розыгрыша, продукты Mini App, …)
  ✅ Рассылки (общие и в событиях) — полный доступ
  ✅ Mini App (визитка, бренд, основатель, продукты) — полный доступ
  ✅ Реф-программа событий — полный доступ
  ❌ Удаление «человеческих» сущностей и привязок людей к событию:
     · сами контакты, коллабораторы, лид-магниты, подарки события
     · само событие
     · участники события, соорганизаторы события, спикеры конференции
  ❌ Каналы (/api/v1/channels/*) — write запрещён (создавать/править/удалять боты,
     импорт CSV → 403). GET разрешён: список каналов нужен пикерам рассылок.
  ❌ Настройки клиента (/api/v1/auth/me, change-password, regenerate-integration-token,
     ассистенты, юр.данные) — нет доступа
  ❌ Лид-магниты и пакеты — только GET (создавать/править/удалять нельзя)
  ❌ Будущие денежные модули (/api/v1/billing/*, /api/v1/payments/*) — нет доступа

Что пропускается без проверки:
  - GET, OPTIONS, HEAD везде кроме явных «закрытых» путей (channels, settings-эндпоинты)
  - /api/v1/auth/login, /auth/me (GET) — читать профиль владельца можно
  - /api/v1/public/*, /api/v1/integrations/* — публичные webhook'и
"""
import re

from fastapi import Request
from fastapi.responses import JSONResponse
from jose import JWTError, jwt
from app.config import settings


# ⚠️ Свой пароль помощник меняет САМ — этот путь открыт ЛЮБОМУ помощнику,
# на любом уровне доступа. Общий `/auth/change-password` ему закрыт и должен
# оставаться закрытым: тот правит запись КЛИЕНТА по номеру кабинета из
# токена, а у помощника там кабинет владельца — он сменил бы пароль ему.
# До появления этого пути помощник не мог сменить пароль никак: забыл или
# утёк — только просить владельца выслать новый.
ASSISTANT_OWN_PASSWORD_PATH = "/api/v1/auth/assistant/change-password"

# Полностью закрытые префиксы — ни GET, ни write.
FORBIDDEN_PREFIXES = (
    "/api/v1/clients/me/assistant",           # ассистент не управляет сам собой
    "/api/v1/billing",                        # будущие платежи
    "/api/v1/payments",                       # будущие платежи
    "/api/v1/admin",                          # админка отдельно
    # ⚠️⚠️ Автонастройка «под ключ» (22.09.2026, решение владельца). Помощник
    # работает в ЧУЖОМ кабинете, а это заказ платной услуги от имени клиента:
    # трогает его бота, его BotFather и его деньги. Уровень `full` сюда НЕ
    # попадает — он пропускается выше по коду (`if level == "full"`), то есть
    # доверенному помощнику автонастройка остаётся. Пункт меню скрыт в
    # Sidebar.tsx, но одного фронта мало: страница открывается и по прямой
    # ссылке, а запросы — из чего угодно.
    "/api/v1/clients/me/tg-autosetup",
)

# Только GET разрешён, write-методы → 403.
READONLY_PREFIXES = (
    "/api/v1/lead-magnets",                   # ассистент только смотрит и копирует ссылки
    "/api/v1/lead-magnet-packages",
    # Каналы: ассистент НЕ управляет ботами (создание/правка/удаление/импорт CSV → 403),
    # но GET нужен — список каналов читают пикеры рассылок (выбор каналов отправки).
    # GET /channels не отдаёт bot_token наружу, поэтому read безопасен.
    "/api/v1/channels",
)

# Write-эндпоинты «настроек» — ассистенту запрещены полностью.
FORBIDDEN_WRITE_PATHS = (
    "/api/v1/auth/me",                              # PATCH профиля владельца
    "/api/v1/auth/change-password",                # смена пароля владельца
    "/api/v1/auth/me/regenerate-integration-token",
    "/api/v1/auth/regenerate-integration-token",
)

# Личные учётные данные владельца — закрыты ЛЮБОМУ ассистенту, включая полного.
# Пароль и email — это вход в кабинет, а не рабочий инструмент; ассистент с полным
# доступом не должен уметь сменить их и отрезать владельца от собственного кабинета.
# ── Что открыто «менеджеру заказов» ───────────────────────────────────────
# ⚠️ Пути перечислены ЦЕЛИКОМ, включая служебные: без /auth/me фронт не
# узнает, кто вошёл, и кабинет не откроется вовсе; без /analytics/sources
# не соберутся фильтры в таблице ответов.
ORDERS_ALLOWED_PREFIXES = (
    "/api/v1/auth/me",
    ASSISTANT_OWN_PASSWORD_PATH,     # свой пароль помощник меняет сам
    "/api/v1/contacts",              # список, карточка, правка, экспорт
    "/api/v1/contact-fields",        # названия доп. полей в карточке
    "/api/v1/surveys",               # анкеты, ответы, отметки об обработке
    "/api/v1/dialogs",               # переписка с человеком из карточки
    "/api/v1/dialog-messages",
    "/api/v1/platforms",             # справочник площадок для значков
    "/api/v1/analytics/sources",     # разрезы для фильтров в таблице ответов
    "/api/v1/analytics/dashboards",  # дашборды анкеты — «сколько разобрать»
    # Новости платформы (миграция 374): плашка и колокольчик есть на КАЖДОЙ
    # странице кабинета, включая те, что открыты менеджеру заказов. Без этого
    # пути плашка у него не закрывалась бы — отметка «прочитано» это POST.
    "/api/v1/news",
)

# ── Что открыто «менеджеру лидов» (миграция 484) ──────────────────────────
# Он ведёт СВОЙ закреплённый список людей: смотрит их в базе контактов, видит
# их же в CRM событий и переписывается с ними через бота клиента.
#
# ⚠️ Этот список решает «в какие РАЗДЕЛЫ пущен», а не «каких ЛЮДЕЙ видит».
# Видимость режется отдельно — фильтром по `contact_assignments` в самих
# выборках (contacts.py, events.py). Одного списка путей мало: путь
# /api/v1/contacts открыт, но отдать он должен только закреплённых.
LEADS_ALLOWED_PREFIXES = (
    "/api/v1/auth/me",
    ASSISTANT_OWN_PASSWORD_PATH,     # свой пароль помощник меняет сам
    "/api/v1/contacts",              # список, карточка, правка, экспорт — только свои
    "/api/v1/contact-fields",        # названия доп. полей в карточке
    "/api/v1/dialogs",               # переписка с человеком из карточки
    "/api/v1/dialog-messages",
    "/api/v1/platforms",             # справочник площадок для значков
    "/api/v1/news",                  # плашка новостей есть на каждой странице
)

# ⚠️⚠️ Внутри событий менеджеру лидов открыты ДВА ТОЧНЫХ пути, а не префикс
# «/api/v1/events». Под этот корень смонтировано ОКОЛО ДВАДЦАТИ независимых
# роутеров: участники, тарифы и покупатели, розыгрыш, реф-отчёты, вебинарная
# комната с чатом, логи рассылок, турнир, конференция, афиши, трекер анонсов.
# Каждый отдаёт людей с телефонами и почтами и НИЧЕГО не знает про
# `contact_assignments`. Открыв префикс, мы дали бы менеджеру выгрузить всю
# базу кабинета одним GET `/events/{id}/participants` — в обход фильтра в
# «Контактах» (поймано аудитом 2026-09-21, до выкатки).
#
# Поэтому список, а не префикс. Появится новый раздел внутри события — он
# НЕ откроется менеджеру сам собой, и это правильное поведение по умолчанию.
LEADS_ALLOWED_EVENT_PATHS = (
    re.compile(r"^/api/v1/events/?$"),          # список событий (сужен фильтром)
    re.compile(r"^/api/v1/events/\d+$"),        # шапка события: название, даты
    re.compile(r"^/api/v1/events/\d+/crm$"),    # CRM — ради неё роль и заходит
)

OWNER_ONLY_ALWAYS_PREFIXES = (
    "/api/v1/clients/me/assistant",   # ассистент не управляет сам собой
    "/api/v1/admin",                  # админка платформы
)
# ⚠️ Сюда НЕ входят рабочие эндпоинты, которые полный ассистент использует:
# PATCH /auth/me (имя, часовой пояс, каналы уведомлений, тестовые аккаунты — email
# там не меняется) и перегенерация интеграционного токена.
OWNER_ONLY_ALWAYS_WRITE_PATHS = (
    "/api/v1/auth/change-password",               # пароль владельца — вход в кабинет
    "/api/v1/auth/verify-email/resend",           # письмо на email владельца
)
FORBIDDEN_WRITE_PREFIXES = (
    "/api/v1/clients/me/legal",                    # юр-данные клиента (миграция 099)
)

# DELETE-эндпоинты которые ассистенту запрещены конкретно (всё прочее DELETE
# внутри контента — пороги, материалы, шаблоны, сессии, призы — разрешено).
FORBIDDEN_DELETE_PATTERNS = tuple(
    re.compile(p) for p in (
        # Сами «люди» и подарки/лид-магниты в общей базе клиента
        r"^/api/v1/contacts/\d+(?:/[^/]+)?$",
        r"^/api/v1/collaborators/\d+(?:/[^/]+)?$",
        # Само событие
        r"^/api/v1/events/\d+$",
        # Привязка человека к событию
        r"^/api/v1/events/\d+/participants/\d+$",
        r"^/api/v1/events/\d+/collaborators/\d+$",
        # Подарки события
        r"^/api/v1/events/\d+/gifts/\d+$",
        # Привязка спикера к конференции
        r"^/api/v1/events/\d+/conference/speakers/\d+$",
    )
)

WRITE_METHODS = {"POST", "PATCH", "PUT", "DELETE"}


async def assistant_permission_guard_middleware(request: Request, call_next):
    auth_header = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth_header or not auth_header.lower().startswith("bearer "):
        return await call_next(request)

    token = auth_header.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return await call_next(request)

    if payload.get("role") != "assistant":
        return await call_next(request)

    path = request.url.path
    method = request.method.upper()

    # OPTIONS — пропустим для CORS preflight всегда.
    if method == "OPTIONS":
        return await call_next(request)

    # Ассистент с ПОЛНЫМ доступом — прав как у владельца, кроме личного владельца:
    # раздел управления ассистентом (иначе сменит себе пароль / удалит себя),
    # админка, а также email и пароль владельца (вход в кабинет — не рабочий инструмент).
    from app.services.assistant_access import get_grant_access_level

    # Уровень живёт в пропуске: помощник может вести несколько кабинетов
    # и в каждом иметь свои права (миграция 209).
    level = await get_grant_access_level(payload.get("grant_id"))
    # Личное владельца закрыто ЛЮБОМУ ассистенту (проверяем до разбора уровня).
    if any(path.startswith(p) for p in OWNER_ONLY_ALWAYS_PREFIXES):
        return JSONResponse(
            status_code=403,
            content={"detail": "Этот раздел доступен только владельцу кабинета."},
        )
    if method in WRITE_METHODS and path in OWNER_ONLY_ALWAYS_WRITE_PATHS:
        return JSONResponse(
            status_code=403,
            content={"detail": "Email и пароль может менять только владелец кабинета."},
        )

    if level == "full":
        return await call_next(request)

    # ── «Менеджер заказов»: РАЗРЕШИТЕЛЬНЫЙ список ─────────────────────────
    # ⚠️ Перечисляем, что МОЖНО, а не что нельзя. Список запретов пришлось бы
    # дописывать при каждом новом разделе кабинета, и однажды забыли бы —
    # менеджер увидел бы деньги, рассылки или настройки.
    #
    # Ему нужны ровно два раздела: «Контакты» (кому звонить) и «Анкеты»
    # (что человек ответил и отметка об обработке). Плюс служебное: кто я,
    # словарь площадок, разрезы для фильтров в таблице ответов.
    if level == "orders":
        if any(path.startswith(p) for p in ORDERS_ALLOWED_PREFIXES):
            return await call_next(request)
        return JSONResponse(
            status_code=403,
            content={"detail": "У вас доступ только к контактам и анкетам."},
        )

    # ── «Менеджер лидов»: РАЗРЕШИТЕЛЬНЫЙ список + события только на чтение ──
    # Видимость людей режется не здесь, а фильтром по `contact_assignments`
    # в выборках: путь открыт, но отдаёт только закреплённых за ним.
    if level == "leads":
        # События — по точному списку путей и ТОЛЬКО на чтение.
        if path.startswith("/api/v1/events"):
            if method in WRITE_METHODS or not any(
                rx.match(path) for rx in LEADS_ALLOWED_EVENT_PATHS
            ):
                return JSONResponse(
                    status_code=403,
                    content={"detail": "В событии вам доступно только отслеживание (CRM)."},
                )
            return await call_next(request)
        # ⚠️ Импорт CSV и объединение контактов закрыты: это работа с базой
        # ЦЕЛИКОМ, а не со своими людьми. Импорт автомерджем переписывает уже
        # существующие чужие контакты, объединение необратимо склеивает двух
        # произвольных людей — оба ломают чужие данные, не показывая их.
        if path in ("/api/v1/contacts/import",) or re.match(
            r"^/api/v1/contacts/\d+/merge$", path
        ):
            return JSONResponse(
                status_code=403,
                content={"detail": "Импорт и объединение контактов доступны только владельцу кабинета."},
            )
        if not any(path.startswith(p) for p in LEADS_ALLOWED_PREFIXES):
            return JSONResponse(
                status_code=403,
                content={"detail": "У вас доступ только к своим контактам и CRM событий."},
            )
        return await call_next(request)

    # 1) Полный запрет по префиксу (любой метод).
    if any(path.startswith(p) for p in FORBIDDEN_PREFIXES):
        return JSONResponse(
            status_code=403,
            content={"detail": "Этот раздел доступен только владельцу кабинета."},
        )

    # 2) Read-only префиксы — запрещаем только write-методы.
    if any(path.startswith(p) for p in READONLY_PREFIXES) and method in WRITE_METHODS:
        return JSONResponse(
            status_code=403,
            content={"detail": "Ассистент может только смотреть этот раздел."},
        )

    # 3) Точечные запрещённые write-эндпоинты.
    if method in WRITE_METHODS:
        if path in FORBIDDEN_WRITE_PATHS or any(
            path.startswith(p) for p in FORBIDDEN_WRITE_PREFIXES
        ):
            return JSONResponse(
                status_code=403,
                content={"detail": "Этот раздел доступен только владельцу кабинета."},
            )

    # 4) Точечный запрет на «опасные» DELETE (люди / событие / привязки людей).
    if method == "DELETE":
        if any(rx.match(path) for rx in FORBIDDEN_DELETE_PATTERNS):
            return JSONResponse(
                status_code=403,
                content={"detail": "Ассистент не может удалять данные. Это действие доступно только владельцу кабинета."},
            )

    return await call_next(request)
