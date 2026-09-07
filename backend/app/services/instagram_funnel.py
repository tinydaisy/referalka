"""
Движок воронки Instagram: комментарий под рилсом → директ → лид-магнит.

Полный план и обоснование решений — documentation/INSTAGRAM-FUNNEL-PLAN.md

⚠️ Воронка — НАДСТРОЙКА над лид-магнитами: своих материалов у неё нет, она
решает только «как раздать» уже существующий подарок. Сборка материалов идёт
общей `_materials_for_run` из funnel_service — второй копии быть не должно,
иначе разъедутся плейсхолдеры реф-кодов и анкеты перед подарком.
"""
from __future__ import annotations

import json
import logging
import random
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from . import instagram_api as ig
from .contact_merge import upsert_contact_with_identity

log = logging.getLogger(__name__)

# Сколько Meta разрешает писать человеку после его последнего сообщения.
_WINDOW_HOURS = 24
# Повторная выдача тому же человеку — не чаще этого срока.
# ⚠️ Иначе десять комментариев подряд превращаются в десять сообщений в личку,
# и это уже спам со стороны аккаунта клиента.
_REPEAT_COOLDOWN_MIN = 60

# Фразы по умолчанию — на случай, если клиент не завёл свои.
#
# ⚠️⚠️ ВСЕ тексты от лица «МЫ», не «я»: род клиента заранее неизвестен, а
# сообщение уходит от имени его аккаунта. «Мы» снимает вопрос рода целиком и
# не требует ни настройки, ни склонения.
#
# ⚠️ По НЕСКОЛЬКУ вариантов на каждый шаг — не для красоты: Instagram считает
# спамом повторяющиеся одинаковые публичные ответы и режет охваты вплоть до
# блокировки аккаунта.
DEFAULT_REPLIES: dict[str, list[str]] = {
    "public_comment": [
        "Отправили в личные сообщения ✉️",
        "Всё в директе 💌",
        "Отправили — загляните в личные сообщения 📩",
        "Готово, ждём вас в директе ✨",
        "Уже отправили, проверьте личные 👀",
    ],
    "dm_intro": [
        "Привет! Материал готов. Подпишитесь на аккаунт и нажмите «Готово» — сразу отправим.",
        "Здравствуйте! Остался один шаг: подпишитесь на аккаунт и нажмите «Готово».",
        "Привет! Рады, что заинтересовало. Подпишитесь на аккаунт и нажмите «Готово» — отправим материал.",
        "Здравствуйте! Чтобы забрать материал, подпишитесь на аккаунт и нажмите «Готово».",
    ],
    "dm_not_subscribed": [
        "Пока не видим вашу подписку. Подпишитесь на аккаунт и нажмите «Готово» ещё раз.",
        "Подписки пока не видно — проверьте, что подписались, и нажмите «Готово».",
        "Кажется, подписка ещё не оформлена. Подпишитесь и нажмите «Готово» — сразу отправим.",
        "Не нашли вас среди подписчиков. Подпишитесь на аккаунт и нажмите «Готово».",
    ],
    "dm_delivered": [
        "Держите, всё внутри 👇",
        "Готово! Забирайте 👇",
        "Отправляем — приятного изучения 👇",
        "Вот обещанное 👇",
        "Всё готово, забирайте 👇",
    ],
    "dm_repeat": [
        "Уже отправляли — вот ещё раз 👇",
        "Отправляли раньше, дублируем 👇",
        "Повторяем на всякий случай 👇",
        "Держите ещё раз, чтобы не потерялось 👇",
    ],
    "dm_reminder": [
        "Напоминаем: материал ждёт вас. Подпишитесь на аккаунт и нажмите «Готово».",
        "Вы не забрали материал — подпишитесь и нажмите «Готово», сразу отправим.",
        "Материал всё ещё за вами. Подпишитесь на аккаунт и нажмите «Готово».",
        "Не хотим, чтобы вы потеряли материал — подпишитесь и нажмите «Готово».",
    ],
}


async def pick_reply(db, funnel_id: int, kind: str) -> str:
    """Случайная фраза нужного вида. Свои у клиента — приоритет, иначе наши."""
    rows = await db.fetch(
        "SELECT text FROM instagram_funnel_replies WHERE funnel_id=$1 AND kind=$2",
        funnel_id, kind,
    )
    texts = [r["text"] for r in rows if (r["text"] or "").strip()]
    if not texts:
        texts = DEFAULT_REPLIES.get(kind) or [""]
    return random.choice(texts)


