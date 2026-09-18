"""
Ссылки в наших ботов поддержки — ОДНА функция на все площадки.

Отсюда берутся и «Написать в тех.поддержку», и «шаг ноль» автонастройки:
разница между ними только в `reason`, всё остальное общее. Появится ВК —
добавится одна строка в `PLATFORMS`, и обе кнопки заработают в нём сразу.

⚠️⚠️ ПАРАМЕТР У ПЛОЩАДОК НАЗЫВАЕТСЯ ПО-РАЗНОМУ: у Telegram и MAX это `start`,
у ВКонтакте — `ref`. Знать это обязана ТОЛЬКО эта функция. Иначе каждое место,
где строится ссылка, помнило бы особенности всех площадок — и при подключении
ВК их пришлось бы искать по всему проекту.

⚠️⚠️ В `start` У TELEGRAM МОЖНО ТОЛЬКО [A-Za-z0-9_-], ДО 64 СИМВОЛОВ.
Кириллица ссылку просто ломает — она не откроется. Поэтому по ссылке едет
КОРОТКИЙ ЛАТИНСКИЙ КОД причины (`zero`, `question`), а человеческий текст
живёт в боте (`REASON_TEXTS`). Плюс это позволяет менять формулировку, не
трогая ни одной ссылки.

⚠️ ПОДПИСЬ ОБЯЗАТЕЛЬНА. Без неё любой подставит в ссылку чужой client_id и
отметит подписку за другого человека. Подпись короткая (10 символов) — в 64
символа `start` полноценный JWT не помещается, а для параметра, который живёт
минуты и ничего не открывает сам по себе, этого достаточно.
"""
import hashlib
import hmac
import re
from typing import Optional

from app.config import settings

# Площадки: слаг → как собрать ссылку.
# ⚠️ Слаги те же, что в channels.platform_slug — чтобы не заводить второй
# словарь соответствий.
PLATFORMS: dict[str, dict] = {
    "telegram": {
        "label": "Telegram",
        "base": "https://telegram.me/pluson_bot",
        "param": "start",
    },
    "max": {
        "label": "MAX",
        "base": "https://max.ru/id890306512862_1_bot",
        "param": "start",
    },
    # ⚠️ ВК пока не подключён — строка лежит готовой и намеренно выключена
    # (`enabled: False`): экран показывает площадку серой, «скоро», и ничего
    # не ломается. Подключим бота — снимем флаг и впишем id сообщества.
    "vk": {
        "label": "ВКонтакте",
        "base": "",
        "param": "ref",
        "enabled": False,
    },
}

_SIG_LEN = 10


def _sign(payload: str) -> str:
    """Короткая подпись параметра — привязана к тому же секрету, что и токены."""
    digest = hmac.new(
        settings.jwt_secret.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()
    return digest[:_SIG_LEN]


def make_support_param(*, reason: str, client_id: Optional[int] = None) -> str:
    """Значение параметра ссылки: `question` или `zero-<client_id>-<подпись>`.

    ⚠️ Без `client_id` подпись не нужна: параметр никого не опознаёт, он лишь
    говорит боту, с какого экрана пришёл человек. Так работает нынешняя кнопка
    «Написать в тех.поддержку» — её ссылки остаются прежними.
    """
    reason = (reason or "question").strip() or "question"
    if client_id is None:
        return reason
    payload = f"{reason}-{int(client_id)}"
    return f"{payload}-{_sign(payload)}"


def parse_support_param(value: str) -> dict:
    """Разбирает параметр обратно: {reason, client_id}.

    `client_id` возвращается ТОЛЬКО если подпись сошлась — иначе None, и
    подписку мы никому не засчитываем.
    """
    out: dict = {"reason": "question", "client_id": None}
    if not value:
        return out

    value = value.strip()
    parts = value.split("-")
    if len(parts) != 3:
        # Обычный параметр без опознания — `question` и прочие.
        out["reason"] = re.sub(r"[^a-zA-Z0-9_]", "", value)[:32] or "question"
        return out

    reason, raw_id, sig = parts
    if not raw_id.isdigit():
        return out
    # ⚠️ hmac.compare_digest, а не `==`: обычное сравнение строк выходит из
    # цикла на первом несовпавшем символе, и по времени ответа подпись можно
    # подобрать посимвольно.
    if not hmac.compare_digest(_sign(f"{reason}-{raw_id}"), sig):
        return out

    out["reason"] = reason
    out["client_id"] = int(raw_id)
    return out


def support_url(platform: str, *, reason: str = "question",
                client_id: Optional[int] = None) -> str:
    """Готовая ссылка в бота поддержки на нужной площадке.

    Пустая строка — если площадка ещё не подключена (ВК): вызывающий код
    показывает её как «скоро» и не делает ссылку.
    """
    cfg = PLATFORMS.get(platform)
    if not cfg or not cfg.get("base") or cfg.get("enabled") is False:
        return ""
    param = make_support_param(reason=reason, client_id=client_id)
    return f"{cfg['base']}?{cfg['param']}={param}"
