"""
Интеграция с сервисом Звонопёс (calldog.ru) — автообзвоны (миграция 359).

Клиент подключает СВОЙ аккаунт: ключ его, деньги за звонки его, ответственность
перед ФАС его. Мы даём интерфейс поверх их API.

⚠️ БАЗУ НОМЕРОВ СЕРВИСУ НЕ ПЕРЕДАЁМ И НЕ СИНХРОНИЗИРУЕМ. У Звонопса нет метода
«загрузить базу» и он не нужен: номера уходят массивом `phones` прямо в запросе
на звонок. База живёт у нас. Иначе неминуемо разъехались бы отписки — у нас
человек отказался от звонков, а в их старом списке остался.

⚠️ СЦЕНАРИЙ ЗВОНКА ЖИВЁТ В ИХ КАБИНЕТЕ шаблоном (templateId): что говорит робот,
что по нажатию 1, куда переадресовать. Мы шлём номера + templateId + переменные.
Свой редактор сценариев не строим — он дублировал бы их кабинет и расходился с
ним при каждой правке на их стороне.

Документация: apiInstruction.pdf от сервиса. Ключ выдаёт их менеджер — в
кабинете он не берётся.
"""
import json
import logging
import re
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

BASE_URL = "https://lk.calldog.ru"

# Реферальная ссылка на регистрацию в Звонопсе (наша).
SIGNUP_URL = "https://lk.calldog.ru?utm_ref_id=67da73ff05315"

# Их эндпоинты (все POST, кроме getAvailableLanguages).
_EP_CREATE_WITH_TEMPLATE = "/apiCalls/createWithTemplate"
_EP_CREATE = "/apiCalls/create"
_EP_GET = "/apiCalls/getWithTemplates"
_EP_TEMPLATES = "/apiCalls/getTemplates"
_EP_PHONES = "/apiCalls/getPhones"
_EP_USER_INFO = "/apiCalls/userInfo"
_EP_REMOVE = "/apiCalls/remove"
_EP_BLACKLIST = "/apiBlacklist/addPhonesFromApi"

# ⚠️ Их лимит на пачку. В документации 5000 указан для чтения статусов; тем же
# размером режем и отправку — большая база уйдёт несколькими запросами.
MAX_PHONES_PER_REQUEST = 5000

# Сколько ждём их ответ. Обзвон на 5000 номеров они принимают не мгновенно.
_TIMEOUT = 60.0

# ⚠️ Вебхуки о результате звонка приходят С ЭТОГО АДРЕСА (указан в их
# документации). Проверяем его в обработчике: у вебхука нет подписи, и без
# сверки адреса кто угодно мог бы прислать нам поддельный результат.
WEBHOOK_SOURCE_IP = "82.202.206.194"

# Их статусы звонка → наши (call_log.status).
# finished — поговорил, canceled — не состоялся, created/processed — ещё идёт.
_STATUS_MAP = {
    "finished": "answered",
    "canceled": "no_answer",
    "created": "queued",
    "processed": "queued",
    "started": "queued",
    "answered": "answered",
}


class CalldogError(Exception):
    """Сервис отказал. Текст — уже человекочитаемый, показываем клиенту."""


def is_configured(client: dict) -> bool:
    """Можно ли звонить: есть ключ и есть с какого номера.

    ⚠️ Номер обязателен — без outgoingPhone (или дежурных номеров) сервис
    звонок не создаст. Проверять только наличие ключа недостаточно: клиент
    сохранил бы ключ, нажал «Обзвонить» и получил невнятную ошибку от них.
    """
    key = (client.get("calls_calldog_api_key") or "").strip()
    if not key:
        return False
    phone = (client.get("calls_calldog_outgoing_phone") or "").strip()
    duty = bool(client.get("calls_calldog_duty_phone"))
    return bool(phone or duty)


def normalize_phone_for_calldog(phone_normalized: str) -> Optional[str]:
    """Наш phone_normalized → формат Звонопса (11 цифр, без плюса).

    ⚠️ У нас phone_normalized — это ТОЛЬКО ЦИФРЫ без плюса (миграция 328), и
    российские уже приведены к 7XXXXXXXXXX. Здесь остаётся лишь отсеять то, что
    сервис не примет: у него string(11).

    Возвращает None для номера, который звонить нельзя, — такие отсеиваем ДО
    отправки. Иначе они съедят деньги на неуспешных попытках и засорят отчёт;
    на проде таких 540 из 3902.
    """
    if not phone_normalized:
        return None
    digits = re.sub(r"\D", "", str(phone_normalized))
    if len(digits) != 11:
        return None
    # 7XXXXXXXXXX — Россия и Казахстан. Другие коды их формат не принимает.
    if not digits.startswith("7"):
        return None
    return digits


