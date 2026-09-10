import logging as _logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from contextlib import asynccontextmanager
from app.config import settings
from app.database import get_pool, close_pool
from app.middleware.subscription_guard import subscription_guard_middleware
from app.middleware.assistant_permission_guard import assistant_permission_guard_middleware
from app.middleware.email_verification_guard import email_verification_guard_middleware
from app.api import auth, events, gifts, participants, referral, admin, event, collaborators, collaborator_posters, integrations, subscription_check, contacts, lead_magnets, lead_magnet_packages, funnels, referral_program, platforms, channels, uploads, client_profile, client_speaker_photos, event_raffle, event_raffle_public, tg_utils, vk_event, max_event, max_webhook, event_nurture, event_nurture_reg, email_unsubscribe, legal, email_tracking, assistants, partner, speaker_cabinet, landing_widget, client_chat_gates, announcement_tracker, pricing_public, subscriptions, referrals, participants_export, contacts_export, event_page_html, events_list_page, tournament, collab_hub, collab_events, event_tariffs, dialogs, event_chat_greetings, addons, client_broadcast_chats, pluson_connect, medialift, medialift_cabinet_html, analytics, event_landing, event_landing_public, client_landing_theme, client_domains_api, client_storage, surveys, surveys_public, analytics_dashboards, products, product_orders, products_public, product_landing, product_landing_public, plusson_bonus_public, platform_legal, speaker_signup_public, request_forms, instagram_webhook, instagram_funnels, module_materials, cover_templates, cover_public, tech_cabinet, admin_tech, tech_materials, tech_dialogs, address_suggest
from app.api import client_offers, client_testimonials, client_payment_settings, event_orders
from app.api import client_call_settings, call_campaigns
from app.api import tg_autosetup, admin_tg_setup
from app.api import partner_program, partner_public
from app.api import platform_news
from app.api.gifts import router_compat as gifts_compat
from app.api.modules import conference, broadcasts, webinar_room
from app.api import webinar_public
from app.api import broadcasts_general


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    if settings.database_url:
        await get_pool()
    yield
    # Shutdown
    await close_pool()


# ⚠️ Логи приложения. Без этой настройки uvicorn пишет только строки доступа
# ("POST /api/v1/... 200 OK"), а `logger.info/warning` из наших модулей НЕ
# попадают в journalctl вовсе. Из-за этого сбои, погашенные `except`, были не
# видны: в MAX-вебхуке ошибка уведомления организатору выглядела как «просто
# ничего не пришло», без единой строки в логе. Диагностика шла вслепую.
_logging.basicConfig(
    level=_logging.INFO,
    format="%(asctime)s — %(name)s — %(levelname)s — %(message)s",
)
# httpx на каждый запрос пишет INFO-строку — на рассылках это тысячи строк.
_logging.getLogger("httpx").setLevel(_logging.WARNING)

app = FastAPI(
    title="PLUSSON API",
    description="ПЛЮСОН — платформа событийного и реферального маркетинга",
    version="1.0.0",
    lifespan=lifespan
)


