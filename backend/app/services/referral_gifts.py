"""Подарки за рекомендации: лестница порогов и личные реф-ссылки участника.

Единая точка для ВСЕХ потребителей (решение владельца 22.09.2026):
  • шаблон догрева зарегистрированных — плейсхолдеры `{ref_links}` и `{gift_ladder}`;
  • команда `/podarki{event_id}` и слово `podarki{event_id}` в TG/ВК/MAX.

⚠️ Почему единый сервис, а не по копии на площадку. Лестница подарков и
подсчёт приглашённых — это правила, которые клиент настраивает один раз
(`event_referral_settings.gift_count_mode`), а показываются они в пяти местах.
Разъехавшиеся копии дали бы человеку РАЗНЫЕ цифры в боте и в догреве по одному
и тому же событию — и виноватой выглядела бы платформа. Один расчёт, три
рендера под разметку площадки.

Разметка: HTML для Telegram и MAX, plain-текст для ВКонтакте (ВК не понимает
HTML-теги, они пришли бы человеку как есть).
"""
from __future__ import annotations

import logging
from html import escape
from typing import Optional

import asyncpg

logger = logging.getLogger(__name__)

# Площадки в фиксированном порядке — как в тексте шаблона («Через ТГ / МАХ / ВК»).
_PLATFORM_LABEL = {
    "telegram": "Телеграм",
    "max": "МАХ",
    "vk": "ВК",
}
_PLATFORM_ORDER = ("telegram", "max", "vk")

# ⚠️ Подсчёт приглашённых — ровно по настройке клиента `gift_count_mode`:
#   registered (default) → только зарегистрировавшиеся,
#   clicked_link         → только нажавшие главную кнопку,
#   visited              → все перешедшие по ссылке.
# Зеркало `_REFERRALS_COUNT` из api/landing_widget.py: там тот же расчёт для
# сортировки спикеров. Считать «просто всех перешедших» нельзя — у клиента с
# режимом `registered` человек увидел бы у себя больше приглашённых, чем ему
# зачтено, и ждал бы подарок, который не придёт.
_INVITED_COUNT_SQL = """
SELECT COUNT(*) FROM event_participants ep
 WHERE ep.event_id = $1
   AND ep.referrer_ref_code IS NOT NULL
   AND ep.referrer_ref_code = $2
   AND CASE $3::text
         WHEN 'visited'      THEN TRUE
         WHEN 'clicked_link' THEN ep.link_clicked_at IS NOT NULL
         ELSE ep.is_registered = TRUE
       END
"""


async def get_gift_count_mode(db: asyncpg.Connection, event_id: int) -> str:
    """Режим подсчёта приглашённых. Нет записи настроек → 'registered'."""
    mode = await db.fetchval(
        "SELECT gift_count_mode FROM event_referral_settings WHERE event_id = $1",
        event_id,
    )
    return (mode or "registered").strip()


async def count_invited(
    db: asyncpg.Connection, *, event_id: int, ref_code: Optional[str],
    mode: Optional[str] = None,
) -> int:
    """Сколько человек привёл участник — по настройке клиента."""
    if not ref_code:
        return 0
    if mode is None:
        mode = await get_gift_count_mode(db, event_id)
    try:
        return int(await db.fetchval(_INVITED_COUNT_SQL, event_id, ref_code, mode) or 0)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"count_invited упал (event={event_id}): {e}")
        return 0