def _norm(s: str) -> str:
    """Слово к сравнимому виду: нижний регистр, без знаков и лишних пробелов."""
    return re.sub(r"[^\w\s]", " ", (s or "").lower(), flags=re.UNICODE).strip()


def _keyword_hit(text: str, keywords: list[str], mode: str = "contains") -> bool:
    """Есть ли кодовое слово в тексте.

    ⚠️ РЕГИСТР НЕ УЧИТЫВАЕТСЯ ВСЕГДА (`_norm` приводит к нижнему) — «ХОЧУ»,
    «Хочу» и «хочу» одно и то же. Отдельной настройки для этого нет: выбор
    «учитывать ли регистр» только запутал бы, полезного применения у него нет.

    Два режима сравнения:

    `contains` (по умолчанию) — слово где-то внутри комментария. Люди пишут
    «хочу!!», «Хочу гайд», «хочу 🙏»: требовать точного равенства значило бы
    терять почти всех.

    `exact` — комментарий целиком равен слову. Нужен, когда слово короткое и
    встречается в чужом смысле: «хочу» есть и в «не хочу», и в «хочу спросить
    совсем про другое».
    """
    t = _norm(text)
    if mode == "exact":
        return any(_norm(kw) and _norm(kw) == t for kw in keywords)
    hay = f" {t} "
    for kw in keywords:
        k = _norm(kw)
        if k and (f" {k} " in hay or k in hay):
            return True
    return False


async def find_funnel(db, channel_id: int, *, trigger_kind: str,
                      media_id: str | None, text: str) -> Optional[dict]:
    """Подобрать воронку под пришедшее событие.

    ⚠️ Порядок отбора значим: сначала воронки с КОНКРЕТНЫМ рилсом, потом «любой».
    Иначе воронка «на любой рилс» перехватывала бы события у точечной, и
    настройка под конкретную публикацию не работала бы никогда.
    """
    rows = await db.fetch(
        """SELECT * FROM instagram_funnels
            WHERE channel_id = $1 AND is_active AND trigger_kind = $2
         ORDER BY (media_scope = 'specific') DESC, sort_order, id""",
        channel_id, trigger_kind,
    )
    for r in rows:
        f = dict(r)
        if f["media_scope"] == "specific":
            if not media_id or media_id not in (f["media_ids"] or []):
                continue
        if f["keyword_mode"] == "specific":
            if not _keyword_hit(text, f["keywords"] or [], f.get("match_mode") or "contains"):
                continue
        return f
    return None


async def _funnel_channel(db, funnel: dict) -> Optional[dict]:
    """Канал воронки с токеном и id аккаунта."""
    row = await db.fetchrow(
        "SELECT id, bot_token, platform_meta FROM channels WHERE id=$1",
        funnel["channel_id"],
    )
    if not row:
        return None
    meta = row["platform_meta"] or {}
    if isinstance(meta, str):
        meta = json.loads(meta)
    return {
        "id": row["id"],
        "token": row["bot_token"] or "",
        "ig_user_id": str(meta.get("ig_user_id") or ""),
        "page_id": str(meta.get("page_id") or ""),
    }


