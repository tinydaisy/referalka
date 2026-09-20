"""Личные переписки (Диалоги) — архив ЛС человека с ботом/сообществом клиента.

⚠️ ОТДЕЛЬНО от chat_archive.py (групповые чаты событий, подсчёт баллов).
   Здесь — личная переписка 1-на-1: клиент видит всю историю и отвечает сам.

Что пишем в `direct_messages`:
  • direction='in'  author_kind='contact'  — человек написал боту;
  • direction='out' author_kind='bot'      — авто-ответ бота;
  • direction='out' author_kind='operator' — клиент ответил вручную из дашборда.

Хранение медиа:
  • Голосовые НЕ качаем (media_kind='voice', media_url=NULL) — бот просит текст.
  • Остальные файлы качаем в R2 по ключу dialog_media (clients/{cid}/dialogs/{contact}/...),
    учитываем в квоте клиента (storage_used_bytes + client_files).

Сервис best-effort: ни одна ошибка архива не должна ронять бот/вебхук.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx

from app.database import get_pool

log = logging.getLogger(__name__)

# Лимит на скачиваемый в R2 файл переписки (как у funnel_media). Голос не качаем.
MAX_DIALOG_MEDIA_BYTES = 50 * 1024 * 1024


async def resolve_contact_id(
    db, client_id: int, platform: str, platform_user_id: str
) -> Optional[int]:
    """Сопоставить собеседника с существующим контактом клиента. НЕ создаёт."""
    return await db.fetchval(
        """
        SELECT pu.contact_id
          FROM platform_users pu
          JOIN contacts c_own ON c_own.id = pu.contact_id
         WHERE c_own.client_id = $1
           AND pu.platform_slug = $2
           AND pu.platform_user_id = $3
         LIMIT 1
        """,
        client_id, platform, str(platform_user_id),
    )


async def archive_direct_message(
    *,
    client_id: int,
    platform: str,
    channel_id: Optional[int],
    platform_user_id: str,
    direction: str,
    author_kind: str,
    text: Optional[str] = None,
    media_url: Optional[str] = None,
    media_kind: Optional[str] = None,
    platform_message_id: Optional[str] = None,
    contact_id: Optional[int] = None,
    error: Optional[str] = None,
    sent_at=None,
) -> Optional[int]:
    """Записать одно сообщение личной переписки. Возвращает id строки или None.

    contact_id можно передать заранее (если уже знаем); иначе резолвим по площадке.
    Дедуп по (client_id, platform, platform_user_id, direction, platform_message_id).
    """
    platform_user_id = str(platform_user_id)
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            if contact_id is None:
                contact_id = await resolve_contact_id(
                    db, client_id, platform, platform_user_id
                )
            row = await db.fetchrow(
                """
                INSERT INTO direct_messages
                    (client_id, contact_id, platform, channel_id, platform_user_id,
                     direction, author_kind, text, media_url, media_kind,
                     platform_message_id, error, sent_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, COALESCE($13, now()))
                ON CONFLICT (client_id, platform, platform_user_id, direction, platform_message_id)
                    WHERE platform_message_id IS NOT NULL
                DO NOTHING
                RETURNING id
                """,
                client_id, contact_id, platform, channel_id, platform_user_id,
                direction, author_kind, text, media_url, media_kind,
                platform_message_id, error, sent_at,
            )
            return int(row["id"]) if row else None
    except Exception as e:  # noqa: BLE001 — архив не должен падать
        log.warning("archive_direct_message failed (%s %s): %s",
                    platform, platform_user_id, e)
        return None


async def _store_bytes_in_r2(
    *, client_id: int, contact_id: Optional[int], message_id: Optional[int],
    data: bytes, ext: str, content_type: str,
) -> Optional[str]:
    """Залить байты в R2 под ключ dialog_media + учесть в квоте клиента.

    Если contact_id нет (собеседник не привязан к контакту) — складываем в
    папку 0 (clients/{cid}/dialogs/0/...). Возвращает public URL или None.
    """
    from app.services.r2_storage import build_key, upload_bytes
    size = len(data)
    if size == 0 or size > MAX_DIALOG_MEDIA_BYTES:
        return None
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            # Проверка квоты — медиа переписок считается в storage клиента.
            q = await db.fetchrow(
                "SELECT storage_used_bytes, storage_quota_bytes FROM clients WHERE id = $1",
                client_id,
            )
            if q and int(q["storage_used_bytes"]) + size > int(q["storage_quota_bytes"]):
                log.info("dialog media skipped — quota exceeded (client %s)", client_id)
                return None

            key = build_key(client_id, "dialog_media", ext,
                            contact_id=contact_id or 0, message_id=message_id)
            url = await upload_bytes(key, data, content_type)

            await db.execute(
                """INSERT INTO client_files (client_id, kind, r2_key, url, size_bytes, content_type)
                   VALUES ($1, 'dialog_media', $2, $3, $4, $5)
                   ON CONFLICT (r2_key) DO NOTHING""",
                client_id, key, url, size, content_type,
            )
            await db.execute(
                "UPDATE clients SET storage_used_bytes = storage_used_bytes + $1 WHERE id = $2",
                size, client_id,
            )
            return url
    except Exception as e:  # noqa: BLE001
        log.warning("dialog media store failed (client %s): %s", client_id, e)
        return None


def _is_page_link(url: str) -> bool:
    """Это ссылка на СТРАНИЦУ просмотра, а не на сам файл?

    VK для видео отдаёт адрес плеера (`vk.com/video-1_2`, `vk.com/video_ext.php`),
    а не файл: скачивать оттуда нечего — вернётся HTML. Такие адреса храним
    как есть и открываем по клику.

    ⚠️ Проверяем по НАЧАЛУ адреса, а не по слову «video» где угодно: у
    настоящих файлов в имени тоже бывает «video», и они уехали бы мимо
    скачивания.
    """
    u = (url or "").lower()
    return (
        u.startswith("https://vk.com/video")
        or u.startswith("http://vk.com/video")
        or "vk.com/video_ext.php" in u
    )


async def store_media_from_url(
    *, client_id: int, contact_id: Optional[int], message_id: Optional[int],
    file_url: str, media_kind: str, file_name: Optional[str] = None,
) -> Optional[str]:
    """Скачать файл по временному URL (TG getFile / VK / MAX) и положить в R2.

    Голосовые сюда не передаём (их не храним). Возвращает постоянный R2 URL.

    ⚠️ Запрещённые типы (п. 7.10 Оферты) НЕ скачиваем вовсе: файл присылает
    участник, и запретить ему выбрать .exe мы не можем — значит просто не
    кладём такое в хранилище. Само сообщение при этом сохраняется, теряется
    только вложение.
    """
    from app.services.file_safety import is_blocked_file
    _name = file_name or file_url.split("/")[-1].split("?")[0]
    if is_blocked_file(_name):
        log.info("dialog media skipped (blocked type): %s", _name)
        return None

    try:
        async with httpx.AsyncClient(timeout=30) as http:
            r = await http.get(file_url)
            if r.status_code != 200:
                return None
            data = r.content
            content_type = r.headers.get("content-type", "application/octet-stream")
    except Exception as e:  # noqa: BLE001
        log.warning("dialog media download failed: %s", e)
        return None

    # Расширение из content-type или из url
    ext = "bin"
    ct = content_type.split(";")[0].strip()
    ct_map = {
        "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
        "image/gif": "gif", "video/mp4": "mp4", "video/quicktime": "mov",
        "audio/mpeg": "mp3", "audio/ogg": "ogg",
        "application/pdf": "pdf",
    }
    if ct in ct_map:
        ext = ct_map[ct]
    elif "." in file_url.split("/")[-1].split("?")[0]:
        ext = file_url.split("/")[-1].split("?")[0].rsplit(".", 1)[-1][:8] or "bin"

    # Повторная проверка по фактическому типу и итоговому расширению: имя из
    # мессенджера могло прийти без расширения, и запрет по нему не сработал.
    if is_blocked_file(f"f.{ext}", ct):
        log.info("dialog media skipped after download (blocked): ext=%s ct=%s", ext, ct)
        return None

    return await _store_bytes_in_r2(
        client_id=client_id, contact_id=contact_id, message_id=message_id,
        data=data, ext=ext, content_type=ct,
    )


async def update_message_media(message_id: int, media_url: str) -> None:
    """Проставить media_url у уже записанной строки (после загрузки в R2)."""
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            await db.execute(
                "UPDATE direct_messages SET media_url = $1 WHERE id = $2",
                media_url, message_id,
            )
    except Exception as e:  # noqa: BLE001
        log.warning("update_message_media failed: %s", e)


# ─────────────────────────────────────────────────────────────────────────────
# Высокоуровневые хелперы для обработчиков ботов
# ─────────────────────────────────────────────────────────────────────────────

VOICE_REPLY = (
    "Голосовые сообщения мы не обрабатываем 🙏 "
    "Пожалуйста, напишите текстом — так быстрее ответим."
)


async def archive_incoming(
    *,
    client_id: int,
    platform: str,
    channel_id: Optional[int],
    platform_user_id: str,
    text: Optional[str],
    media_kind: Optional[str] = None,
    file_url: Optional[str] = None,
    platform_message_id: Optional[str] = None,
    contact_id: Optional[int] = None,
    sent_at=None,
) -> Optional[int]:
    """Записать входящее сообщение человека + (опц.) скачать медиа в R2.

    Голос (media_kind='voice') не качаем — только пометка.
    """
    row_id = await archive_direct_message(
        client_id=client_id, platform=platform, channel_id=channel_id,
        platform_user_id=platform_user_id, direction="in", author_kind="contact",
        text=text, media_kind=media_kind, platform_message_id=platform_message_id,
        contact_id=contact_id, sent_at=sent_at,
    )
    # ⚠️ Ссылку на СТРАНИЦУ (а не на файл) не качаем — сохраняем как есть.
    # У VK-видео в attachments лежит адрес плеера vk.com/video-123_456: по нему
    # приходит HTML-страница, а не видеофайл. Скачивание такого молча падало, и
    # в переписке оставалась подпись «Видео» без ссылки — открыть присланное
    # было нечем. Страница VK постоянная (в отличие от часовых ссылок на файлы),
    # поэтому её можно просто запомнить и открывать по клику.
    if row_id and file_url and media_kind and _is_page_link(file_url):
        await update_message_media(row_id, file_url)
        return row_id

    if row_id and file_url and media_kind and media_kind != "voice":
        # ⚠️ Берём contact_id ИЗ ЗАПИСАННОГО сообщения, а не из аргумента.
        # archive_direct_message умеет резолвить собеседника сам, когда id не
        # передали, — и в строку попадает верный контакт. А сюда уходил
        # исходный None, медиа пыталось лечь в «папку 0», build_key считал это
        # ошибкой, и ФОТО МОЛЧА ТЕРЯЛОСЬ: в переписке оставалась подпись
        # «Фото» без самого файла (жалоба «не вижу, что мне шлют люди»).
        eff_contact_id = contact_id
        if eff_contact_id is None:
            try:
                pool = await get_pool()
                async with pool.acquire() as db:
                    eff_contact_id = await db.fetchval(
                        "SELECT contact_id FROM direct_messages WHERE id = $1", row_id,
                    )
            except Exception as e:  # noqa: BLE001 — не смогли уточнить, кладём в папку 0
                log.warning("dialog media: contact resolve failed: %s", e)
        url = await store_media_from_url(
            client_id=client_id, contact_id=eff_contact_id, message_id=row_id,
            file_url=file_url, media_kind=media_kind,
        )
        if url:
            await update_message_media(row_id, url)

    # ⚠️⚠️ УВЕДОМЛЕНИЕ ВНЕДРЕНЦУ — ЗДЕСЬ, а не в каждом боте по отдельности.
    # Это единственная точка, через которую проходят входящие со ВСЕХ трёх
    # площадок; поставь врезку в ботах — забудешь в одном из них, как уже вышло
    # с «шагом ноль» (сделали в Telegram, в MAX не работало).
    if row_id:
        try:
            await _notify_assigned_tech(client_id=client_id, platform=platform,
                                        text=text, row_id=row_id)
        except Exception as e:  # noqa: BLE001 — уведомление не должно ронять приём
            log.warning("tech notify from dialog failed: %s", e)
    return row_id


async def _notify_assigned_tech(*, client_id: int, platform: str,
                                text: Optional[str], row_id: int) -> None:
    """Сообщает внедренцу, что его клиент написал.

    ⚠️ Шлём ТОЛЬКО по сообщениям в СЕРВИСНЫЙ кабинет (@pluson_bot): туда пишут
    клиенты платформы. В кабинете обычного клиента переписка идёт с его
    участниками — внедренца она не касается вовсе.
    """
    from app.services.tech_notify import format_person, notify_tech

    pool = await get_pool()
    async with pool.acquire() as db:
        # Чей это кабинет и сервисный ли он.
        is_service = await db.fetchval(
            "SELECT is_system_service FROM clients WHERE id = $1", client_id)
        if not is_service:
            return

        msg = await db.fetchrow(
            """SELECT dm.contact_id, ct.name, ct.email, ct.phone,
                      ct.client_id AS contact_client_id
                 FROM direct_messages dm
                 LEFT JOIN contacts ct ON ct.id = dm.contact_id
                WHERE dm.id = $1""",
            row_id,
        )
        if not msg or not msg["contact_id"]:
            return

        # За кем закреплён ЭТОТ человек как клиент платформы.
        # ⚠️ Связь через почту: в сервисном кабинете он контакт, а клиентом
        # платформы является отдельной строкой в `clients`.
        # ⚠️ Сравниваем LOWER(TRIM(email)), а НЕ `email_normalized`: такой
        # колонки в `clients` нет вовсе — она есть только у `contacts`.
        spec = await db.fetchrow(
            """SELECT c.tech_specialist_id, c.id AS client_id,
                      c.referred_by_tech_id
                 FROM clients c
                WHERE LOWER(TRIM(c.email)) = LOWER(TRIM($1))
                  AND c.tech_specialist_id IS NOT NULL
                LIMIT 1""",
            msg["email"] or "",
        ) if msg["email"] else None

        if not spec or not spec["tech_specialist_id"]:
            return

        # Ник на площадке — чтобы менеджер мог написать напрямую.
        username = await db.fetchval(
            """SELECT username FROM platform_users
                WHERE contact_id = $1 AND platform_slug = $2
                ORDER BY id DESC LIMIT 1""",
            msg["contact_id"], platform,
        )

        person = format_person(
            name=msg["name"], email=msg["email"], phone=msg["phone"],
            tg_username=username if platform == "telegram" else None,
            max_username=username if platform == "max" else None,
            platform=platform,
        )
        own = spec["referred_by_tech_id"] == spec["tech_specialist_id"]
        # ⚠️ Текст клиента ЭКРАНИРУЕМ: одна угловая скобка в его сообщении
        # ломает всю разметку, и Telegram отвергает сообщение целиком.
        import html as _html
        safe = _html.escape((text or "(без текста)")[:600])
        body = (f"{person}\n"
                f"{'Ваш клиент' if own else 'Из базы ПЛЮСОНА'}\n\n"
                f"<i>{safe}</i>\n\n"
                f"Ответьте на это сообщение — текст уйдёт клиенту.")

        await notify_tech(db, spec["tech_specialist_id"], "question", body,
                          contact_id=msg["contact_id"],
                          client_id=client_id, platform=platform)


async def archive_outgoing_bot(
    *,
    client_id: int,
    platform: str,
    channel_id: Optional[int],
    platform_user_id: str,
    text: Optional[str],
    platform_message_id: Optional[str] = None,
    contact_id: Optional[int] = None,
) -> Optional[int]:
    """Записать авто-ответ бота (для полноты ленты)."""
    return await archive_direct_message(
        client_id=client_id, platform=platform, channel_id=channel_id,
        platform_user_id=platform_user_id, direction="out", author_kind="bot",
        text=text, platform_message_id=platform_message_id, contact_id=contact_id,
    )
