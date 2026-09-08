"""
Фоновые задачи Instagram: напоминание молчащему и продление токенов.

⚠️⚠️ `asyncio.set_event_loop(loop)` ОБЯЗАТЕЛЕН в каждой задаче. `new_event_loop()`
создаёт цикл, но НЕ делает его текущим: библиотеки внутри зовут
`asyncio.get_event_loop()` и получают ЗАКРЫТЫЙ цикл предыдущей задачи того же
воркера → RuntimeError('Event loop is closed'). На этом уже молча терялись
записи эфиров и Текст 3 воронок — правило проекта, не убирать.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

import asyncpg

from app.celery_app import celery
from ..config import settings

log = logging.getLogger(__name__)


def _run(coro):
    """Запустить корутину в задаче Celery — с правильным циклом событий."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


@celery.task(name="app.tasks.instagram.send_reminder")
def send_reminder(run_id: int):
    """Напоминание человеку, который не забрал материал.

    ⚠️ Внутри ЗАНОВО сверяется 24-часовое окно: задача ставится заранее, и к
    моменту исполнения срок мог выйти. Вне окна Meta отклонит отправку, а серия
    отказов портит репутацию приложения.
    """
    async def _go():
        from ..services.instagram_funnel import send_reminder as do
        conn = await asyncpg.connect(settings.database_url)
        try:
            return await do(conn, run_id)
        finally:
            await conn.close()

    try:
        return _run(_go())
    except Exception:
        log.exception("Instagram: напоминание run=%s сорвалось", run_id)
        return False