async def fetch_gift_ladder(db: asyncpg.Connection, event_id: int) -> list[dict]:
    """Лестница подарков события: [{count, titles: [...]}, ...] по возрастанию.

    Название подарка берём у лид-магнита или пакета — это то, что человек
    реально получит. У одного порога подарков может быть несколько (клиент
    заводит их отдельными строками с тем же `threshold_count`), поэтому
    группируем: иначе «За 1 зарегистрированного» напечаталось бы дважды.

    ⚠️ Порог без названия (ни лид-магнита, ни пакета — только сертификат или
    текст выдачи) пропускаем: строка «За 3 зарегистрированных дарим:» с пустым
    списком выглядит как сломанная вёрстка.
    """
    rows = await db.fetch(
        """SELECT t.threshold_count,
                  COALESCE(NULLIF(lm.name, ''), NULLIF(pk.name, '')) AS gift_title
             FROM event_referral_thresholds t
             LEFT JOIN lead_magnets lm ON lm.id = t.lead_magnet_id
             LEFT JOIN lead_magnet_packages pk ON pk.id = t.package_id
            WHERE t.event_id = $1
            ORDER BY t.threshold_count, t.sort, t.id""",
        event_id,
    )
    ladder: list[dict] = []
    for r in rows:
        title = (r["gift_title"] or "").strip()
        if not title:
            continue
        cnt = int(r["threshold_count"] or 0)
        if ladder and ladder[-1]["count"] == cnt:
            ladder[-1]["titles"].append(title)
        else:
            ladder.append({"count": cnt, "titles": [title]})
    return ladder


def _plural_people(n: int, mode: str) -> str:
    """«1 зарегистрированного» / «3 зарегистрированных». Для режимов
    visited/clicked_link слово другое: человек там не регистрируется."""
    if mode == "registered":
        return "зарегистрированного" if n == 1 else "зарегистрированных"
    return "приглашённого" if n == 1 else "приглашённых"


async def build_gift_ladder_block(
    db: asyncpg.Connection, *, event_id: int, invited: int = 0,
    html: bool = True, mark_earned: bool = True,
) -> str:
    """Текст лестницы подарков.

    `invited` + `mark_earned` — отметка уже достигнутых ступеней (решение
    владельца 22.09.2026): человек видит, что у него уже есть, и сколько
    осталось до следующего. Без отметок (`mark_earned=False`) блок одинаков
    для всех — так он годится и для текста, который клиент показывает до
    регистрации.

    html=True → Telegram/MAX (<b>), html=False → ВК (plain).
    """
    ladder = await fetch_gift_ladder(db, event_id)
    if not ladder:
        return ""
    mode = await get_gift_count_mode(db, event_id)

    def _b(s: str) -> str:
        return f"<b>{s}</b>" if html else s

    def _esc(s: str) -> str:
        return escape(s) if html else s

    blocks: list[str] = []
    for step in ladder:
        cnt = step["count"]
        earned = mark_earned and invited >= cnt
        if cnt == 0:
            head = "За 0 " + _plural_people(0, mode) + " (сразу после регистрации):"
        else:
            head = f"За {cnt} {_plural_people(cnt, mode)} дарим:"
        # ✅ — ступень уже ваша. Ставим в конце строки-заголовка, чтобы не
        # ломать чтение самих названий подарков.
        if earned:
            head = f"{_b(head)} ✅"
        else:
            head = _b(head)
        lines = [head]
        lines += [f"🎁 {_esc(t)}" for t in step["titles"]]
        blocks.append("\n".join(lines))

    out = "\n\n".join(blocks)

    # Шапка «у вас сейчас N» — только когда есть что показать: нулевой счётчик
    # в первом же сообщении звучит как упрёк, а не как приглашение.
    if mark_earned and invited > 0:
        word = _plural_people(invited, mode)
        head = f"У вас сейчас: {invited} {word}"
        out = f"{_b(head)}\n\n{out}"
    return out


