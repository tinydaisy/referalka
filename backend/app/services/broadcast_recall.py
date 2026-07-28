"""Отзыв (удаление) уже отправленной рассылки в Telegram / VK / MAX.

Работает только для сообщений, у которых при отправке был сохранён
`broadcast_log.external_message_id` (message_id одного или нескольких
сообщений через запятую). Сохранять message_id для отзыва начали 2026-07-16 —
более старые рассылки отозвать нельзя (id не сохранялись).

По платформам:
  • Telegram — deleteMessage(chat_id, message_id). Личные + групповые TG-чаты.
  • VK       — messages.delete(message_ids, delete_for_all=1).
  • MAX      — DELETE /messages?message_id=...
Email — отозвать невозможно (письмо уже доставлено), такие записи пропускаются.

⚠️ Платформа может отказать удалить сообщение, если оно слишком старое или у
бота нет прав — тогда запись попадёт в «не удалось» с причиной. Мы не гадаем
срок заранее, а показываем фактический ответ платформы.
"""
import asyncio
import logging

import httpx

logger = logging.getLogger(__name__)


async def _tg_delete(http: httpx.AsyncClient, token: str, chat_id: str, message_id: str) -> tuple[bool, str]:
    try:
        r = await http.post(
            f"https://api.telegram.org/bot{token}/deleteMessage",
            json={"chat_id": chat_id, "message_id": int(message_id)},
        )
        data = r.json()
        if data.get("ok"):
            return True, ""
        return False, data.get("description") or f"HTTP {r.status_code}"
    except Exception as e:  # noqa: BLE001
        return False, str(e)


async def _vk_delete(token: str, message_id: str) -> tuple[bool, str]:
    from app.services.vk_api import vk_call
    try:
        await vk_call("messages.delete", {
            "message_ids": int(message_id), "delete_for_all": 1,
        }, token=token)
        return True, ""
    except Exception as e:  # noqa: BLE001
        return False, str(e)


async def _max_delete(token: str, message_id: str) -> tuple[bool, str]:
    from app.services.max_api import max_call
    try:
        await max_call("DELETE", "/messages", token=token, params={"message_id": message_id})
        return True, ""
    except Exception as e:  # noqa: BLE001
        return False, str(e)