async def _get_or_create_run(db, funnel: dict, contact_id: int, igsid: str) -> dict:
    """Забег в общей `funnel_runs`.

    ⚠️ Отдельной таблицы под Instagram НЕТ намеренно: в общей сами заработают
    счётчик «зашло», CRM лид-магнитов, фильтр контактов и аналитика UTM.

    ⚠️ UNIQUE (client_id, platform_slug, platform_user_id, lead_magnet_id) не
    даёт задвоить забег — повторный комментарий обновляет существующий.
    """
    row = await db.fetchrow(
        """SELECT * FROM funnel_runs
            WHERE client_id=$1 AND platform_slug='instagram' AND platform_user_id=$2
              AND lead_magnet_id IS NOT DISTINCT FROM $3
              AND package_id IS NOT DISTINCT FROM $4
            ORDER BY id DESC LIMIT 1""",
        funnel["client_id"], igsid, funnel["lead_magnet_id"], funnel["package_id"],
    )
    if row:
        await db.execute(
            "UPDATE funnel_runs SET ig_last_user_message_at=now(), contact_id=COALESCE(contact_id,$2) WHERE id=$1",
            row["id"], contact_id,
        )
        return dict(row)

    new_id = await db.fetchval(
        # ⚠️ `type` — NOT NULL без значения по умолчанию, и его легко не
        # заметить: движок Instagram его пропускал, и КАЖДЫЙ забег падал с
        # NotNullViolationError уже после того, как человеку ушёл публичный
        # ответ и создался контакт. Значение то же, что у остальных воронок
        # ('lead_magnet'): Instagram — способ раздать лид-магнит, а не
        # отдельный вид забега.
        """INSERT INTO funnel_runs (client_id, type, lead_magnet_id, package_id, contact_id,
                                    platform_slug, platform_user_id, stage,
                                    instagram_funnel_id, ig_last_user_message_at,
                                    landed_at, started_at)
           VALUES ($1,'lead_magnet',$2,$3,$4,'instagram',$5,'started',$6, now(), now(), now())
           RETURNING id""",
        funnel["client_id"], funnel["lead_magnet_id"], funnel["package_id"],
        contact_id, igsid, funnel["id"],
    )
    return dict(await db.fetchrow("SELECT * FROM funnel_runs WHERE id=$1", new_id))


def _within_window(run: dict) -> bool:
    """Можно ли писать человеку прямо сейчас.

    ⚠️ Окно считается от ПОСЛЕДНЕГО СООБЩЕНИЯ ЧЕЛОВЕКА, не от нашей отправки.
    Считать от своего — значит регулярно выходить за 24 часа и получать отказы,
    а серия отказов портит репутацию приложения.
    """
    last = run.get("ig_last_user_message_at")
    if not last:
        return False
    return (datetime.now(timezone.utc) - last) < timedelta(hours=_WINDOW_HOURS)


async def _materials_text(db, run: dict) -> str:
    """Текст со ссылками на материалы.

    ⚠️ Собираем ОБЩЕЙ `_materials_for_run` из funnel_service: там раскрываются
    плейсхолдеры реф-кодов и подменяются ссылки на анкеты. Своя сборка
    разъехалась бы с остальными площадками.
    """
    from .funnel_service import _materials_for_run, _package_description_for_run

    materials = await _materials_for_run(dict(run), db)
    parts: list[str] = []
    desc = await _package_description_for_run(dict(run), db)
    if desc:
        parts.append(desc)
    for i, m in enumerate(materials, 1):
        line = f"{i}. {m['name']}"
        if m.get("url"):
            line += f"\n{m['url']}"
        parts.append(line)
    return "\n\n".join(p for p in parts if p)


async def _telegram_link(db, run: dict, funnel: dict) -> str:
    """Ссылка на телеграм-бота клиента — перелив аудитории из Instagram.

    ⚠️ Дальше человека ведёт уже существующая воронка `/m/` со своей проверкой
    подписки на телеграм-канал. Второй проверки здесь не делаем — она там.
    """
    from .share_links import build_funnel_landing_links

    kind = "m" if run["lead_magnet_id"] else "p"
    slug_row = await db.fetchrow(
        f"SELECT slug FROM {'lead_magnets' if kind == 'm' else 'lead_magnet_packages'} WHERE id=$1",
        run["lead_magnet_id"] or run["package_id"],
    )
    if not slug_row:
        return ""
    links = await build_funnel_landing_links(db, funnel["client_id"], kind, slug_row["slug"])
    return (links or {}).get("telegram") or ""


async def deliver(db, funnel: dict, run: dict, ch: dict, igsid: str,
                  *, repeat: bool = False) -> bool:
    """Выдать материал в директ. True — отправлено."""
    kind = "dm_repeat" if repeat else "dm_delivered"
    head = await pick_reply(db, funnel["id"], kind)

    if funnel["delivery_mode"] == "telegram":
        link = await _telegram_link(db, run, funnel)
        body = link or await _materials_text(db, run)
    else:
        body = await _materials_text(db, run)

    text = f"{head}\n\n{body}".strip()
    try:
        await ig.send_message(ch["page_id"], igsid, text, ch["token"])
    except ig.InstagramApiError as e:
        log.warning("Instagram: не удалось выдать материал (run %s): %s", run["id"], e)
        return False

    await db.execute(
        "UPDATE funnel_runs SET stage='delivered', delivered_at=COALESCE(delivered_at, now()), "
        "ig_last_delivered_at=now() WHERE id=$1",
        run["id"],
    )
    return True