async def build_ref_links_block(
    db: asyncpg.Connection, *, event_id: int, client_id: int, slug: str,
    ref_code: Optional[str], html: bool = True,
) -> str:
    """Личные реф-ссылки участника по площадкам: «Через Телеграм: <ссылка>».

    Показываем ТОЛЬКО те площадки, что есть у клиента (`build_share_links` сам
    отсеивает отсутствующих ботов и отключённые у события площадки). Строка
    «Через ВК:» без ссылки хуже отсутствия строки — человек ищет, что нажать.

    ⚠️ Ссылка личная: в неё зашит `pid{ref_code}` — реф-код человека. Без него
    приглашённые не зачтутся, поэтому при пустом `ref_code` возвращаем пустоту,
    а не «общую» ссылку события: та молча не принесла бы подарков.
    """
    if not ref_code:
        return ""
    try:
        from app.services.share_links import build_share_links
        links = await build_share_links(
            db, client_id=client_id, event_slug=slug, partner_id=ref_code,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(f"build_ref_links_block упал (event={event_id}): {e}")
        return ""

    lines: list[str] = []
    for plat in _PLATFORM_ORDER:
        url = (links.get(plat) or "").strip()
        if not url:
            continue
        label = _PLATFORM_LABEL.get(plat, plat)
        if html:
            lines.append(
                f'<b>Через {escape(label)}:</b> '
                f'<a href="{escape(url, quote=True)}">{escape(url)}</a>'
            )
        else:
            lines.append(f"Через {label}: {url}")
    return "\n".join(lines)


def split_text_chunks(text: str, limit: int = 3900) -> list[str]:
    """Режет длинный текст на части по лимиту мессенджера (TG — 4096, берём
    с запасом; MAX и ВК допускают меньше, тот же запас годится и им).

    ⚠️ Режем ПО АБЗАЦАМ, а не по символам: разрыв посреди HTML-тега («<b») даёт
    у Telegram ошибку разбора, и сообщение не уходит ВООБЩЕ. Абзац длиннее
    лимита (бывает у одного очень длинного названия подарка) отдаём как есть —
    обрезать название хуже, чем прислать одним куском.

    Лестница подарков растёт с числом ступеней, и у крупного события текст
    уже перерастает лимит: без нарезки человек не получил бы ничего.
    """
    text = text or ""
    if len(text) <= limit:
        return [text]
    parts: list[str] = []
    cur = ""
    for para in text.split("\n\n"):
        candidate = f"{cur}\n\n{para}" if cur else para
        if len(candidate) <= limit:
            cur = candidate
            continue
        if cur:
            parts.append(cur)
        cur = para
    if cur:
        parts.append(cur)
    return parts or [text]


def build_friend_invite_text(event_title: str) -> str:
    """Готовый текст приглашения другу — «Привет! Иду на "X" — идём со мной?»."""
    title = (event_title or "").strip() or "событие"
    return f'Привет! Иду на «{title}» — идём со мной?'


async def build_share_friend_url(
    db: asyncpg.Connection, *, client_id: int, slug: str,
    ref_code: Optional[str], event_title: str,
) -> str:
    """Telegram-шеринг: `t.me/share/url` с реф-ссылкой и готовым текстом.

    ⚠️ Только для Telegram. Кнопка открывает выбор чата и подставляет текст —
    у ВК и MAX такого механизма в API нет (MAX принимает лишь link/callback/
    open_app), поэтому там вторую кнопку не рисуем вовсе: обещать нажатие,
    которого не будет, хуже, чем не показать кнопку.

    Ссылка в шеринге — ЛИЧНАЯ, с `pid{ref_code}`: без него приглашённый не
    зачтётся пригласившему, и подарок не придёт.
    """
    if not ref_code:
        return ""
    try:
        from urllib.parse import quote

        from app.services.share_links import build_share_links
        links = await build_share_links(
            db, client_id=client_id, event_slug=slug, partner_id=ref_code,
        )
        url = (links.get("telegram") or "").strip()
        if not url:
            return ""
        text = build_friend_invite_text(event_title)
        return (f"https://t.me/share/url?url={quote(url, safe='')}"
                f"&text={quote(text, safe='')}")
    except Exception as e:  # noqa: BLE001
        logger.warning(f"build_share_friend_url упал (client={client_id}): {e}")
        return ""


async def build_gifts_message(
    db: asyncpg.Connection, *, event_id: int, client_id: int,
    contact_id: Optional[int], platform: str,
) -> Optional[dict]:
    """Готовое сообщение «Подарки за рекомендации» для команды `/podarki{id}`.

    Возвращает `{text, tab_label, main_url, share_url}` или None, если событие
    не найдено. Тот же текст, что у шага догрева, — единый источник, чтобы бот
    и воронка не разошлись формулировками.

    `platform` — 'telegram' | 'vk' | 'max': от неё зависит и разметка (ВК без
    HTML), и вид ссылки на кабинет (режим клиента на этой площадке).

    ⚠️ `share_url` заполняется ТОЛЬКО для Telegram — см. `build_share_friend_url`.
    """
    row = await db.fetchrow(
        "SELECT slug, title FROM events WHERE id = $1", event_id)
    if not row:
        return None
    slug = (row["slug"] or "").strip()
    title = (row["title"] or "").strip()
    html = (platform != "vk")

    ref_code = None
    if contact_id:
        ref_code = await db.fetchval(
            "SELECT ref_code FROM contacts WHERE id = $1", contact_id)

    ref_links = await build_ref_links_block(
        db, event_id=event_id, client_id=client_id, slug=slug,
        ref_code=ref_code, html=html,
    )
    invited = await count_invited(db, event_id=event_id, ref_code=ref_code)
    ladder = await build_gift_ladder_block(
        db, event_id=event_id, invited=invited, html=html)
    tab_label = await get_tab_label_game(db, client_id)

    def _b(s: str) -> str:
        return f"<b>{s}</b>" if html else s

    parts = [
        "Мы щедро благодарим тех, кто рекомендует нас и помогает нам сделать "
        "наше событие еще более масштабным.",
        "Вы можете получать ценнейшие подарки, просто рекомендуя наше событие "
        "по своей реферальной ссылке.",
    ]
    # ⚠️ Нет реф-кода (человек не опознан или ещё не участник) — блок ссылок
    # пуст. Тогда и заголовок «Ваши реферальные ссылки» не печатаем: заголовок
    # над пустотой выглядит поломкой.
    if ref_links:
        parts.append(_b("Ваши реферальные ссылки:") + "\n" + ref_links)
    if ladder:
        parts.append("А именно:\n\n" + ladder)
    parts.append(
        f"Нажмите на кнопку, чтобы перейти в свой кабинет на вкладку "
        f"«{escape(tab_label) if html else tab_label}», чтобы забрать вашу "
        f"реферальную ссылку и готовые материалы для анонсов."
    )

    from app.tasks.nurture import _build_app_url
    main_url = await _build_app_url(
        db, platform=platform, client_id=client_id, slug=slug,
        ref_code=ref_code, contact_id=contact_id, tab="game",
    )
    share_url = ""
    if platform == "telegram":
        share_url = await build_share_friend_url(
            db, client_id=client_id, slug=slug, ref_code=ref_code,
            event_title=title,
        )

    return {
        "text": "\n\n".join(p for p in parts if p),
        "tab_label": tab_label,
        "main_url": main_url,
        "share_url": share_url,
        "event_title": title,
    }


async def resolve_event_for_client(
    db: asyncpg.Connection, *, event_id: int, client_id: int,
) -> Optional[dict]:
    """Событие `event_id`, если оно принадлежит клиенту этого бота.

    ⚠️ Проверка обязательна (требование владельца): команда `/podarki89`
    содержит номер события, и без неё человек из чужого бота вытянул бы
    лестницу подарков любого события платформы по перебору номеров.
    Проверяем через `event_owners … status='accepted'` — как `/vip_link{id}`
    в TG и меню события в ВК. В коллабе организаторы равноправны, поэтому
    EXISTS по всем владельцам, а не «первый владелец».
    """
    if not client_id:
        return None
    row = await db.fetchrow(
        """SELECT e.id, e.slug, e.title
             FROM events e
            WHERE e.id = $1
              AND EXISTS (SELECT 1 FROM event_owners eo
                           WHERE eo.event_id = e.id AND eo.client_id = $2
                             AND eo.status = 'accepted')
            LIMIT 1""",
        event_id, client_id,
    )
    return dict(row) if row else None


async def get_tab_label_game(db: asyncpg.Connection, client_id: int) -> str:
    """Название вкладки подарков, как его настроил клиент.

    ⚠️ Дефолт «Привилегии» — как в Mini App (`WelcomePage.tsx`). В бэкенде
    местами стоит «Подарки», и это расхождение уже путало: в письме звали на
    одну вкладку, а в приложении она называлась иначе.
    """
    try:
        lbl = await db.fetchval(
            "SELECT tab_label_game FROM clients WHERE id = $1", client_id)
        return (lbl or "").strip() or "Привилегии"
    except Exception:
        return "Привилегии"