# ⚠️ Любая неперехваченная ошибка приходила клиенту как «Internal Server Error».
# Человек видел эту надпись на экране подключения бота или платёжки и не мог
# понять ничего: ни что случилось, ни что делать дальше, ни к кому идти. Хуже
# того — по такому тексту нельзя даже пожаловаться толком.
#
# Теперь клиент получает понятную фразу с номером ошибки, а подробности (файл,
# строка, трассировка) уходят в лог сервера — по номеру их легко найти.
@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception):
    import logging, uuid
    code = uuid.uuid4().hex[:8]
    logging.getLogger("app.unhandled").exception(
        "НЕОБРАБОТАННАЯ ОШИБКА [%s] %s %s", code, request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Что-то пошло не так на нашей стороне — мы уже видим эту "
                           f"ошибку в логах. Попробуйте ещё раз через минуту; если "
                           f"повторится, напишите в поддержку и назовите код {code}."},
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        settings.frontend_url,
        settings.mini_app_url,
        "http://localhost:3000",
        "http://localhost:5173",
        "https://*.vercel.app",
    ],
    # ⚠️⚠️ ПОДДОМЕНЫ ПЛАТФОРМЫ — ОТДЕЛЬНЫМ ПРАВИЛОМ. Список `allow_origins`
    # проверяет ТОЧНОЕ совпадение, звёздочка в нём не работает: запрос с
    # tech.pluson.ru получал 400, и браузер показывал человеку «Сервер
    # недоступен» вместо входа в кабинет.
    # Правило покрывает и будущие поддомены — заводить каждый руками не надо.
    allow_origin_regex=r"https://[a-z0-9-]+\.pluson\.ru",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Starlette middleware-stack оборачивает запрос в обратном порядке регистрации:
# то, что добавлено ПОСЛЕДНИМ, исполняется ПЕРВЫМ. Поэтому регистрируем
# subscription_guard ПЕРЕД assistant_permission_guard: на запросе ассистента
# сначала отработает права (быстрее, без БД), потом подписка.
app.add_middleware(BaseHTTPMiddleware, dispatch=subscription_guard_middleware)
app.add_middleware(BaseHTTPMiddleware, dispatch=assistant_permission_guard_middleware)
# Гейт по подтверждению email — блокирует только write по рассылкам.
# Добавлен последним → исполняется первым (быстрый выход для не-broadcast путей).
app.add_middleware(BaseHTTPMiddleware, dispatch=email_verification_guard_middleware)
# Клиент открытого Mini App (`X-Plusson-Client`) → в контекст запроса.
# Добавлен последним → исполняется ПЕРВЫМ: значение нужно всем обработчикам
# ниже, чтобы у коллабы не уехать к «первому владельцу» события.
from app.middleware.app_client import AppClientMiddleware  # noqa: E402
app.add_middleware(AppClientMiddleware)

