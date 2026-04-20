from celery import Celery
from celery.schedules import crontab
from app.config import settings

celery = Celery(
    "plusson",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.tasks.broadcast"]
)

celery.conf.update(
    timezone="Europe/Moscow",
    enable_utc=True,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    beat_schedule={
        # Каждую минуту проверяем расписание рассылок
        "check-broadcasts": {
            "task": "app.tasks.broadcast.check_and_send_broadcasts",
            "schedule": 60.0,
        },
    }
)
