from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from contextlib import asynccontextmanager
from app.config import settings
from app.database import get_pool, close_pool
from app.middleware.subscription_guard import subscription_guard_middleware
from app.middleware.assistant_permission_guard import assistant_permission_guard_middleware
from app.api import auth, events, gifts, participants, referral, admin, event, collaborators, integrations, subscription_check, contacts, lead_magnets, lead_magnet_packages, funnels, referral_program, platforms, channels, uploads, client_profile, event_raffle, event_raffle_public, tg_utils, vk_event, max_event, max_webhook, event_nurture, email_unsubscribe, legal, email_tracking, assistants, partner, speaker_cabinet
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

# Подключаем роутеры
app.include_router(auth.router,         prefix="/api/v1")
app.include_router(events.router,       prefix="/api/v1")
app.include_router(gifts.router,        prefix="/api/v1")
app.include_router(gifts_compat,        prefix="/api/v1")  # совместимость: /events/slug/{slug}/gifts/
app.include_router(participants.router, prefix="/api/v1")
app.include_router(admin.router,        prefix="/api/v1")
app.include_router(conference.router,   prefix="/api/v1")
app.include_router(broadcasts.router,   prefix="/api/v1")
app.include_router(broadcasts_general.router, prefix="/api/v1")
app.include_router(collaborators.router)
app.include_router(event.router,        prefix="/api/v1")  # POST /api/v1/event
app.include_router(vk_event.router,     prefix="/api/v1")  # POST /api/v1/vk/event (миграция 2026-05-19)
app.include_router(max_event.router,    prefix="/api/v1")  # POST /api/v1/max/event (миграция 2026-05-20)
app.include_router(max_webhook.router,  prefix="/api/v1")  # POST /api/v1/max/webhook/{secret}
app.include_router(referral.router)     # /api/v1/referral/conversion
app.include_router(integrations.router, prefix="/api/v1")
app.include_router(subscription_check.router)  # /api/v1/public/...
app.include_router(contacts.router,     prefix="/api/v1")
app.include_router(lead_magnets.router, prefix="/api/v1")
app.include_router(lead_magnet_packages.router, prefix="/api/v1")  # пакеты лид-магнитов (миграция 062)
app.include_router(funnels.template_router, prefix="/api/v1")      # шаблоны воронок (миграция 063)
app.include_router(funnels.public_router)                          # /m/{slug}, /p/{slug}
app.include_router(partner.public_router)                          # /partner/{client_id} (миграция 105)
app.include_router(referral_program.router, prefix="/api/v1")
app.include_router(platforms.router,    prefix="/api/v1")  # справочник платформ (миграция 036)
app.include_router(channels.router,     prefix="/api/v1")  # каналы клиента (миграция 036)
app.include_router(uploads.router,      prefix="/api/v1")  # POST /uploads, DELETE /uploads/{id}, GET /storage/usage (миграция 037)
app.include_router(client_profile.public,           prefix="/api/v1")  # /api/v1/public/clients/{id}/profile|offerings|events; /events/{slug}/landing
app.include_router(client_profile.profile_router,   prefix="/api/v1")  # /api/v1/clients/me/profile (миграция 039)
app.include_router(client_profile.offerings_router, prefix="/api/v1")  # /api/v1/client-offerings (миграция 039)
app.include_router(event_raffle.router,             prefix="/api/v1")  # /api/v1/events/{id}/raffle/{settings|prizes|keywords|tickets|participants|winners|draw} (миграции 042, 056)
app.include_router(event_raffle_public.router,            prefix="/api/v1")  # Mini App: /events/{slug}/raffle/{free-ticket|keyword|me} (миграция 056)
app.include_router(event_raffle_public.event_root_router, prefix="/api/v1")  # Mini App: /events/{slug}/live — отметка «в эфире» (миграция 056)
app.include_router(tg_utils.router,                       prefix="/api/v1")  # /api/v1/utils/resolve-tg-chat-id
app.include_router(event_nurture.router,                  prefix="/api/v1")  # /api/v1/events/{id}/nurture/steps (миграция 088)
app.include_router(email_unsubscribe.router)                                   # /api/v1/email/unsubscribe (миграции 097-098)
app.include_router(legal.router)                                               # юр-данные клиента + публичная страничка политики (миграция 099)
app.include_router(email_tracking.router)                                      # /api/v1/email/pixel/{token}.gif, /api/v1/email/click (миграция 098)
app.include_router(assistants.router,   prefix="/api/v1")                      # /api/v1/clients/me/assistant — управление ассистентом (миграция 106)
app.include_router(speaker_cabinet.router)                                     # /api/v1/public/speaker-cabinet — мини-кабинет спикера (миграция 108)


@app.get("/", tags=["health"])
async def root():
    return {"service": "PLUSSON API", "version": "1.0.0", "status": "ok"}


@app.get("/health", tags=["health"])
async def health():
    return {"status": "healthy"}
