"""Автонастройка Telegram «под ключ» — фоновая очередь (миграция 364).

ЧТО ЗДЕСЬ ПРОИСХОДИТ.
Поллер раз в минуту берёт оплаченные заказы и доводит их до конца:
создаёт бота, привязывает Mini App, заводит группу уведомлений, а когда
клиент сделает свои два действия — передаёт ему права и всё прописывает.

⚠️ ПОЧЕМУ В ФОНЕ, А НЕ В HTTP-ЗАПРОСЕ.
Разговор с BotFather — это переписка с паузами: отправил, подождал ответ,
ответил снова. Один прогон занимает полминуты-минуту, и он не должен
держать запрос из браузера. Плюс часть шагов ждёт ДЕЙСТВИЙ КЛИЕНТА
(зайти в бота, вступить в группу) — это часы, а не секунды.

⚠️ ОЧЕРЕДЬ СЧИТАЕТСЯ ПО СЛОТАМ, А НЕ ПО ВРЕМЕНИ.
Telegram не даёт одному аккаунту держать много ботов. Слот занимает бот,
которого клиент ещё не забрал, и освобождает — передача бота клиенту.
Поэтому «сколько ботов в день» роли не играет: важно, сколько висит
непереданными прямо сейчас.

⚠️ УСЛУГА СЧИТАЕТСЯ ОКАЗАННОЙ, КОГДА БОТ СОЗДАН.
Всё, что дальше, зависит от действий клиента. Не забрал за 3 дня — бот
удаляется и слот освобождается, но ОПЛАТА НЕ СГОРАЕТ: клиент запускает
настройку заново без повторного платежа.
"""
import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

import asyncpg

from app.celery_app import celery
from app.config import settings
from app.services import tg_setup as tgs

logger = logging.getLogger(__name__)

# Сколько дней у клиента есть на то, чтобы забрать бота.
CLAIM_DAYS = 3

# Название группы уведомлений. Бренд в конце — чтобы владелец платформы
# различал десятки одинаковых чатов в своём списке.
GROUP_TITLE_TEMPLATE = "Уведомления с ПЛЮСОНа — {brand}"


