"""Автонастройка: ловим действия клиента (миграция 364).

Три вещи, которые может сделать только сам клиент, и которые мы замечаем сами,
не заставляя его ничего сообщать:

  1. написал своему боту `/start` — узнаём его настоящий числовой Telegram-id
     и получаем право передать ему бота;
  2. вступил в созданную группу — назначаем его админом;
  3. добавил бота в свой канал — записываем канал в базу чатов для рассылок.

⚠️ ПОЧЕМУ ЭТО ВАЖНО.
Числовой id человека нельзя узнать ниоткуда: по токену бота Telegram отдаёт
данные самого бота, но НЕ его владельца, а передача владения идёт по @нику и
id не возвращает. Единственный источник — момент, когда человек сам напишет
боту. Поэтому мы его и ловим, вместо того чтобы просить клиента «узнайте свой
ID и впишите» (именно эту ручную возню услуга и убирает).

⚠️ ВСЁ ЗДЕСЬ FAIL-SAFE. Эти функции зовутся из обработчиков бота, которые
обслуживают всех клиентов платформы. Ошибка автонастройки не должна ломать
работу бота у остальных, поэтому каждая точка обёрнута в try/except.
"""
import logging
from typing import Optional

log = logging.getLogger(__name__)


async def on_client_started_bot(db, bot_token_id: Optional[int],
                                bot_username: str, tg_user_id: int,
                                tg_username: str = "") -> bool:
    """Кто-то написал боту `/start`. Если это клиент из заказа — отмечаем.

    ⚠️ Сверяем именно по @нику клиента из его кабинета: боту пишут все подряд,
    и принять первого встречного за владельца нельзя.
    """
    if not bot_username or not tg_user_id:
        return False
    try:
        order = await db.fetchrow(
            """SELECT so.id, so.client_id, c.telegram_username
                 FROM service_orders so
                 JOIN clients c ON c.id = so.client_id
                WHERE lower(so.bot_username) = lower($1)
                  AND so.setup_state = 'awaiting_user'
                  AND so.client_started_bot_at IS NULL
                ORDER BY so.id DESC LIMIT 1""",
            bot_username.lstrip("@"),
        )
        if not order:
            return False

        want = (order["telegram_username"] or "").lstrip("@").lower()
        got = (tg_username or "").lstrip("@").lower()
        # ⚠️ Ник клиента может быть записан как ссылка (t.me/ник) — приводим.
        want = want.rsplit("/", 1)[-1] if want else want
        if want and got and want != got:
            # Боту написал не владелец — это нормально, просто не наш случай.
            return False

        await db.execute(
            """UPDATE service_orders
                  SET client_started_bot_at = NOW(), client_tg_user_id = $2,
                      updated_at = NOW()
                WHERE id = $1""",
            order["id"], int(tg_user_id),
        )
        await _remember_client_tg_id(db, order["client_id"], int(tg_user_id))
        await _link_client_identity(db, order["client_id"], int(tg_user_id),
                                    tg_username or "")
        log.info("tg_setup: клиент %s зашёл в своего бота @%s (tg_id=%s)",
                 order["client_id"], bot_username, tg_user_id)
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("tg_setup on_client_started_bot failed: %s", e)
        return False


async def _remember_client_tg_id(db, client_id: int, tg_user_id: int) -> None:
    """Записывает id клиента в тестовые аккаунты рассылок.

    ⚠️ Ровно это клиент раньше делал руками: узнавал свой ID командой и вписывал
    в настройки, чтобы получать тестовые рассылки. Теперь заполняется само.
    ⚠️ Колонка `test_telegram_ids` — массив СТРОК (TEXT[]), не чисел.
    """
    try:
        await db.execute(
            """UPDATE clients
                  SET test_telegram_ids =
                      CASE WHEN $2 = ANY(COALESCE(test_telegram_ids, '{}'))
                           THEN test_telegram_ids
                           ELSE COALESCE(test_telegram_ids, '{}') || $2
                      END
                WHERE id = $1""",
            client_id, str(tg_user_id),
        )
    except Exception as e:  # noqa: BLE001
        log.warning("tg_setup: не записал тестовый id клиента %s: %s", client_id, e)


async def _link_client_identity(db, client_id: int, tg_user_id: int,
                                tg_username: str) -> None:
    """Цепляет пойманный Telegram-id к КАРТОЧКЕ клиента (его self-коллаб).

    ⚠️⚠️ ЗАЧЕМ. `personal_tg_id` карточки — это «пробный камень» проверки
    подписки на каналы ([subscription_check.py](backend/app/api/subscription_check.py)):
    боту дают заведомо подписанного человека — владельца канала. Прошёл
    `getChatMember` по нему → бот реально админ, его ответам можно верить; не
    прошёл → проверка ненадёжна и участников не режем.

    Раньше клиент вписывал свой id руками, а услуга «под ключ» ровно эту возню
    и убирает: id мы уже поймали в момент захода в бота, второй раз спрашивать
    незачем.

    ⚠️ Идентичность цепляем ОБЩЕЙ функцией `upsert_contact_with_identity`, а не
    своим INSERT: там живут дедуп, дорастание псевдо-записи `@ник` до числового
    id и защита от гонок. Свой запрос плодил бы вторые карточки человека.

    ⚠️ Fail-safe: сбой не должен ломать заход клиента в бота — самое важное
    (право передать бота) к этому моменту уже записано.
    """
    try:
        from app.services.self_collaborator import ensure_self_collaborator
        from app.services.contact_merge import upsert_contact_with_identity

        collab_id = await ensure_self_collaborator(db, client_id)
        if not collab_id:
            return
        contact_id = await db.fetchval(
            "SELECT contact_id FROM collaborators WHERE id = $1", collab_id
        )
        if not contact_id:
            return

        # `known_contact_id` — ключевой параметр: идентичность цепляется именно
        # к карточке клиента, а не заводит нового человека в его же базе.
        await upsert_contact_with_identity(
            db,
            client_id=client_id,
            platform_slug="telegram",
            platform_user_id=str(tg_user_id),
            username=(tg_username or "").lstrip("@") or None,
            known_contact_id=int(contact_id),
        )
        log.info("tg_setup: tg_id клиента %s привязан к его карточке", client_id)
    except Exception as e:  # noqa: BLE001
        log.warning("tg_setup: не привязал tg_id клиента %s к карточке: %s",
                    client_id, e)


