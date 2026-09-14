"""Админская панель автонастройки Telegram (миграция 364).

Владелец платформы видит здесь сервисные аккаунты (телефон, пароль двухфакторки,
прокси, свободные слоты, состояние спам-блока) и все заказы услуги.

⚠️ ПОЧЕМУ ПАРОЛЬ ВИДЕН В ПАНЕЛИ.
Аккаунты — расходники: сгорел один, завели другой. Владельцу нужно уметь зайти
в такой аккаунт руками (переложить сессию, разобраться с блокировкой), а для
этого нужны телефон и облачный пароль. Прятать их от единственного человека,
который имеет право их знать, — только мешать. Эндпоинты закрыты ролью админа
платформы, клиентам сюда хода нет.

⚠️ ПОЧЕМУ ЗДЕСЬ ЖЕ ЗАГРУЗКА СЕССИИ.
Сессия Telethon — обычный файл. Заводя аккаунт, владелец кладёт его сюда, и
файл ложится в каталог на сервере. Иначе пришлось бы каждый раз ходить по SSH.
"""
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import asyncpg
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from typing import Optional

from app.auth import get_current_admin
from app.config import settings
from app.database import get_db
from app.services import tg_setup as tgs

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/tg-setup", tags=["Админ: автонастройка"])


# ─────────────────────────────────────────────────────────────────────────
# Аккаунты
# ─────────────────────────────────────────────────────────────────────────
@router.get("/accounts")
async def list_accounts(admin=Depends(get_current_admin), db=Depends(get_db)):
    """Список сервисных аккаунтов со свободными слотами."""
    rows = await db.fetch(
        """
        SELECT a.*,
               (SELECT COUNT(*) FROM service_orders so
                 WHERE so.setup_account_id = a.id
                   AND so.bot_created_at IS NOT NULL
                   AND so.bot_transferred_at IS NULL
                   AND so.setup_state IN ('running','awaiting_user')) AS busy_slots,
               -- ⚠️ Сутки считаем по ФАКТИЧЕСКИМ заказам, а не по счётчику на
               -- аккаунте: счётчик копится за всю жизнь и для лимита не годится.
               (SELECT COUNT(*) FROM service_orders so
                 WHERE so.setup_account_id = a.id
                   AND so.bot_created_at >= NOW() - INTERVAL '24 hours')
                   AS made_today,
               (SELECT COUNT(*) FROM service_orders so
                 WHERE so.setup_account_id = a.id
                   AND so.bot_transferred_at IS NOT NULL) AS transferred_total
          FROM tg_setup_accounts a
         ORDER BY a.is_active DESC, a.id
        """
    )
    out = []
    for r in rows:
        d = dict(r)
        d["free_slots"] = max(0, int(r["max_slots"]) - int(r["busy_slots"]))
        # ⚠️ Почему аккаунт не берёт заказы — СЧИТАЕМ ЗДЕСЬ, а не во фронте:
        # правила живут в `_pick_account`, и вторая копия условий в браузере
        # разъехалась бы с очередью. Человек должен видеть ту же причину,
        # по которой очередь его пропускает.
        reasons = []
        if not r["is_active"]:
            reasons.append("выключен в админке")
        if r["health"] != "ok":
            reasons.append(f"здоровье: {r['health']}")
        if r["cooldown_until"] and r["cooldown_until"] > datetime.now(timezone.utc):
            reasons.append("Telegram просил подождать")
        if int(r["busy_slots"]) >= int(r["max_slots"]):
            reasons.append("слоты заняты")
        limit = int(r["daily_bot_limit"] or 0)
        if limit and int(r["made_today"]) >= limit:
            reasons.append(f"дневной лимит {limit} исчерпан")
        gap = int(r["min_create_gap_min"] or 0)
        if gap and r["last_bot_created_at"]:
            ready = r["last_bot_created_at"] + timedelta(minutes=gap)
            if ready > datetime.now(timezone.utc):
                left = int((ready - datetime.now(timezone.utc)).total_seconds() // 60) + 1
                reasons.append(f"пауза ещё {left} мин")
        d["blocked_reasons"] = reasons
        d["session_exists"] = bool(
            r["session_path"] and Path(str(r["session_path"]) + ".session").exists()
            or (r["session_path"] and Path(str(r["session_path"])).exists())
        )
        out.append(d)
    return {"accounts": out}


class AccountIn(BaseModel):
    # ⚠️ Телефон обязателен только при СОЗДАНИИ. У PATCH своя модель
    # (AccountPatch): там телефон не меняют, а требовать его значило бы
    # ронять правку лимитов с 422 ещё до обращения к базе.
    phone: str
    title: Optional[str] = None
    twofa_password: Optional[str] = None
    proxy: Optional[str] = None
    max_slots: Optional[int] = None
    is_active: Optional[bool] = None
    # ⚠️ 0 = «без ограничения», а не «нельзя ничего»: так человек выключает
    # лимит, не стирая поле. NULL означает «не присылали» (PATCH их не трогает).
    daily_bot_limit: Optional[int] = None
    min_create_gap_min: Optional[int] = None


@router.post("/accounts")
async def create_account(data: AccountIn,
                         admin=Depends(get_current_admin), db=Depends(get_db)):
    phone = re.sub(r"\D", "", data.phone or "")
    if not phone:
        raise HTTPException(400, "Укажите телефон аккаунта")

    exists = await db.fetchval(
        "SELECT id FROM tg_setup_accounts WHERE phone=$1", phone
    )
    if exists:
        raise HTTPException(409, "Такой аккаунт уже добавлен")

    session_dir = Path(settings.tg_setup_sessions_dir)
    account_id = await db.fetchval(
        """INSERT INTO tg_setup_accounts (phone, title, twofa_password, proxy,
                                          session_path, max_slots, is_active,
                                          daily_bot_limit, min_create_gap_min)
                VALUES ($1, $2, $3, $4, $5, COALESCE($6, 5), COALESCE($7, TRUE),
                        $8, $9)
             RETURNING id""",
        phone, data.title, data.twofa_password, data.proxy,
        str(session_dir / phone), data.max_slots, data.is_active,
        data.daily_bot_limit, data.min_create_gap_min,
    )
    return {"ok": True, "id": account_id}


class AccountPatch(BaseModel):
    """Правка аккаунта. Телефона здесь нет — он не меняется."""
    title: Optional[str] = None
    twofa_password: Optional[str] = None
    proxy: Optional[str] = None
    max_slots: Optional[int] = None
    is_active: Optional[bool] = None
    daily_bot_limit: Optional[int] = None
    min_create_gap_min: Optional[int] = None


@router.patch("/accounts/{account_id}")
async def update_account(account_id: int, data: AccountPatch,
                         admin=Depends(get_current_admin), db=Depends(get_db)):
    """Меняет только те поля, которые реально прислали.

    ⚠️⚠️ РАЗЛИЧАЕМ «не прислали» и «прислали пусто» (`model_fields_set`), а не
    `value is not None`. Иначе прокси нельзя СТЕРЕТЬ: `null` молча пропадал бы,
    и снять прокси с аккаунта из админки было бы нечем. Тот же приём, что в
    client_broadcast_chats.py и PATCH /clients/me/profile.
    """
    fs = data.model_fields_set
    fields, values = [], []
    for name in ("title", "twofa_password", "proxy", "max_slots", "is_active",
                 "daily_bot_limit", "min_create_gap_min"):
        if name not in fs:
            continue
        value = getattr(data, name)
        # ⚠️ Пустая строка в прокси/пароле — это «стереть», а не «оставить».
        if isinstance(value, str) and not value.strip():
            value = None
        values.append(value)
        fields.append(f"{name} = ${len(values) + 1}")
    if not fields:
        return {"ok": True, "unchanged": True}
    await db.execute(
        f"UPDATE tg_setup_accounts SET {', '.join(fields)}, updated_at=NOW() WHERE id=$1",
        account_id, *values,
    )
    return {"ok": True}


@router.delete("/accounts/{account_id}")
async def delete_account(account_id: int,
                         admin=Depends(get_current_admin), db=Depends(get_db)):
    """Удаляет аккаунт.

    ⚠️ Отказываем, если на нём висят непереданные боты: удалив аккаунт, мы
    потеряли бы к ним доступ, а клиенты остались бы без ботов.
    """
    busy = await db.fetchval(
        """SELECT COUNT(*) FROM service_orders
            WHERE setup_account_id=$1 AND bot_created_at IS NOT NULL
              AND bot_transferred_at IS NULL""",
        account_id,
    )
    if busy:
        raise HTTPException(
            409,
            f"На аккаунте {busy} непереданных ботов — сначала передайте их клиентам",
        )
    await db.execute("DELETE FROM tg_setup_accounts WHERE id=$1", account_id)
    return {"ok": True}


@router.post("/accounts/{account_id}/session")
async def upload_session(account_id: int, file: UploadFile = File(...),
                         admin=Depends(get_current_admin), db=Depends(get_db)):
    """Кладёт файл сессии Telethon на сервер.

    ⚠️ Одна сессия — один сервер. Если этот же файл продолжает использовать
    другой сервис (например мейлер), Telegram сломает ключ авторизации, и
    аккаунт придётся логинить заново. Аккаунт должен быть выведен оттуда.
    """
    row = await db.fetchrow(
        "SELECT phone, session_path FROM tg_setup_accounts WHERE id=$1", account_id
    )
    if not row:
        raise HTTPException(404, "Аккаунт не найден")

    session_dir = Path(settings.tg_setup_sessions_dir)
    session_dir.mkdir(parents=True, exist_ok=True)
    target = Path(row["session_path"] or str(session_dir / row["phone"]))
    if target.suffix != ".session":
        target = target.with_suffix(".session")

    data = await file.read()
    if not data:
        raise HTTPException(400, "Пустой файл")
    target.write_bytes(data)
    # ⚠️ Файл содержит ключ авторизации аккаунта — читать его должен только root.
    target.chmod(0o600)

    base = str(target)[: -len(".session")]
    await db.execute(
        "UPDATE tg_setup_accounts SET session_path=$2, health='unknown', updated_at=NOW() "
        " WHERE id=$1", account_id, base,
    )
    return {"ok": True, "path": str(target), "size": len(data)}


# ─────────────────────────────────────────────────────────────────────────
# Подключение аккаунта: комплектом файлов или входом по коду
#
# ⚠️⚠️ ЛОГИКА ЖИВЁТ В `tg_account_connect`, а не здесь. Тот же механизм
# понадобится любому будущему разделу, который работает от имени живого
# аккаунта, — здесь только приём запроса и запись в нашу таблицу.
# ─────────────────────────────────────────────────────────────────────────
@router.post("/accounts/upload-bundle")
async def upload_bundle(files: list[UploadFile] = File(...),
                        admin=Depends(get_current_admin), db=Depends(get_db)):
    """Заводит аккаунты из комплекта файлов продавца (zip / .session / .json).

    ⚠️ Сразу ПРОВЕРЯЕМ живость сессии — иначе панель скажет «подключён» о
    мёртвом файле, и это вскроется только когда услуга упадёт на клиенте.

    ⚠️ Прокси берём у СУЩЕСТВУЮЩЕЙ записи, если номер уже заведён: иностранный
    номер без прокси не подключится вовсе (запрет в `connect`).
    """
    from app.services.tg_account_connect import session_is_alive, unpack_bundle

    payload = []
    for f in files:
        data = await f.read()
        if data:
            payload.append((f.filename or "file", data))
    if not payload:
        raise HTTPException(400, "Файлы не выбраны")

    bundles, errors = unpack_bundle(payload)
    if not bundles:
        raise HTTPException(
            400, "Не нашёл ни одного комплекта. " + ("; ".join(errors) or
                 "Нужен файл .session — один или внутри архива."))

    session_dir = Path(settings.tg_setup_sessions_dir)
    session_dir.mkdir(parents=True, exist_ok=True)
    results = []

    for b in bundles:
        row = await db.fetchrow(
            "SELECT id, proxy, twofa_password FROM tg_setup_accounts WHERE phone=$1",
            b.phone,
        )
        base = str(session_dir / b.phone)
        target = Path(base + ".session")
        # ⚠️ Сохраняем ДО проверки: проверка подключается именно этим файлом.
        target.write_bytes(b.session_bytes or b"")
        target.chmod(0o600)

        proxy = (row["proxy"] if row else None) or None
        alive, note = await session_is_alive(base, b.phone, proxy)

        if not alive:
            # ⚠️ Мёртвый файл НЕ оставляем: он молча занял бы место рабочего,
            # и очередь считала бы аккаунт настроенным.
            target.unlink(missing_ok=True)
            results.append({"phone": b.phone, "ok": False, "note": note})
            continue

        twofa = b.twofa or (row["twofa_password"] if row else None)
        if row:
            await db.execute(
                """UPDATE tg_setup_accounts
                      SET session_path=$2, health='unknown',
                          twofa_password=COALESCE($3, twofa_password),
                          title=COALESCE($4, title),
                          username=COALESCE($5, username),
                          updated_at=NOW()
                    WHERE id=$1""",
                row["id"], base, twofa, b.title, b.username,
            )
            account_id = row["id"]
        else:
            account_id = await db.fetchval(
                """INSERT INTO tg_setup_accounts
                       (phone, title, username, twofa_password, session_path,
                        max_slots, is_active, health)
                    VALUES ($1, $2, $3, $4, $5, 5, TRUE, 'unknown')
                 RETURNING id""",
                b.phone, b.title, b.username, twofa, base,
            )
        results.append({"phone": b.phone, "ok": True, "note": note,
                        "id": account_id, "twofa_found": bool(b.twofa)})

    return {"ok": True, "results": results, "errors": errors}


class LoginStart(BaseModel):
    phone: str
    proxy: Optional[str] = None


@router.post("/accounts/login/start")
async def login_start(data: LoginStart, admin=Depends(get_current_admin),
                      db=Depends(get_db)):
    """Шаг 1 входа по коду — Telegram присылает код на номер.

    ⚠️ Нужен, когда ключ сессии аннулирован: файлом такой аккаунт не вернуть,
    только входом с кодом из SMS.
    """
    from app.services.tg_account_connect import start_login

    phone = re.sub(r"\D", "", data.phone or "")
    if not phone:
        raise HTTPException(400, "Укажите телефон")

    row = await db.fetchrow(
        "SELECT id, proxy, session_path FROM tg_setup_accounts WHERE phone=$1",
        phone,
    )
    proxy = data.proxy or (row["proxy"] if row else None)
    base = (row["session_path"] if row else None) or str(
        Path(settings.tg_setup_sessions_dir) / phone)
    if base.endswith(".session"):
        base = base[: -len(".session")]

    try:
        # ⚠️ Telethon блокирующий — держим его вне цикла событий, иначе
        # на время ожидания кода встаёт весь API.
        import asyncio
        res = await asyncio.to_thread(start_login, phone, base, proxy)
    except Exception as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}")
    return res