def run_async(coro):
    """⚠️ set_event_loop ОБЯЗАТЕЛЕН: new_event_loop() создаёт цикл, но не делает
    его текущим. Библиотеки внутри зовут get_event_loop() и получают ЗАКРЫТЫЙ
    цикл предыдущей задачи этого же воркера → RuntimeError('Event loop is
    closed'). На этом уже молча терялись записи эфиров и тексты воронок."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


async def _get_conn():
    return await asyncpg.connect(settings.database_url)


# ─────────────────────────────────────────────────────────────────────────
# Лог шагов — то, что клиент видит на экране живьём
# ─────────────────────────────────────────────────────────────────────────
async def _log_step(db, order_id: int, step: str, text: str, ok: bool = True):
    """Дописывает строку в setup_log заказа.

    ⚠️ Пишем через jsonb_build_object на стороне БД, а не читаем-меняем-пишем:
    иначе две параллельные записи затрут друг друга.
    """
    entry = json.dumps(
        {"at": datetime.now(timezone.utc).isoformat(), "step": step,
         "ok": ok, "text": text},
        ensure_ascii=False,
    )
    # ⚠️⚠️ НЕ ПОВТОРЯЕМ ОДНО И ТО ЖЕ СООБЩЕНИЕ ПОДРЯД.
    #
    # Поллер ходит РАЗ В МИНУТУ и на каждом заходе повторяет неудавшийся шаг.
    # Без этой проверки лог рос бесконечно: на живом заказе за час накопилось
    # 114 строк, из них «Передаём вам права на бота…» — 53 раза и «Передача не
    # подтвердилась» — 51. Отчёт о работе превращался в простыню, где ничего
    # не найти, а человек видел это как поломку.
    #
    # ⚠️ Сравнивать с ОДНОЙ последней строкой НЕДОСТАТОЧНО: неудачная попытка
    # пишет ПАРУ сообщений («Передаём…» → «Не подтвердилась»), и они чередуются
    # — каждое не равно предыдущему, проверка их пропускает. Поэтому смотрим на
    # несколько последних: текст, который там уже есть, не добавляем.
    await db.execute(
        """UPDATE service_orders
              SET setup_log = COALESCE(setup_log, '[]'::jsonb) || $2::jsonb,
                  updated_at = NOW()
            WHERE id = $1
              AND NOT EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements(COALESCE(setup_log, '[]'::jsonb))
                           WITH ORDINALITY AS t(x, ord)
                     WHERE ord > jsonb_array_length(COALESCE(setup_log,'[]'::jsonb)) - 4
                       AND x ->> 'text' = $3
              )""",
        order_id, f"[{entry}]", text,
    )


# ─────────────────────────────────────────────────────────────────────────
# Человеческие тексты ошибок
# ─────────────────────────────────────────────────────────────────────────
#
# ⚠️⚠️ КЛИЕНТУ НЕЛЬЗЯ ПОКАЗЫВАТЬ ИМЕНА ИСКЛЮЧЕНИЙ. В логе заказа висело
# «UserIdInvalidError» и «FrozenMethodInvalidError» — человек не понимает ни
# слова и не знает, что делать. Причём именно эти два означали не «сбой», а
# «служебный аккаунт заморожен» — то есть проблема на НАШЕЙ стороне, и сказать
# об этом надо прямо.
#
# ⚠️ Ключи — по подстроке в имени класса ИЛИ в тексте: Telethon отдаёт часть
# ошибок строкой ответа сервера, а не отдельным классом.
_ERROR_TEXTS: tuple[tuple[str, str], ...] = (
    ("FrozenMethod",
     "Служебный аккаунт заморожен Telegram — мы уже разбираемся, "
     "настройка продолжится после замены аккаунта"),
    ("FrozenParticipant",
     "Служебный аккаунт заморожен Telegram — мы уже разбираемся, "
     "настройка продолжится после замены аккаунта"),
    ("UserIdInvalid",
     "Не удалось добавить вас в группу — проверьте ник в настройках кабинета"),
    ("UsernameNotOccupied",
     "Такого ника в Telegram нет — проверьте ник в настройках кабинета"),
    ("UsernameInvalid",
     "Ник записан неверно — проверьте его в настройках кабинета"),
    ("UserPrivacyRestricted",
     "У вас закрыты настройки приватности — вступите в группу по ссылке сами"),
    ("UserNotMutualContact",
     "Telegram не даёт добавить вас автоматически — вступите по ссылке сами"),
    ("FloodWait",
     "Telegram временно ограничил служебный аккаунт — продолжим позже"),
    ("PeerFlood",
     "Telegram временно ограничил служебный аккаунт — продолжим позже"),
    ("ChatAdminRequired",
     "У бота не хватает прав в группе"),
    ("PasswordHashInvalid",
     "Не подошёл пароль служебного аккаунта — нужен человек"),
    ("Timeout",
     "Telegram не ответил вовремя"),
)


def _human_error(exc: BaseException) -> str:
    """Понятный русский текст вместо имени исключения.

    Незнакомую ошибку не выдумываем и не показываем «как есть»: пишем нейтрально
    и зовём поддержку — техническая подробность всё равно остаётся в логах
    сервера, где её читает человек, а не клиент.
    """
    probe = f"{type(exc).__name__} {exc}"
    for key, text in _ERROR_TEXTS:
        if key.lower() in probe.lower():
            return text
    return "Не удалось выполнить шаг — мы разберёмся и продолжим"


# ─────────────────────────────────────────────────────────────────────────
# Выбор аккаунта под заказ
# ─────────────────────────────────────────────────────────────────────────
async def _transfer_failed_unless_done(db, client, order_id: int, client_id: int,
                                       bot_username: str, reason: str) -> None:
    """Пишет ошибку передачи — но СНАЧАЛА проверяет, не передан ли бот уже.

    ⚠️⚠️ ПОРЯДОК ВАЖЕН: сначала факт, потом ошибка. BotFather отвечает
    по-разному («It worked!», «Success!», …), и незнакомый ответ раньше сразу
    красил шаг красным: человек видел «Не удалось выполнить шаг, напишите в
    тех.поддержку» на успешной передаче (заказ 5, 11.09.2026). Перепроверка
    была, но срабатывала ПОСЛЕ показа ошибки — через 12 секунд.

    Признак успеха однозначный: бота больше нет в `/mybots` нашего аккаунта.
    """
    try:
        import app.services.tg_setup as tgs

        u = (bot_username or "").lstrip("@")
        await tgs._ask(client, tgs.BOTFATHER, "/cancel", wait=2)
        mine = (await tgs._ask(client, tgs.BOTFATHER, "/mybots", wait=5) or "").lower()
        if u and ("no bots" in mine or f"@{u.lower()}" not in mine):
            await db.execute(
                "UPDATE service_orders SET bot_transferred_at=NOW(), "
                "       setup_error=NULL, updated_at=NOW() WHERE id=$1", order_id,
            )
            await _log_step(db, order_id, "transfer",
                            "Бот теперь ваш — вы его владелец")
            logger.info("tg_setup transfer order %s: ответ не распознан (%s), "
                        "но бот @%s исчез из /mybots — передача прошла",
                        order_id, reason, u)
            return
    except Exception as e:  # noqa: BLE001
        # ⚠️ Перепроверка не удалась — успех наугад НЕ выдаём, идём в ошибку:
        # лучше лишний раз позвать поддержку, чем сказать «готово» о
        # непереданном боте.
        logger.warning("tg_setup transfer order %s: перепроверка не удалась: %s",
                       order_id, e)

    await _fail_step(db, order_id, client_id, bot_username, reason, step="transfer")

async def _fail_step(db, order_id: int, client_id: int,
                     bot_username: str, reason: str, step: str = "transfer") -> None:
    """Неудача НА ЛЮБОМ ШАГЕ: считаем попытки, после ВТОРОЙ — закрываем задачу.

    ⚠️⚠️ ПРАВИЛО ВЛАДЕЛЬЦА: две неудачи — и задача закрывается с ошибкой,
    дальше разбирается человек. Раньше поллер повторял бесконечно (51 попытка
    подряд за час на живом заказе) — это долбёжка в Telegram с ЕДИНСТВЕННОГО
    служебного аккаунта, ровно то, за что Telegram ограничивает аккаунты.
    Потеряем аккаунт — встанет вся услуга.

    ⚠️⚠️ СЧЁТЧИК НУЖЕН НА КАЖДОМ ШАГЕ, А НЕ ТОЛЬКО НА ПЕРЕДАЧЕ ПРАВ. Сначала
    его поставили только на передачу — и 09.09.2026 аккаунт всё равно
    ЗАБЛОКИРОВАЛИ: бесконечно повторялось СОЗДАНИЕ ГРУППЫ, у которого счётчика
    не было. Отсюда параметр `step`: функция закрывает шаг любого имени.

    ⚠️ Стоп ≠ отмена услуги. Заказ помечается `failed`, но оплата не сгорает:
    человек может запустить настройку заново сколько угодно раз.

    ⚠️ Счётчик живёт В ЗАКАЗЕ, а не в памяти: поллер перезапускается при каждом
    деплое, и счётчик в памяти обнулялся бы, начиная цикл заново.

    ⚠️ Первая неудача НЕ закрывает заказ: причина бывает временной (сеть,
    BotFather не ответил), и человек может повторить кнопкой «Передать мне».
    """
    attempts = await db.fetchval(
        "UPDATE service_orders SET transfer_attempts = transfer_attempts + 1, "
        "       setup_error = $2, updated_at = NOW() "
        " WHERE id = $1 RETURNING transfer_attempts",
        order_id, reason,
    ) or 1

    if attempts < 2:
        await _log_step(db, order_id, step,
                        f"{reason}. Пробуем ещё раз",
                        ok=False)
        return

    # ── вторая неудача: закрываем задачу и зовём человека ──
    await db.execute(
        "UPDATE service_orders SET setup_state='failed', updated_at=NOW() WHERE id=$1",
        order_id,
    )
    await _log_step(db, order_id, step,
                    f"{reason}. Мы остановились и передали задачу в тех.поддержку",
                    ok=False)

    # ⚠️ Уведомление ОСНОВАТЕЛЮ — в группу «[Тех.поддержка] Увед. ПЛЮСОН».
    # Используем готовую точку, своей отправки не заводим. Сбой уведомления не
    # должен ломать обработку заказа — потому и try.
    try:
        from app.services.plusson_referral_notify import notify_founder_channel
        row = await db.fetchrow(
            "SELECT name, email, telegram_username FROM clients WHERE id=$1", client_id
        )
        await notify_founder_channel(db, (
            f"🔴 <b>Автонастройка остановлена (шаг: {step})</b>\n\n"
            f"Клиент: {row['name'] if row else client_id}"
            f"{' · ' + row['email'] if row and row['email'] else ''}\n"
            f"Ник: {row['telegram_username'] if row else '—'}\n"
            f"Бот: @{bot_username}\n"
            f"Причина: {reason}\n\n"
            "Задача остановлена после двух попыток — нужен человек."
        ))
    except Exception as e:  # noqa: BLE001
        logger.warning("tg_setup: не удалось уведомить основателя: %s", e)


async def _pick_account(db):
    """Свободный аккаунт с местом под ещё одного бота.

    ⚠️ Берём только health='ok': аккаунт под спам-блоком ботов не создаёт
    вовсе (BotFather отвечает «cannot create new bots»), и заказ на нём
    просто сгорел бы. Проверку здоровья гоняет отдельная задача.

    ⚠️⚠️ ЧЕТЫРЕ ОГРАНИЧИТЕЛЯ, и каждый про своё (миграция 414):
      • `max_slots`          — сколько ботов висит НЕПЕРЕДАННЫМИ сейчас;
      • `cooldown_until`     — Telegram уже сказал «подожди столько-то»;
      • `daily_bot_limit`    — сколько создаём за сутки (наша страховка);
      • `min_create_gap_min` — пауза после предыдущего создания.
    Первые два — реакция на уже случившееся, вторые два — чтобы до этого не
    доводить: у BotFather нарастающий лимит, и три аккаунта подряд легко
    создают ботов за минуты и ложатся все разом на 17 часов.

    ⚠️ NULL или 0 в новых полях = без ограничения (прежнее поведение).
    """
    return await db.fetchrow(
        """
        SELECT a.*,
               (SELECT COUNT(*) FROM service_orders so
                 WHERE so.setup_account_id = a.id
                   AND so.bot_transferred_at IS NULL
                   AND so.bot_created_at IS NOT NULL
                   AND so.setup_state IN ('running','awaiting_user')) AS busy,
               (SELECT COUNT(*) FROM service_orders so
                 WHERE so.setup_account_id = a.id
                   AND so.bot_created_at >= NOW() - INTERVAL '24 hours') AS made_today
          FROM tg_setup_accounts a
         WHERE a.is_active = TRUE AND a.health = 'ok'
           -- ⚠️ Аккаунт, упёршийся в лимит BotFather, отдыхает: он физически
           -- не создаст бота, пока срок не пройдёт. Берём следующий свободный.
           AND (a.cooldown_until IS NULL OR a.cooldown_until <= NOW())
           -- Суточный лимит — считаем по фактическим заказам за 24 часа.
           AND (COALESCE(a.daily_bot_limit, 0) = 0
                OR (SELECT COUNT(*) FROM service_orders so2
                     WHERE so2.setup_account_id = a.id
                       AND so2.bot_created_at >= NOW() - INTERVAL '24 hours')
                    < a.daily_bot_limit)
           -- Пауза между созданиями — от отметки последнего.
           AND (COALESCE(a.min_create_gap_min, 0) = 0
                OR a.last_bot_created_at IS NULL
                OR a.last_bot_created_at
                   <= NOW() - (a.min_create_gap_min || ' minutes')::interval)
         ORDER BY busy ASC, a.id ASC
         LIMIT 1
        """
    )


def _acc_from_row(row) -> tgs.SetupAccount:
    return tgs.SetupAccount(
        id=row["id"],
        phone=row["phone"],
        twofa_password=row["twofa_password"] or "",
        proxy=row["proxy"] or "",
        session_path=row["session_path"] or "",
        username=row["username"] or "",
        tg_user_id=row["tg_user_id"] or 0,
    )


# ─────────────────────────────────────────────────────────────────────────
# Шаг 1 — создать бота, привязать Mini App, завести группу
# ─────────────────────────────────────────────────────────────────────────
async def _run_setup(db, order) -> None:
    """Делает всё, что можно сделать без участия клиента."""
    order_id = order["id"]
    client_id = order["client_id"]

    acc_row = await _pick_account(db)
    if not acc_row:
        # Свободных слотов нет — заказ остаётся в очереди, вернёмся через минуту.
        return
    if acc_row["busy"] >= acc_row["max_slots"]:
        return

    await db.execute(
        "UPDATE service_orders SET setup_state='running', setup_account_id=$2, "
        "       updated_at=NOW() WHERE id=$1",
        order_id, acc_row["id"],
    )

    acc = _acc_from_row(acc_row)
    client = None
    try:
        client = await tgs.connect(acc)

        # ── бот ──
        if not order["bot_created_at"]:
            await _log_step(db, order_id, "bot", "Создаём вашего бота…")
            token = await tgs.create_bot(
                client, order["bot_username"], order["bot_title"] or order["bot_username"]
            )
            deadline = datetime.now(timezone.utc) + timedelta(days=CLAIM_DAYS)
            await db.execute(
                "UPDATE service_orders SET bot_token=$2, bot_created_at=NOW(), "
                "       claim_deadline=$3, updated_at=NOW() WHERE id=$1",
                order_id, token, deadline,
            )
            # ⚠️ Отметка и счётчик на АККАУНТЕ (миграция 414): по ним очередь
            # считает паузу между созданиями, а админка показывает, сколько
            # ботов аккаунт сделал. Без этого пауза не работает вовсе —
            # `last_bot_created_at` остался бы пустым навсегда.
            await db.execute(
                "UPDATE tg_setup_accounts "
                "   SET last_bot_created_at = NOW(), "
                "       bots_created_total = bots_created_total + 1, "
                "       updated_at = NOW() WHERE id = $1",
                acc.id,
            )
            order = await db.fetchrow("SELECT * FROM service_orders WHERE id=$1", order_id)
            await _log_step(db, order_id, "bot",
                            f"Бот @{order['bot_username']} создан")

        # ── бот заводится в кабинете клиента ──
        if not order["bot_channel_id"]:
            channel_id = await _register_bot_channel(db, client_id, order)
            if channel_id:
                await db.execute(
                    "UPDATE service_orders SET bot_channel_id=$2, updated_at=NOW() "
                    " WHERE id=$1", order_id, channel_id,
                )
                # ⚠️ В тексте называем МЕСТО, где это видно: человек читает
                # лог и не понимает, куда смотреть, чтобы убедиться.
                await _log_step(db, order_id, "channel",
                                "Бот подключён к вашему кабинету — "
                                "виден в разделе «Каналы» → «Боты»")

        # ── Mini App ──
        #
        # ⚠️⚠️ ДЕЛАЕМ ДВА ДЕЙСТВИЯ, И ЭТО РАЗНЫЕ ВЕЩИ:
        #   1) ГЛАВНЫЙ Mini App — Bot Settings → Configure Mini App у BotFather.
        #      Он даёт короткие ссылки `t.me/бот?startapp=…`, на которых держится
        #      вся платформа (события, воронки, реф-ссылки). Спрашивают там
        #      ТОЛЬКО адрес: ни картинки, ни названия в этом меню нет — так и
        #      написано в нашей инструкции клиентам (/dashboard/help/connect-bot).
        #   2) КНОПКА МЕНЮ (`setChatMenuButton` через Bot API) — та самая кнопка
        #      в боте, которой человек открывает кабинет.
        #
        # ⚠️ НЕ `/newapp`. Раньше шли им, и шаг ПРОВАЛИВАЛСЯ ВСЕГДА: он заводит
        # ОТДЕЛЬНОЕ приложение с коротким именем и обязательно требует картинку
        # 640×360, а отправлялась ссылка на `pluson.ru/miniapp-cover.png`,
        # которого не существует (404, файла нет в проекте). Клиент читал
        # «Приложение подключим отдельно» при каждой настройке.
        if not order["miniapp_linked_at"]:
            base = (settings.frontend_url or "https://pluson.ru").rstrip("/")
            url = f"{base}/c/{client_id}/tg/"
            # ⚠️ Токен берём ИЗ ЗАКАЗА, а не из локальной переменной: она
            # существует, только когда бота создали в этом же прогоне. При
            # повторном заходе (бот уже был) её нет — упали бы с NameError.
            bot_token = await db.fetchval(
                "SELECT bot_token FROM service_orders WHERE id=$1", order_id
            )

            # 1) Главный Mini App через BotFather.
            main_ok = await tgs.configure_main_mini_app(client, order["bot_username"], url)

            # 2) Кнопка меню через Bot API — независимо от первого шага.
            ok = False
            try:
                import httpx
                async with httpx.AsyncClient(timeout=20) as http:
                    r = await http.post(
                        f"https://api.telegram.org/bot{bot_token}/setChatMenuButton",
                        json={"menu_button": {
                            "type": "web_app",
                            "text": "ОТКРЫТЬ",
                            "web_app": {"url": url},
                        }},
                    )
                    ok = bool(r.json().get("ok"))

                    # ── меню команд бота ──
                    #
                    # ⚠️ Без `setMyCommands` человек не знает, что боту вообще
                    # можно писать команды: списка в интерфейсе Telegram нет,
                    # пока его не задали. Обе команды в боте УЖЕ работают
                    # (`/app` и `/support` в bot/handlers/start.py) — мы лишь
                    # показываем их в меню. Ставить команду, которой нет в коде,
                    # нельзя: человек нажмёт, а бот промолчит.
                    await http.post(
                        f"https://api.telegram.org/bot{bot_token}/setMyCommands",
                        json={"commands": [
                            {"command": "app", "description": "Открыть приложение"},
                            {"command": "support", "description": "Служба поддержки"},
                        ]},
                    )
            except Exception as e:  # noqa: BLE001 — шаг не должен ронять настройку
                logger.warning("tg_setup: не удалось поставить кнопку Mini App: %s", e)

            # ⚠️ Шаг считается выполненным, если сработало ХОТЯ БЫ ОДНО: кнопка
            # меню и главный Mini App полезны по отдельности. Требовать оба —
            # значит из-за сбоя в переписке с BotFather объявить несделанным то,
            # что на деле работает.
            ok = ok or main_ok
            if ok:
                await db.execute(
                    "UPDATE service_orders SET miniapp_linked_at=NOW(), updated_at=NOW() "
                    " WHERE id=$1", order_id,
                )
                await _log_step(db, order_id, "miniapp",
                                "Приложение внутри бота подключено — "
                                "настройки в разделе «Mini App»")
            else:
                # ⚠️ Шаг необязательный: бот уже работает и полезен сам по себе.
                # Не роняем настройку, просто отмечаем в логе.
                await _log_step(db, order_id, "miniapp",
                                "Приложение подключим отдельно — бот уже работает",
                                ok=False)

        # ── группа уведомлений ──
        if not order["group_created_at"]:
            brand = await _client_brand(db, client_id)
            title = GROUP_TITLE_TEMPLATE.format(brand=brand)
            # ⚠️ «Создаём…» БЕЗ строки-результата читается как зависание: человек
            # видел «Создаём группу для уведомлений…» и рядом английскую ошибку,
            # и не понимал, создана группа или нет. Поэтому исход шага пишем
            # всегда — и удачный, и неудачный (вторым сообщением ниже).
            await _log_step(db, order_id, "group", "Создаём группу для уведомлений…")
            grp = await tgs.create_notifications_group(client, title, order["bot_username"])
            await db.execute(
                "UPDATE service_orders SET group_chat_id=$2, group_invite_link=$3, "
                "       group_created_at=NOW(), updated_at=NOW() WHERE id=$1",
                order_id, grp.chat_id, grp.invite_link,
            )
            # Сразу прописываем в кабинет — уведомления заработают, как только
            # клиент вступит.
            # ⚠️ Ссылку-приглашение сохраняем КЛИЕНТУ, а не только в заказе
            # (миграция 386): заказ завершится и уйдёт из активных, а вступить в
            # группу человек может позже — с другого устройства или после
            # выхода. По одному `chat_id` в Telegram вступить нельзя.
            await db.execute(
                "UPDATE clients SET notifications_telegram_chat_id=$2, "
                "       notifications_telegram_invite_link=$3 WHERE id=$1",
                client_id, grp.chat_id, grp.invite_link,
            )
            await _log_step(db, order_id, "group",
                            "Группа создана и прописана в настройках — "
                            "Настройки → «Техническое», поле «Канал уведомлений»")

            # Пробуем добавить клиента сразу — вдруг у него открыта приватность.
            #
            # ⚠️⚠️ ПИШЕМ, ЧТО ПРОБУЕМ, А НЕ ЧТО ЧЕЛОВЕК «ВОШЁЛ» (16.09.2026).
            # Раньше лог сообщал «Вы добавлены в группу и назначены админом» —
            # и человек читал это как СВОЁ действие: «я никуда не заходила».
            # Добавляем его МЫ, своим сервисным аккаунтом, и получается это
            # далеко не всегда: у большинства закрыта приватность «кто может
            # добавлять в группы», и Telegram нам запрещает. Формулировка
            # обязана говорить, кто именно что сделал.
            tg_nick = await db.fetchval(
                "SELECT telegram_username FROM clients WHERE id=$1", client_id
            )
            if tg_nick:
                await _log_step(db, order_id, "group",
                                "Пробуем добавить вас в группу…")
                ok, why = await tgs.invite_to_group(client, grp.chat_id, tg_nick)
                if ok:
                    await db.execute(
                        "UPDATE service_orders SET client_joined_at=NOW(), updated_at=NOW() "
                        " WHERE id=$1", order_id,
                    )
                    await tgs.promote_in_group(client, grp.chat_id, tg_nick.lstrip("@"))
                    await _log_step(db, order_id, "group",
                                    "Добавили вас в группу и назначили админом — "
                                    "проверьте: группа появилась в списке чатов")
                else:
                    # ⚠️ Отказ — НЕ ошибка услуги: это нормальная настройка
                    # приватности. Говорим прямо, что делать, и не пугаем.
                    await _log_step(
                        db, order_id, "group",
                        "Добавить вас автоматически не вышло — у вас закрыты "
                        "настройки приватности «кто может добавлять в группы». "
                        "Это нормально: вступите сами по кнопке ниже.",
                    )

        # ─── Служба заботы ───
        #
        # ⚠️⚠️ ЭТО ШАГ УСЛУГИ, А НЕ «клиент заполнит сам в Настройках».
        # Поле `work_tg_username` необязательное, лежит отдельной вкладкой, и
        # до него не доходят. А без него молча не работает всё, что на нём
        # завязано: команда /support во всех ботах, кнопка «Тех. поддержка» в
        # меню события и в рассылках, блок поддержки на лендинге, подпись в
        # письмах о заказе. Настройка «под ключ» обязана закрыть и это.
        #
        # ⚠️ Ставим ТОЛЬКО в пустое поле: у части клиентов поддержку ведёт не
        # владелец, а отдельный аккаунт — затирать его настройку нельзя.
        # Нормализация общая с остальным проектом (ссылка https://…).
        support_nick = await db.fetchval(
            "SELECT telegram_username FROM clients WHERE id=$1", client_id
        )
        if support_nick:
            from app.services.support_message import tg_support_link
            link = tg_support_link(support_nick)
            if link:
                filled = await db.fetchval(
                    """UPDATE clients
                          SET work_tg_username = $2
                        WHERE id = $1 AND COALESCE(work_tg_username, '') = ''
                    RETURNING id""",
                    client_id, link,
                )
                # ⚠️⚠️ ШАГ ОТМЕЧАЕМ В ОБОИХ СЛУЧАЯХ — и когда заполнили сами, и
                # когда поле уже было в порядке. Раньше запись шла ТОЛЬКО при
                # `filled`, и у клиента с заполненной ранее службой заботы пункт
                # оставался серым навсегда: работа сделана, а в отчёте «не
                # сделано». Для человека шаг закрыт в любом случае — разница
                # только в формулировке.
                await _log_step(
                    db, order_id, "support",
                    "Служба заботы прописана — заработают «Тех. поддержка» "
                    "в боте и на лендинге" if filled
                    else "Служба заботы уже заполнена — оставили вашу настройку",
                )

        # Всё, что могли — сделали. Дальше ждём клиента.
        await db.execute(
            "UPDATE service_orders SET setup_state='awaiting_user', updated_at=NOW() "
            " WHERE id=$1", order_id,
        )
        await _log_step(db, order_id, "wait",
                        "Готово. Осталось зайти в бота и вступить в группу")

        # ⚠️⚠️ ПИСЬМО УХОДИТ СРАЗУ, а не ждёт напоминаний. Раньше о том, что
        # настройка дошла до «зайдите в бота», человек узнавал ТОЛЬКО из
        # `remind` — а та бежит раз в час и шлёт не чаще раза в 20 часов.
        # Закрыл вкладку — и следующий шаг всплывал в лучшем случае через
        # сутки; бот тем временем занимает слот и держит очередь.
        #
        # ⚠️ Ошибка отправки НЕ роняет настройку: бот создан, работа сделана —
        # человек увидит тот же шаг в кабинете и в напоминаниях.
        try:
            fresh = await db.fetchrow("SELECT * FROM service_orders WHERE id=$1", order_id)
            if fresh:
                await _send_ready_notice(db, fresh)
        except Exception as e:  # noqa: BLE001
            logger.warning("ready notice failed for order %s: %s", order_id, e)

    except tgs.BotFatherError as e:
        state = "queued" if e.retryable else "failed"
        # ⚠️⚠️ BotFather ограничивает создание ботов, и лимит бывает СУТОЧНЫМ:
        # на проде он ответил «try again in 61470 seconds» — 17 часов. Срок
        # берём из его же ответа, иначе поллер весь день бьётся в закрытую
        # дверь. Заказ при этом ждёт в очереди, а не сгорает.
        wait_sec = int(getattr(e, "retry_after_sec", 0) or 0)
        await db.execute(
            "UPDATE service_orders SET setup_state=$2, setup_error=$3, "
            "       setup_account_id = CASE WHEN $4 > 0 THEN NULL ELSE setup_account_id END, "
            "       retry_after = CASE WHEN $4 > 0 "
            "                          THEN NOW() + ($4 || ' seconds')::interval "
            "                          ELSE NULL END, "
            "       updated_at=NOW() WHERE id=$1",
            order_id, state, str(e), wait_sec,
        )
        logger.warning("tg_setup order %s: %s (raw=%s)", order_id, e, e.raw[:200])

        if wait_sec == 0:
            # ⚠️⚠️ БЕЗ ЯВНОГО СРОКА ОЖИДАНИЯ ЭТО ОБЫЧНАЯ НЕУДАЧА — со счётчиком.
            # Раньше `retryable=True` без срока возвращал заказ в очередь
            # безусловно, то есть повтор каждую минуту без конца: ещё один
            # путь к блокировке аккаунта, помимо создания группы.
            await _fail_step(db, order_id, client_id, order["bot_username"] or "",
                             _human_error(e), step="setup")
        else:
            # ⚠️ Лимит у ЭТОГО аккаунта, а не у услуги: помечаем его отдыхающим,
            # и очередь возьмёт следующий свободный. Иначе один исчерпанный
            # аккаунт останавливал бы работу целиком, хотя рядом есть живые.
            await db.execute(
                "UPDATE tg_setup_accounts "
                "   SET cooldown_until = NOW() + ($2 || ' seconds')::interval, "
                "       updated_at = NOW() WHERE id=$1",
                acc.id, wait_sec,
            )
            # Заказ отвязываем от аккаунта — пусть выберется заново.
            await db.execute(
                "UPDATE service_orders SET retry_after = NULL WHERE id=$1", order_id
            )

        if not e.retryable:
            # Аккаунт, похоже, заболел — пусть проверка здоровья разберётся.
            await db.execute(
                "UPDATE tg_setup_accounts SET health='unknown', updated_at=NOW() "
                " WHERE id=$1", acc.id,
            )
    except Exception as e:  # noqa: BLE001
        logger.exception("tg_setup order %s failed", order_id)
        # ⚠️⚠️ СЧЁТЧИК НА ЛЮБОМ ШАГЕ, А НЕ ТОЛЬКО НА ПЕРЕДАЧЕ ПРАВ.
        #
        # Здесь стояло безусловное «вернуть в очередь, продолжим автоматически»
        # — то есть БЕСКОНЕЧНЫЙ повтор раз в минуту при любой ошибке. Ровно так
        # 09.09.2026 был ЗАБЛОКИРОВАН служебный аккаунт: создание группы падало,
        # задача повторяла его сутки напролёт, и Telegram заморозил аккаунт
        # («Your account was blocked for violations of the Terms of Service»).
        # Аккаунт был единственный — услуга встала целиком.
        #
        # Правило владельца: две попытки на ЛЮБОМ шаге — и стоп, дальше человек.
        await _fail_step(
            db, order_id, order["client_id"], order["bot_username"] or "",
            _human_error(e), step="setup",
        )
    finally:
        if client:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001
                pass


async def _client_brand(db, client_id: int) -> str:
    row = await db.fetchrow(
        "SELECT COALESCE(NULLIF(brand_name,''), name) AS brand FROM clients WHERE id=$1",
        client_id,
    )
    return (row["brand"] if row else "") or "ПЛЮСОН"


async def _register_bot_channel(db, client_id: int, order) -> int | None:
    """Заводит созданного бота каналом клиента — как если бы он подключил его сам.

    ⚠️ Переиспользуем ту же схему, что и ручное подключение
    (channels + client_channels), чтобы бот ничем не отличался от
    подключённого руками: рассылки, воронки и меню находят его сами.
    """
    token = order["bot_token"]
    if not token:
        return None
    try:
        from app.api.channels import _tg_call  # переиспользуем проверенный вызов

        me = await _tg_call(token, "getMe")
        username = me.get("username") or order["bot_username"]
        title = me.get("first_name") or order["bot_title"] or username
    except Exception as e:  # noqa: BLE001
        logger.warning("getMe failed for order %s: %s", order["id"], e)
        return None

    async with db.transaction():
        channel_id = await db.fetchval(
            """INSERT INTO channels (platform_slug, display_name, handle, bot_token,
                                     is_system, is_test)
                    VALUES ('telegram', $1, $2, $3, FALSE, FALSE)
                 RETURNING id""",
            title, username, token,
        )
        # ⚠️ Главным делаем только если у клиента ещё нет главного telegram-бота:
        # иначе автонастройка молча перебила бы уже работающего бота.
        has_primary = await db.fetchval(
            """SELECT EXISTS(
                   SELECT 1 FROM client_channels cc
                     JOIN channels ch ON ch.id = cc.channel_id
                    WHERE cc.client_id = $1 AND ch.platform_slug='telegram'
                      AND cc.is_active = TRUE)""",
            client_id,
        )
        await db.execute(
            "INSERT INTO client_channels (client_id, channel_id, is_active) "
            "VALUES ($1, $2, $3)",
            client_id, channel_id, not has_primary,
        )
    return channel_id


# ─────────────────────────────────────────────────────────────────────────
# Шаг 2 — клиент сделал своё, доводим до конца
# ─────────────────────────────────────────────────────────────────────────
async def _finish_setup(db, order) -> None:
    """Передаёт права, когда клиент зашёл в бота и/или вступил в группу."""
    order_id = order["id"]
    client_id = order["client_id"]

    acc_row = await db.fetchrow(
        "SELECT * FROM tg_setup_accounts WHERE id=$1", order["setup_account_id"]
    )
    if not acc_row:
        return

    tg_nick = await db.fetchval(
        "SELECT telegram_username FROM clients WHERE id=$1", client_id
    )
    if not tg_nick:
        return

    acc = _acc_from_row(acc_row)
    client = None
    try:
        client = await tgs.connect(acc)

        # ── передача бота: возможна только после того, как клиент написал ему ──
        #
        # ⚠️⚠️ ОДНА ПОПЫТКА, А НЕ КАЖДУЮ МИНУТУ. Раньше неудача нигде не
        # запоминалась, и поллер повторял передачу бесконечно: на живом заказе
        # 51 попытка подряд за час. Это и мусор в логе, и — что важнее —
        # долбёжка в BotFather с одного аккаунта, за которую Telegram
        # ограничивает аккаунт. Сорвалось — останавливаемся и ждём, пока
        # человек нажмёт «Передать мне» (ручка transfer-now снимает стоп).
        if (order["client_started_bot_at"] and not order["bot_transferred_at"]
                and not order["setup_error"]):
            await _log_step(db, order_id, "transfer", "Передаём вам права на бота…")
            try:
                ok = await tgs.transfer_bot(
                    client, order["bot_username"], tg_nick, acc.twofa_password
                )
                if ok:
                    await db.execute(
                        "UPDATE service_orders SET bot_transferred_at=NOW(), "
                        "       setup_error=NULL, updated_at=NOW() WHERE id=$1", order_id,
                    )
                    await _log_step(db, order_id, "transfer",
                                    "Бот теперь ваш — вы его владелец")
                else:
                    await _transfer_failed_unless_done(
                        db, client, order_id, client_id, order["bot_username"],
                        "Передача не подтвердилась",
                    )
            except tgs.BotFatherError as e:
                # ⚠️ BotFather отвечает по-английски («SORRY, you can't transfer…»)
                # — клиенту это не текст. Понятную причину подбирает _human_error,
                # исходный ответ остаётся в логах сервера.
                logger.warning("tg_setup transfer order %s: %s", order_id, e)
                await _transfer_failed_unless_done(
                    db, client, order_id, client_id, order["bot_username"],
                    _human_error(e),
                )

        # ── права на группу: только после вступления клиента ──
        if order["client_joined_at"] and not order["group_transferred_at"]:
            ok = await tgs.promote_in_group(
                client, order["group_chat_id"], tg_nick.lstrip("@")
            )
            if ok:
                await db.execute(
                    "UPDATE service_orders SET group_transferred_at=NOW(), "
                    "       updated_at=NOW() WHERE id=$1", order_id,
                )
                await _log_step(db, order_id, "group",
                                "Вы админ группы с полными правами — "
                                "проверьте в самой группе: «Участники» → ваш аккаунт")

        # ── всё отдано — выходим из группы и закрываем заказ ──
        order = await db.fetchrow("SELECT * FROM service_orders WHERE id=$1", order_id)
        if order["bot_transferred_at"] and order["group_transferred_at"]:
            # ⚠️ Выходим ТОЛЬКО после того, как клиент стал полным админом,
            # иначе группа осталась бы без управления.
            await tgs.leave_group(client, order["group_chat_id"])
            await db.execute(
                "UPDATE service_orders SET setup_state='done', updated_at=NOW() "
                " WHERE id=$1", order_id,
            )
            await _log_step(db, order_id, "done",
                            "Настройка завершена — бот, группа и настройки "
                            "кабинета готовы к работе")

            # ⚠️⚠️ ДВЕ РАБОЧИЕ ЗАГОТОВКИ — иначе человек остаётся с пустым
            # ботом: бот есть, а что он умеет и как это проверить, непонятно.
            # Заготовки дают нажать свою же ссылку, увидеть выдачу глазами и
            # заменить тексты на свои (названия — заглушки «тут ваше…»).
            #
            # ⚠️ Ошибка НЕ роняет настройку: бот и группа уже переданы, работа
            # сделана. Заготовки — приятное дополнение, а не часть услуги.
            try:
                from app.api.solutions import create_demo_lead_magnets
                demos = await create_demo_lead_magnets(db, client_id)
                for d in demos:
                    if d.get("created"):
                        await _log_step(
                            db, order_id, f"demo{d['num']}",
                            f"Создан лид-магнит «{d['name']}» — проверьте выдачу "
                            f"на себе и замените тексты на свои. "
                            f"Править: раздел «Лид-магниты»",
                        )
                # ⚠️ Про витрину пишем ОТДЕЛЬНОЙ строкой: карточки «О проекте»
                # человек ищет в другом разделе (Mini App → «Продукты»), и без
                # этой строки он не узнает, что они появились.
                if demos:
                    await _log_step(
                        db, order_id, "offerings",
                        "Раздел «О проекте» в Mini App наполнен: два бесплатных "
                        "материала и «Стратегическая сессия» со ссылкой в вашу "
                        "личку. Проверить глазами участника: "
                        f"https://t.me/{order['bot_username']}/"
                        "?startapp=ref_tabecosystem · "
                        "Править: Mini App → «Продукты»",
                    )
            except Exception as e:  # noqa: BLE001
                logger.warning("demo lead magnets failed for order %s: %s", order_id, e)

    except Exception as e:  # noqa: BLE001
        logger.exception("tg_setup finish order %s failed", order_id)
        # ⚠️ Счётчик и здесь: без него шаг повторялся каждую минуту вечно.
        # Именно так был заблокирован служебный аккаунт 09.09.2026.
        await _fail_step(
            db, order_id, client_id, order["bot_username"] or "",
            _human_error(e), step="transfer",
        )
    finally:
        if client:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001
                pass


# ─────────────────────────────────────────────────────────────────────────
# Поллер очереди
# ─────────────────────────────────────────────────────────────────────────
@celery.task(name="app.tasks.tg_setup.tick")
def tick():
    """Раз в минуту: двигаем очередь автонастройки."""
    return run_async(_tick())


async def _tick():
    db = await _get_conn()
    try:
        # 1. Новые оплаченные — в очередь.
        await db.execute(
            "UPDATE service_orders SET setup_state='queued', updated_at=NOW() "
            " WHERE status='paid' AND setup_state='new' AND bot_username IS NOT NULL"
        )

        # 2. Очередь — по одному заказу за тик, чтобы не нагружать аккаунт.
        # ⚠️ `retry_after` — отсрочка после ограничения частоты BotFather.
        # Пока она не прошла, заказ пропускаем: попытка всё равно упрётся в
        # то же ограничение и только продлит его.
        order = await db.fetchrow(
            "SELECT * FROM service_orders "
            " WHERE setup_state='queued' AND status='paid' "
            "   AND (retry_after IS NULL OR retry_after <= NOW()) "
            " ORDER BY paid_at NULLS LAST, id LIMIT 1"
        )
        if order:
            await _run_setup(db, order)

        # 2б. Кто ждёт в очереди — сообщаем, что заявка принята и не потерялась.
        #
        # ⚠️⚠️ ПИСЬМО ТОЛЬКО ТЕМ, У КОГО НЕ НАЧАЛОСЬ СРАЗУ. Обычно очередь
        # берёт заказ за секунды (её будит сама кнопка), и письмо «принято»
        # через 9 секунд рядом с письмом «бот готов» — шум. Поэтому ждём
        # 2 минуты: если за это время не началось, человеку правда нужно
        # знать, что заявка в работе.
        #
        # ⚠️ Отметки (`queued_notice_at`), а не «прошло ли N минут»: поллер
        # бежит каждую минуту, иначе письмо ушло бы десять раз подряд.
        waiting = await db.fetch(
            """SELECT * FROM service_orders
                WHERE setup_state = 'queued' AND status = 'paid'
                  AND bot_created_at IS NULL
                  AND updated_at < NOW() - INTERVAL '2 minutes'
                  AND queued_notice_at IS NULL"""
        )
        for row in waiting:
            await _send_queue_notice(db, row, "accepted")
            await db.execute(
                "UPDATE service_orders SET queued_notice_at = NOW() WHERE id=$1", row["id"])

        # 2в. Ждёт больше 10 минут — второе письмо, уже с причиной и, если
        # она известна, точным временем возврата.
        delayed = await db.fetch(
            """SELECT * FROM service_orders
                WHERE setup_state = 'queued' AND status = 'paid'
                  AND bot_created_at IS NULL
                  AND queued_notice_at IS NOT NULL
                  AND queued_notice_at < NOW() - INTERVAL '10 minutes'
                  AND delay_notice_at IS NULL"""
        )
        for row in delayed:
            await _send_queue_notice(db, row, "delay")
            await db.execute(
                "UPDATE service_orders SET delay_notice_at = NOW() WHERE id=$1", row["id"])

        # 3. Те, кто ждёт клиента и уже дождался хотя бы одного действия.
        waiting = await db.fetch(
            "SELECT * FROM service_orders "
            " WHERE setup_state='awaiting_user' "
            "   AND (client_started_bot_at IS NOT NULL OR client_joined_at IS NOT NULL) "
            "   AND (bot_transferred_at IS NULL OR group_transferred_at IS NULL) "
            " ORDER BY id LIMIT 5"
        )
        for row in waiting:
            await _finish_setup(db, row)

        return {"ok": True}
    finally:
        await db.close()


# ─────────────────────────────────────────────────────────────────────────
# Напоминания и сгорание
# ─────────────────────────────────────────────────────────────────────────
@celery.task(name="app.tasks.tg_setup.remind")
def remind():
    """Раз в час: напоминаем забрать бота, просроченные — гасим."""
    return run_async(_remind())


async def _remind():
    db = await _get_conn()
    try:
        # ── напоминания ──
        # ⚠️ Считаем по счётчику отправленных, а не «прошло ли N часов»:
        # задача бежит каждый час, иначе одно напоминание ушло бы 24 раза в сутки.
        rows = await db.fetch(
            """SELECT so.*, c.name AS client_name
                 FROM service_orders so
                 JOIN clients c ON c.id = so.client_id
                WHERE so.setup_state = 'awaiting_user'
                  AND so.bot_transferred_at IS NULL
                  AND so.claim_deadline IS NOT NULL
                  AND so.claim_deadline > NOW()
                  AND (so.last_reminder_at IS NULL
                       OR so.last_reminder_at < NOW() - INTERVAL '20 hours')
                  AND so.reminders_sent < 4"""
        )
        for row in rows:
            await _send_reminder(db, row)
            await db.execute(
                "UPDATE service_orders SET reminders_sent = reminders_sent + 1, "
                "       last_reminder_at = NOW(), updated_at = NOW() WHERE id=$1",
                row["id"],
            )

        # ── сгорание ──
        expired = await db.fetch(
            """SELECT * FROM service_orders
                WHERE setup_state = 'awaiting_user'
                  AND bot_transferred_at IS NULL
                  AND claim_deadline IS NOT NULL
                  AND claim_deadline <= NOW()"""
        )
        for row in expired:
            await _expire_order(db, row)

        return {"reminded": len(rows), "expired": len(expired)}
    finally:
        await db.close()


async def _queue_wait_reason(db, order) -> tuple[str, datetime | None]:
    """Почему заказ ещё ждёт и когда вернёмся. → (причина, время-или-None).

    ⚠️⚠️ ПРИЧИНУ НАЗЫВАЕМ ЧЕСТНО, НО НЕ ПЕРЕКЛАДЫВАЕМ НА TELEGRAM. «Telegram
    вас ограничил» — неправда и пугает: ограничение стоит на НАШЕМ служебном
    аккаунте, к клиенту оно отношения не имеет. «Все менеджеры заняты» —
    тоже плохо: звучит как «у нас всё сломалось».
    Формулировка одна: у площадки есть предел на одновременное создание
    ботов, мы выжидаем его и продолжим сами.

    Причины:
      'limit'  — все живые аккаунты на отдыхе по лимиту. Время ИЗВЕСТНО
                 (`cooldown_until`) — его и называем, не выдумывая.
      'slots'  — свободных слотов нет: кто-то не забрал своего бота. Срок
                 неизвестен, обещать его нельзя.
      'queue'  — просто ждёт своей очереди.
    """
    # Своя отсрочка заказа (BotFather ответил «try again in N») — самая точная.
    if order.get("retry_after") and order["retry_after"] > datetime.now(timezone.utc):
        return "limit", order["retry_after"]

    row = await db.fetchrow(
        """SELECT
             COUNT(*) FILTER (WHERE a.cooldown_until IS NOT NULL
                                AND a.cooldown_until > NOW())        AS on_cooldown,
             COUNT(*)                                                AS alive,
             MIN(a.cooldown_until) FILTER (WHERE a.cooldown_until > NOW()) AS back_at,
             COALESCE(SUM(a.max_slots), 0)                           AS slots,
             COALESCE(SUM((SELECT COUNT(*) FROM service_orders so
                            WHERE so.setup_account_id = a.id
                              AND so.bot_transferred_at IS NULL
                              AND so.bot_created_at IS NOT NULL
                              AND so.setup_state IN ('running','awaiting_user'))), 0) AS busy
           FROM tg_setup_accounts a
          WHERE a.is_active = TRUE AND a.health = 'ok'"""
    )
    if not row or not row["alive"]:
        return "slots", None
    if row["on_cooldown"] and row["on_cooldown"] >= row["alive"]:
        return "limit", row["back_at"]
    if row["busy"] >= row["slots"]:
        return "slots", None
    return "queue", None


def _msk(dt: datetime) -> str:
    """Время по Москве строкой «в 09:40» / «завтра в 09:40»."""
    msk = dt.astimezone(timezone(timedelta(hours=3)))
    now = datetime.now(timezone(timedelta(hours=3)))
    prefix = "завтра " if msk.date() > now.date() else ""
    return f"{prefix}в {msk:%H:%M} МСК"


async def _send_queue_notice(db, order, kind: str) -> None:
    """Письмо об ожидании: 'accepted' — принято, 'delay' — всё ещё ждём.

    ⚠️ Коротко. Длинное письмо про очередь никто не дочитывает, а сказать
    нужно ровно три вещи: приняли, ничего делать не надо, напишем сами.
    """
    reason, back_at = await _queue_wait_reason(db, order)

    if kind == "accepted":
        subject = "Заявка на автонастройку принята"
        text = ("Заявка принята — настраиваем.\n\n"
                "Напишем, когда бот будет готов: останется зайти в него и "
                "принять права владельца. Делать ничего не нужно.")
    else:
        subject = "Автонастройка: ещё в работе"
        if reason == "limit" and back_at:
            when = _msk(back_at)
            text = (f"Ваш бот — следующий в очереди.\n\n"
                    f"У площадки Telegram есть предел на количество ботов, "
                    f"создаваемых за раз. Выжидаем его и продолжим {when} — "
                    f"автоматически, от вас ничего не нужно.")
        elif reason == "limit":
            text = ("Ваш бот — следующий в очереди.\n\n"
                    "У площадки Telegram есть предел на количество ботов, "
                    "создаваемых за раз. Выжидаем его и продолжим сами — "
                    "напишем, как только бот будет готов.")
        else:
            text = ("Заявка в работе, не потерялась.\n\n"
                    "Создаём ботов по очереди — как только дойдёт до вашего, "
                    "сразу напишем. От вас ничего не нужно.")

    try:
        from app.services.channels import notify_organizer_all_channels
        await notify_organizer_all_channels(order["client_id"], text, db)
    except Exception as e:  # noqa: BLE001
        logger.warning("queue notice to channels failed for order %s: %s", order["id"], e)
    try:
        await _send_reminder_email(db, order, text, subject=subject)
    except Exception as e:  # noqa: BLE001
        logger.warning("queue notice email failed for order %s: %s", order["id"], e)


async def _send_ready_notice(db, order) -> None:
    """Бот создан — зовём человека забрать права. Шлём СРАЗУ, один раз.

    ⚠️ Это не напоминание: напоминания (`_send_reminder`) идут потом, раз в
    20 часов. Здесь — первое и главное сообщение, ради которого человек и
    оставлял почту: настройка дошла до шага, который без него не двинется.

    ⚠️ Почта, а не только мессенджеры: человек мог закрыть кабинет, а в боте
    его ещё нет вовсе — он туда как раз и не зашёл.
    """
    text = (
        f"✅ Ваш бот @{order['bot_username']} создан и настроен.\n\n"
        f"Остался один шаг — он за вами:\n"
        f"1. Откройте бота: https://t.me/{order['bot_username']}\n"
        f"2. Нажмите «Запустить»\n"
        f"3. Вернитесь в кабинет — мы передадим вам права владельца\n\n"
        f"Без этого шага Telegram не даёт передать бота: он должен увидеть, "
        f"что вы с ним знакомы."
    )

    try:
        from app.services.channels import notify_organizer_all_channels
        await notify_organizer_all_channels(order["client_id"], text, db)
    except Exception as e:  # noqa: BLE001
        logger.warning("ready notice to channels failed for order %s: %s", order["id"], e)

    try:
        await _send_reminder_email(
            db, order, text, subject="Бот готов — заберите права владельца",
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("ready notice email failed for order %s: %s", order["id"], e)


async def _send_reminder(db, order) -> None:
    """Напоминание по всем каналам сразу: кабинет, почта, боты клиента.

    ⚠️ Плашку в кабинете рисует фронт по самому заказу — отдельно слать не надо.
    Здесь почта и мессенджеры.
    """
    left = order["claim_deadline"] - datetime.now(timezone.utc)
    hours = max(1, int(left.total_seconds() // 3600))
    when = f"{hours // 24} дн." if hours >= 24 else f"{hours} ч."

    text = (
        f"⏳ Ваш бот @{order['bot_username']} готов, но ещё не передан вам.\n\n"
        f"Откройте бота и нажмите «Запустить» — после этого мы передадим вам "
        f"права владельца.\n\n"
        f"Осталось времени: {when}. Потом бота придётся создавать заново "
        f"(повторно платить не нужно)."
    )

    try:
        from app.services.channels import notify_organizer_all_channels
        await notify_organizer_all_channels(order["client_id"], text, db)
    except Exception as e:  # noqa: BLE001
        logger.warning("reminder to channels failed for order %s: %s", order["id"], e)

    try:
        await _send_reminder_email(db, order, text)
    except Exception as e:  # noqa: BLE001
        logger.warning("reminder email failed for order %s: %s", order["id"], e)


async def _send_reminder_email(
    db, order, text: str, *, subject: str = "Заберите вашего Telegram-бота",
) -> None:
    email = await db.fetchval("SELECT email FROM clients WHERE id=$1", order["client_id"])
    if not email:
        return
    from app.services.email_sender import EmailSender

    html = text.replace("\n", "<br>")
    sender = EmailSender()
    await asyncio.to_thread(
        sender.send,
        to_email=email,
        subject=subject,
        html=html,
        text=text,
    )


async def _expire_order(db, order) -> None:
    """Срок вышел: удаляем бота, освобождаем слот, оплату сохраняем."""
    order_id = order["id"]
    acc_row = await db.fetchrow(
        "SELECT * FROM tg_setup_accounts WHERE id=$1", order["setup_account_id"]
    )
    if acc_row:
        client = None
        try:
            client = await tgs.connect(_acc_from_row(acc_row))
            await tgs._delete_bot(client, order["bot_username"])
        except Exception as e:  # noqa: BLE001
            logger.warning("expire: delete bot failed for order %s: %s", order_id, e)
        finally:
            if client:
                try:
                    await client.disconnect()
                except Exception:  # noqa: BLE001
                    pass

    # ⚠️ Канал бота у клиента тоже убираем — токен больше не рабочий.
    if order["bot_channel_id"]:
        try:
            await db.execute("DELETE FROM channels WHERE id=$1", order["bot_channel_id"])
        except Exception as e:  # noqa: BLE001
            logger.warning("expire: channel cleanup failed: %s", e)

    await db.execute(
        """UPDATE service_orders
              SET setup_state='expired', bot_token=NULL, bot_channel_id=NULL,
                  bot_created_at=NULL, miniapp_linked_at=NULL,
                  setup_error='Бот не был забран за 3 дня и удалён. '
                              'Запустите настройку заново — платить не нужно',
                  updated_at=NOW()
            WHERE id=$1""",
        order_id,
    )
    await _log_step(db, order_id, "expired",
                    "Бот удалён — вы не забрали его за 3 дня. "
                    "Настройку можно запустить заново без оплаты", ok=False)

    text = (
        f"Бот @{order['bot_username']} удалён — его не забрали в течение 3 дней.\n\n"
        f"Настройку можно запустить заново в разделе «Каналы» — "
        f"платить повторно не нужно."
    )
    try:
        from app.services.channels import notify_organizer_all_channels
        await notify_organizer_all_channels(order["client_id"], text, db)
    except Exception:  # noqa: BLE001
        pass


# ─────────────────────────────────────────────────────────────────────────
# Проверка здоровья аккаунтов
# ─────────────────────────────────────────────────────────────────────────
@celery.task(name="app.tasks.tg_setup.health_check")
def health_check():
    """Раз в 6 часов: спрашиваем у @SpamBot, живы ли сервисные аккаунты.

    ⚠️ Без этого очередь молча падала бы на каждом клиенте: аккаунт под
    спам-блоком не создаёт ботов вовсе, но внешне выглядит рабочим.
    """
    return run_async(_health_check())


async def _health_check():
    db = await _get_conn()
    try:
        rows = await db.fetch(
            "SELECT * FROM tg_setup_accounts WHERE is_active = TRUE ORDER BY id"
        )
        results = []
        for row in rows:
            health = await tgs.check_health(_acc_from_row(row))
            await db.execute(
                """UPDATE tg_setup_accounts
                      SET health=$2, health_note=$3, health_checked_at=NOW(),
                          username=COALESCE(NULLIF($4,''), username),
                          -- ⚠️ ::bigint ОБЯЗАТЕЛЕН: без него asyncpg выводит тип
                          -- литерала 0 как int32, а Telegram id давно длиннее
                          -- (8741578822 > 2^31) — запрос падает «value out of
                          -- int32 range». Поймано на живом аккаунте 07.09.2026.
                          tg_user_id=COALESCE(NULLIF($5::bigint, 0::bigint), tg_user_id),
                          updated_at=NOW()
                    WHERE id=$1""",
                row["id"], health.state, health.note,
                health.username, health.tg_user_id,
            )
            results.append({"phone": row["phone"], "health": health.state})
        return {"checked": results}
    finally:
        await db.close()
