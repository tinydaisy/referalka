"""Автонастройка Telegram «под ключ» — работа от лица живого аккаунта.

ЗАЧЕМ ЭТОТ ФАЙЛ.
Клиент оплачивает услугу, и вместо получасовой переписки с поддержкой всё
делается само: создаётся бот, к нему привязывается Mini App, заводится
закрытая группа уведомлений, туда добавляется бот, а клиенту передаются права.

⚠️ ПОЧЕМУ ЗДЕСЬ TELETHON, А НЕ BOT API.
Bot API не умеет ничего из перечисленного: ботов создаёт только @BotFather в
переписке, и говорить с ним может лишь живой аккаунт-человек (MTProto).
Поэтому здесь Telethon и файл сессии, а не токен.

⚠️ ПОЧЕМУ КОД ЖИВЁТ В ПЛЮСОНЕ, А НЕ В МЕЙЛЕРЕ.
У мейлера нет машинного API (только веб-кабинет со входом по паролю), и он
стоит на другом сервере. Связь между двумя серверами была бы лишней точкой
отказа, а очередь и заказы всё равно живут в базе ПЛЮСОНа.

⚠️ ОДНА СЕССИЯ — ОДИН СЕРВЕР.
Файл сессии Telethon нельзя использовать с двух машин одновременно: Telegram
ломает ключ авторизации (`AuthKeyDuplicatedError`), и аккаунт приходится
логинить заново. Поэтому аккаунт, отданный сюда, обязан быть выведен из мейлера.
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

BOTFATHER = "BotFather"
SPAMBOT = "SpamBot"

# Сколько ждём ответ BotFather. Он отвечает быстро, но под нагрузкой бывает
# задержка; лучше подождать лишнюю секунду, чем принять молчание за отказ.
REPLY_WAIT_SEC = 7
REPLY_POLL_SEC = 0.7

# Куда ведёт Mini App клиента. Адрес всегда на pluson.ru — он вбивается
# в BotFather намертво и на домен клиента не переезжает (см. CLAUDE.md,
# раздел про свой домен клиента).
MINIAPP_SHORT_NAME = "pluson"

# ─────────────────────────────────────────────────────────────────────────
# Транслитерация — чтобы предложить клиенту ник бота из названия его бренда
# ─────────────────────────────────────────────────────────────────────────
_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def translit(text: str) -> str:
    """«Клуб МедиаЛифт» → «klub_medialift». Только латиница, цифры и _."""
    out = []
    for ch in (text or "").lower():
        if ch in _TRANSLIT:
            out.append(_TRANSLIT[ch])
        elif ch.isalnum() and ch.isascii():
            out.append(ch)
        elif ch in " -_":
            out.append("_")
    slug = re.sub(r"_+", "_", "".join(out)).strip("_")
    return slug


def suggest_bot_usernames(brand: str, limit: int = 4) -> list[str]:
    """Варианты ника бота из названия бренда.

    ⚠️ Ник обязан заканчиваться на `bot` и укладываться в 5..32 символа —
    это требование Telegram, иначе BotFather просто откажет.
    """
    base = translit(brand)[:24].strip("_")
    if not base:
        base = "pluson"
    variants = [f"{base}_bot"]
    for suffix in ("plus", "club", "team", "pro"):
        v = f"{base}_{suffix}_bot"
        if len(v) <= 32:
            variants.append(v)
    # Короткий запасной вариант — если база длинная, к ней ничего не приклеить.
    short = base[:20].strip("_")
    if short and f"{short}_bot" not in variants:
        variants.append(f"{short}_bot")
    return [v for v in variants if 5 <= len(v) <= 32][:limit]


def validate_bot_username(username: str) -> Optional[str]:
    """Проверка ника по правилам Telegram. Возвращает текст ошибки или None."""
    u = (username or "").strip().lstrip("@")
    if not u:
        return "Введите имя бота"
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,31}", u):
        return ("Имя может состоять только из латинских букв, цифр и знака _, "
                "начинаться с буквы и быть длиной от 5 до 32 символов")
    if not u.lower().endswith("bot"):
        return "Имя должно заканчиваться на «bot» — этого требует Telegram"
    if "__" in u:
        return "Два знака _ подряд Telegram не принимает"
    return None


# ─────────────────────────────────────────────────────────────────────────
# Подключение к аккаунту
# ─────────────────────────────────────────────────────────────────────────
@dataclass
class SetupAccount:
    """Аккаунт, от лица которого идёт настройка (строка tg_setup_accounts)."""
    id: int
    phone: str
    twofa_password: str = ""
    proxy: str = ""
    session_path: str = ""
    username: str = ""
    tg_user_id: int = 0


def parse_proxy(url: str) -> Optional[dict]:
    """socks5://логин:пароль@хост:порт → словарь прокси для Telethon.

    ⚠️⚠️ ТРЕБУЕТСЯ `python-socks`, а не PySocks. Telethon 1.43 берёт прокси
    через python-socks, и `proxy_type` там — СТРОКА («socks5»), а не константа
    PySocks. Если python-socks не установлен, Telethon пишет в лог
    «proxy argument will be ignored» и идёт НАПРЯМУЮ — молча, без ошибки.
    Поймано на проде 07.09.2026: узбекский номер подключался с российского
    IP, то есть ровно то, за что Telegram блокирует аккаунты.

    ⚠️ Строку он принимает только как словарь или кортеж — голый URL даёт
    «Proxy of unknown format: <class 'str'>» (тоже проверено).

    ⚠️ Строка прокси у сервисов приходит с человекочитаемым хвостом вида
    «:Страна - Город[https://api...refresh-ip]» — его надо отрезать, иначе
    порт не распарсится.
    """
    s = (url or "").strip()
    if not s:
        return None
    # Отрезаем всё после порта: и «[…refresh-ip]», и «:Страна - Город».
    s = re.split(r"\[", s)[0]
    m = re.match(
        r"^(?P<scheme>socks5|socks4|http)://"
        r"(?:(?P<user>[^:@]+):(?P<password>[^@]*)@)?"
        r"(?P<host>[^:/]+):(?P<port>\d+)",
        s,
    )
    if not m:
        return None
    d = m.groupdict()
    out = {
        "proxy_type": d["scheme"],   # именно строкой — так ждёт python-socks
        "addr": d["host"],
        "port": int(d["port"]),
        "rdns": True,
    }
    if d.get("user"):
        out["username"] = d["user"]
        out["password"] = d.get("password") or ""
    return out


async def connect(acc: SetupAccount):
    """Поднимает клиент Telethon для аккаунта. Возвращает подключённый клиент.

    Бросает RuntimeError с текстом по-русски, если сессия мертва — этот текст
    уходит владельцу платформы в админку, а не клиенту.
    """
    from telethon import TelegramClient

    from app.config import settings

    api_id = int(getattr(settings, "tg_setup_api_id", 0) or 0)
    api_hash = getattr(settings, "tg_setup_api_hash", "") or ""
    if not api_id or not api_hash:
        raise RuntimeError(
            "Не заданы TG_SETUP_API_ID / TG_SETUP_API_HASH в настройках сервера"
        )

    session = acc.session_path or ""
    if session.endswith(".session"):
        session = session[: -len(".session")]
    if not session:
        raise RuntimeError(f"У аккаунта {acc.phone} не указан файл сессии")
    if not Path(session + ".session").exists():
        raise RuntimeError(f"Файл сессии не найден: {session}.session")

    client = TelegramClient(
        session, api_id, api_hash,
        proxy=parse_proxy(acc.proxy),
        # ⚠️ catch_up=False — не догонять пропущенные апдейты за оффлайн.
        # Иначе Telethon может залипнуть на разборе истории вместо работы.
        catch_up=False,
        # ⚠️⚠️ ЯЗЫК ЗАДАЁМ ЯВНО. Служебные боты Telegram (@SpamBot, @BotFather)
        # отвечают НА ЯЗЫКЕ АККАУНТА. Узбекский номер отвечал по-узбекски
        # («cheklov yoʻq» вместо «no limits»), разбор ответа этого не понимал,
        # и живой аккаунт получал health='unknown' — очередь берёт только 'ok',
        # то есть услуга не работала при исправном аккаунте.
        # Русский, а не английский: остальные тексты услуги на русском, и
        # ответы ботов удобнее читать в админке на одном языке.
        lang_code="ru",
        system_lang_code="ru",
    )
    await client.connect()
    if not await client.is_user_authorized():
        await client.disconnect()
        raise RuntimeError(
            f"Сессия аккаунта {acc.phone} мертва — нужен повторный вход по SMS"
        )
    return client


# ─────────────────────────────────────────────────────────────────────────
# Разговор с BotFather
# ─────────────────────────────────────────────────────────────────────────
async def _ask(client, peer: str, text: str, wait: float = REPLY_WAIT_SEC) -> str:
    """Пишет собеседнику и ждёт НОВЫЙ ответ.

    ⚠️ Ждём именно новое сообщение, а не «последнее в диалоге»: если просто
    поспать и прочитать последнее, можно принять прошлый ответ за свежий и
    пойти по ветке дальше с чужим текстом. Поэтому запоминаем id до отправки.

    ⚠️⚠️ ЖДЁМ ДОЛГО И НЕ СДАЁМСЯ РАНЬШЕ ВРЕМЕНИ. BotFather отвечает за
    доли секунды, когда с ним говорят впервые, но после серии команд подряд
    (а у нас именно так: проверка имени → создание → Mini App → передача)
    задержка доходит до десятка секунд. Пустой ответ при этом неотличим от
    отказа: код решал, что «Telegram не ответил», и ронял всю настройку на
    ровном месте — поймано на сквозной проверке 07.09.2026.
    """
    before = await client.get_messages(peer, limit=1)
    last_id = before[0].id if before else 0

    await client.send_message(peer, text)

    waited = 0.0
    while waited < wait:
        await asyncio.sleep(REPLY_POLL_SEC)
        waited += REPLY_POLL_SEC
        msgs = await client.get_messages(peer, limit=1)
        if msgs and msgs[0].id > last_id and not msgs[0].out:
            return msgs[0].message or ""
    return ""


async def _ask_expect(client, peer: str, text: str, expect: tuple[str, ...],
                      *, wait: float = REPLY_WAIT_SEC, tries: int = 3) -> str:
    """То же, что `_ask`, но ждёт ОСМЫСЛЕННЫЙ ответ и повторяет попытку.

    ⚠️ Нужен там, где по ответу принимается решение (создать бота, передать
    владение). Пустая строка означает «не дождались», а не «отказ» — и
    отличить одно от другого можно только повторив вопрос.

    `expect` — куски текста, любой из которых означает «ответ по делу».
    Возвращает последний полученный ответ (пустой, если так и не дождались).
    """
    last = ""
    for attempt in range(tries):
        last = await _ask(client, peer, text, wait=wait)
        low = last.lower()
        if any(e in low for e in expect):
            return last
        if last:
            # Ответ пришёл, но не тот, что ждали — это осмысленный отказ
            # («имя занято», «cannot create»), повторять бессмысленно.
            return last
        # Пусто — BotFather не успел. Ждём дольше и спрашиваем снова.
        await asyncio.sleep(2 + attempt * 2)
    return last


_TOKEN_RE = re.compile(r"\b(\d{6,12}:[A-Za-z0-9_-]{30,})")


def extract_bot_token(text: str) -> Optional[str]:
    """Достаёт токен из ответа BotFather «Use this token to access the HTTP API»."""
    m = _TOKEN_RE.search(text or "")
    return m.group(1) if m else None


_WAIT_RE = re.compile(r"try again in (\d+)\s*(second|minute|hour)", re.I)


def _too_many_message(raw: str) -> str:
    """Человеческий текст про ограничение частоты BotFather.

    Достаём срок из ответа («try again in 129 seconds») и переводим в минуты —
    иначе клиент читает секунды и не понимает, что делать.
    """
    m = _WAIT_RE.search(raw or "")
    if not m:
        return "Telegram просит подождать — попробуем ещё раз через несколько минут"
    n, unit = int(m.group(1)), m.group(2).lower()
    secs = n * {"second": 1, "minute": 60, "hour": 3600}[unit]
    if secs <= 90:
        when = "меньше минуты"
    elif secs < 3600:
        when = f"около {max(1, round(secs / 60))} мин."
    else:
        when = f"около {max(1, round(secs / 3600))} ч."
    return f"Telegram просит подождать {when} — мы продолжим сами, ничего делать не нужно"


def parse_retry_after(raw: str) -> int:
    """Сколько секунд просит подождать BotFather. 0 — если не сказал.

    ⚠️⚠️ ЛИМИТ БЫВАЕТ СУТОЧНЫМ, А НЕ «ПАРА МИНУТ». Проверено на проде
    07.09.2026: после нескольких созданий подряд BotFather ответил
    «try again in 61470 seconds» — это 17 часов. Поэтому отсрочку берём из
    самого ответа, а не ставим фиксированную: пять минут при суточном лимите
    означали бы, что поллер долбится в закрытую дверь весь день.
    """
    m = _WAIT_RE.search(raw or "")
    if not m:
        return 0
    n, unit = int(m.group(1)), m.group(2).lower()
    return n * {"second": 1, "minute": 60, "hour": 3600}[unit]


class BotFatherError(RuntimeError):
    """Ошибка в разговоре с BotFather — с текстом, понятным человеку."""

    def __init__(self, message: str, *, retryable: bool = False, raw: str = "",
                 retry_after_sec: int = 0):
        super().__init__(message)
        self.retryable = retryable   # можно ли повторить с другим именем
        self.raw = raw               # дословный ответ, для лога владельцу
        # Сколько ждать до следующей попытки (0 — сразу можно).
        self.retry_after_sec = retry_after_sec


def proxy_to_url(raw: str) -> Optional[str]:
    """Прокси из базы → строка URL для httpx (у Telethon свой формат, словарь)."""
    p = parse_proxy(raw)
    if not p:
        return None
    auth = f"{p['username']}:{p.get('password','')}@" if p.get("username") else ""
    return f"{p['proxy_type']}://{auth}{p['addr']}:{p['port']}"


async def username_looks_taken(username: str,
                               proxy_url: Optional[str] = None) -> Optional[bool]:
    """Занято ли имя — по публичной странице t.me, БЕЗ участия BotFather.

    ⚠️⚠️ ЗАЧЕМ НЕ ЧЕРЕЗ BOTFATHER. Спросить у него — значит начать `/newbot`,
    а он считает попытки создания и выдаёт лимит, причём СУТОЧНЫЙ (проверено
    на проде: «try again in 61470 seconds» = 17 часов). Каждая проверка имени
    отъедала бы у клиента саму возможность создать бота.

    Возвращает True (занято), False (свободно) или None (не смогли проверить —
    тогда не мешаем, окончательный ответ даст BotFather при создании).

    ⚠️ У занятого имени страница содержит карточку профиля (`tgme_page_title`),
    у свободного — только заглушку. Проверено на проде.

    ⚠️⚠️ ХОДИМ ЧЕРЕЗ ПРОКСИ. С российского IP t.me отвечает через раз
    («Network is unreachable») — поймано на проде 07.09.2026. Прокси берём тот
    же, что у сервисного аккаунта: он и куплен под работу с Telegram.
    """
    u = (username or "").strip().lstrip("@")
    if not u:
        return None
    try:
        import httpx

        kwargs = {"timeout": 12, "follow_redirects": True}
        if proxy_url:
            # httpx принимает готовый URL прокси строкой.
            kwargs["proxy"] = proxy_url
        async with httpx.AsyncClient(**kwargs) as c:
            r = await c.get(f"https://t.me/{u}")
        if r.status_code != 200:
            return None
        html = r.text
        return "tgme_page_title" in html or "tgme_page_photo" in html
    except Exception as e:  # noqa: BLE001
        log.warning("username check for @%s failed: %s", u, e)
        return None


async def check_username_free(client, username: str) -> tuple[bool, str]:
    """Свободен ли ник бота. Спрашиваем у BotFather ДО оплаты и до создания.

    Возвращает (свободен, пояснение).

    ⚠️ Проверка не даёт гарантии: между ней и созданием имя может занять
    кто-то другой. Тогда клиент просто вводит другое — оплата не сгорает.
    """
    u = username.lstrip("@")
    await _ask(client, BOTFATHER, "/cancel", wait=3)
    r = await _ask_expect(client, BOTFATHER, "/newbot",
                          ("choose a name", "how are we going to call it",
                           "cannot create new bots", "too many attempts"))
    low = r.lower()
    if "cannot create new bots" in low:
        # Аккаунт под спам-блоком — ботов он не создаст вовсе.
        await _ask(client, BOTFATHER, "/cancel", wait=3)
        return False, "__account_blocked__"
    if "too many attempts" in low:
        # ⚠️ Ограничение ЧАСТОТЫ, а не блокировка: проверять имя сейчас нечем,
        # но услуга работает. Клиенту говорим подождать, а не «имя занято» —
        # иначе он начнёт менять хорошее имя на худшее.
        await _ask(client, BOTFATHER, "/cancel", wait=3)
        return False, _too_many_message(r)

    # BotFather просит сначала имя, потом ник.
    await _ask_expect(client, BOTFATHER, f"Check {u}", ("username",))
    r = await _ask_expect(client, BOTFATHER, u,
                          ("congratulations", "already taken", "invalid",
                           "must end in", "sorry"),
                          wait=12)
    low = r.lower()

    # ⚠️⚠️ BotFather отвечает «занято» ЕЩЁ ДО создания — проверено вживую
    # 07.09.2026 («Sorry, this username is already taken»). Поэтому свободное
    # имя мы НЕ доводим до создания: иначе каждая проверка плодила бы боты,
    # которые тут же приходится удалять — это лишний расход слотов, лишние
    # команды BotFather (он их считает) и мусор, если удаление сорвётся.
    free = False
    note = r.strip()
    if "already taken" in low or "is already in use" in low:
        note = "Это имя уже занято — придумайте другое"
    elif "invalid" in low or "must end in" in low:
        note = "Telegram не принимает такое имя. Оно должно заканчиваться на «bot»"
    elif extract_bot_token(r):
        # Бот всё-таки создался (BotFather принял имя сразу) — значит имя было
        # свободно. Удаляем: на этом шаге мы только проверяли.
        free = True
        note = "Имя свободно"
        await _delete_bot(client, u)
    elif "sorry" in low:
        note = "Telegram не принял это имя — попробуйте другое"
    else:
        note = "Не удалось проверить имя — попробуйте ещё раз"

    await _ask(client, BOTFATHER, "/cancel", wait=3)
    return free, note


async def _delete_bot(client, username: str) -> bool:
    """Удаляет бота через BotFather. Возвращает, получилось ли."""
    u = username.lstrip("@")
    await _ask(client, BOTFATHER, "/cancel", wait=3)
    await _ask(client, BOTFATHER, "/deletebot")
    await _ask(client, BOTFATHER, f"@{u}")
    r = await _ask(client, BOTFATHER, "Yes, I am totally sure.", wait=8)
    return "gone" in (r or "").lower()


async def create_bot(client, username: str, title: str) -> str:
    """Создаёт бота и возвращает его токен.

    ⚠️ Порядок шагов задаёт сам BotFather: /newbot → отображаемое имя → ник.
    Менять местами нельзя, он не поймёт.
    """
    u = username.lstrip("@")
    await _ask(client, BOTFATHER, "/cancel", wait=3)

    r = await _ask_expect(client, BOTFATHER, "/newbot",
                          ("choose a name", "how are we going to call it",
                           "cannot create new bots", "too many attempts"))
    low = r.lower()
    if "cannot create new bots" in low:
        raise BotFatherError(
            "Сервисный аккаунт временно не может создавать ботов",
            retryable=False, raw=r,
        )
    # ⚠️⚠️ BotFather ОГРАНИЧИВАЕТ ЧАСТОТУ создания ботов и говорит об этом
    # прямо: «Sorry, too many attempts. Please try again in 129 seconds».
    # Это не поломка и не вина клиента — просто надо подождать. Раньше код
    # выдавал невнятное «Telegram не ответил» и заказ уходил в ошибку;
    # поймано на сквозной проверке 07.09.2026.
    if "too many attempts" in low:
        raise BotFatherError(
            _too_many_message(r), retryable=True, raw=r,
            retry_after_sec=parse_retry_after(r),
        )
    if "how are we going to call it" not in low and "choose a name" not in low:
        raise BotFatherError(
            "Telegram не ответил на запрос создания бота",
            retryable=True, raw=r,
        )

    await _ask_expect(client, BOTFATHER, title[:64], ("username", "choose a username"))
    r = await _ask_expect(client, BOTFATHER, u,
                          ("congratulations", "already taken", "invalid",
                           "must end in", "sorry"),
                          wait=12)
    token = extract_bot_token(r)
    if token:
        return token

    low = r.lower()
    if "already taken" in low or "is already in use" in low:
        raise BotFatherError(
            "Пока мы дошли до вашей очереди, это имя заняли. "
            "Выберите другое — платить повторно не нужно",
            retryable=True, raw=r,
        )
    raise BotFatherError(
        "Не удалось создать бота. Попробуйте другое имя",
        retryable=True, raw=r,
    )


async def configure_main_mini_app(client, bot_username: str, url: str) -> bool:
    """Привязывает ГЛАВНЫЙ Mini App бота: Bot Settings → Configure Mini App.

    ⚠️⚠️ ЭТО НЕ `/newapp`. Разница принципиальная, и на ней уже обожглись:
      • `/newapp` заводит ОТДЕЛЬНОЕ приложение с коротким именем
        (`t.me/бот/имя`) и ОБЯЗАТЕЛЬНО требует картинку 640×360 — там шаг
        проваливался всегда, потому что обложки у нас нет;
      • «Configure Mini App» настраивает ГЛАВНЫЙ Mini App, и там спрашивают
        ТОЛЬКО адрес. Ни картинки, ни названия, ни описания в этом меню нет
        вовсе — ровно так написано в нашей же инструкции клиентам
        (/dashboard/help/connect-bot, шаг 3).

    Ссылки при этом получаются короткие (`t.me/бот?startapp=…`) и одинаково
    работают везде — именно их ждёт остальная платформа.

    ⚠️ BotFather управляется КНОПКАМИ, а не текстом (см. `_click`). Порядок
    задаёт он сам: /mybots → бот → Bot Settings → Configure Mini App →
    (Enable Mini App, если ещё не включён) → Edit Mini App URL → адрес.

    Шаг необязательный: не вышло — бот всё равно работает, кнопка меню
    (`setChatMenuButton`) ставится отдельно и от этого не зависит.
    """
    u = bot_username.lstrip("@")
    try:
        await _ask(client, BOTFATHER, "/cancel", wait=3)
        r = await _ask(client, BOTFATHER, "/mybots", wait=8)
        if not await _click(client, BOTFATHER, f"@{u}"):
            return False
        if not await _click(client, BOTFATHER, "Bot Settings"):
            return False
        if not await _click(client, BOTFATHER, "Configure Mini App"):
            return False

        # ⚠️⚠️ ДВЕ РАЗНЫЕ ВЕТКИ, и на этом уже спотыкались:
        #   • Mini App ВЫКЛЮЧЕН → есть кнопка «Enable Mini App», и сразу после
        #     нажатия BotFather САМ просит адрес («Send me the Mini App URL») —
        #     кнопки «Edit Mini App URL» в этот момент НЕТ;
        #   • Mini App УЖЕ включён → кнопки «Enable» нет, зато есть
        #     «Edit Mini App URL», её и жмём.
        # Код ждал «Edit Mini App URL» всегда и на первой ветке выходил ни с чем.
        enabled_now = await _click(client, BOTFATHER, "Enable Mini App", wait=6)
        if not enabled_now:
            if not await _click(client, BOTFATHER, "Edit Mini App URL"):
                return False
        r = await _ask(client, BOTFATHER, url, wait=10)
        low = (r or "").lower()
        return "success" in low or "url updated" in low
    except Exception as e:  # noqa: BLE001 — шаг необязательный
        log.warning("configure main mini app failed for @%s: %s", u, e)
        return False


async def link_mini_app(client, bot_username: str, url: str, title: str) -> bool:
    """Привязывает Mini App к боту через /newapp у BotFather.

    ⚠️⚠️ НЕ ИСПОЛЬЗУЕТСЯ. Оставлено как история: в автонастройке этот шаг
    ПРОВАЛИВАЛСЯ ВСЕГДА, и клиент при каждой настройке читал «Приложение
    подключим отдельно».

    Причина: BotFather обязательно требует картинку 640×360 (`/empty` там не
    принимается, в отличие от GIF-демо), а отправлялась ссылка на
    `pluson.ru/miniapp-cover.png`, которого не существует — 404, файла нет в
    проекте вовсе. Диалог обрывался на этом вопросе.

    ⚠️ Заменено на `setChatMenuButton` через Bot API (tasks/tg_setup.py): он
    даёт ровно то, что нужно человеку — кнопку в боте, открывающую кабинет, —
    без картинок, short-name и переписки с BotFather. Тем же способом Mini App
    подключается в мастере «Каналов» (api/channels.py), то есть механика общая.

    Возвращать сюда `/newapp` есть смысл, только если понадобится ОТДЕЛЬНОЕ
    приложение со своей ссылкой `t.me/бот/имя` — и тогда сначала нужна реально
    существующая обложка 640×360.
    """
    u = bot_username.lstrip("@")
    try:
        await _ask(client, BOTFATHER, "/cancel", wait=3)
        r = await _ask(client, BOTFATHER, "/newapp")
        if "choose a bot" not in (r or "").lower():
            return False
        await _ask(client, BOTFATHER, f"@{u}")
        await _ask(client, BOTFATHER, title[:32])              # название приложения
        await _ask(client, BOTFATHER, title[:64])              # короткое описание
        # Картинка 640x360 — обязательна.
        from app.config import settings
        base = (getattr(settings, "frontend_url", "") or "https://pluson.ru").rstrip("/")
        await _ask(client, BOTFATHER, f"{base}/miniapp-cover.png", wait=10)
        await _ask(client, BOTFATHER, "/empty", wait=6)        # GIF-демо не нужно
        await _ask(client, BOTFATHER, url, wait=8)             # адрес приложения
        r = await _ask(client, BOTFATHER, MINIAPP_SHORT_NAME, wait=10)
        return "success" in (r or "").lower() or "t.me/" in (r or "")
    except Exception as e:  # noqa: BLE001 — шаг необязательный
        log.warning("mini app link failed for @%s: %s", u, e)
        return False


async def transfer_bot(client, bot_username: str, to_username: str,
                       twofa_password: str) -> bool:
    """Передаёт бота новому владельцу по его @нику.

    ⚠️ ТРИ УСЛОВИЯ TELEGRAM, без которых передача невозможна:
      1) у нашего аккаунта включена двухфакторка, и включена ≥7 дней назад;
      2) получатель уже написал этому боту (иначе его нельзя выбрать);
      3) подтверждение — облачным паролем нашего аккаунта.
    """
    u = bot_username.lstrip("@")
    to = to_username.lstrip("@")

    await _ask(client, BOTFATHER, "/cancel", wait=3)
    r = await _ask(client, BOTFATHER, "/mybots")
    if "no bots" in (r or "").lower():
        raise BotFatherError("Бот не найден на сервисном аккаунте", raw=r)

    # Дальше BotFather работает кнопками, а не текстом: нажимаем их.
    ok = await _click(client, BOTFATHER, f"@{u}")
    if not ok:
        raise BotFatherError("Не удалось открыть бота в BotFather")
    if not await _click(client, BOTFATHER, "Transfer Ownership"):
        # У кнопки бывает другое название в зависимости от версии.
        if not await _click(client, BOTFATHER, "Transfer"):
            raise BotFatherError("В BotFather нет кнопки передачи владения")
    if not await _click(client, BOTFATHER, "Choose Recipient"):
        await _click(client, BOTFATHER, "Choose recipient")

    r = await _ask(client, BOTFATHER, f"@{to}", wait=10)
    low = (r or "").lower()
    if "hasn't messaged" in low or "must start" in low or "never" in low:
        raise BotFatherError(
            "Вы ещё не заходили в своего бота. Откройте его и нажмите «Запустить»",
            retryable=True, raw=r,
        )
    if "password" in low or "2-step" in low or "two-step" in low:
        r = await _ask(client, BOTFATHER, twofa_password, wait=10)
        low = (r or "").lower()

    if "success" in low or "transferred" in low or "now owned" in low:
        return True
    if "invalid password" in low or "wrong password" in low:
        raise BotFatherError("Неверный пароль сервисного аккаунта", raw=r)
    raise BotFatherError("Передача не подтвердилась", retryable=True, raw=r)


async def _click(client, peer: str, button_text: str, wait: float = 5) -> bool:
    """Нажимает кнопку под последним сообщением собеседника.

    ⚠️ BotFather управляется кнопками, а не текстом: «Transfer Ownership»
    отправленное сообщением он не поймёт.
    """
    msgs = await client.get_messages(peer, limit=1)
    if not msgs:
        return False
    msg = msgs[0]
    markup = getattr(msg, "reply_markup", None)
    if not markup or not getattr(markup, "rows", None):
        return False
    needle = button_text.lower().lstrip("@")
    for row in markup.rows:
        for btn in row.buttons:
            label = (getattr(btn, "text", "") or "").lower().lstrip("@")
            if needle in label:
                try:
                    await msg.click(text=getattr(btn, "text", ""))
                    await asyncio.sleep(wait)
                    return True
                except Exception as e:  # noqa: BLE001
                    log.warning("botfather click '%s' failed: %s", button_text, e)
                    return False
    return False


# ─────────────────────────────────────────────────────────────────────────
# Группа уведомлений
# ─────────────────────────────────────────────────────────────────────────
@dataclass
class CreatedGroup:
    chat_id: int
    invite_link: str = ""
    title: str = ""


async def create_notifications_group(client, title: str, bot_username: str) -> CreatedGroup:
    """Создаёт закрытую группу и добавляет туда бота полным админом.

    ⚠️ megagroup=True — именно группа, а не канал. В канале нельзя переписываться,
    а уведомления клиент читает и обсуждает с командой.

    ⚠️ Бот обязан быть АДМИНОМ: без этого Telegram не присылает ему события
    о вступлении участников, и мы не узнаем, что клиент вошёл.
    """
    from telethon.tl.functions.channels import (
        CreateChannelRequest, EditAdminRequest, InviteToChannelRequest,
    )
    from telethon.tl.functions.messages import ExportChatInviteRequest
    from telethon.tl.types import ChatAdminRights

    res = await client(CreateChannelRequest(
        title=title[:128],
        about="Уведомления от платформы ПЛЮСОН",
        megagroup=True,     # группа, не канал
        broadcast=False,
    ))
    chat = res.chats[0]

    bot = bot_username.lstrip("@")
    await client(InviteToChannelRequest(channel=chat, users=[bot]))
    await client(EditAdminRequest(
        channel=chat, user_id=bot,
        admin_rights=ChatAdminRights(
            change_info=True, post_messages=True, edit_messages=True,
            delete_messages=True, ban_users=True, invite_users=True,
            pin_messages=True, add_admins=False, manage_call=False,
            anonymous=False, other=True,
        ),
        rank="ПЛЮСОН",
    ))

    invite = ""
    try:
        exported = await client(ExportChatInviteRequest(peer=chat))
        invite = getattr(exported, "link", "") or ""
    except Exception as e:  # noqa: BLE001
        log.warning("export invite failed: %s", e)

    # ⚠️ id супергруппы в Bot API имеет вид -100XXXXXXXXXX, а Telethon отдаёт
    # «голый» id. Приводим к тому виду, в котором его ждут наши боты.
    raw_id = int(chat.id)
    chat_id = raw_id if str(raw_id).startswith("-100") else int(f"-100{raw_id}")

    return CreatedGroup(chat_id=chat_id, invite_link=invite, title=title)


async def promote_in_group(client, chat_id: int, user_ref, *, full: bool = True) -> bool:
    """Делает человека админом группы.

    full=True даёт право назначать других админов — это и есть «передача
    управления»: клиент дальше сам решает, кто в его группе главный.
    """
    from telethon.tl.functions.channels import EditAdminRequest
    from telethon.tl.types import ChatAdminRights

    try:
        entity = await client.get_entity(chat_id)
        await client(EditAdminRequest(
            channel=entity, user_id=user_ref,
            admin_rights=ChatAdminRights(
                change_info=True, post_messages=True, edit_messages=True,
                delete_messages=True, ban_users=True, invite_users=True,
                pin_messages=True, add_admins=full, manage_call=True,
                anonymous=False, other=True,
            ),
            rank="владелец",
        ))
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("promote in %s failed: %s", chat_id, e)
        return False


async def invite_to_group(client, chat_id: int, username: str) -> tuple[bool, str]:
    """Пробует добавить человека в группу по нику.

    ⚠️ Часто НЕ получается: у большинства людей закрыты настройки приватности,
    и Telegram запрещает добавлять их в чаты. Это не ошибка — тогда человек
    вступает сам по ссылке-приглашению. Поэтому возвращаем причину, а не
    бросаем исключение.
    """
    from telethon.tl.functions.channels import InviteToChannelRequest

    try:
        entity = await client.get_entity(chat_id)
        await client(InviteToChannelRequest(channel=entity, users=[username.lstrip("@")]))
        return True, ""
    except Exception as e:  # noqa: BLE001
        name = type(e).__name__
        if "Privacy" in name or "privacy" in str(e).lower():
            return False, "приватность"
        return False, name


async def leave_group(client, chat_id: int) -> bool:
    """Выходит из группы — после того, как клиент стал в ней полным админом.

    ⚠️ Зовётся ТОЛЬКО когда клиент уже админ с правом назначать админов.
    Иначе группа осталась бы без управления вовсе.
    """
    try:
        entity = await client.get_entity(chat_id)
        await client.delete_dialog(entity)
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("leave group %s failed: %s", chat_id, e)
        return False


# ─────────────────────────────────────────────────────────────────────────
# Здоровье аккаунта
# ─────────────────────────────────────────────────────────────────────────
@dataclass
class Health:
    state: str = "unknown"        # ok | limited | dead | unknown
    note: str = ""
    username: str = ""
    tg_user_id: int = 0
    bots_count: int = 0
    extra: dict = field(default_factory=dict)


async def check_health(acc: SetupAccount) -> Health:
    """Спрашивает у @SpamBot, не ограничен ли аккаунт.

    ⚠️ ЗАЧЕМ ЭТО ВООБЩЕ. Спам-блок Telegram запрещает не только писать людям,
    но и СОЗДАВАТЬ БОТОВ: BotFather отвечает «Unfortunately, you cannot create
    new bots at this time» (проверено на живых аккаунтах 07.09.2026).
    Без такой проверки очередь молча падала бы на каждом клиенте.
    """
    out = Health()
    try:
        client = await connect(acc)
    except Exception as e:  # noqa: BLE001
        out.state = "dead"
        out.note = str(e)
        return out

    try:
        me = await client.get_me()
        out.username = me.username or ""
        out.tg_user_id = int(me.id)

        r = await _ask(client, SPAMBOT, "/start", wait=8)
        out.note = (r or "").strip()[:500]
        low = out.note.lower()
        # ⚠️⚠️ @SPAMBOT ОТВЕЧАЕТ НА ЯЗЫКЕ АККАУНТА, А НЕ ПО-АНГЛИЙСКИ.
        #
        # Здесь искались только английские фразы, и живой узбекский аккаунт
        # (998700388279) попадал в `unknown` — очередь берёт лишь `ok`, то есть
        # услуга не работала при исправном аккаунте. Дословный ответ 09.09.2026:
        # «Sizga xushxabarimiz bor! Hozirda hisobingizda hech qanday cheklov
        #  yoʻq. Misoli erkin qushsiz!» — «ограничений нет, свободен как птица».
        #
        # ⚠️ Сверяем по КОРНЯМ слов, а не по целым фразам: формулировки Telegram
        # меняются, а «cheklov» (ограничение) и «erkin qush» (свободная птица)
        # устойчивы. Русский добавлен на случай аккаунта с русским интерфейсом.
        OK_MARKERS = (
            "no limits", "free as a bird",          # английский
            "cheklov yo", "erkin qush",             # узбекский: «ограничений нет»
            # ⚠️ Русские формулировки Telegram: «Ваш аккаунт свободен от
            # каких-либо ограничений», «Хорошие новости, никаких ограничений».
            "ограничений нет", "свободны как птица",
            "свободен от каких-либо ограничений", "никаких ограничений",
        )
        BAD_MARKERS = (
            "limited", "restricted",                # английский
            "cheklangan", "cheklandi",              # узбекский: «ограничен»
            "ограничен ", "ограничения применены",   # русский
        )
        # ⚠️⚠️ ХОРОШИЕ МАРКЕРЫ ПРОВЕРЯЮТСЯ ПЕРВЫМИ, И ЭТО ВАЖНО.
        # В русском ответе «свободен от каких-либо ОГРАНИЧЕНИЙ» встречается
        # корень «ограничен» — и живой аккаунт помечался `limited`, то есть
        # выбывал из очереди при полном порядке. Поймано на проде 09.09.2026.
        if any(m in low for m in OK_MARKERS):
            out.state = "ok"
        elif any(m in low for m in BAD_MARKERS):
            out.state = "limited"
        else:
            out.state = "unknown"

        # Сколько ботов уже на аккаунте — по кнопкам в /mybots.
        r = await _ask(client, BOTFATHER, "/mybots", wait=8)
        if "no bots" in (r or "").lower():
            out.bots_count = 0
        else:
            msgs = await client.get_messages(BOTFATHER, limit=1)
            if msgs and getattr(msgs[0], "reply_markup", None):
                count = 0
                for row in (msgs[0].reply_markup.rows or []):
                    for btn in row.buttons:
                        if (getattr(btn, "text", "") or "").startswith("@"):
                            count += 1
                out.bots_count = count
    except Exception as e:  # noqa: BLE001
        out.state = "unknown"
        out.note = f"{type(e).__name__}: {e}"
    finally:
        await client.disconnect()

    return out
