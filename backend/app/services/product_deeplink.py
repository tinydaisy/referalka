"""Метка продукта в боте: `pr_<slug>` — приветствие + кнопка «СМОТРЕТЬ».

Зачем (решение № 24). У события ссылки есть на все площадки, а у продукта была
только веб-страница `/pr/{slug}`. Партнёру нужно то же самое: дать ссылку в
мессенджере, чтобы человек попал в бота (там он опознаётся и подписывается),
а уже оттуда — на страницу продукта.

Формат метки — как у лид-магнитов: `pr_<slug>` + необязательные `_pid<код>`
и `_src<utm>`.

⚠️⚠️ ВЕТКА РАЗБОРА ОБЯЗАНА БЫТЬ В БОТЕ КАЖДОЙ ПЛОЩАДКИ, и показывать ссылку
можно ТОЛЬКО там, где она написана. Ссылка без разбора хуже её отсутствия:
человек переходит, реф-код молча теряется, за партнёром никто не
закрепляется. На этом уже обжигались с MAX (`ref<код>` проваливался в чужую
ветку и терялся).

⚠️ Логика ОДНА на три бота — здесь. Копия в каждом боте неминуемо разъедется.
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

PREFIX = "pr_"


def parse_product_payload(payload: str) -> Optional[dict]:
    """`pr_<slug>[_pid<код>][_src<utm>]` → {slug, pid, utm_source}.

    Не наша метка → None. Разбор такой же, как у `m_`/`p_` в лид-магнитах:
    свой формат не выдумываем, иначе в ботах появится второй парсер.
    """
    if not payload or not payload.startswith(PREFIX):
        return None
    rest = payload[len(PREFIX):]
    if not rest:
        return None

    parts = rest.split("_")
    slug = parts[0] if parts else ""
    if not slug:
        return None

    pid: Optional[str] = None
    utm_source: Optional[str] = None
    for chunk in parts[1:]:
        if chunk.startswith("pid"):
            pid = chunk[3:] or None
        elif chunk.startswith("src"):
            utm_source = chunk[3:] or None
    return {"slug": slug, "pid": pid, "utm_source": utm_source}


async def resolve_product_for_bot(db, *, slug: str, client_id: Optional[int] = None):
    """Продукт по метке. Возвращает dict или None.

    ⚠️ `slug` уникален ТОЛЬКО в пределах кабинета — глобально их может быть
    несколько. Клиент известен по боту, поэтому ищем в его границах; без
    клиента берём, только если продукт с таким адресом ровно один.
    """
    if client_id:
        row = await db.fetchrow(
            """SELECT id, client_id, slug, title, subtitle, cover_url, status
                 FROM products WHERE slug = $1 AND client_id = $2""",
            slug, client_id,
        )
    else:
        rows = await db.fetch(
            """SELECT id, client_id, slug, title, subtitle, cover_url, status
                 FROM products WHERE slug = $1 LIMIT 2""",
            slug,
        )
        row = rows[0] if len(rows) == 1 else None

    if not row or row["status"] == "archived":
        return None
    return dict(row)


async def build_product_message(db, product: dict, *, pid: Optional[str] = None) -> dict:
    """Текст приветствия + адрес кнопки «СМОТРЕТЬ».

    ⚠️ Адрес — на ДОМЕНЕ КЛИЕНТА (`client_public_link`), а не на pluson.ru:
    продукт клиент отдаёт своей аудитории, и литералов нашего домена в таких
    ссылках быть не должно.

    ⚠️ `pid` едет в ссылке дальше: на странице продукта он и превратится в
    закрепление за партнёром, когда человек оформит заказ.
    """
    from app.services.client_domains import client_public_link

    url = await client_public_link(db, product["client_id"], f"/pr/{product['slug']}")
    if pid:
        url = f"{url}{'&' if '?' in url else '?'}pid={pid}"

    title = product.get("title") or "Продукт"
    subtitle = (product.get("subtitle") or "").strip()

    text = f"<b>{title}</b>"
    if subtitle:
        text += f"\n{subtitle}"
    text += "\n\nНажмите кнопку, чтобы посмотреть подробности."

    return {"text": text, "url": url, "button": "СМОТРЕТЬ",
            "photo": product.get("cover_url")}


async def bind_partner_from_product_link(
    db, *, client_id: int, contact_id: Optional[int], pid: Optional[str]
) -> None:
    """Закрепление за партнёром при переходе по ссылке продукта.

    ⚠️ Закрепляем УЖЕ ЗДЕСЬ, на входе в бота, а не при оформлении заказа:
    человек мог перейти по ссылке партнёра, а купить через неделю с другого
    устройства — и `pid` к тому моменту потеряется.

    Fail-open: сбой партнёрки не должен мешать человеку открыть продукт.
    """
    if not contact_id or not pid:
        return
    try:
        from app.services.partner_binding import try_bind_by_ref_code
        await try_bind_by_ref_code(
            db, client_id=client_id, contact_id=contact_id, ref_code=pid)
    except Exception as e:  # noqa: BLE001
        logger.warning("Партнёрка: закрепление по ссылке продукта не удалось: %s", e)
