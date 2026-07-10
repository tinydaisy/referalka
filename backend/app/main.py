from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from contextlib import asynccontextmanager
from app.config import settings
from app.database import get_pool, close_pool
from app.middleware.subscription_guard import subscription_guard_middleware
from app.middleware.assistant_permission_guard import assistant_permission_guard_middleware
from app.middleware.email_verification_guard import email_verification_guard_middleware
from app.api import auth, events, gifts, participants, referral, admin, event, collaborators, collaborator_posters, integrations, subscription_check, contacts, lead_magnets, lead_magnet_packages, funnels, referral_program, platforms, channels, uploads, client_profile, event_raffle, event_raffle_public, tg_utils, vk_event, max_event, max_webhook, event_nurture, event_nurture_reg, email_unsubscribe, legal, email_tracking, assistants, partner, speaker_cabinet, landing_widget, client_chat_gates, announcement_tracker, pricing_public, subscriptions, referrals, participants_export, contacts_export, event_page_html, events_list_page, tournament, collab_hub, collab_events, event_tariffs, dialogs, event_chat_greetings, addons, client_broadcast_chats, pluson_connect, medialift, medialift_cabinet_html, analytics
from app.api.gifts import router_compat as gifts_compat
from app.api.modules import conference, broadcasts
from app.api import broadcasts_general


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    if settings.database_url:
        await get_pool()
    yield
    # Shutdown
    await close_pool()


app = FastAPI(
    title="PLUSSON API",
    description="ПЛЮСОН — платформа событийного и реферального маркетинга",
    version="1.0.0",
    lifespan=lifespan
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
app.include_router(collaborator_posters.router)                                # /api/v1/collaborators/{id}/posters — библиотека афиш (миграция 121)
app.include_router(event.router,        prefix="/api/v1")  # POST /api/v1/event
app.include_router(vk_event.router,     prefix="/api/v1")  # POST /api/v1/vk/event (миграция 2026-05-19)
app.include_router(max_event.router,    prefix="/api/v1")  # POST /api/v1/max/event (миграция 2026-05-20)
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
app.include_router(lead_magnets.router, prefix="/api/v1")
app.include_router(lead_magnet_packages.router, prefix="/api/v1")  # пакеты лид-магнитов (миграция 062)
app.include_router(funnels.template_router, prefix="/api/v1")      # шаблоны воронок (миграция 063)
app.include_router(funnels.public_router)                          # /m/{slug}, /p/{slug}
app.include_router(partner.public_router)                          # /partner/{client_id} (миграция 105)
app.include_router(referral_program.router, prefix="/api/v1")
app.include_router(announcement_tracker.router, prefix="/api/v1")  # трекер анонсов спикеров (миграция 124)
app.include_router(platforms.router,    prefix="/api/v1")  # справочник платформ (миграция 036)
app.include_router(channels.router,     prefix="/api/v1")  # каналы клиента (миграция 036)
app.include_router(uploads.router,      prefix="/api/v1")  # POST /uploads, DELETE /uploads/{id}, GET /storage/usage (миграция 037)
app.include_router(client_profile.public,           prefix="/api/v1")  # /api/v1/public/clients/{id}/profile|offerings|events; /events/{slug}/landing
app.include_router(client_profile.profile_router,   prefix="/api/v1")  # /api/v1/clients/me/profile (миграция 039)
app.include_router(client_profile.offerings_router, prefix="/api/v1")  # /api/v1/client-offerings (миграция 039)
app.include_router(event_raffle.router,             prefix="/api/v1")  # /api/v1/events/{id}/raffle/{settings|prizes|keywords|tickets|participants|winners|draw} (миграции 042, 056)
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
app.include_router(email_tracking.router)                                      # /api/v1/email/pixel/{token}.gif, /api/v1/email/click (миграция 098)
app.include_router(assistants.router,   prefix="/api/v1")                      # /api/v1/clients/me/assistants — помощники кабинета (миграции 106, 209)
app.include_router(speaker_cabinet.router)                                     # /api/v1/public/speaker-cabinet — мини-кабинет спикера (миграция 108)
app.include_router(landing_widget.router)                                      # /api/v1/public/landing-widget — JSON для сторонних лендингов (миграция 111)
app.include_router(event_page_html.router)                                     # GET /event/{slug} — простая серверная HTML-страница события (витрина + реф-кабинет)
app.include_router(medialift_cabinet_html.router)                              # GET /medialift/me — веб-кабинет участника МедиаЛифта
app.include_router(events_list_page.router)                                    # GET /o/{client_id} — серверная HTML-страница «Все события клиента» (как HubSelector Mini App)
app.include_router(client_chat_gates.router, prefix="/api/v1")                 # /api/v1/clients/me/chat-gates — гейт по подписке в TG-чатах (миграция 115)
app.include_router(client_broadcast_chats.router, prefix="/api/v1")            # /api/v1/clients/me/broadcast-chats — база чатов клиента для рассылок (миграция 170)
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


@app.get("/", tags=["health"])
async def root():
    return {"service": "PLUSSON API", "version": "1.0.0", "status": "ok"}


@app.get("/health", tags=["health"])
async def health():
    return {"status": "healthy"}