class LoginStep(BaseModel):
    phone: str
    value: str


@router.post("/accounts/login/code")
async def login_code(data: LoginStep, admin=Depends(get_current_admin),
                     db=Depends(get_db)):
    """Шаг 2 — код из SMS. Может попросить облачный пароль."""
    import asyncio

    from app.services.tg_account_connect import confirm_code

    res = await asyncio.to_thread(confirm_code, data.phone, data.value)
    if res.get("status") == "ok":
        await _save_logged_in(db, res)
    return res


@router.post("/accounts/login/password")
async def login_password(data: LoginStep, admin=Depends(get_current_admin),
                         db=Depends(get_db)):
    """Шаг 3 — облачный пароль (двухфакторка)."""
    import asyncio

    from app.services.tg_account_connect import confirm_password

    res = await asyncio.to_thread(confirm_password, data.phone, data.value)
    if res.get("status") == "ok":
        # ⚠️ Пароль, которым только что вошли, СОХРАНЯЕМ: он же нужен для
        # передачи ботов клиентам, и второй раз его никто не вспомнит.
        await _save_logged_in(db, res, twofa=data.value)
    return res


@router.post("/accounts/login/cancel")
async def login_cancel(data: LoginStart, admin=Depends(get_current_admin)):
    """Бросить незаконченный вход (человек закрыл окно)."""
    import asyncio

    from app.services.tg_account_connect import cancel_login

    await asyncio.to_thread(cancel_login, data.phone)
    return {"ok": True}


