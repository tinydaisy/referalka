"""
API для юр-данных клиента + текст политики + публичная страничка политики.

Реализует требования 152-ФЗ:
- Клиент в дашборде заполняет юр-данные (ИП/ООО/физлицо, ИНН, контакт оператора)
- Клиент в дашборде редактирует текст политики обработки персональных данных
- При публикации политики создаётся новая версия (история сохраняется)
- Каждое согласие контакта на регистрации связано с конкретной версией политики
- Публичная страничка /c/{client_id}/privacy показывает актуальный текст
"""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.database import get_db
from app.auth import get_current_client


router = APIRouter(prefix="/api/v1", tags=["legal"])


# ─── Pydantic ──────────────────────────────────────────


class LegalDataUpdate(BaseModel):
    legal_form: Optional[str] = None             # individual | ip | ooo | other
    legal_name: Optional[str] = None
    legal_inn: Optional[str] = None
    legal_ogrn: Optional[str] = None
    legal_address: Optional[str] = None
    legal_operator_email: Optional[str] = None
    legal_operator_phone: Optional[str] = None
    # Текст политики — отдельным полем; публикацию делает POST /policy/publish
    privacy_policy_text: Optional[str] = None


# ─── Личный кабинет клиента ───────────────────────────


@router.get("/clients/me/legal-and-policy")
async def get_legal_and_policy(
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        """SELECT legal_form, legal_name, legal_inn, legal_ogrn,
                  legal_address, legal_operator_email, legal_operator_phone,
                  privacy_policy_text, privacy_policy_version,
                  privacy_policy_published_at
             FROM clients WHERE id = $1""",
        client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    data = dict(row)
    # Проверка полноты юр-данных — нужна, чтобы заблокировать «Опубликовать»
    # пока не заполнены обязательные поля
    required = ["legal_form", "legal_name", "legal_inn",
                "legal_address", "legal_operator_email"]
    missing = [f for f in required if not (data.get(f) or "").strip()]
    data["legal_data_complete"] = not missing
    data["missing_legal_fields"] = missing
    return data


@router.patch("/clients/me/legal-and-policy")
async def update_legal_and_policy(
    data: LegalDataUpdate,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    client_id = int(client["sub"])

    # Простейшая валидация ИНН (10 или 12 цифр, опционально)
    if data.legal_inn is not None:
        inn = (data.legal_inn or "").strip()
        if inn and (not inn.isdigit() or len(inn) not in (10, 12)):
            raise HTTPException(
                status_code=400,
                detail="ИНН должен содержать 10 цифр (для юр.лица) или 12 (для ИП/физлица)",
            )

    if data.legal_form is not None and data.legal_form not in (
        "individual", "ip", "ooo", "other", ""
    ):
        raise HTTPException(
            status_code=400,
            detail="Форма должна быть одной из: individual, ip, ooo, other",
        )

    sets = []
    args: list = []
    for field in ["legal_form", "legal_name", "legal_inn", "legal_ogrn",
                  "legal_address", "legal_operator_email", "legal_operator_phone",
                  "privacy_policy_text"]:
        val = getattr(data, field)
        if val is not None:
            args.append(val.strip() if isinstance(val, str) else val)
            sets.append(f"{field} = ${len(args)}")

    if not sets:
        raise HTTPException(status_code=400, detail="Нечего обновлять")

    args.append(client_id)
    await db.execute(
        f"UPDATE clients SET {', '.join(sets)} WHERE id = ${len(args)}",
        *args,
    )
    return await get_legal_and_policy(client=client, db=db)


@router.post("/clients/me/policy/publish")
async def publish_policy(
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """
    Публикует текущий privacy_policy_text как новую версию.
    Версия инкрементируется. Старые версии остаются в client_policy_versions —
    они нужны для аудита: каждое согласие ссылается на конкретную версию.

    Блокируется, если не заполнены обязательные юр-данные.
    """
    client_id = int(client["sub"])
    row = await db.fetchrow(
        """SELECT privacy_policy_text, privacy_policy_version,
                  legal_form, legal_name, legal_inn,
                  legal_address, legal_operator_email
             FROM clients WHERE id = $1""",
        client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Клиент не найден")

    required = {"legal_form": row["legal_form"], "legal_name": row["legal_name"],
                "legal_inn": row["legal_inn"], "legal_address": row["legal_address"],
                "legal_operator_email": row["legal_operator_email"]}
    missing = [k for k, v in required.items() if not (v or "").strip()]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Заполните юр-данные перед публикацией: {', '.join(missing)}",
        )

    text = (row["privacy_policy_text"] or "").strip()
    if not text or len(text) < 100:
        raise HTTPException(
            status_code=400,
            detail="Текст политики слишком короткий — минимум 100 символов",
        )

    new_version = (row["privacy_policy_version"] or 0) + 1
    async with db.transaction():
        await db.execute(
            """INSERT INTO client_policy_versions (client_id, version, text)
               VALUES ($1, $2, $3)""",
            client_id, new_version, text,
        )
        await db.execute(
            """UPDATE clients
                  SET privacy_policy_version = $1,
                      privacy_policy_published_at = NOW()
                WHERE id = $2""",
            new_version, client_id,
        )
    return {"version": new_version, "published_at": "now"}


# ─── Публичная страничка политики ──────────────────────


@router.get("/public/clients/{client_id}/privacy")
async def get_public_privacy(client_id: int, db=Depends(get_db)):
    """
    Публичный JSON с текстом политики клиента + блоком «Оператор перс-данных».
    Используется Next.js-страницей /c/{client_id}/privacy.
    """
    row = await db.fetchrow(
        """SELECT name, brand_name,
                  privacy_policy_text, privacy_policy_version,
                  privacy_policy_published_at,
                  legal_form, legal_name, legal_inn, legal_ogrn,
                  legal_address, legal_operator_email, legal_operator_phone
             FROM clients WHERE id = $1""",
        client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    data = dict(row)
    if not data.get("privacy_policy_text") or not data.get("privacy_policy_published_at"):
        raise HTTPException(
            status_code=404,
            detail="Политика обработки персональных данных пока не опубликована",
        )
    # Имя клиента для отображения — brand_name приоритетнее
    data["display_name"] = data.get("brand_name") or data.get("name") or "Клиент"
    return data
