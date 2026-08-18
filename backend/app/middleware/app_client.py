"""Клиент, ЧЬЁ приложение открыто, — из заголовка `X-Plusson-Client`.

⚠️ ЗАЧЕМ. Mini App у каждого организатора свой (`pluson.ru/c/{N}/tg/`), и
бэкенд обязан знать, в чьём приложении сидит человек. Иначе у КОЛЛАБЫ (где
владельцев несколько и они равноправны) берётся «первый из event_owners» —
чужой организатор: человеку пишет чужой бот, ссылки ведут в чужой кабинет,
контакт заводится в чужой базе.

⚠️ ПОЧЕМУ ЗАГОЛОВОК, А НЕ ПАРАМЕТР. Путей входа много — ссылка с реф-кодом,
календарь, deeplink, переход между вкладками, — и в половине из них параметра
просто нет. Дописывать `cid` в каждый запрос значит чинить поштучно: ровно так
баг всплывал снова и снова в течение суток (прод, событие 92). Заголовок
ставится один раз в общем слое запросов Mini App и приезжает со ВСЕМИ.

Значение — подсказка, а не право доступа: `resolve_event_client` всё равно
проверяет, что этот клиент действительно организатор события.
"""
import contextvars
from typing import Optional

from starlette.middleware.base import BaseHTTPMiddleware

_app_client: contextvars.ContextVar[Optional[int]] = contextvars.ContextVar(
    "plusson_app_client", default=None,
)


def get_app_client_id() -> Optional[int]:
    """Клиент открытого Mini App для текущего запроса (None — заголовка не было)."""
    return _app_client.get()


class AppClientMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        raw = request.headers.get("X-Plusson-Client") or ""
        token = None
        try:
            if raw.isdigit():
                token = _app_client.set(int(raw))
            else:
                token = _app_client.set(None)
            return await call_next(request)
        finally:
            if token is not None:
                _app_client.reset(token)