@celery.task(name="app.tasks.instagram.poll_comments")
def poll_comments():
    """Забрать свежие комментарии САМИ — временная замена вебхукам.

    ⚠️⚠️ ЗАЧЕМ ЭТО ЕСТЬ. Meta шлёт вебхуки о комментариях только
    ОПУБЛИКОВАННОМУ приложению, а для поля `comments` требует ещё и Advanced
    Access, то есть App Review длиной в недели. Проверено 2026-09-07: подписки
    настроены, права выданы, комментарии читаются запросом — а событий нет ни
    одного. Запросы к API при этом работают уже сейчас, поэтому до одобрения
    забираем комментарии опросом.

    ⚠️ ВРЕМЕННЫЙ режим. После одобрения Meta выключить (убрать из beat) и
    вернуться на вебхуки: они мгновенные и не тратят лимит запросов. Движок,
    тексты и выдача общие — меняется только источник события.
    """
    async def _go():
        import json
        from ..services import instagram_api as ig
        from ..services import instagram_funnel as funnel

        conn = await asyncpg.connect(settings.database_url)
        seen_new = handled = 0
        try:
            # Опрашиваем только каналы, у которых есть ЧТО опрашивать: без
            # активной воронки поход в Meta бессмыслен и тратит лимит.
            channels = await conn.fetch(
                """SELECT DISTINCT ch.id, ch.bot_token, ch.platform_meta, ch.ig_polled_at
                     FROM channels ch
                     JOIN instagram_funnels f
                       ON f.channel_id = ch.id AND f.is_active
                                        AND f.trigger_kind = 'comment'
                    WHERE ch.platform_slug = 'instagram'
                      AND COALESCE(ch.bot_token, '') <> ''"""
            )
            for ch in channels:
                meta = ch["platform_meta"] or {}
                if isinstance(meta, str):
                    meta = json.loads(meta)
                ig_user_id = str(meta.get("ig_user_id") or "")
                if not ig_user_id:
                    continue
                token = ch["bot_token"]

                # Какие публикации смотреть: если все воронки канала настроены
                # на конкретные рилсы — только их, иначе последние из ленты.
                #
                # ⚠️ Лента ограничена намеренно: комментарии под старыми
                # публикациями воронку не запускают, а каждый лишний рилс —
                # это лишний запрос к Meta каждую минуту.
                rows = await conn.fetch(
                    """SELECT media_scope, media_ids FROM instagram_funnels
                        WHERE channel_id=$1 AND is_active AND trigger_kind='comment'""",
                    ch["id"],
                )
                media_ids: list[str] = []
                need_recent = False
                for r in rows:
                    if r["media_scope"] == "specific":
                        media_ids.extend(r["media_ids"] or [])
                    else:
                        need_recent = True
                if need_recent:
                    try:
                        for m in await ig.list_media(ig_user_id, token, limit=10):
                            media_ids.append(str(m.get("id")))
                    except Exception as e:
                        log.warning("Instagram опрос: список публикаций канала %s — %s", ch["id"], e)

                for media_id in dict.fromkeys(media_ids):  # без повторов, порядок сохранён
                    try:
                        data = await ig.graph_get(
                            f"{media_id}/comments",
                            token=token,
                            params={"fields": "id,text,from,timestamp", "limit": 25},
                        )
                    except Exception as e:
                        log.warning("Instagram опрос: комментарии %s — %s", media_id, e)
                        continue

                    for c in (data.get("data") or []):
                        cid = str(c.get("id") or "")
                        if not cid:
                            continue
                        frm = c.get("from") or {}
                        sender = str(frm.get("id") or "")
                        # ⚠️ Свои комментарии пропускаем: иначе ответ бота под
                        # публикацией сам запустит воронку — бесконечный круг.
                        if not sender or sender == ig_user_id:
                            continue

                        # ⚠️⚠️ Отметка ставится ДО обработки и по первичному
                        # ключу: если задача упадёт на середине или Celery
                        # выполнит её повторно, человек не получит материал
                        # дважды. Цена — при сбое один комментарий останется
                        # без ответа; это меньшее зло, чем сообщения по кругу.
                        marked = await conn.fetchval(
                            """INSERT INTO instagram_seen_comments (comment_id, channel_id, media_id)
                                    VALUES ($1, $2, $3)
                               ON CONFLICT (comment_id) DO NOTHING
                                 RETURNING comment_id""",
                            cid, ch["id"], str(media_id),
                        )
                        if not marked:
                            continue  # уже видели
                        seen_new += 1

                        # ⚠️⚠️ ПЕРВЫЙ опрос канала НИЧЕГО НЕ ВЫДАЁТ, только
                        # запоминает. Иначе всем, кто комментировал за месяцы
                        # до подключения, разом улетит материал — от лица
                        # клиента, без всякого повода с их стороны.
                        if ch["ig_polled_at"] is None:
                            continue

                        try:
                            await funnel.handle_comment(
                                conn, ch["id"],
                                comment_id=cid,
                                media_id=str(media_id),
                                text=c.get("text") or "",
                                from_igsid=sender,
                                from_username=frm.get("username") or "",
                            )
                            handled += 1
                        except Exception:
                            log.exception("Instagram опрос: обработка комментария %s сорвалась", cid)

                # ── Ответы людей в директе ────────────────────────────────
                #
                # ⚠️⚠️ Без этого воронка останавливается на полпути: человек
                # получил «подпишитесь и нажмите Готово», нажал — а нажатие
                # приходит вебхуком `messages`, которого у нас нет. Материал
                # не выдаётся никогда, и снаружи это выглядит так, будто бот
                # обманул.
                try:
                    convs = await ig.list_conversations(meta.get("page_id") or "", token)
                except Exception as e:
                    # ⚠️ `%s` у InstagramApiError бывает ПУСТЫМ — тогда в логе
                    # висит «переписки канала 102 —» без причины, и разбирать
                    # нечего. Печатаем тип и user_message как запасной вариант.
                    log.warning(
                        "Instagram опрос: переписки канала %s — %s: %s | %s",
                        ch["id"], type(e).__name__, e,
                        getattr(e, "user_message", ""),
                    )
                    convs = []

                for conv in convs:
                    msgs = (conv.get("messages") or {}).get("data") or []
                    # ⚠️⚠️ Отвечаем ТОЛЬКО НА САМОЕ СВЕЖЕЕ сообщение человека,
                    # остальные лишь помечаем виденными.
                    #
                    # Meta отдаёт переписку целиком, и раньше опрос обрабатывал
                    # КАЖДОЕ новое сообщение подряд. Человек нажимает «Готово»
                    # дважды (первый раз не был подписан) — и получает материал,
                    # а следом два «уже отправляли». Смысла в ответе на каждое
                    # нажатие нет: человеку важен один ответ на его последнее
                    # действие.
                    #
                    # ⚠️⚠️ Свежее ищем ПО ВРЕМЕНИ (`created_time`), а НЕ по
                    # позиции в списке. Раньше здесь стояло «первое подходящее»
                    # в расчёте, что Meta отдаёт от новых к старым — оказалось
                    # ненадёжно: нажатие «Готово» попадало не первым, в одном
                    # прогоне помечалось молча, а в следующем становилось
                    # «свежим» и обрабатывалось ПОВТОРНО. Человек получал
                    # материал, а через минуту «уже отправляли».
                    def _ts(x: dict) -> str:
                        return str(x.get("created_time") or "")

                    from_user = [x for x in msgs
                                 if str((x.get("from") or {}).get("id") or "") not in ("", ig_user_id)]
                    newest_of_user = max(from_user, key=_ts) if from_user else None
                    for m in msgs:
                        mid = str(m.get("id") or "")
                        sender = str((m.get("from") or {}).get("id") or "")
                        # ⚠️ Свои сообщения пропускаем: иначе бот ответит сам
                        # себе на собственное «подпишитесь и нажмите Готово».
                        if not mid or not sender or sender == ig_user_id:
                            continue
                        # Не самое свежее — запоминаем, но не отвечаем.
                        is_newest = newest_of_user is not None and mid == str(newest_of_user.get("id") or "")

                        marked = await conn.fetchval(
                            """INSERT INTO instagram_seen_comments (comment_id, channel_id, media_id)
                                    VALUES ($1, $2, 'dm')
                               ON CONFLICT (comment_id) DO NOTHING
                                 RETURNING comment_id""",
                            mid, ch["id"],
                        )
                        if not marked:
                            continue
                        seen_new += 1

                        # ⚠️ Первый опрос канала только запоминает — иначе на
                        # старую переписку разом уйдут ответы (то же правило,
                        # что у комментариев выше).
                        if ch["ig_polled_at"] is None:
                            continue

                        # ⚠️ Не самое свежее сообщение человека — запомнили и
                        # молчим (см. пояснение выше про двойное «Готово»).
                        if not is_newest:
                            continue

                        try:
                            await funnel.handle_message(
                                conn, ch["id"],
                                from_igsid=sender,
                                text=m.get("message") or "",
                                from_username=(m.get("from") or {}).get("username") or "",
                            )
                            handled += 1
                        except Exception:
                            log.exception("Instagram опрос: обработка сообщения %s сорвалась", mid)

                await conn.execute(
                    "UPDATE channels SET ig_polled_at = now() WHERE id = $1", ch["id"]
                )

            # ⚠️ Уборка: таблица растёт на каждый комментарий под
            # отслеживаемыми публикациями, а нужна только чтобы не ответить
            # дважды. Месяца с запасом хватает — столько один комментарий в
            # ленте живым поводом не бывает.
            await conn.execute(
                "DELETE FROM instagram_seen_comments WHERE created_at < now() - interval '30 days'"
            )
        finally:
            await conn.close()
        return {"new": seen_new, "handled": handled}

    try:
        return _run(_go())
    except Exception:
        log.exception("Instagram: опрос комментариев сорвался")
        return {"new": 0, "handled": 0}