async def _save_logged_in(db, res: dict, twofa: Optional[str] = None) -> None:
    """Записывает удачный вход: заводит аккаунт или обновляет существующий."""
    phone = res["phone"]
    base = str(Path(settings.tg_setup_sessions_dir) / phone)
    exists = await db.fetchval(
        "SELECT id FROM tg_setup_accounts WHERE phone=$1", phone)
    if exists:
        await db.execute(
            """UPDATE tg_setup_accounts
                  SET session_path=$2, health='unknown',
                      username=COALESCE($3, username),
                      title=COALESCE($4, title),
                      tg_user_id=COALESCE($5, tg_user_id),
                      twofa_password=COALESCE($6, twofa_password),
                      health_note='Вошли по коду из SMS',
                      updated_at=NOW()
                WHERE id=$1""",
            exists, base, res.get("username"), res.get("title"),
            res.get("tg_user_id"), twofa,
        )
    else:
        await db.execute(
            """INSERT INTO tg_setup_accounts
                   (phone, title, username, tg_user_id, twofa_password,
                    session_path, max_slots, is_active, health, health_note)
                VALUES ($1, $2, $3, $4, $5, $6, 5, TRUE, 'unknown',
                        'Вошли по коду из SMS')""",
            phone, res.get("title"), res.get("username"),
            res.get("tg_user_id"), twofa, base,
        )