async def on_member_joined_group(db, chat_id: int, tg_user_id: int,
                                 tg_username: str = "") -> bool:
    """Кто-то вступил в группу. Если это группа автонастройки и её владелец —
    отмечаем, дальше Celery назначит его админом.

    ⚠️ Само назначение админом делает НЕ бот, а сервисный аккаунт: право
    назначать админов есть у создателя группы, и оно даётся вместе с полными
    правами. Здесь мы только фиксируем факт вступления.
    """
    if not chat_id or not tg_user_id:
        return False
    try:
        order = await db.fetchrow(
            """SELECT so.id, so.client_id, c.telegram_username
                 FROM service_orders so
                 JOIN clients c ON c.id = so.client_id
                WHERE so.group_chat_id = $1
                  AND so.client_joined_at IS NULL
                ORDER BY so.id DESC LIMIT 1""",
            int(chat_id),
        )
        if not order:
            return False

        want = (order["telegram_username"] or "").lstrip("@").lower()
        want = want.rsplit("/", 1)[-1] if want else want
        got = (tg_username or "").lstrip("@").lower()
        # ⚠️ Если ник совпал — точно он. Если ника у человека нет вовсе,
        # считаем вступившего клиентом: в свежесозданную закрытую группу
        # ссылка есть только у него.
        if want and got and want != got:
            return False

        await db.execute(
            """UPDATE service_orders
                  SET client_joined_at = NOW(),
                      client_tg_user_id = COALESCE(client_tg_user_id, $2),
                      updated_at = NOW()
                WHERE id = $1""",
            order["id"], int(tg_user_id),
        )
        log.info("tg_setup: клиент %s вступил в группу %s",
                 order["client_id"], chat_id)
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("tg_setup on_member_joined_group failed: %s", e)
        return False


async def on_bot_added_to_channel(db, bot_id: int, chat_id: int, title: str,
                                  chat_type: str, is_admin: bool) -> bool:
    """Бота добавили в канал/группу клиента → записываем в базу чатов рассылок.

    ⚠️ ЗАЧЕМ. Это третий шаг услуги: «добавьте бота в свой канал». Раньше клиент
    должен был узнать id канала командой и вписать его руками — теперь мы узнаём
    его в момент добавления и записываем сами.

    ⚠️ НЕ трогаем группу уведомлений, которую создали сами: она уже прописана
    в clients.notifications_telegram_chat_id и в базу рассылок не относится.
    """
    if not bot_id or not chat_id:
        return False
    try:
        # Чей это бот.
        client_id = await db.fetchval(
            """SELECT cc.client_id
                 FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                WHERE ch.platform_slug = 'telegram'
                  AND split_part(ch.bot_token, ':', 1) = $1
                ORDER BY cc.is_active DESC LIMIT 1""",
            str(bot_id),
        )
        if not client_id:
            return False

        # Это наша группа уведомлений? Тогда ничего не делаем.
        is_setup_group = await db.fetchval(
            "SELECT EXISTS(SELECT 1 FROM service_orders WHERE group_chat_id = $1)",
            int(chat_id),
        )
        if is_setup_group:
            return False

        # ⚠️ chat_id в client_broadcast_chats — TEXT, не число.
        existing = await db.fetchval(
            "SELECT id FROM client_broadcast_chats "
            " WHERE client_id=$1 AND platform='telegram' AND chat_id=$2",
            client_id, str(chat_id),
        )
        if existing:
            await db.execute(
                "UPDATE client_broadcast_chats SET title=COALESCE(NULLIF($2,''), title), "
                "       is_active=TRUE, updated_at=NOW() WHERE id=$1",
                existing, title or "",
            )
        else:
            await db.execute(
                """INSERT INTO client_broadcast_chats
                       (client_id, platform, chat_id, title, is_active,
                        use_for_broadcasts, added_via)
                   VALUES ($1, 'telegram', $2, $3, TRUE, TRUE, 'auto')""",
                client_id, str(chat_id), title or "Канал",
            )

        # Отмечаем шаг в активном заказе, если он есть.
        await db.execute(
            """UPDATE service_orders
                  SET channel_linked_at = NOW(), updated_at = NOW()
                WHERE client_id = $1 AND channel_linked_at IS NULL
                  AND setup_state IN ('awaiting_user','done')""",
            client_id,
        )
        log.info("tg_setup: бот клиента %s добавлен в %s «%s» (админ=%s)",
                 client_id, chat_id, title, is_admin)
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("tg_setup on_bot_added_to_channel failed: %s", e)
        return False
