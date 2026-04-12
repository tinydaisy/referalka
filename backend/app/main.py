from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from app.config import settings
from app.database import get_pool, close_pool
from app.api import auth, events, gifts, participants, referral, admin, event, speakers
from app.api.modules import conference


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
    description="Реферальный сервис ПЛЮСОН — платформа управляемого вирального роста",
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

# Подключаем роутеры
app.include_router(auth.router,         prefix="/api/v1")
app.include_router(events.router,       prefix="/api/v1")
app.include_router(gifts.router,        prefix="/api/v1")
app.include_router(participants.router, prefix="/api/v1")
app.include_router(admin.router,        prefix="/api/v1")
app.include_router(conference.router,   prefix="/api/v1")
app.include_router(speakers.router)
app.include_router(event.router,        prefix="/api/v1")  # POST /api/v1/event
app.include_router(referral.router)     # /r/{ref_code} и /api/v1/referral/conversion


@app.get("/", tags=["health"])
async def root():
    return {"service": "PLUSSON API", "version": "1.0.0", "status": "ok"}


@app.get("/health", tags=["health"])
async def health():
    return {"status": "healthy"}