@router.post("/accounts/{account_id}/check")
async def check_account(account_id: int,
                        admin=Depends(get_current_admin), db=Depends(get_db)):
    """Проверяет аккаунт вживую: жив ли, не под спам-блоком, сколько ботов."""
    row = await db.fetchrow("SELECT * FROM tg_setup_accounts WHERE id=$1", account_id)
    if not row:
        raise HTTPException(404, "Аккаунт не найден")

    acc = tgs.SetupAccount(
        id=row["id"], phone=row["phone"],
        twofa_password=row["twofa_password"] or "",
        proxy=row["proxy"] or "", session_path=row["session_path"] or "",
    )
    health = await tgs.check_health(acc)
    await db.execute(
        """UPDATE tg_setup_accounts
              SET health=$2, health_note=$3, health_checked_at=NOW(),
                  username=COALESCE(NULLIF($4,''), username),
                  -- ⚠️ ::bigint ОБЯЗАТЕЛЕН — см. пояснение в tasks/tg_setup.py:
                  -- без него asyncpg считает 0 за int32, а Telegram id длиннее.
                  tg_user_id=COALESCE(NULLIF($5::bigint, 0::bigint), tg_user_id),
                  updated_at=NOW()
            WHERE id=$1""",
        account_id, health.state, health.note, health.username, health.tg_user_id,
    )
    return {
        "ok": True,
        "health": health.state,
        "note": health.note,
        "username": health.username,
        "bots_count": health.bots_count,
    }


