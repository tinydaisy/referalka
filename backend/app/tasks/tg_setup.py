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
    await db.execute(
        "UPDATE service_orders "
        "   SET setup_log = COALESCE(setup_log, '[]'::jsonb) || $2::jsonb, "
        "       updated_at = NOW() "
        " WHERE id = $1",
        order_id, f"[{entry}]",
    )


# ─────────────────────────────────────────────────────────────────────────
# Выбор аккаунта под заказ
# ─────────────────────────────────────────────────────────────────────────
async def _pick_account(db):
    """Свободный аккаунт с местом под ещё одного бота.

    ⚠️ Берём только health='ok': аккаунт под спам-блоком ботов не создаёт
    вовсе (BotFather отвечает «cannot create new bots»), и заказ на нём
    просто сгорел бы. Проверку здоровья гоняет отдельная задача.
    """
    return await db.fetchrow(
        """
        SELECT a.*,
               (SELECT COUNT(*) FROM service_orders so
                 WHERE so.setup_account_id = a.id
                   AND so.bot_transferred_at IS NULL
                   AND so.bot_created_at IS NOT NULL
                   AND so.setup_state IN ('running','awaiting_user')) AS busy
          FROM tg_setup_accounts a
         WHERE a.is_active = TRUE AND a.health = 'ok'
           -- ⚠️ Аккаунт, упёршийся в лимит BotFather, отдыхает: он физически
           -- не создаст бота, пока срок не пройдёт. Берём следующий свободный.
           AND (a.cooldown_until IS NULL OR a.cooldown_until <= NOW())
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
                await _log_step(db, order_id, "channel",
                                "Бот подключён к вашему кабинету")

        # ── Mini App ──
        if not order["miniapp_linked_at"]:
            base = (settings.frontend_url or "https://pluson.ru").rstrip("/")
            url = f"{base}/c/{client_id}/tg/"
            brand = await _client_brand(db, client_id)
            ok = await tgs.link_mini_app(client, order["bot_username"], url, brand)
            if ok:
                await db.execute(
                    "UPDATE service_orders SET miniapp_linked_at=NOW(), updated_at=NOW() "
                    " WHERE id=$1", order_id,
                )
                await _log_step(db, order_id, "miniapp", "Приложение внутри бота подключено")
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
            await _log_step(db, order_id, "group", "Создаём группу для уведомлений…")
            grp = await tgs.create_notifications_group(client, title, order["bot_username"])
            await db.execute(
                "UPDATE service_orders SET group_chat_id=$2, group_invite_link=$3, "
                "       group_created_at=NOW(), updated_at=NOW() WHERE id=$1",
                order_id, grp.chat_id, grp.invite_link,
            )
            # Сразу прописываем в кабинет — уведомления заработают, как только
            # клиент вступит.
            await db.execute(
                "UPDATE clients SET notifications_telegram_chat_id=$2 WHERE id=$1",
                client_id, grp.chat_id,
            )
            await _log_step(db, order_id, "group",
                            "Группа создана и прописана в настройках")

            # Пробуем добавить клиента сразу — вдруг у него открыта приватность.
            tg_nick = await db.fetchval(
                "SELECT telegram_username FROM clients WHERE id=$1", client_id
            )
            if tg_nick:
                ok, why = await tgs.invite_to_group(client, grp.chat_id, tg_nick)
                if ok:
                    await db.execute(
                        "UPDATE service_orders SET client_joined_at=NOW(), updated_at=NOW() "
                        " WHERE id=$1", order_id,
                    )
                    await tgs.promote_in_group(client, grp.chat_id, tg_nick.lstrip("@"))
                    await _log_step(db, order_id, "group",
                                    "Вы добавлены в группу и назначены админом")

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
                if filled:
                    await _log_step(db, order_id, "support",
                                    "Служба заботы прописана — заработают "
                                    "«Тех. поддержка» в боте и на лендинге")

        # Всё, что могли — сделали. Дальше ждём клиента.
        await db.execute(
            "UPDATE service_orders SET setup_state='awaiting_user', updated_at=NOW() "
            " WHERE id=$1", order_id,
        )
        await _log_step(db, order_id, "wait",
                        "Готово. Осталось зайти в бота и вступить в группу")

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
        await _log_step(db, order_id, "error", str(e), ok=False)
        logger.warning("tg_setup order %s: %s (raw=%s)", order_id, e, e.raw[:200])

        if wait_sec > 0:
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
        elif not e.retryable:
            # Аккаунт, похоже, заболел — пусть проверка здоровья разберётся.
            await db.execute(
                "UPDATE tg_setup_accounts SET health='unknown', updated_at=NOW() "
                " WHERE id=$1", acc.id,
            )
    except Exception as e:  # noqa: BLE001
        logger.exception("tg_setup order %s failed", order_id)
        await db.execute(
            "UPDATE service_orders SET setup_state='queued', setup_error=$2, "
            "       updated_at=NOW() WHERE id=$1",
            order_id, "Временная заминка, продолжим автоматически",
        )
        await _log_step(db, order_id, "error", f"{type(e).__name__}", ok=False)
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
        if order["client_started_bot_at"] and not order["bot_transferred_at"]:
            await _log_step(db, order_id, "transfer", "Передаём вам права на бота…")
            try:
                ok = await tgs.transfer_bot(
                    client, order["bot_username"], tg_nick, acc.twofa_password
                )
                if ok:
                    await db.execute(
                        "UPDATE service_orders SET bot_transferred_at=NOW(), "
                        "       updated_at=NOW() WHERE id=$1", order_id,
                    )
                    await _log_step(db, order_id, "transfer",
                                    "Бот теперь ваш — вы его владелец")
            except tgs.BotFatherError as e:
                await _log_step(db, order_id, "transfer", str(e), ok=False)

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
                                "Вы админ группы с полными правами")

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
            await _log_step(db, order_id, "done", "Настройка завершена")

    except Exception as e:  # noqa: BLE001
        logger.exception("tg_setup finish order %s failed", order_id)
        await _log_step(db, order_id, "error", f"{type(e).__name__}", ok=False)
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


async def _send_reminder_email(db, order, text: str) -> None:
    email = await db.fetchval("SELECT email FROM clients WHERE id=$1", order["client_id"])
    if not email:
        return
    from app.services.email_sender import EmailSender

    html = text.replace("\n", "<br>")
    sender = EmailSender()
    await asyncio.to_thread(
        sender.send,
        to_email=email,
        subject="Заберите вашего Telegram-бота",
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
