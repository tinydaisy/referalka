"""
Отзывы и кейсы клиента (миграция 249).

Общая база на клиента, а не привязка к событию: один отзыв нужен и на лендинге
конференции, и в рассылке, и на странице следующего события. Раньше файлы
загружались прямо в блок галереи — переиспользовать их было нельзя.

Отбор в галерею лендинга идёт ПО ТЕГАМ («конференция», «частушки», «ivision-8»),
поэтому массовая загрузка сразу принимает общий набор тегов.

Гейт — фича `testimonials` (никогда по tariff_slug).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
import asyncpg

from app.database import get_db
from app.auth import get_current_client
from app.services.features import client_has_feature

router = APIRouter(prefix="/clients/me/testimonials", tags=["Отзывы и кейсы"])


async def _assert_feature(db, client_id: int) -> None:
    if not await client_has_feature(db, client_id, "testimonials"):
        raise HTTPException(
            status_code=403, detail="Раздел «Отзывы и кейсы» недоступен на вашем тарифе."
        )


def _norm_tags(tags) -> list[str]:
    """Теги в нижнем регистре, без пустых и дублей — иначе «Конференция» и
    «конференция» будут разными метками и фильтр галереи их не сведёт."""
    out: list[str] = []
    for t in (tags or []):
        s = str(t).strip().lower()
        if s and s not in out:
            out.append(s[:40])
    return out[:20]


class ItemIn(BaseModel):
    kind: str = "photo"
    url: str
    preview_url: Optional[str] = None
    title: Optional[str] = None
    caption: Optional[str] = None
    tags: Optional[list] = None
    event_id: Optional[int] = None


class BulkIn(BaseModel):
    """Массовая загрузка: набор ссылок + общие теги на всю пачку."""
    kind: str = "photo"
    urls: list[str]
    tags: Optional[list] = None
    event_id: Optional[int] = None
    title: Optional[str] = None


class ItemPatch(BaseModel):
    kind: Optional[str] = None
    url: Optional[str] = None
    preview_url: Optional[str] = None
    title: Optional[str] = None
    caption: Optional[str] = None
    tags: Optional[list] = None
    event_id: Optional[int] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


@router.get("", summary="Отзывы и кейсы (с фильтром по типу и тегам)")
async def list_items(
    kind: Optional[str] = None,
    tag: Optional[str] = None,
    q: Optional[str] = None,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)

    where = ["client_id = $1"]
    args: list = [client_id]
    if kind in ("photo", "video"):
        args.append(kind)
        where.append(f"kind = ${len(args)}")
    if tag:
        args.append(tag.strip().lower())
        where.append(f"${len(args)} = ANY(tags)")
    # ⚠️ Поиск по НАЗВАНИЮ и подписи. Метки отвечают за отбор в подборки, а
    # найти конкретный отзыв среди сотни снимков ими нельзя: они общие для
    # десятков записей. Название даёт поиск по смыслу — «Иванова», «вебинар».
    if q and q.strip():
        args.append(f"%{q.strip()}%")
        where.append(f"(title ILIKE ${len(args)} OR caption ILIKE ${len(args)})")

    rows = await db.fetch(
        f"""SELECT * FROM client_testimonials
             WHERE {' AND '.join(where)}
             ORDER BY sort_order, id DESC""",
        *args,
    )
    # Справочник тегов — чтобы в UI показать список меток с количеством.
    tags = await db.fetch(
        """SELECT t AS tag, COUNT(*) AS cnt
             FROM client_testimonials, UNNEST(tags) AS t
            WHERE client_id = $1
            GROUP BY t ORDER BY cnt DESC, t""",
        client_id,
    )
    return {
        "items": [dict(r) for r in rows],
        "tags": [dict(t) for t in tags],
    }


@router.post("", summary="Добавить отзыв")
async def create_item(
    data: ItemIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    if data.kind not in ("photo", "video"):
        raise HTTPException(status_code=400, detail="Тип: photo или video")
    if not (data.url or "").strip():
        raise HTTPException(status_code=400, detail="Нужна картинка или ссылка на видео")

    row = await db.fetchrow(
        """INSERT INTO client_testimonials
             (client_id, kind, url, preview_url, title, caption, tags, event_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *""",
        client_id, data.kind, data.url.strip(), data.preview_url,
        data.title, data.caption, _norm_tags(data.tags), data.event_id,
    )
    return dict(row)


@router.post("/bulk", summary="Загрузить сразу несколько (с общими тегами)")
async def bulk_create(
    data: BulkIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    if data.kind not in ("photo", "video"):
        raise HTTPException(status_code=400, detail="Тип: photo или video")

    urls = [u.strip() for u in (data.urls or []) if str(u).strip()]
    if not urls:
        raise HTTPException(status_code=400, detail="Список пуст")

    tags = _norm_tags(data.tags)
    last = await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), 0) FROM client_testimonials WHERE client_id = $1",
        client_id,
    )
    created = []
    async with db.transaction():
        for i, url in enumerate(urls):
            row = await db.fetchrow(
                """INSERT INTO client_testimonials
                     (client_id, kind, url, title, tags, event_id, sort_order)
                   VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *""",
                client_id, data.kind, url, data.title, tags, data.event_id, last + (i + 1) * 10,
            )
            created.append(dict(row))
    return {"created": len(created), "items": created}


@router.patch("/{item_id}", summary="Изменить отзыв")
async def patch_item(
    item_id: int,
    data: ItemPatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    owns = await db.fetchval(
        "SELECT 1 FROM client_testimonials WHERE id = $1 AND client_id = $2", item_id, client_id
    )
    if not owns:
        raise HTTPException(status_code=404, detail="Отзыв не найден")

    fs = data.model_fields_set
    sets, vals = [], []
    for field in ("kind", "url", "preview_url", "title", "caption",
                  "event_id", "sort_order", "is_active"):
        if field not in fs:
            continue
        val = getattr(data, field)
        if field == "kind" and val not in ("photo", "video"):
            val = "photo"
        vals.append(val)
        sets.append(f"{field} = ${len(vals)}")

    if "tags" in fs:
        vals.append(_norm_tags(data.tags))
        sets.append(f"tags = ${len(vals)}")

    if not sets:
        return {"ok": True}

    vals.append(item_id)
    row = await db.fetchrow(
        f"UPDATE client_testimonials SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(vals)} RETURNING *",
        *vals,
    )
    return dict(row)


@router.delete("/{item_id}", summary="Удалить отзыв")
async def delete_item(
    item_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    deleted = await db.fetchval(
        "DELETE FROM client_testimonials WHERE id = $1 AND client_id = $2 RETURNING id",
        item_id, client_id,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Отзыв не найден")
    return {"ok": True}