# ─────────────────────────────────────────────────────────────────────────
# Заказы
# ─────────────────────────────────────────────────────────────────────────
@router.get("/orders")
async def list_orders(admin=Depends(get_current_admin), db=Depends(get_db),
                      limit: int = 100):
    rows = await db.fetch(
        """SELECT so.*, c.name AS client_name, c.email AS client_email,
                  c.telegram_username, a.phone AS account_phone
             FROM service_orders so
             JOIN clients c ON c.id = so.client_id
        LEFT JOIN tg_setup_accounts a ON a.id = so.setup_account_id
            ORDER BY so.id DESC
            LIMIT $1""",
        min(limit, 500),
    )
    return {"orders": [dict(r) for r in rows]}


class ServiceIn(BaseModel):
    price: Optional[int] = None
    coming_soon: Optional[bool] = None
    is_active: Optional[bool] = None
    leadpay_product_id: Optional[str] = None
    prodamus_payment_url: Optional[str] = None
    require_feature: Optional[str] = None


@router.get("/services")
async def list_services(admin=Depends(get_current_admin), db=Depends(get_db)):
    rows = await db.fetch("SELECT * FROM services ORDER BY sort, id")
    return {"services": [dict(r) for r in rows]}


@router.patch("/services/{slug}")
async def update_service(slug: str, data: ServiceIn,
                         admin=Depends(get_current_admin), db=Depends(get_db)):
    """Правит услугу: цену, «скоро», карточку оплаты.

    ⚠️ `coming_soon` — тот самый рычаг «показывать без кнопки оплаты».
    Снял галочку → услуга начинает продаваться. Отдельного релиза не нужно.
    """
    fields, values = [], []
    for name in ("price", "coming_soon", "is_active", "leadpay_product_id",
                 "prodamus_payment_url", "require_feature"):
        value = getattr(data, name)
        if value is not None:
            values.append(value)
            fields.append(f"{name} = ${len(values) + 1}")
    if not fields:
        return {"ok": True, "unchanged": True}
    await db.execute(
        f"UPDATE services SET {', '.join(fields)}, updated_at=NOW() WHERE slug=$1",
        slug, *values,
    )
    return {"ok": True}