async def recall_broadcast(db, schedule_id: int) -> dict:
    """Пытается удалить у получателей все сообщения рассылки, для которых
    сохранён message_id (TG/VK/MAX).

    Возвращает сводку:
      {ok, deleted, failed, skipped_no_msgid, skipped_email, total_log_rows,
       by_platform: {telegram, vk, max}, errors: [примеры ошибок]}
    """
    from app.services.channels import (
        get_client_telegram_token, get_client_vk_token, get_client_max_token,
    )

    sched = await db.fetchrow(
        "SELECT id, client_id FROM broadcast_schedules WHERE id = $1", schedule_id
    )
    if not sched:
        return {"ok": False, "error": "Рассылка не найдена"}
    client_id = sched["client_id"]

    # Клиентские токены как fallback (когда channel_id в логе NULL — напр. чаты).
    tg_default = await get_client_telegram_token(client_id, db) if client_id else None
    vk_default = await get_client_vk_token(client_id, db) if client_id else None
    max_default = await get_client_max_token(client_id, db) if client_id else None

    rows = await db.fetch(
        """
        SELECT bl.id, bl.external_message_id, bl.channel_id, bl.platform_user_id,
               bl.chat_platform, bl.chat_ref,
               pu.platform_slug AS pu_platform, pu.platform_user_id AS platform_uid,
               ch.bot_token, ch.platform_slug AS ch_platform
          FROM broadcast_log bl
          LEFT JOIN platform_users pu ON pu.id = bl.platform_user_id
          LEFT JOIN channels ch ON ch.id = bl.channel_id
         WHERE bl.schedule_id = $1
        """,
        schedule_id,
    )

    deleted = 0
    failed = 0
    skipped_no_msgid = 0
    skipped_email = 0
    by_platform = {"telegram": 0, "vk": 0, "max": 0}
    errors: list[str] = []

    # (platform, token, target, message_id) — target = chat_id для TG, иначе не нужен.
    tg_tasks: list[tuple[str, str, str]] = []   # (token, chat_id, mid)
    vk_tasks: list[tuple[str, str]] = []        # (token, mid)
    max_tasks: list[tuple[str, str]] = []       # (token, mid)

    for r in rows:
        ext = (r["external_message_id"] or "").strip()
        if not ext:
            skipped_no_msgid += 1
            continue

        # Определяем платформу записи: личное сообщение — по platform_users,
        # чат — по chat_platform.
        if r["platform_user_id"] is not None:
            platform = r["pu_platform"]
            target = str(r["platform_uid"])
        else:
            platform = r["chat_platform"]
            target = str(r["chat_ref"])

        mids = [m.strip() for m in ext.split(",") if m.strip()]
        if not mids:
            skipped_no_msgid += 1
            continue

        if platform == "telegram":
            token = r["bot_token"] or tg_default
            if not token or not target:
                failed += len(mids)
                continue
            for mid in mids:
                tg_tasks.append((token, target, mid))
        elif platform == "vk":
            token = r["bot_token"] or vk_default
            if not token:
                failed += len(mids)
                continue
            for mid in mids:
                vk_tasks.append((token, mid))
        elif platform == "max":
            token = r["bot_token"] or max_default
            if not token:
                failed += len(mids)
                continue
            for mid in mids:
                max_tasks.append((token, mid))
        elif platform == "email":
            skipped_email += 1
        else:
            skipped_no_msgid += 1

    sem = asyncio.Semaphore(20)

    def _note_err(err: str):
        if err and len(errors) < 5:
            errors.append(err)

    async def _run_tg(http, token, chat_id, mid):
        nonlocal deleted, failed
        async with sem:
            ok, err = await _tg_delete(http, token, chat_id, mid)
            if ok:
                deleted += 1
                by_platform["telegram"] += 1
            else:
                failed += 1
                _note_err(err)

    async def _run_vk(token, mid):
        nonlocal deleted, failed
        async with sem:
            ok, err = await _vk_delete(token, mid)
            if ok:
                deleted += 1
                by_platform["vk"] += 1
            else:
                failed += 1
                _note_err(err)

    async def _run_max(token, mid):
        nonlocal deleted, failed
        async with sem:
            ok, err = await _max_delete(token, mid)
            if ok:
                deleted += 1
                by_platform["max"] += 1
            else:
                failed += 1
                _note_err(err)

    async with httpx.AsyncClient(timeout=15) as http:
        await asyncio.gather(
            *[_run_tg(http, t, c, m) for (t, c, m) in tg_tasks],
            *[_run_vk(t, m) for (t, m) in vk_tasks],
            *[_run_max(t, m) for (t, m) in max_tasks],
        )

    logger.info(
        f"Отзыв рассылки {schedule_id}: удалено {deleted} "
        f"(tg={by_platform['telegram']}, vk={by_platform['vk']}, max={by_platform['max']}), "
        f"не удалось {failed}, без message_id {skipped_no_msgid}, email {skipped_email}"
    )

    # Хоть что-то удалили — помечаем рассылку отозванной, чтобы в очереди она
    # не выглядела как обычная «Отправлено». Статус отдельный от 'cancelled'
    # (та = снятая с очереди ДО отправки, её можно запустить снова).
    if deleted:
        await db.execute(
            "UPDATE broadcast_schedules SET status='recalled' WHERE id=$1 AND status='done'",
            schedule_id,
        )
    return {
        "ok": True,
        "deleted": deleted,
        "failed": failed,
        "skipped_no_msgid": skipped_no_msgid,
        "skipped_email": skipped_email,
        "total_log_rows": len(rows),
        "by_platform": by_platform,
        "errors": errors,
    }