@celery.task(name="app.tasks.instagram.refresh_tokens")
def refresh_tokens():
    """Продлить токены, которым осталось меньше 10 дней.

    ⚠️⚠️ Токен живёт 60 дней. Без этой задачи воронка через два месяца молча
    перестаёт отвечать людям: не ломается заметно, а просто затихает — и клиент
    узнаёт об этом от подписчиков, а не от нас.

    ⚠️ Продлеваем ЗАРАНЕЕ, за 10 дней: если продление не удалось (клиент сменил
    пароль, отозвал доступ), остаётся время предупредить и переподключить.
    """
    async def _go():
        import json
        from ..services import instagram_api as ig

        conn = await asyncpg.connect(settings.database_url)
        ok = failed = 0
        try:
            rows = await conn.fetch(
                "SELECT id, bot_token, platform_meta FROM channels "
                " WHERE platform_slug='instagram' AND COALESCE(bot_token,'') <> ''"
            )
            soon = int((datetime.now(timezone.utc) + timedelta(days=10)).timestamp())
            for r in rows:
                meta = r["platform_meta"] or {}
                if isinstance(meta, str):
                    meta = json.loads(meta)
                exp = int(meta.get("token_expires_at") or 0)
                if exp and exp > soon:
                    continue
                try:
                    tok, ttl = await ig.refresh_long_lived(r["bot_token"])
                except Exception as e:
                    failed += 1
                    log.warning("Instagram: токен канала %s не продлён — %s", r["id"], e)
                    # ⚠️ Отметку об ошибке кладём в сам канал: по ней кабинет
                    # покажет клиенту, что доступ пора обновить, не дожидаясь,
                    # пока воронка замолчит.
                    meta["token_refresh_failed_at"] = int(datetime.now(timezone.utc).timestamp())
                    await conn.execute(
                        "UPDATE channels SET platform_meta=$2::jsonb WHERE id=$1",
                        r["id"], json.dumps(meta),
                    )
                    continue
                meta["token_expires_at"] = int(datetime.now(timezone.utc).timestamp()) + ttl
                meta.pop("token_refresh_failed_at", None)
                await conn.execute(
                    "UPDATE channels SET bot_token=$2, platform_meta=$3::jsonb, updated_at=now() WHERE id=$1",
                    r["id"], tok, json.dumps(meta),
                )
                ok += 1
        finally:
            await conn.close()
        return {"refreshed": ok, "failed": failed}

    try:
        return _run(_go())
    except Exception:
        log.exception("Instagram: продление токенов сорвалось")
        return {"refreshed": 0, "failed": 0}
