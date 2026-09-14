"""Подключение служебного Telegram-аккаунта — два пути в одном месте.

⚠️⚠️ ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Подключить аккаунт нужно не только автонастройке:
тот же механизм понадобится любому будущему разделу, где платформа работает от
имени живого аккаунта (парсинг, рассылки, проверка каналов). Поэтому здесь нет
ни одного упоминания услуги и её таблиц — на вход телефон и файлы, на выход
факт «сессия рабочая» и данные аккаунта. Куда это записывать, решает вызывающий.

ДВА ПУТИ, оба ведут к рабочему файлу сессии:

  1. КОМПЛЕКТ ФАЙЛОВ от продавца — `unpack_bundle()`.
     Продавцы кладут архив как попало: файлы в корне, во вложенной папке с
     номером, иногда несколько аккаунтов в одном zip. Поэтому структуру не
     угадываем — обходим ВСЕ файлы и группируем по цифрам из имени.

  2. ВХОД ПО КОДУ ИЗ SMS — `start_login()` → `confirm_code()` → `confirm_password()`.
     Единственный способ вернуть аккаунт, у которого аннулирован ключ.

⚠️⚠️ EVENT LOOP МЕЖДУ ШАГАМИ НЕ МЕНЯЕТСЯ. Telethon привязывает клиента к тому
циклу, на котором тот подключился, и смена цикла даёт «The asyncio event loop
must not change after connection». Между вводом телефона, кода и пароля
проходят разные HTTP-запросы, поэтому все шаги гоняются на ОДНОМ вечном цикле
в фоновом потоке (`_run`). Это же решение работает в мейлере.

⚠️⚠️ ВХОДИМ ЧЕРЕЗ ТОТ ЖЕ ПРОКСИ, через который аккаунт потом работает. Иначе
Telegram видит вход из одной страны, а работу из другой — и блокирует.
Иностранный номер без прокси не подключаем вовсе (см. `connect` в tg_setup).
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import tempfile
import threading
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ── вечный цикл для многошагового входа ──────────────────────────────────────
_LOOP: Optional[asyncio.AbstractEventLoop] = None
_LOOP_LOCK = threading.Lock()

# телефон → {"client": TelegramClient, "hash": str}
_PENDING: dict[str, dict[str, Any]] = {}
_PENDING_LOCK = threading.Lock()


def _get_loop() -> asyncio.AbstractEventLoop:
    """Поднимает (один раз) фоновый цикл и возвращает его."""
    global _LOOP
    with _LOOP_LOCK:
        if _LOOP is None:
            loop = asyncio.new_event_loop()

            def _runner() -> None:
                asyncio.set_event_loop(loop)
                loop.run_forever()

            threading.Thread(target=_runner, name="tg-connect-loop",
                             daemon=True).start()
            _LOOP = loop
        return _LOOP


def _run(coro):
    """Выполняет корутину на общем фоновом цикле и ждёт результат."""
    return asyncio.run_coroutine_threadsafe(coro, _get_loop()).result()


# ── разбор комплекта файлов ──────────────────────────────────────────────────
@dataclass
class AccountBundle:
    """Один комплект: телефон + то, что нашлось рядом с ним."""
    phone: str
    session_bytes: Optional[bytes] = None
    twofa: Optional[str] = None
    title: Optional[str] = None
    username: Optional[str] = None
    raw_json: Optional[str] = None


def parse_account_json(text: str) -> dict:
    """Достаёт данные аккаунта из JSON продавца.

    ⚠️ У разных продавцов поля названы по-разному, и в ОДНОМ файле могут
    лежать ОБА варианта с РАЗНЫМИ значениями. Проверено вживую на номере
    77006746162: верным оказался `twoFA`, а не `2FA` — поэтому он первый.
    """
    import json

    try:
        data = json.loads(text)
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}

    def pick(*keys: str) -> Optional[str]:
        for k in keys:
            v = data.get(k)
            if v not in (None, "", 0):
                return str(v).strip()
        return None

    phone = pick("phone", "phone_number", "number", "session_file")
    if phone:
        phone = re.sub(r"\D", "", phone)

    first = pick("first_name", "firstname", "name") or ""
    last = pick("last_name", "lastname", "surname") or ""
    title = " ".join(x for x in (first, last) if x).strip() or None

    username = pick("username", "user_name")
    if username:
        username = username.lstrip("@") or None

    return {
        "phone": phone,
        "title": title,
        "username": username,
        "twofa": pick("twoFA", "twofa", "two_fa", "2FA", "password"),
    }


def unpack_bundle(files: list[tuple[str, bytes]]) -> tuple[list[AccountBundle], list[str]]:
    """Разбирает загруженные файлы в комплекты по номерам телефона.

    Принимает список `(имя файла, содержимое)` — это могут быть .zip, .session,
    .json в любом сочетании и в любом количестве.

    ⚠️ Группируем по ЦИФРАМ ИЗ ИМЕНИ файла, а не по структуре архива: продавцы
    раскладывают по-разному, и жёсткая структура ломается на первом же новом.

    Возвращает `(комплекты, ошибки)` — ошибки текстом для человека.
    """
    sets: dict[str, AccountBundle] = {}
    errors: list[str] = []
    tmpdirs: list[str] = []

    def _take(path: str, name: str) -> None:
        stem, ext = os.path.splitext(name)
        ext = ext.lower()
        digits = re.sub(r"\D", "", stem)

        if ext == ".session" and digits:
            b = sets.setdefault(digits, AccountBundle(phone=digits))
            b.session_bytes = Path(path).read_bytes()
        elif ext == ".json" and digits:
            b = sets.setdefault(digits, AccountBundle(phone=digits))
            text = Path(path).read_text(encoding="utf-8-sig", errors="replace")
            b.raw_json = text
            info = parse_account_json(text)
            b.title = b.title or info.get("title")
            b.username = b.username or info.get("username")
            b.twofa = b.twofa or info.get("twofa")
        elif name.lower().startswith("twofa"):
            # ⚠️ У файла twoFA.txt нет номера в имени — берём его из имени
            # ПАПКИ выше, куда продавец положил комплект.
            key = re.sub(r"\D", "", os.path.basename(os.path.dirname(path)))
            if key:
                b = sets.setdefault(key, AccountBundle(phone=key))
                try:
                    b.twofa = b.twofa or Path(path).read_text(
                        encoding="utf-8-sig").strip()
                except OSError:
                    pass

    try:
        for fname, content in files:
            if not fname or not content:
                continue
            if fname.lower().endswith(".zip"):
                tmp = tempfile.mkdtemp(prefix="tgacc_")
                tmpdirs.append(tmp)
                zpath = os.path.join(tmp, "in.zip")
                Path(zpath).write_bytes(content)
                try:
                    with zipfile.ZipFile(zpath) as z:
                        # ⚠️ zip-slip: имя внутри архива может содержать «..»
                        # или быть абсолютным — это запись за пределы папки.
                        for n in z.namelist():
                            if os.path.isabs(n) or ".." in n.split("/"):
                                raise ValueError(f"подозрительный путь: {n}")
                        z.extractall(tmp)
                except Exception as e:
                    errors.append(f"{fname}: архив не читается ({e})")
                    continue
                for root, _dirs, names in os.walk(tmp):
                    for n in names:
                        if n == "in.zip":
                            continue
                        _take(os.path.join(root, n), n)
            else:
                tmp = tempfile.mkdtemp(prefix="tgacc_")
                tmpdirs.append(tmp)
                path = os.path.join(tmp, os.path.basename(fname))
                Path(path).write_bytes(content)
                _take(path, os.path.basename(fname))
    finally:
        # ⚠️ Содержимое уже прочитано в память (`session_bytes`), временные
        # папки не нужны: в них лежат ключи авторизации.
        for d in tmpdirs:
            shutil.rmtree(d, ignore_errors=True)

    found = [b for b in sets.values() if b.session_bytes or b.twofa or b.raw_json]
    for b in found:
        if not b.session_bytes:
            errors.append(f"{b.phone}: в комплекте нет файла .session")
    return [b for b in found if b.session_bytes], errors


# ── проверка живости сессии ──────────────────────────────────────────────────
async def session_is_alive(session_base: str, phone: str,
                           proxy: Optional[str]) -> tuple[bool, str]:
    """Проверяет, рабочий ли файл сессии. Возвращает `(жива, причина)`.

    ⚠️ Проверяем СРАЗУ после загрузки, чтобы не врать «аккаунт подключён» о
    мёртвом файле: мёртвую сессию видно только при попытке подключиться.
    """
    from app.services.tg_setup import SetupAccount, connect

    acc = SetupAccount(id=0, phone=phone, twofa_password="",
                       proxy=proxy or "", session_path=session_base)
    client = None
    try:
        client = await connect(acc)
        me = await client.get_me()
        title = " ".join(x for x in (me.first_name or "", me.last_name or "")
                         if x).strip()
        return True, (f"@{me.username}" if me.username else title or "без имени")
    except Exception as e:
        return False, f"{type(e).__name__}: {str(e)[:200]}"
    finally:
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass


# ── вход по коду из SMS ──────────────────────────────────────────────────────
def _make_client(phone: str, session_base: str, proxy: Optional[str]):
    """Клиент Telethon для входа — с теми же настройками, что у рабочего."""
    from telethon import TelegramClient

    from app.config import settings
    from app.services.tg_setup import parse_proxy

    api_id = int(getattr(settings, "tg_setup_api_id", 0) or 0)
    api_hash = getattr(settings, "tg_setup_api_hash", "") or ""
    if not api_id or not api_hash:
        raise RuntimeError("Не заданы TG_SETUP_API_ID / TG_SETUP_API_HASH")

    proxy_cfg = parse_proxy(proxy)
    digits = re.sub(r"\D", "", phone or "")
    # ⚠️ То же правило, что при обычном подключении: иностранный номер без
    # прокси войдёт с российского IP, и Telegram это накажет.
    if not proxy_cfg and not digits.startswith("7"):
        raise RuntimeError(
            "Иностранному номеру нужен прокси — без него вход пойдёт с "
            "российского адреса, и Telegram заблокирует аккаунт"
        )

    return TelegramClient(
        session_base, api_id, api_hash, proxy=proxy_cfg, catch_up=False,
        # ⚠️ Язык задаём явно: служебные боты отвечают на языке аккаунта,
        # и узбекский ответ наш разбор не понимает (проверено на проде).
        lang_code="ru", system_lang_code="ru",
    )


def start_login(phone: str, session_base: str,
                proxy: Optional[str] = None) -> dict:
    """Шаг 1 — запрашивает код в Telegram.

    ⚠️ Если ключ сессии аннулирован (`AuthKeyDuplicated`), битый файл сносим и
    подключаемся с нуля: иначе войти заново невозможно вовсе.
    """
    from telethon.errors import AuthKeyDuplicatedError

    phone = re.sub(r"\D", "", str(phone))

    async def _do():
        client = _make_client(phone, session_base, proxy)
        try:
            await client.connect()
        except AuthKeyDuplicatedError:
            try:
                await client.disconnect()
            except Exception:
                pass
            Path(session_base + ".session").unlink(missing_ok=True)
            client = _make_client(phone, session_base, proxy)
            await client.connect()

        if await client.is_user_authorized():
            me = await client.get_me()
            await client.disconnect()
            return {"status": "already", "username": me.username, "phone": phone}

        sent = await client.send_code_request(phone)
        # ⚠️ Клиент НЕ отключаем — он должен дожить до ввода кода.
        with _PENDING_LOCK:
            _PENDING[phone] = {"client": client, "hash": sent.phone_code_hash}
        return {"status": "code_sent", "phone": phone}

    return _run(_do())


def confirm_code(phone: str, code: str) -> dict:
    """Шаг 2 — ввод кода. Может потребовать облачный пароль."""
    from telethon.errors import PhoneCodeInvalidError, SessionPasswordNeededError

    phone = re.sub(r"\D", "", str(phone))
    with _PENDING_LOCK:
        pend = _PENDING.get(phone)
    if not pend:
        return {"status": "error",
                "msg": "Вход не начат или истёк — запросите код заново"}

    async def _do():
        try:
            await pend["client"].sign_in(phone=phone, code=str(code).strip(),
                                         phone_code_hash=pend["hash"])
        except SessionPasswordNeededError:
            return {"status": "need_password", "phone": phone}
        except PhoneCodeInvalidError:
            return {"status": "error", "msg": "Неверный код"}
        except Exception as e:
            return {"status": "error", "msg": f"{type(e).__name__}: {e}"}
        return await _finish(phone, pend["client"])

    return _run(_do())


def confirm_password(phone: str, password: str) -> dict:
    """Шаг 3 — облачный пароль (двухфакторка)."""
    phone = re.sub(r"\D", "", str(phone))
    with _PENDING_LOCK:
        pend = _PENDING.get(phone)
    if not pend:
        return {"status": "error",
                "msg": "Вход не начат или истёк — запросите код заново"}

    async def _do():
        try:
            await pend["client"].sign_in(password=str(password))
        except Exception as e:
            return {"status": "error", "msg": f"Пароль не подошёл: {e}"}
        return await _finish(phone, pend["client"])

    return _run(_do())


async def _finish(phone: str, client) -> dict:
    """Общий хвост удачного входа: забрать данные и отпустить клиента."""
    me = await client.get_me()
    try:
        await client.disconnect()
    except Exception:
        pass
    with _PENDING_LOCK:
        _PENDING.pop(phone, None)
    title = " ".join(x for x in (me.first_name or "", me.last_name or "")
                     if x).strip()
    return {"status": "ok", "phone": phone,
            "username": me.username, "title": title or None,
            "tg_user_id": me.id}


def cancel_login(phone: str) -> None:
    """Бросить незаконченный вход и отпустить клиента."""
    phone = re.sub(r"\D", "", str(phone))
    with _PENDING_LOCK:
        pend = _PENDING.pop(phone, None)
    if pend:
        try:
            _run(pend["client"].disconnect())
        except Exception:
            pass