@router.post("/orders/{order_id}/retry")
async def retry_order(order_id: int,
                      admin=Depends(get_current_admin), db=Depends(get_db)):
    """Возвращает заказ в очередь — когда сорвалось по нашей вине."""
    order = await db.fetchrow("SELECT * FROM service_orders WHERE id=$1", order_id)
    if not order:
        raise HTTPException(404, "Заказ не найден")
    if order["status"] != "paid":
        raise HTTPException(400, "Заказ не оплачен")
    await db.execute(
        """UPDATE service_orders
              SET setup_state='queued', setup_error=NULL, setup_account_id=NULL,
                  updated_at=NOW()
            WHERE id=$1""",
        order_id,
    )
    return {"ok": True}


@router.post("/orders/{order_id}/mark-paid")
async def mark_paid(order_id: int,
                    admin=Depends(get_current_admin), db=Depends(get_db)):
    """Отмечает заказ оплаченным вручную — для теста и для оплаты мимо кассы."""
    order = await db.fetchrow("SELECT * FROM service_orders WHERE id=$1", order_id)
    if not order:
        raise HTTPException(404, "Заказ не найден")
    next_state = "queued" if order["bot_username"] else "new"
    await db.execute(
        """UPDATE service_orders
              SET status='paid', paid_at=COALESCE(paid_at, NOW()),
                  payment_provider='manual', setup_state=$2, updated_at=NOW()
            WHERE id=$1""",
        order_id, next_state,
    )
    return {"ok": True, "setup_state": next_state}