async def handle_comment(db, channel_id: int, *, comment_id: str, media_id: str,
                         text: str, from_igsid: str, from_username: str) -> None:
    """Пришёл комментарий под публикацией. Точка входа из вебхука."""
    funnel = await find_funnel(db, channel_id, trigger_kind="comment",
                               media_id=media_id, text=text)
    if not funnel:
        return
    ch = await _funnel_channel(db, funnel)
    if not ch or not ch["token"]:
        log.warning("Instagram: у воронки %s нет рабочего канала", funnel["id"])
        return

    # 1. Публичный ответ под комментарием — если клиент его не выключил.
    if funnel["public_reply_enabled"]:
        try:
            await ig.reply_to_comment(comment_id, await pick_reply(db, funnel["id"], "public_comment"),
                                      ch["token"])
        except ig.InstagramApiError as e:
            # ⚠️ Не прерываем воронку: главное — доставить материал в директ.
            log.warning("Instagram: публичный ответ не ушёл (%s): %s", comment_id, e)

    # 2. Человек в базе. Только через общий резолвер — иначе дубли контактов.
    # ⚠️ Только через общий резолвер: свой SELECT по контактам плодит дубли
    # людей (правило проекта). Возвращает (contact_id, identity_id, is_new).
    contact_id, _identity_id, _is_new = await upsert_contact_with_identity(
        db, client_id=funnel["client_id"], platform_slug="instagram",
        platform_user_id=from_igsid, username=from_username or None,
        first_name=from_username or None,
    )
    run = await _get_or_create_run(db, funnel, contact_id, from_igsid)

    # 3. Уже получал этот материал?
    if run.get("ig_last_delivered_at"):
        since = datetime.now(timezone.utc) - run["ig_last_delivered_at"]
        if since < timedelta(minutes=_REPEAT_COOLDOWN_MIN):
            # ⚠️ В пределах часа в директ повторно НЕ пишем — только публичный
            # ответ выше. Десять комментариев подряд иначе дадут десять писем.
            return
        text_repeat = await pick_reply(db, funnel["id"], "dm_repeat")
        try:
            await ig.private_reply(comment_id, text_repeat, ch["token"], ch["page_id"])
        except ig.InstagramApiError:
            pass
        await deliver(db, funnel, run, ch, from_igsid, repeat=True)
        return

    # 4. Первое сообщение в директ.
    #
    # ⚠️ Только `private_reply` — обычной отправкой человеку, который нам ещё
    # не писал, написать нельзя: 24-часового окна с ним не существует.
    if funnel["require_subscription"]:
        intro = await pick_reply(db, funnel["id"], "dm_intro")
    else:
        intro = await pick_reply(db, funnel["id"], "dm_delivered")

    try:
        await ig.private_reply(comment_id, intro, ch["token"], ch["page_id"])
    except ig.InstagramApiError as e:
        log.warning("Instagram: приватный ответ не ушёл (%s): %s", comment_id, e)
        return

    if not funnel["require_subscription"]:
        # Подписка не нужна — сразу материал.
        await deliver(db, funnel, run, ch, from_igsid)
        return

    # Подписка нужна — ставим напоминание на случай, если человек пропадёт.
    #
    # ⚠️ Задержка меньше суток намеренно (проверяется и при сохранении воронки):
    # Meta разрешает писать только 24 часа с последнего сообщения человека, и
    # напоминание за пределами окна просто не уйдёт. Внутри задачи окно
    # сверяется ЗАНОВО — за эти часы человек мог не написать ничего.
    if funnel["reminder_enabled"]:
        try:
            from ..tasks.instagram import send_reminder as _rem
            _rem.apply_async(args=[run["id"]], countdown=int(funnel["reminder_delay_min"]) * 60)
        except Exception:
            # ⚠️ Сбой постановки напоминания не должен ломать выдачу подарка —
            # человек уже получил первое сообщение, это главное.
            log.exception("Instagram: не удалось поставить напоминание для run %s", run["id"])


