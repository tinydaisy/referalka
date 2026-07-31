"""Выгрузки для владельца платформы: список клиентов и участников Коллабораторной.

Используется командами /clients и /collabs в @pluson_bot. Доступ — только у
аккаунтов из ALLOWED_USERNAMES (Марго и её рабочие аккаунты).

⚠️ Логика доступа и формат вывода живут ЗДЕСЬ, а не в хендлере бота: команды
идентичны по структуре, и дублировать сборку строк в двух местах нельзя.
"""

from typing import Optional

# ⚠️ Команды работают ТОЛЬКО в этом боте. Polling-диспетчер один на все боты
# платформы, поэтому хендлер обязан сверить, из какого бота пришло сообщение:
# иначе выгрузка по всей платформе была бы доступна из бота любого клиента.
EXPORT_BOT_USERNAME: str = "pluson_bot"

# Кому доступны выгрузки. Сверяем по @нику (регистр не важен, '@' не нужен).
ALLOWED_USERNAMES: frozenset[str] = frozenset({
    "margo_forbs",
    "margo_frbs",
    "forbs_service2",
    "forbs_margo2",
})

# Тарифы «Профи и выше» + модули, ради которых человек считается действующим
# клиентом. ⚠️ Модуль может быть и в тарифе (tariff_features), и куплен отдельно
# (client_addons) — учитываем оба источника, как client_has_feature.
PAID_TARIFFS: tuple[str, ...] = ("pro", "vip", "admin")
MODULE_FEATURES: tuple[str, ...] = ("conference", "tournaments", "awards")


def is_allowed(username: Optional[str]) -> bool:
    """Разрешён ли доступ к выгрузкам по TG-нику."""
    return bool(username) and username.lstrip("@").lower() in ALLOWED_USERNAMES


def wa_link(phone: Optional[str]) -> str:
    """Телефон → ссылка WhatsApp https://wa.me/<цифры>, без '+'.

    Телефоны в базе в разном виде: '+79991234567', '89991234567', '79991234567'.
    Российскую «8» в начале 11-значного номера меняем на «7» — иначе wa.me даёт
    несуществующий номер. Непохожее на телефон (меньше 10 цифр) → пусто.
    """
    digits = "".join(ch for ch in (phone or "") if ch.isdigit())
    if len(digits) == 11 and digits.startswith("8"):
        digits = "7" + digits[1:]
    if len(digits) < 10:
        return ""
    return f"https://wa.me/{digits}"


def tg_link(username: Optional[str]) -> str:
    """@ник или готовая ссылка → https://telegram.me/<ник>. Пусто → ''.

    В базе поле хранится по-разному: '@nick', 'nick', 'https://telegram.me/nick'.
    """
    raw = (username or "").strip()
    if not raw:
        return ""
    if raw.startswith("http"):
        return raw
    return f"https://telegram.me/{raw.lstrip('@')}"


def _clean_url(url: Optional[str]) -> str:
    raw = (url or "").strip()
    return raw if raw.startswith("http") else ""


async def fetch_clients(db) -> list[dict]:
    """ВСЕ клиенты с активной подпиской + их тариф и купленные модули.

    Группировка (по тарифам и модулям, триал отдельно) делается при выводе —
    см. group_clients. Здесь только данные. Демо-карточки Хаба (@hub.local) и
    тестовые аккаунты исключены.

    ⚠️ Коллабораторная (collab_hub) в модули НЕ входит — под неё отдельная
    команда /collabs, иначе один и тот же человек попал бы в оба списка.
    """
    rows = await db.fetch(
        """
        SELECT c.id, c.name, c.phone, c.telegram_username, c.work_tg_username,
               c.work_vk, c.work_max,
               c.social_links->>'vk'  AS soc_vk,
               c.social_links->>'max' AS soc_max,
               t.name AS tariff_name, t.slug AS tariff_slug,
               cs.expires_at,
               (SELECT string_agg(DISTINCT f2.name, ', ')
                  FROM client_addons a
                  JOIN features f2 ON f2.id = a.feature_id
                 WHERE a.client_id = c.id AND a.status = 'active'
                   AND a.expires_at > NOW() AND f2.slug = ANY($1::text[])) AS addons,
               (SELECT array_agg(DISTINCT f3.slug)
                  FROM client_addons a
                  JOIN features f3 ON f3.id = a.feature_id
                 WHERE a.client_id = c.id AND a.status = 'active'
                   AND a.expires_at > NOW() AND f3.slug = ANY($1::text[])) AS addon_slugs
          FROM clients c
          JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
          JOIN tariffs t ON t.id = cs.tariff_id
         WHERE cs.status = 'active' AND cs.expires_at > NOW()
           AND c.email NOT LIKE '%@hub.local'
           AND c.name NOT ILIKE 'ТЕСТ %'
         ORDER BY c.name
        """,
        list(MODULE_FEATURES),
    )
    return [dict(r) for r in rows]


def group_clients(rows: list[dict]) -> list[tuple[str, list[dict]]]:
    """Разбить клиентов на блоки: платные тарифы → модули → триал.

    Человек попадает РОВНО В ОДИН блок, иначе списки не сложатся в общее число:
      1. по тарифу (Экстра / Профи / Администратор / Стандарт) — если тариф платный;
      2. иначе по купленному модулю (Конференции / Премии / Турниры);
      3. иначе «Триал» — их больше всего, поэтому идут последними.
    """
    paid: dict[str, list[dict]] = {}
    by_module: dict[str, list[dict]] = {}
    trial: list[dict] = []
    for r in rows:
        if r.get("tariff_slug") in PAID_TARIFFS:
            paid.setdefault(r.get("tariff_name") or r["tariff_slug"], []).append(r)
        elif r.get("addon_slugs"):
            by_module.setdefault(r["addons"] or "Модуль", []).append(r)
        else:
            trial.append(r)

    blocks: list[tuple[str, list[dict]]] = []
    # Платные — по убыванию «веса» тарифа, чтобы Экстра была выше Профи.
    order = {"vip": 0, "pro": 1, "admin": 2, "start": 3}
    for title, items in sorted(paid.items(),
                               key=lambda kv: order.get(kv[1][0]["tariff_slug"], 9)):
        blocks.append((f"Тариф «{title}»", items))
    for title, items in sorted(by_module.items()):
        blocks.append((f"Модуль «{title}» (на триале)", items))
    if trial:
        blocks.append(("Триал (без модулей)", trial))
    return blocks