async def _post(api_key: str, endpoint: str, payload: dict) -> Any:
    """POST к их API. Ключ кладётся в тело — так у них устроена авторизация."""
    body = {"apiKey": api_key, **payload}
    url = f"{BASE_URL}{endpoint}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as cli:
            resp = await cli.post(
                url,
                content=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "accept": "application/json",
                },
            )
    except httpx.TimeoutException:
        raise CalldogError(
            "Звонопёс не ответил вовремя. Попробуйте позже — если обзвон уже "
            "создан на их стороне, повторный запуск сделает второй звонок."
        )
    except httpx.HTTPError as e:
        logger.warning("calldog request failed: %s", e)
        raise CalldogError("Не удалось связаться со Звонопсом. Проверьте интернет и попробуйте снова.")

    if resp.status_code in (401, 403):
        raise CalldogError("Звонопёс не принял API-ключ. Проверьте ключ в настройках.")
    if resp.status_code >= 500:
        raise CalldogError("Звонопёс сейчас недоступен (ошибка на их стороне). Попробуйте позже.")

    try:
        data = resp.json()
    except Exception:
        raise CalldogError(f"Звонопёс вернул неожиданный ответ (код {resp.status_code}).")

    # Их формат: {"status": "success"|"error", "data": ...}
    if isinstance(data, dict) and str(data.get("status", "")).lower() == "error":
        raise CalldogError(_error_text(data))
    if resp.status_code >= 400:
        raise CalldogError(_error_text(data) or f"Звонопёс отклонил запрос (код {resp.status_code}).")
    return data