async def handle_message(db, channel_id: int, *, from_igsid: str, text: str,
                         from_username: str = "") -> None:
    """Человек написал в директ (в том числе нажал кнопку). Точка входа из вебхука."""
    # Ищем незавершённый забег этого человека.
    run = await db.fetchrow(
        """SELECT fr.*, f.id AS f_id FROM funnel_runs fr
             JOIN instagram_funnels f ON f.id = fr.instagram_funnel_id
            WHERE fr.platform_slug='instagram' AND fr.platform_user_id=$1
              AND f.channel_id=$2
         ORDER BY fr.id DESC LIMIT 1""",
        from_igsid, channel_id,
    )
    if not run:
        return

    # ⚠️ Окно 24 часов отсчитывается отсюда — человек только что написал.
    await db.execute(
        "UPDATE funnel_runs SET ig_last_user_message_at=now() WHERE id=$1", run["id"]
    )

    funnel = dict(await db.fetchrow("SELECT * FROM instagram_funnels WHERE id=$1", run["f_id"]))
    ch = await _funnel_channel(db, funnel)
    if not ch or not ch["token"]:
        return

    run = dict(run)
    already = bool(run.get("ig_last_delivered_at"))

    if not funnel["require_subscription"]:
        await deliver(db, funnel, run, ch, from_igsid, repeat=already)
        return

    sub = await ig.is_follower(from_igsid, ch["token"])
    if sub is False:
        try:
            await ig.send_message(
                ch["page_id"], from_igsid,
                await pick_reply(db, funnel["id"], "dm_not_subscribed"), ch["token"],
            )
        except ig.InstagramApiError:
            pass
        return

    # ⚠️ sub is None — спросить не удалось. Выдаём: правило проекта, сбой
    # проверки не лишает человека подарка (то же в телеграм-воронке).
    await deliver(db, funnel, run, ch, from_igsid, repeat=already)


async def send_reminder(db, run_id: int) -> bool:
    """Напоминание молчащему. True — отправлено.

    ⚠️ Перед отправкой ЗАНОВО сверяем окно: напоминание ставится в очередь
    заранее, и к моменту исполнения 24 часа могли выйти. Не влезли — молча не
    шлём, забег остаётся как есть.

    ⚠️ И перепроверяем подписку: человек мог подписаться, но не нажать кнопку.
    Иначе он получит «не видим подписки», хотя подписан, — и это выглядит как
    поломка.
    """
    run = await db.fetchrow(
        """SELECT fr.*, f.id AS f_id FROM funnel_runs fr
             JOIN instagram_funnels f ON f.id = fr.instagram_funnel_id
            WHERE fr.id=$1""",
        run_id,
    )
    if not run or run["ig_reminder_sent_at"] or run["stage"] == "delivered":
        return False
    run = dict(run)
    if not _within_window(run):
        log.info("Instagram: напоминание run %s пропущено — вышли из 24 часов", run_id)
        return False

    funnel = dict(await db.fetchrow("SELECT * FROM instagram_funnels WHERE id=$1", run["f_id"]))
    if not funnel["reminder_enabled"]:
        return False
    ch = await _funnel_channel(db, funnel)
    if not ch or not ch["token"]:
        return False

    igsid = run["platform_user_id"]

    if funnel["require_subscription"]:
        sub = await ig.is_follower(igsid, ch["token"])
        if sub is not False:
            # Подписан (или проверить не вышло) — выдаём материал вместо
            # напоминания «подпишитесь».
            ok = await deliver(db, funnel, run, ch, igsid)
            await db.execute("UPDATE funnel_runs SET ig_reminder_sent_at=now() WHERE id=$1", run_id)
            return ok

    try:
        await ig.send_message(
            ch["page_id"], igsid,
            await pick_reply(db, funnel["id"], "dm_reminder"), ch["token"],
        )
    except ig.InstagramApiError as e:
        log.warning("Instagram: напоминание не ушло (run %s): %s", run_id, e)
        return False

    # ⚠️ Отметка «уже слали», а не «прошло N часов»: задача может выполниться
    # повторно (ретрай Celery, дубль вебхука), и по времени проверка пропустила
    # бы второе напоминание.
    await db.execute("UPDATE funnel_runs SET ig_reminder_sent_at=now() WHERE id=$1", run_id)
    return True