async def fetch_collabs(db) -> list[dict]:
    """Участники Коллабораторной — РЕАЛЬНЫЕ люди.

    Реальный = опубликован в Хабе ИЛИ купил модуль collab_hub. Отсеиваем
    демо-карточки (@hub.local) и тестовые аккаунты (имя начинается с «ТЕСТ»).
    """
    rows = await db.fetch(
        """
        SELECT c.id, c.name, c.phone, c.telegram_username, c.work_tg_username,
               c.work_vk, c.work_max,
               c.social_links->>'vk'  AS soc_vk,
               c.social_links->>'max' AS soc_max,
               c.is_published_in_hub
          FROM clients c
         WHERE c.email NOT LIKE '%@hub.local'
           AND c.name NOT ILIKE 'ТЕСТ %'
           AND (
                c.is_published_in_hub
             OR EXISTS (SELECT 1 FROM client_addons a JOIN features f ON f.id = a.feature_id
                         WHERE a.client_id = c.id AND f.slug = 'collab_hub'
                           AND a.status = 'active' AND a.expires_at > NOW())
           )
         ORDER BY c.name
        """
    )
    return [dict(r) for r in rows]


def format_row(row: dict, idx: int, extra: str = "") -> str:
    """Одна карточка человека для сообщения в боте (HTML).

    Показываем только заполненное — пустые строки не выводим, чтобы список
    читался. ВК/МАКС берём из рабочих полей, иначе из соцсетей визитки.
    """
    parts = [f"<b>{idx}. {row['name'] or 'Без имени'}</b>"]
    if extra:
        parts.append(extra)
    tg = tg_link(row.get("telegram_username") or row.get("work_tg_username"))
    if tg:
        parts.append(f"TG: {tg}")
    vk = _clean_url(row.get("work_vk")) or _clean_url(row.get("soc_vk"))
    if vk:
        parts.append(f"ВК: {vk}")
    mx = _clean_url(row.get("work_max")) or _clean_url(row.get("soc_max"))
    if mx:
        parts.append(f"МАКС: {mx}")
    wa = wa_link(row.get("phone"))
    if wa:
        parts.append(f"WhatsApp: {wa}")
    # Ни одного контакта — говорим прямо. Иначе в списке просто имя без строк,
    # и непонятно: то ли выгрузка сломалась, то ли человек не заполнил профиль.
    if len(parts) == (2 if extra else 1):
        parts.append("<i>контактов нет</i>")
    return "\n".join(parts)


def build_grouped_message(rows: list[dict], title: str) -> list[str]:
    """Клиенты блоками: платные тарифы → модули → триал.

    Нумерация внутри каждого блока своя — так видно размер каждой группы.
    Режем по границе карточки (лимит Telegram ~4096): по символам нельзя,
    HTML-теги разъедутся и сообщение не уйдёт целиком.
    """
    if not rows:
        return [f"<b>{title}</b>\n\nПусто — никого не нашлось."]
    chunks: list[str] = []
    cur: list[str] = [f"<b>{title}</b> — всего {len(rows)}\n"]
    cur_len = len(cur[0])

    def flush():
        nonlocal cur, cur_len
        if cur:
            chunks.append("".join(cur))
        cur, cur_len = [], 0

    for block_title, items in group_clients(rows):
        head = f"\n<b>━━ {block_title} — {len(items)} ━━</b>\n"
        if cur_len + len(head) > 3800:
            flush()
        cur.append(head)
        cur_len += len(head)
        for i, r in enumerate(items, 1):
            body = "\n" + format_row(r, i) + "\n"
            if cur_len + len(body) > 3800:
                flush()
                # Продолжение блока на новой странице — иначе непонятно, чей это список.
                cont = f"<b>━━ {block_title} (продолжение) ━━</b>\n"
                cur.append(cont)
                cur_len += len(cont)
            cur.append(body)
            cur_len += len(body)
    flush()
    return chunks


def build_message(rows: list[dict], title: str, with_tariff: bool) -> list[str]:
    """Готовые куски сообщения (Telegram режет всё длиннее ~4096 символов).

    Разбиваем ПО ГРАНИЦЕ КАРТОЧКИ, а не по символам — иначе HTML-теги рвутся
    посередине и Telegram отклоняет сообщение целиком.
    """
    if not rows:
        return [f"<b>{title}</b>\n\nПусто — никого не нашлось."]
    header = f"<b>{title}</b> — {len(rows)}\n"
    chunks: list[str] = []
    cur = [header]
    cur_len = len(header)
    for i, r in enumerate(rows, 1):
        extra = ""
        if with_tariff:
            bits = [r.get("tariff_name") or ""]
            if r.get("addons"):
                bits.append(r["addons"])
            extra = "<i>" + " · ".join(b for b in bits if b) + "</i>"
        block = "\n" + format_row(r, i, extra) + "\n"
        if cur_len + len(block) > 3800:
            chunks.append("".join(cur))
            cur, cur_len = [], 0
        cur.append(block)
        cur_len += len(block)
    if cur:
        chunks.append("".join(cur))
    return chunks