def _error_text(data: Any) -> str:
    """Вытащить понятную причину из их ответа об ошибке."""
    if not isinstance(data, dict):
        return "Звонопёс отклонил запрос."
    for key in ("message", "error", "errors", "data"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return f"Звонопёс: {val.strip()}"
        if isinstance(val, dict):
            parts = []
            for field, msgs in val.items():
                if isinstance(msgs, list):
                    parts.append(f"{field}: {'; '.join(str(m) for m in msgs)}")
                else:
                    parts.append(f"{field}: {msgs}")
            if parts:
                return "Звонопёс: " + "; ".join(parts)
        if isinstance(val, list) and val:
            return "Звонопёс: " + "; ".join(str(v) for v in val)
    return "Звонопёс отклонил запрос."


async def get_user_info(api_key: str) -> dict:
    """Баланс и id аккаунта. Заодно — проверка, что ключ рабочий."""
    data = await _post(api_key, _EP_USER_INFO, {})
    if isinstance(data, dict) and "data" in data and isinstance(data["data"], dict):
        return data["data"]
    return data if isinstance(data, dict) else {}


async def get_phones(api_key: str) -> list[dict]:
    """Исходящие номера аккаунта — клиент выбирает, с какого звонить.

    ⚠️ Номер должен быть подтверждён в их кабинете; неподтверждённый приходит
    с enable=false, и звонок с него не создастся.
    """
    data = await _post(api_key, _EP_PHONES, {"all": True})
    rows = data.get("data") if isinstance(data, dict) else None
    return rows if isinstance(rows, list) else []


async def get_templates(api_key: str, only_moderated: bool = True) -> list[dict]:
    """Шаблоны сценариев звонка из их кабинета.

    ⚠️ По умолчанию только отмодерированные: незаверенный шаблон не позвонит, и
    клиент не поймёт, почему обзвон «запустился, но тишина».
    """
    data = await _post(api_key, _EP_TEMPLATES, {"onlyModerated": 1 if only_moderated else 0})
    rows = data.get("data") if isinstance(data, dict) else None
    return rows if isinstance(rows, list) else []


async def create_calls_with_template(
    api_key: str,
    *,
    template_id: int,
    phones: list[str],
    outgoing_phone: Optional[str] = None,
    duty_phone: bool = False,
    planned_at: Optional[int] = None,
    smart_delay: Optional[int] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    weekdays: Optional[list[int]] = None,
    webhook_url: Optional[str] = None,
    webhook_parameters: Optional[dict] = None,
    variables: Optional[dict] = None,
) -> list[dict]:
    """Запустить обзвон по шаблону. Возвращает список созданных звонков.

    ⚠️ Пачка не больше MAX_PHONES_PER_REQUEST — резать должен вызывающий:
    здесь мы не знаем, как он хочет логировать частичный успех.
    """
    if not phones:
        return []
    if len(phones) > MAX_PHONES_PER_REQUEST:
        raise CalldogError(
            f"За один запрос можно отправить не больше {MAX_PHONES_PER_REQUEST} номеров."
        )

    payload: dict = {"templateId": int(template_id), "phones": list(phones)}

    # Номер, с которого звоним. dutyPhone=1 — пусть выберут сами из дежурных.
    if duty_phone:
        payload["dutyPhone"] = 1
    elif outgoing_phone:
        payload["outgoingPhone"] = outgoing_phone
    else:
        raise CalldogError(
            "Не выбран номер, с которого звоним. Укажите его в настройках."
        )

    if planned_at:
        payload["plannedAt"] = int(planned_at)
    if smart_delay:
        # Их границы: 2..1440 минут. Выход за них они отклоняют целиком.
        payload["smartDelay"] = max(2, min(1440, int(smart_delay)))
    # ⚠️ Окно дозвона: звонок в 7 утра — это жалоба и штраф. Их формат "HH:MM".
    if start_time:
        payload["startTime"] = start_time
    if end_time:
        payload["endTime"] = end_time
    if weekdays:
        payload["weekdays"] = list(weekdays)
    if webhook_url:
        payload["webhookUrl"] = webhook_url
        # Их поле — JSON-СТРОКА, а не объект. Объект они не разберут.
        if webhook_parameters:
            payload["webhookParameters"] = json.dumps(webhook_parameters, ensure_ascii=False)
    if variables:
        payload["variables"] = variables

    data = await _post(api_key, _EP_CREATE_WITH_TEMPLATE, payload)
    rows = data.get("data") if isinstance(data, dict) else None
    return rows if isinstance(rows, list) else []


async def add_to_blacklist(api_key: str, phones: list[dict]) -> dict:
    """Добавить номера в чёрный список Звонопса.

    `phones` — [{"phone": "7...", "comment": "..."}].
    Зовётся, когда человек нажал «не звоните»: мало пометить у себя — сервис
    должен перестать звонить и по другим кампаниям тоже.
    """
    if not phones:
        return {}
    data = await _post(api_key, _EP_BLACKLIST, {"phones": phones})
    return data if isinstance(data, dict) else {}


async def remove_calls(api_key: str, id_list: list[int], is_template: bool = True) -> dict:
    """Отменить запланированные звонки.

    ⚠️ is_template обязателен для звонков, созданных из шаблона, иначе сервис
    их не удалит и деньги спишутся.
    """
    if not id_list:
        return {}
    payload: dict = {"idList": [int(i) for i in id_list]}
    if is_template:
        payload["isTemplate"] = 1
    data = await _post(api_key, _EP_REMOVE, payload)
    return data if isinstance(data, dict) else {}


def map_status(external_status: Optional[str], answered_at: Any = None) -> str:
    """Их статус звонка → наш call_log.status."""
    s = (external_status or "").strip().lower()
    mapped = _STATUS_MAP.get(s)
    if mapped:
        return mapped
    # Статуса нет, но человек ответил — считаем состоявшимся.
    if answered_at:
        return "answered"
    return "queued"


async def check_credentials(api_key: str) -> dict:
    """Проверить ключ без совершения звонков — кнопка «Проверить связь».

    Показываем баланс и число доступных номеров: клиент сразу видит, что ключ
    рабочий и с чего можно звонить.
    """
    key = (api_key or "").strip()
    if not key:
        return {"ok": False, "message": "Укажите API-ключ."}
    try:
        info = await get_user_info(key)
    except CalldogError as e:
        return {"ok": False, "message": str(e)}

    result = {"ok": True, "balance": info.get("balance")}
    try:
        phones = await get_phones(key)
        result["phones_count"] = len([p for p in phones if p.get("enable")])
    except CalldogError:
        # Баланс уже получен — ключ рабочий. Номера не критичны для проверки.
        result["phones_count"] = None
    result["message"] = "Связь со Звонопсом установлена."
    return result