# Подключаем роутеры
app.include_router(auth.router,         prefix="/api/v1")
app.include_router(events.router,       prefix="/api/v1")
app.include_router(gifts.router,        prefix="/api/v1")
app.include_router(gifts_compat,        prefix="/api/v1")  # совместимость: /events/slug/{slug}/gifts/
app.include_router(participants.router, prefix="/api/v1")
app.include_router(pluson_connect.router, prefix="/api/v1")  # /api/v1/pluson-connect/{info|link|register} — связка контакта с ПЛЮСОН (команда /pluson_connect)
app.include_router(admin.router,        prefix="/api/v1")
app.include_router(conference.router,   prefix="/api/v1")
app.include_router(broadcasts.router,   prefix="/api/v1")
app.include_router(broadcasts_general.router, prefix="/api/v1")
app.include_router(collaborators.router)
app.include_router(client_speaker_photos.router)                              # /api/v1/clients/me/speaker-photos — библиотека фото спикера (миграция 323)
app.include_router(collaborator_posters.router)                                # /api/v1/collaborators/{id}/posters — библиотека афиш (миграция 121)
app.include_router(event.router,        prefix="/api/v1")  # POST /api/v1/event
app.include_router(vk_event.router,     prefix="/api/v1")  # POST /api/v1/vk/event (миграция 2026-05-19)
app.include_router(max_event.router,    prefix="/api/v1")  # POST /api/v1/max/event (миграция 2026-05-20)
app.include_router(instagram_webhook.router)   # вебхук Meta: у него свой префикс внутри
app.include_router(instagram_funnels.router)   # CRUD воронок Instagram
app.include_router(max_webhook.router,  prefix="/api/v1")  # POST /api/v1/max/webhook/{secret}
app.include_router(referral.router)     # /api/v1/referral/conversion
app.include_router(integrations.router, prefix="/api/v1")
app.include_router(participants_export.router, prefix="/api/v1")  # /api/v1/integrations/events/{id}/participants/{registered|not-registered} — выгрузка участников для сторонних сервисов
app.include_router(contacts_export.router, prefix="/api/v1")  # /api/v1/integrations/contacts — вся база контактов клиента для мейлера/CRM
app.include_router(subscription_check.router)  # /api/v1/public/...
app.include_router(medialift.router)  # /api/v1/public/medialift/... — МедиаЛифт (тип события medialift)
app.include_router(medialift.client_router)  # /api/v1/clients/me/medialift/my-card — карточка клиента в МедиаЛифте
app.include_router(contacts.router,     prefix="/api/v1")
app.include_router(analytics.router,    prefix="/api/v1")  # /api/v1/analytics/utm — сводка по UTM
# ⚠️ Объявлять ПОСЛЕ analytics: у обоих префикс /analytics, но пути не
# пересекаются (/utm против /dashboards, /sources).
app.include_router(analytics_dashboards.router, prefix="/api/v1")  # дашборды-квадратики
app.include_router(lead_magnets.router, prefix="/api/v1")
# Анкеты (миграция 280): кабинет + публичная страница /f/{slug}.
app.include_router(surveys.router, prefix="/api/v1")
app.include_router(surveys_public.router, prefix="/api/v1")
# Продукты/услуги вне событий (миграция 290): продукты, тарифы, библиотека
# материалов и состав. Гейт — фича `products` (пока только у тарифа admin).
app.include_router(products.router, prefix="/api/v1")
# Материалы, которые открывает купленный МОДУЛЬ (Коллабораторная и далее).
# ⚠️ Отдельный роутер, а не ветка в products: там всё завязано на владение
# продуктом, а тут право даёт фича. Только чтение — правка в products.
app.include_router(module_materials.router, prefix="/api/v1")
# Шаблоны обложек (миграция 387): настройка «как выглядит обложка».
app.include_router(cover_templates.router, prefix="/api/v1/clients/me")
# Страница отрисовки обложки — её открывает Chromium по подписанному токену.
# ⚠️ Без префикса: свой полный путь /api/v1/public/cover.
app.include_router(cover_public.router)
# Тех-специалисты (внедренцы, миграция 391) — ТРЕТИЙ тип входа помимо клиента
# и админа: свой срез данных платформы по закреплённым клиентам.
app.include_router(tech_cabinet.router, prefix="/api/v1")
app.include_router(admin_tech.router,   prefix="/api/v1")
# Правка материалов Коллабораторной внедренцем: выдаёт токен системного
# кабинета, дальше работает готовый редактор products.py.
app.include_router(tech_materials.router, prefix="/api/v1")
# Диалоги внедренца: переписка с теми, кто написал в @pluson_bot (мигр. 392).
app.include_router(tech_dialogs.router,   prefix="/api/v1")
# Публичный заказ тарифа продукта. ⚠️ Свой префикс у роутера уже есть
# (/api/v1/public/product-orders), поэтому без prefix=. Вебхуки оплаты
# приходят на ОБЩИЙ роут /integrations/client-pay/* (см. event_orders.py):
# отдельного адреса завести нельзя, различаем по префиксу номера `prd-`.
app.include_router(product_orders.router)
# Активация бонусного доступа в ПЛЮСОН по ссылке из письма (мигр. 308).
app.include_router(plusson_bonus_public.router)
# Витрина продукта /pr/{slug} и кабинет купившего /my — у роутера свой префикс.
app.include_router(products_public.router)
# Конструктор лендинга продукта (миграция 293) — те же блоки, что у события.
app.include_router(product_landing.router, prefix="/api/v1")
app.include_router(product_landing_public.router)
app.include_router(lead_magnet_packages.router, prefix="/api/v1")  # пакеты лид-магнитов (миграция 062)
app.include_router(funnels.template_router, prefix="/api/v1")      # шаблоны воронок (миграция 063)
app.include_router(funnels.public_router)                          # /m/{slug}, /p/{slug}
app.include_router(partner.public_router)                          # /partner/{client_id} (миграция 105)
app.include_router(referral_program.router, prefix="/api/v1")
app.include_router(announcement_tracker.router, prefix="/api/v1")  # трекер анонсов спикеров (миграция 124)
app.include_router(platforms.router,    prefix="/api/v1")  # справочник платформ (миграция 036)
app.include_router(channels.router,     prefix="/api/v1")  # каналы клиента (миграция 036)
app.include_router(uploads.router,      prefix="/api/v1")  # POST /uploads, DELETE /uploads/{id}, GET /storage/usage, GET /storage/files (миграция 037)
app.include_router(uploads.public_router, prefix="/api/v1")  # GET /public/storage-promo — реф-ссылка на своё хранилище
app.include_router(client_storage.router, prefix="/api/v1")  # своё хранилище клиента (миграция 320)
app.include_router(address_suggest.router, prefix="/api/v1")  # подсказки адреса (DaData)
app.include_router(client_profile.public,           prefix="/api/v1")  # /api/v1/public/clients/{id}/profile|offerings|events; /events/{slug}/landing
app.include_router(client_profile.profile_router,   prefix="/api/v1")  # /api/v1/clients/me/profile (миграция 039)
app.include_router(client_profile.offerings_router, prefix="/api/v1")  # /api/v1/client-offerings (миграция 039)
app.include_router(event_raffle.router,             prefix="/api/v1")  # /api/v1/events/{id}/raffle/{settings|prizes|keywords|tickets|participants|winners|draw} (миграции 042, 056)
app.include_router(request_forms.event_router,      prefix="/api/v1")  # /api/v1/events/{id}/request-form — форма заявки события (миграция 363)
app.include_router(request_forms.product_router,    prefix="/api/v1")  # /api/v1/products/{id}/request-form — форма заявки продукта
app.include_router(event_tariffs.router,            prefix="/api/v1")  # /api/v1/events/{id}/tariffs/{...|buyers} — тарифы мероприятия (миграция 157)
app.include_router(event_chat_greetings.router,     prefix="/api/v1")  # /api/v1/events/{id}/chat-greetings — приветствие в чатах (миграция 163)
app.include_router(dialogs.router,                  prefix="/api/v1")  # /api/v1/dialogs, /contacts/{id}/messages|reply, /dialog-messages/{id} — личные переписки (миграция 160)
app.include_router(event_raffle_public.router,            prefix="/api/v1")  # Mini App: /events/{slug}/raffle/{free-ticket|keyword|me} (миграция 056)
app.include_router(event_raffle_public.event_root_router, prefix="/api/v1")  # Mini App: /events/{slug}/live — отметка «в эфире» (миграция 056)
app.include_router(tg_utils.router,                       prefix="/api/v1")  # /api/v1/utils/resolve-tg-chat-id
app.include_router(event_nurture.router,                  prefix="/api/v1")  # /api/v1/events/{id}/nurture/steps (миграция 088)
app.include_router(event_nurture_reg.router,              prefix="/api/v1")  # /api/v1/events/{id}/nurture-reg/steps — воронка зарег. (миграция 129)
app.include_router(email_unsubscribe.router)                                   # /api/v1/email/unsubscribe (миграции 097-098)
app.include_router(legal.router)                                               # юр-данные клиента + публичная страничка политики (миграция 099)
app.include_router(platform_news.client_router,  prefix="/api/v1")             # /api/v1/news — новости платформы в кабинете клиента (миграция 374)
app.include_router(platform_news.manage_router,  prefix="/api/v1")             # /api/v1/platform-news — ведение: админ ИЛИ сервисный кабинет
app.include_router(platform_news.public_router)                                # /api/v1/news/unsubscribe — отписка от писем с новостями
app.include_router(platform_legal.router)                                      # правовые документы ПЛАТФОРМЫ: админка (миграция 317)
app.include_router(platform_legal.public_router)                               # они же публично — /offer, /privacy, /partner-offer
app.include_router(email_tracking.router)                                      # /api/v1/email/pixel/{token}.gif, /api/v1/email/click (миграция 098)
app.include_router(assistants.router,   prefix="/api/v1")                      # /api/v1/clients/me/assistants — помощники кабинета (миграции 106, 209)
app.include_router(speaker_cabinet.router)                                     # /api/v1/public/speaker-cabinet — мини-кабинет спикера (миграция 108)
app.include_router(speaker_signup_public.router)                                # /api/v1/public/speaker-signup — веб-регистрация в состав БЕЗ мессенджеров (2026-08-27)
app.include_router(landing_widget.router)                                      # /api/v1/public/landing-widget — JSON для сторонних лендингов (миграция 111)
app.include_router(event_landing.router,            prefix="/api/v1")  # /api/v1/events/{id}/landing — конструктор лендинга события (миграция 240)
app.include_router(client_landing_theme.router,     prefix="/api/v1")
app.include_router(client_offers.router,            prefix="/api/v1")
app.include_router(client_offers.public_router)                                 # /api/v1/public/offers/{slug} — текст оферты для pluson.ru/o/{slug}  # /api/v1/clients/me/offers — база оферт (миграция 249)
app.include_router(client_testimonials.router,      prefix="/api/v1")  # /api/v1/clients/me/testimonials — отзывы и кейсы  # /api/v1/clients/me/landing-theme — фирменная тема лендингов (миграция 241)
app.include_router(event_landing_public.router)                                # /api/v1/public/event-landing/{slug} — собранный лендинг для pluson.ru/e/{slug}
app.include_router(client_payment_settings.router,  prefix="/api/v1")           # /api/v1/clients/me/payment-settings — своя платёжная система клиента (миграция 257)
# Автообзвоны — интеграция с сервисом Звонопёс (миграция 359).
# public_router — приём результата звонка вебхуком: авторизации у него нет,
# отправитель сверяется по IP внутри обработчика.
app.include_router(client_call_settings.router,     prefix="/api/v1")           # /api/v1/clients/me/call-settings
app.include_router(call_campaigns.router,           prefix="/api/v1")           # /api/v1/call-campaigns
app.include_router(call_campaigns.public_router,    prefix="/api/v1")           # /api/v1/public/calls/webhook
# Автонастройка Telegram «под ключ» — разовая услуга (миграция 364).
app.include_router(tg_autosetup.router,             prefix="/api/v1")           # /api/v1/clients/me/tg-autosetup
app.include_router(tg_autosetup.leadpay_webhook_router,  prefix="/api/v1")      # оплата услуги (LeadPay)
app.include_router(tg_autosetup.prodamus_webhook_router, prefix="/api/v1")      # оплата услуги (Продамус)
app.include_router(admin_tg_setup.router,           prefix="/api/v1")           # /api/v1/admin/tg-setup/*
# Автонастройка Telegram «под ключ» — разовая услуга (миграция 364).
app.include_router(event_orders.router)                                         # /api/v1/public/event-orders — заказ тарифа события с лендинга
app.include_router(event_orders.webhook_router)                                 # /api/v1/integrations/client-pay/leadpay — оплата тарифа пришла
app.include_router(partner_program.router,          prefix="/api/v1")           # /api/v1/partner-program — раздел клиента «Моя партнёрка» (миграции 346-348)
app.include_router(partner_public.router,           prefix="/api/v1")           # /api/v1/public/partner — кабинет партнёра клиента и регистрация
app.include_router(event_page_html.router)                                     # GET /event/{slug} — простая серверная HTML-страница события (витрина + реф-кабинет)
app.include_router(medialift_cabinet_html.router)                              # GET /medialift/me — веб-кабинет участника МедиаЛифта
app.include_router(events_list_page.router)                                    # GET /o/{client_id} — серверная HTML-страница «Все события клиента» (как HubSelector Mini App)
app.include_router(client_chat_gates.router, prefix="/api/v1")                 # /api/v1/clients/me/chat-gates — гейт по подписке в TG-чатах (миграция 115)
app.include_router(client_broadcast_chats.router, prefix="/api/v1")            # /api/v1/clients/me/broadcast-chats — база чатов клиента для рассылок (миграция 170)
app.include_router(client_domains_api.router, prefix="/api/v1")                # /api/v1/clients/me/domains — свои домены клиента: страницы + почта (миграция 270)
app.include_router(client_domains_api.public_router, prefix="/api/v1")        # /api/v1/public/domain/home — что открывать на корне клиентского домена (миграция 278)
app.include_router(pricing_public.router)                                      # /api/v1/public/tariffs, /api/v1/public/promotions/active — для лендинга pluson.ru (миграции 116-119)
app.include_router(subscriptions.router,         prefix="/api/v1")              # /api/v1/subscriptions/order, /orders — оплата подписки клиентом (миграция 120)
app.include_router(subscriptions.webhook_router, prefix="/api/v1")              # /api/v1/integrations/prodamus/webhook — webhook от Prodamus (миграция 120)
app.include_router(subscriptions.leadpay_webhook_router, prefix="/api/v1")      # /api/v1/integrations/leadpay/webhook — webhook от LeadPay (миграция 188)
app.include_router(subscriptions.admin_router,   prefix="/api/v1")              # /api/v1/admin/orders — список всех оплат подписок
app.include_router(addons.router,                prefix="/api/v1")              # /api/v1/addons — модули-аддоны (миграция 165)
app.include_router(addons.webhook_router,        prefix="/api/v1")              # /api/v1/integrations/prodamus/addon-webhook — оплата модуля
app.include_router(addons.leadpay_webhook_router, prefix="/api/v1")             # /api/v1/integrations/leadpay/addon-webhook — оплата модуля LeadPay (миграция 188)
app.include_router(referrals.router,             prefix="/api/v1")              # /api/v1/referrals/me, /withdraw — реф-программа (миграции 125-126)
app.include_router(referrals.pay_router,         prefix="/api/v1")              # /api/v1/subscriptions/pay-with-bonus — оплата бонусами
app.include_router(referrals.admin_router,       prefix="/api/v1")              # /api/v1/admin/withdrawals — обработка заявок
app.include_router(tournament.router,            prefix="/api/v1")              # /api/v1/events/{id}/tournament — оценки участников турнира (миграция 132)
app.include_router(tournament.jury_router)                                      # /api/v1/public/tournament-jury — кабинет жюри (миграция 132)
app.include_router(collab_hub.router,            prefix="/api/v1")              # /api/v1/collab-hub — Коллабораторная: карточка, каталог, ниши, рейтинг (миграция 134)
app.include_router(collab_events.router,         prefix="/api/v1")              # /api/v1/collab — запросы, co-ownership, сват, отзывы (миграция 134)
app.include_router(webinar_room.router,          prefix="/api/v1")              # /api/v1/events/{id}/webinar — вебинарная комната: CRUD, блоки, опросы/батлы, аналитика (миграция 221)
app.include_router(webinar_room.internal_router, prefix="/api/v1")              # /api/v1/internal/webinar/stream — хук MediaMTX (X-Bridge-Token)
app.include_router(webinar_public.router)                                       # /api/v1/public/webinar/{slug}/{day} — зритель: heartbeat, чат, реакции, формы, опросы
app.include_router(webinar_public.ws_router)                                    # /ws/webinar/{slug}/{day} — WebSocket realtime


@app.get("/", tags=["health"])
async def root():
    return {"service": "PLUSSON API", "version": "1.0.0", "status": "ok"}


@app.get("/health", tags=["health"])
async def health():
    return {"status": "healthy"}
