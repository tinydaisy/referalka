"""
Настройки автообзвонов — подключение своего аккаунта Звонопса (миграция 359).

Клиент вписывает свой API-ключ, выбирает номер, с которого звонить, и сценарий
звонка. Деньги за звонки его, ответственность перед ФАС его — мы даём интерфейс.

⚠️ Ключ выдаёт менеджер Звонопса, в их кабинете он не берётся. Поэтому рядом с
полем — ссылка на регистрацию, чтобы человеку не пришлось искать, где его взять.

Гейт — фича `calls` (никогда по tariff_slug), сейчас только admin.
Ассистенту запись закрыта общим middleware.
"""
import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.auth import get_current_client
from app.database import get_db
from app.services import calldog
from app.services.features import client_has_feature

router = APIRouter(prefix="/clients/me/call-settings", tags=["Автообзвоны"])

_FIELDS = (
    "calls_calldog_api_key",
    "calls_calldog_outgoing_phone",
    "calls_calldog_duty_phone",
)


async def assert_calls_feature(db, client_id: int) -> None:
    if not await client_has_feature(db, client_id, "calls"):
        raise HTTPException(
            status_code=403,
            detail="Раздел «Автообзвоны» недоступен на вашем тарифе.",
        )


class SettingsIn(BaseModel):
    calls_calldog_api_key: Optional[str] = None
    calls_calldog_outgoing_phone: Optional[str] = None
    calls_calldog_duty_phone: Optional[bool] = None


class CheckIn(BaseModel):
    # Не прислали ключ — проверяем сохранённый.
    calls_calldog_api_key: Optional[str] = None


async def _load(db, client_id: int) -> dict:
    row = await db.fetchrow(
        f"SELECT {', '.join(_FIELDS)} FROM clients WHERE id = $1", client_id
    )
    return dict(row or {})


def _public(d: dict) -> dict:
    """Наружу — без самого ключа.

    ⚠️ Секрет целиком не отдаём никогда: он утечёт в любой лог фронта. Отдаём
    признак «задан» и хвост, чтобы человек узнал свой ключ. Так же сделано в
    настройках платёжных систем.
    """
    key = (d.pop("calls_calldog_api_key", None) or "").strip()
    out = dict(d)
    out["has_api_key"] = bool(key)
    out["api_key_tail"] = key[-4:] if len(key) >= 4 else ""
    out["is_configured"] = calldog.is_configured({**d, "calls_calldog_api_key": key})
    # Ссылка на регистрацию в Звонопсе — ключ выдаёт их менеджер, человеку надо
    # знать, куда идти. Держим в сервисе, а не в вёрстке: адрес один на проект.
    out["signup_url"] = calldog.SIGNUP_URL
    return out


@router.get("", summary="Настройки автообзвонов")
async def get_settings(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await assert_calls_feature(db, client_id)
    return _public(await _load(db, client_id))


@router.patch("", summary="Сохранить настройки автообзвонов")
async def patch_settings(
    data: SettingsIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await assert_calls_feature(db, client_id)

    fs = data.model_fields_set
    sets, vals = [], []
    for field in _FIELDS:
        if field not in fs:
            continue
        val = getattr(data, field)
        if isinstance(val, str):
            val = val.strip() or None
        # Галочка — не текст: NULL в NOT NULL-колонку не пройдёт.
        if field == "calls_calldog_duty_phone":
            val = bool(val)
        # Номер храним только цифрами — сервису он нужен в таком виде.
        if field == "calls_calldog_outgoing_phone" and val:
            digits = "".join(ch for ch in val if ch.isdigit())
            val = digits or None
        vals.append(val)
        sets.append(f"{field} = ${len(vals)}")

    if sets:
        vals.append(client_id)
        await db.execute(
            f"UPDATE clients SET {', '.join(sets)} WHERE id = ${len(vals)}", *vals
        )
    return _public(await _load(db, client_id))


@router.post("/check", summary="Проверить связь со Звонопсом")
async def check_settings(
    data: CheckIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Проверка ключа без реальных звонков — показывает баланс."""
    client_id = int(client["sub"])
    await assert_calls_feature(db, client_id)
    key = (data.calls_calldog_api_key or "").strip()
    if not key:
        saved = await _load(db, client_id)
        key = (saved.get("calls_calldog_api_key") or "").strip()
    return await calldog.check_credentials(key)


@router.get("/phones", summary="Исходящие номера аккаунта Звонопса")
async def list_phones(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Номера подтягиваем из их API — руками вводить не нужно.

    ⚠️ Отдаём и неподтверждённые (enable=false), но с флагом: клиент должен
    видеть, что номер есть, но с него звонить пока нельзя — иначе он решит,
    что номер потерялся.
    """
    client_id = int(client["sub"])
    await assert_calls_feature(db, client_id)
    saved = await _load(db, client_id)
    key = (saved.get("calls_calldog_api_key") or "").strip()
    if not key:
        return {"phones": [], "message": "Сначала укажите API-ключ."}
    try:
        phones = await calldog.get_phones(key)
    except calldog.CalldogError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"phones": phones}


@router.get("/templates", summary="Сценарии звонка из кабинета Звонопса")
async def list_templates(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Шаблоны сценариев — что робот говорит и что делает по нажатию.

    ⚠️ Только отмодерированные: незаверенный шаблон не позвонит, и обзвон
    «запустится», но останется тишина — понять причину клиент не сможет.
    """
    client_id = int(client["sub"])
    await assert_calls_feature(db, client_id)
    saved = await _load(db, client_id)
    key = (saved.get("calls_calldog_api_key") or "").strip()
    if not key:
        return {"templates": [], "message": "Сначала укажите API-ключ."}
    try:
        templates = await calldog.get_templates(key, only_moderated=True)
    except calldog.CalldogError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"templates": templates}
