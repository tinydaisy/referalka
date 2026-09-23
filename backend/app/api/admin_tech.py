"""Управление тех-специалистами — админская часть (миграция 391).

Заведение людей, ставки, распределение клиентов, отметка выплат.

⚠️ Всё под `get_current_admin`: это деньги и чужие клиенты. Сам специалист сюда
не ходит — у него свой кабинет (`tech_cabinet.py`).
"""

from __future__ import annotations

import logging
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth import get_current_admin
from app.database import get_db
from app.services.tech_accruals import (
    assign_client, REFERRER_SPEC_SQL, PAYING_SQL, TRIAL_SQL,
    CRM_CASE_SQL, CRM_STATUSES,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/tech", tags=["Админ: тех-специалисты"])

# ⚠️ Генератора паролей здесь больше нет (миграция 486): своего пароля у
# внедренца не существует, он входит паролем своего кабинета клиента.


class SpecIn(BaseModel):
    """⚠️⚠️ Внедренца ЗАВОДЯТ ИЗ КЛИЕНТОВ (миграция 486), а не вводят почтой.

    Почты, пароля, имени, телефона и телеграма здесь больше нет — они живут в
    `clients`. Внедренец всегда сначала клиент: кабинет клиента — его же
    рабочий инструмент, и ссылки для приглашений он берёт оттуда.
    """
    client_id: Optional[int] = None
    can_edit_materials: Optional[bool] = None
    # Право удалять вопросы из общей базы частых вопросов (мигр. 461).
    can_delete_faq: Optional[bool] = None
    # ⚠️ Два РАЗНЫХ состояния (миграция 403), не путать:
    #   `is_active`     — работает ли вообще. FALSE = уволился: кабинет закрыт.
    #   `takes_clients` — берёт ли НОВЫХ клиентов. FALSE = отпуск или перегруз:
    #                     кабинет и начисления остаются, распределение не идёт.
    is_active: Optional[bool] = None
    takes_clients: Optional[bool] = None


class AssignIn(BaseModel):
    client_id: int
    # None = снять закрепление (клиент становится ничьим).
    spec_id: Optional[int] = None
    reason: Optional[str] = None


@router.get("/specialists", summary="Список тех-специалистов")
async def list_specs(
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Кто есть и сколько на ком висит.

    ⚠️ Считаем и клиентов, и НЕВЫПЛАЧЕННОЕ: это две цифры, ради которых сюда
    заходят. Без второй пришлось бы открывать каждого по очереди.
    """
    # ⚠️ Почта, имя, телефон и телеграм берутся ИЗ КЛИЕНТА (миграция 486):
    # внедренец — роль над клиентом, своих копий этих полей у него нет.
    rows = await db.fetch(
        """SELECT ts.id, ts.client_id,
                  c.email, c.name, c.phone, c.telegram_username,
                  ts.can_edit_materials, ts.can_delete_faq, ts.is_active, ts.takes_clients,
                  ts.last_login_at, ts.created_at,
                  (SELECT COUNT(*) FROM clients c
                    WHERE c.tech_specialist_id = ts.id) AS clients_count,
                  (SELECT COUNT(*) FROM clients c
                    WHERE c.tech_specialist_id = ts.id
                      AND EXISTS (SELECT 1 FROM client_subscriptions cs
                                   WHERE cs.id = c.current_subscription_id
                                     AND cs.status='active' AND cs.expires_at > NOW()
                                     AND cs.source='paid')) AS paying_count,
                  (SELECT COALESCE(SUM(a.amount_kopecks),0) FROM tech_accruals a
                    WHERE a.spec_id = ts.id AND a.paid_at IS NULL) AS unpaid_kopecks
             FROM tech_specialists ts
             JOIN clients c ON c.id = ts.client_id
            -- ⚠️ Сверху те, кто реально берёт клиентов; ниже — работающие, но
            -- в отпуске; в самом низу уволенные. Иначе человек в отпуске
            -- стоит вперемешку с действующими, и его назначают.
            ORDER BY ts.is_active DESC, ts.takes_clients DESC, c.name, ts.id"""
    )
    return {"specialists": [dict(r) for r in rows]}


@router.post("/specialists", summary="Сделать клиента внедренцем")
async def create_spec(
    data: SpecIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Выдаёт клиенту роль внедренца (миграция 486).

    ⚠️⚠️ ПАРОЛЯ ЗДЕСЬ НЕ ВЫДАЁТСЯ ВОВСЕ. Человек входит на `/tech/login` своей
    клиентской почтой и своим клиентским паролём — третьего пароля в системе
    больше нет. Прежняя схема (своя почта + сгенерированный пароль) отменена:
    у одного человека выходило два пароля и две почты.
    """
    if not data.client_id:
        raise HTTPException(400, "Выберите клиента")

    client = await db.fetchrow(
        "SELECT id, name, email, is_active FROM clients WHERE id = $1",
        data.client_id)
    if not client:
        raise HTTPException(404, "Такого клиента нет")
    if not client["is_active"]:
        raise HTTPException(400, "Кабинет этого клиента заблокирован — "
                                 "внедренцем его сделать нельзя")

    # ⚠️ Одна роль на клиента: `client_id` уникален (486/488). Проверяем заранее,
    # чтобы отдать понятный текст вместо 500 от нарушенного ограничения.
    if await db.fetchval("SELECT 1 FROM tech_specialists WHERE client_id = $1",
                         data.client_id):
        raise HTTPException(409, "Этот клиент уже внедренец")

    row = await db.fetchrow(
        """INSERT INTO tech_specialists (client_id, can_edit_materials)
           VALUES ($1, COALESCE($2, FALSE))
           RETURNING id, client_id, can_edit_materials, is_active, takes_clients""",
        data.client_id, data.can_edit_materials,
    )
    return {**dict(row), "name": client["name"], "email": client["email"]}


@router.patch("/specialists/{spec_id}", summary="Изменить тех-специалиста")
async def update_spec(
    spec_id: int,
    data: SpecIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    # ⚠️ Пишем только присланное: форма может слать часть полей, и не
    # присланное должно остаться прежним, а не обнулиться.
    #
    # ⚠️ Имени, телефона и телеграма здесь НЕТ (миграция 486) — это данные
    # человека, он правит их сам в своём кабинете клиента. Менять их отсюда
    # значило бы держать вторую копию и расходиться с ней.
    fs = data.model_fields_set
    sets, args = [], []
    for col in ("can_edit_materials", "can_delete_faq", "is_active", "takes_clients"):
        if col in fs:
            args.append(getattr(data, col))
            sets.append(f"{col} = ${len(args)}")
    if not sets:
        raise HTTPException(400, "Нечего менять")
    args.append(spec_id)
    row = await db.fetchrow(
        f"UPDATE tech_specialists SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(args)} RETURNING *",
        *args,
    )
    if not row:
        raise HTTPException(404, "Не найден")

    # ⚠️⚠️ УВОЛЬНЕНИЕ ЗАКРЫВАЕТ ПОДАРЕННУЮ ПОДПИСКУ (решение владельца
    # 22.09.2026). Кабинет клиента внедренцу дарится как рабочий инструмент —
    # уволился, значит инструмент больше не нужен.
    #
    # ⚠️ ПЛАТНУЮ (`source='paid'`) НЕ ТРОГАЕМ: за неё человек заплатил своими
    # деньгами, и закрыть её значило бы отобрать оплаченное. Он остаётся
    # клиентом и дорабатывает оплаченный срок.
    #
    # ⚠️ Различаем именно по `source`, а не по наличию заказа: подаренная
    # подписка — `admin` (выдал владелец) или `trial`, и это единственный
    # надёжный признак «не покупал».
    closed_subscription = None
    if "is_active" in fs and data.is_active is False:
        closed = await db.fetchrow(
            """UPDATE client_subscriptions cs
                  SET status = 'expired', expires_at = NOW(), updated_at = NOW()
                 FROM tech_specialists ts
                WHERE ts.id = $1
                  AND cs.id = (SELECT current_subscription_id FROM clients
                                WHERE id = ts.client_id)
                  AND cs.status = 'active'
                  AND cs.source IN ('admin', 'trial')
              RETURNING cs.id, cs.source""",
            spec_id,
        )
        if closed:
            closed_subscription = dict(closed)

    return {**dict(row), "closed_subscription": closed_subscription}


@router.delete("/specialists/{spec_id}", summary="Удалить тех-специалиста")
async def delete_spec(
    spec_id: int,
    force: bool = Query(False, description="Удалить вместе с историей начислений"),
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Снимает с клиента роль внедренца насовсем.

    ⚠️ Удаляется РОЛЬ, а не человек (миграция 486): кабинет клиента, его база и
    подписка остаются нетронутыми — он просто перестаёт быть внедренцем.

    ⚠️⚠️ У `tech_accruals` стоит ON DELETE CASCADE — удаление УНЕСЁТ ВСЮ ЕГО
    ИСТОРИЮ НАЧИСЛЕНИЙ. Это деньги: сколько человеку начислено и что из этого
    выплачено. Восстановить её нельзя ничем.

    Поэтому: есть начисления → по умолчанию 409 с их числом и суммой, и
    предложение отключить вместо удаления (`is_active = FALSE` — кабинет
    закрыт, история цела). Удалить всё равно можно, но осознанно — `force=true`.

    Клиенты не теряются: `clients.tech_specialist_id` объявлен ON DELETE SET
    NULL, они просто становятся нераспределёнными.
    """
    # ⚠️ Почта и имя — из клиента (миграция 486).
    spec = await db.fetchrow(
        """SELECT ts.id, c.email, c.name FROM tech_specialists ts
             JOIN clients c ON c.id = ts.client_id
            WHERE ts.id = $1""", spec_id)
    if not spec:
        raise HTTPException(404, "Не найден")

    stats = await db.fetchrow(
        """SELECT COUNT(*) AS cnt, COALESCE(SUM(amount_kopecks), 0) AS total
             FROM tech_accruals WHERE spec_id = $1""",
        spec_id,
    )
    accruals = int(stats["cnt"] or 0)

    if accruals and not force:
        raise HTTPException(409, detail={
            "error": "has_accruals",
            "accruals": accruals,
            "total_kopecks": int(stats["total"] or 0),
            "message": (
                f"У этого человека {accruals} начислений — удаление сотрёт всю "
                f"историю выплат. Лучше отключите его: кабинет закроется, "
                f"а история останется."
            ),
        })

    # Сколько клиентов осиротеет — вернём в ответе, чтобы их сразу перераспределили.
    freed = await db.fetchval(
        "SELECT COUNT(*) FROM clients WHERE tech_specialist_id = $1", spec_id)

    await db.execute("DELETE FROM tech_specialists WHERE id=$1", spec_id)
    return {"ok": True, "deleted_accruals": accruals,
            "freed_clients": int(freed or 0)}


@router.post("/specialists/{spec_id}/reset-password", summary="Пароля у внедренца нет")
async def reset_password(
    spec_id: int,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """⚠️⚠️ Своего пароля у внедренца БОЛЬШЕ НЕТ (миграция 486).

    Он входит клиентским паролём и меняет его сам в своём кабинете, а забыл —
    восстанавливает обычным «Забыли пароль?» на /login. Ручка оставлена, чтобы
    старая кнопка в админке отвечала внятным текстом, а не 500 по дропнутой
    колонке `password_hash`.
    """
    row = await db.fetchrow(
        """SELECT c.email FROM tech_specialists ts
             JOIN clients c ON c.id = ts.client_id
            WHERE ts.id = $1""",
        spec_id)
    if not row:
        raise HTTPException(404, "Не найден")
    raise HTTPException(400, detail=(
        f"У внедренца нет отдельного пароля — он входит паролем своего кабинета "
        f"клиента ({row['email']}). Забыл пароль — пусть восстановит его на "
        f"pluson.ru/password-reset, и этот же пароль подойдёт на /tech/login."
    ))


@router.post("/assign", summary="Закрепить клиента за специалистом")
async def assign(
    data: AssignIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Передача клиента. ⚠️ Начисления с этого момента идут НОВОМУ (решение
    владельца), уже начисленное прежнему остаётся — оно за сделанную работу."""
    if data.spec_id is not None:
        # ⚠️⚠️ Проверяем ОБА флага (миграция 403), и они про разное:
        #   `is_active`     — работает ли человек вообще (уволился → FALSE);
        #   `takes_clients` — берёт ли НОВЫХ (отпуск, перегруз → FALSE).
        # Раньше состояние было одно, и «отправить в отпуск» означало закрыть
        # человеку кабинет вместе с его начислениями.
        #
        # ⚠️ На НАЗНАЧЕНИЕ ДИАЛОГА это правило НЕ распространяется (ниже по
        # файлу): переписку можно отдать и тому, кто новых клиентов не берёт —
        # он продолжает вести своих.
        row = await db.fetchrow(
            "SELECT is_active, takes_clients FROM tech_specialists WHERE id=$1",
            data.spec_id)
        if not row or not row["is_active"]:
            raise HTTPException(400, "Такого тех-специалиста нет или он уволен")
        if not row["takes_clients"]:
            raise HTTPException(
                400, "Этот специалист сейчас не берёт новых клиентов "
                     "(отпуск или загрузка). Снимите отметку в его карточке "
                     "или выберите другого.")
    await assign_client(db, client_id=data.client_id,
                        spec_id=data.spec_id, reason=data.reason or "")
    return {"ok": True}


@router.get("/unassigned", summary="Клиенты для распределения")
async def unassigned(
    scope: str = "free",
    q: str = "",
    spec_id: Optional[int] = None,
    # ⚠️ Страницы по 50 (23.09.2026). Раньше стоял глухой `LIMIT 500` без
    # смещения: на тысяче клиентов вторая половина была недостижима вовсе —
    # ни поиском, ни прокруткой. Отдаём `total`, чтобы кнопки знали, где конец.
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Кого распределяем.

    ⚠️ Показываем ВСЕХ без ответственного, включая остывших: среди них как раз и
    ищут, кого можно оживить, а спрятанные они не попадутся никому на глаза.

    ⚠️⚠️ ПЕРЕЗАКРЕПЛЕНИЕ (18.09.2026). Раньше отдавались ТОЛЬКО клиенты без
    ответственного, и уже закреплённого нельзя было передать другому: его не
    было в списке. Сам движок (`assign_client`) перезакрепление умел всегда —
    не хватало ровно этого списка. Административные решения бывают разные:
    внедренец уволился, ушёл в отпуск, клиента забрали на другого — передать
    надо уметь в любой момент, а не только при первом распределении.

    `scope`: `free` — без ответственного (как было, умолчание),
             `busy` — уже закреплённые, `all` — все.
    `q` — поиск по имени, почте и телеграму. `spec_id` — чьих показывать.
    """
    scope = scope if scope in ("free", "busy", "all") else "free"
    # ⚠️ Условие и параметры собираются ВМЕСТЕ: при сборке строки отдельно от
    # значений легко разъезжаются номера $1/$2 — и запрос молча фильтрует не по
    # тому полю.
    where = ["c.is_active", "NOT c.is_system_service", "NOT c.is_tech_test"]
    args: list = []
    if scope == "free":
        where.append("c.tech_specialist_id IS NULL")
    elif scope == "busy":
        where.append("c.tech_specialist_id IS NOT NULL")
    if spec_id is not None:
        args.append(spec_id)
        where.append(f"c.tech_specialist_id = ${len(args)}")
    if (q or "").strip():
        args.append(f"%{q.strip()}%")
        n = len(args)
        where.append(
            # ⚠️ И по ФАМИЛИИ (23.09.2026): у клиента она отдельным полем, и
            # поиск по ней не находил ничего.
            f"(c.name ILIKE ${n} OR c.last_name ILIKE ${n}"
            f" OR c.email ILIKE ${n} OR c.telegram_username ILIKE ${n})")

    rows = await db.fetch(
        # ⚠️ «Привёл» отдаём ВМЕСТЕ со списком: при передаче админ должен
        # видеть, кому пойдут деньги. Ответственный (кого выбираем здесь) и
        # приведший — РАЗНЫЕ люди: передача отдаёт новому фикс за обслуживание,
        # а 10 % пожизненно остаются у приведшего и не переезжают никогда.
        # Без этой подписи передача выглядит так, будто отдаёт клиента целиком.
        # ⚠️ Приведший ищется по КЛИЕНТСКОЙ реф-ссылке, а его имя берётся из
        # клиента: колонка `referred_by_tech_id` дропнута, своего имени у роли
        # внедренца нет (миграции 486–487).
        # ⚠️ Фамилия отдаётся ОТДЕЛЬНЫМ полем (23.09.2026): искали по ней уже
        # давно, а в списке её не было — человека находишь, но проверить, тот
        # ли это Иванов, нечем. У клиента имя и фамилия лежат раздельно.
        """SELECT c.id, c.name, c.last_name, c.email, c.telegram_username, c.created_at,
                  t.slug AS tariff_slug, cs.expires_at, cs.source AS sub_source,
                  ref.id AS referred_by_tech_id,
                  refc.name AS referred_by_name,
                  c.tech_specialist_id,
                  ownc.name AS owner_name,
                  c.tech_assigned_at,
                  (SELECT COUNT(*) FROM subscription_orders so
                    WHERE so.client_id = c.id AND so.status='paid'
                      AND so.amount_paid_card_kopecks > 0) AS payments_count
             FROM clients c
             LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
             LEFT JOIN tariffs t ON t.id = cs.tariff_id
             LEFT JOIN tech_specialists ref ON ref.client_id = c.referred_by_client_id
             LEFT JOIN clients refc ON refc.id = ref.client_id
             LEFT JOIN tech_specialists own ON own.id = c.tech_specialist_id
             LEFT JOIN clients ownc ON ownc.id = own.client_id
            -- ⚠️ Тестовые кабинеты самих техспецов (миграция 403) в
            -- распределение не идут: их брали в работу как живых лидов и
            -- пытались оживить.
            WHERE """ + " AND ".join(where) + f"""
            ORDER BY c.created_at DESC
            LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}""",
        *args, limit, offset,
    )
    # ⚠️ Общее число считаем ТЕМ ЖЕ условием, но без сортировки и джойнов:
    # они нужны только для показа строк, а на счёт не влияют. Без `total`
    # кнопка «вперёд» не знает, есть ли следующая страница.
    total = await db.fetchval(
        "SELECT COUNT(*) FROM clients c WHERE " + " AND ".join(where), *args)
    return {"clients": [dict(r) for r in rows], "total": int(total or 0),
            "limit": limit, "offset": offset}


@router.get("/crm", summary="Сводная CRM: клиенты всех внедренцев")
async def crm(
    spec_id: Optional[int] = None,
    status: Optional[str] = None,
    q: str = "",
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Клиенты платформы одним списком — с фильтром по внедренцу (23.09.2026).

    ⚠️ Это ТОТ ЖЕ экран, что «Мои клиенты» в кабинете внедренца, только без
    ограничения «мои». Владелец смотрит всю базу разом, а `spec_id` сужает её
    до одного человека — так из карточки внедренца попадают в его срез, не
    заходя в чужой кабинет.

    ⚠️⚠️ Воронка и «платит» берутся из ОБЩЕГО модуля (`tech_accruals`), а не
    считаются здесь заново: те же выражения считают деньги и показывают
    кабинет внедренца. Своя копия разошлась бы с ними молча.

    ⚠️ Без `spec_id` показываем ВСЕХ, включая ничьих: «у кого нет
    ответственного» — это тоже ответ, и его должно быть видно.
    """
    args: list = []
    where = ["c.is_active", "NOT c.is_system_service", "NOT c.is_tech_test"]

    if spec_id is not None:
        args.append(spec_id)
        n = len(args)
        # ⚠️ И закреплённые, и приведённые ЛИЧНО: внедренцу принадлежат обе
        # группы, и в его срезе должны быть обе. По одному признаку человек
        # увидел бы половину своей работы.
        where.append(f"(c.tech_specialist_id = ${n} OR {REFERRER_SPEC_SQL} = ${n})")

    if (q or "").strip():
        args.append(f"%{q.strip()}%")
        n = len(args)
        where.append(f"(c.name ILIKE ${n} OR c.last_name ILIKE ${n}"
                     f" OR c.email ILIKE ${n} OR c.telegram_username ILIKE ${n})")

    if status == "paying":
        where.append(PAYING_SQL)
    elif status == "trial":
        where.append(TRIAL_SQL)
    elif status == "cold":
        where.append(f"NOT {PAYING_SQL} AND NOT {TRIAL_SQL}")
    elif status in CRM_STATUSES:
        args.append(status)
        where.append(f"({CRM_CASE_SQL}) = ${len(args)}")

    cond = " AND ".join(where)

    rows = await db.fetch(
        f"""SELECT c.id, c.name, c.last_name, c.email, c.telegram_username,
                   c.created_at, c.tech_assigned_at,
                   t.slug AS tariff_slug, t.name AS tariff_name,
                   cs.expires_at, cs.source AS sub_source,
                   {PAYING_SQL} AS is_paying,
                   ({CRM_CASE_SQL}) AS crm_status,
                   -- Ответственный и приведший — РАЗНЫЕ люди и разные деньги:
                   -- первому идёт фикс за обслуживание, второму 10 % навсегда.
                   c.tech_specialist_id,
                   ownc.name AS owner_name,
                   {REFERRER_SPEC_SQL} AS referrer_spec_id,
                   refc.name AS referrer_name,
                   (SELECT COUNT(*) FROM subscription_orders so
                     WHERE so.client_id = c.id AND so.status='paid'
                       AND so.amount_paid_card_kopecks > 0) AS payments_count,
                   (SELECT COALESCE(SUM(so.amount_paid_card_kopecks),0)
                      FROM subscription_orders so
                     WHERE so.client_id = c.id AND so.status='paid')
                     AS total_paid_kopecks,
                   (SELECT MAX(so.paid_at) FROM subscription_orders so
                     WHERE so.client_id = c.id AND so.status='paid') AS last_paid_at
              FROM clients c
              LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
              LEFT JOIN tariffs t ON t.id = cs.tariff_id
              LEFT JOIN tech_specialists own ON own.id = c.tech_specialist_id
              LEFT JOIN clients ownc ON ownc.id = own.client_id
              LEFT JOIN tech_specialists refs
                     ON refs.client_id = c.referred_by_client_id
              LEFT JOIN clients refc ON refc.id = refs.client_id
             WHERE {cond}
             ORDER BY c.created_at DESC
             LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}""",
        *args, limit, offset,
    )

    total = await db.fetchval(
        f"SELECT COUNT(*) FROM clients c WHERE {cond}", *args)

    # Сводка по воронке — теми же условиями, что и список. Показывает, из чего
    # складывается выбранный срез, не открывая каждую строку.
    funnel = await db.fetchrow(
        f"""SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE ({CRM_CASE_SQL}) = 'trial') AS trial,
                   COUNT(*) FILTER (WHERE ({CRM_CASE_SQL}) = 'activated') AS activated,
                   COUNT(*) FILTER (WHERE ({CRM_CASE_SQL}) = 'retained') AS retained,
                   COUNT(*) FILTER (WHERE ({CRM_CASE_SQL}) = 'revived') AS revived,
                   COUNT(*) FILTER (WHERE ({CRM_CASE_SQL}) = 'churned') AS churned,
                   COUNT(*) FILTER (WHERE ({CRM_CASE_SQL}) = 'lead') AS lead,
                   COUNT(*) FILTER (WHERE {PAYING_SQL}) AS paying
              FROM clients c WHERE {cond}""",
        *args)

    # ── Вид «блоками»: люди, разложенные по этапам воронки ───────────────
    # ⚠️ ОДНИМ запросом на все этапы, а не шестью по одному: шесть запросов
    # к одной и той же выборке — это шесть проходов по базе ради разбиения,
    # которое умеет сделать сам SQL.
    #
    # ⚠️ В каждом блоке НЕ БОЛЬШЕ 100 человек (`rn <= 100`): на лидах их
    # сотни, и полный список превратил бы страницу в мегабайт JSON. Счётчик
    # блока при этом честный — он из `funnel`, а не из длины списка.
    board_rows = await db.fetch(
        f"""SELECT * FROM (
              SELECT ({CRM_CASE_SQL}) AS crm_status,
                     c.id, c.name, c.last_name, c.email, c.telegram_username,
                     t.name AS tariff_name, cs.expires_at,
                     ownc.name AS owner_name,
                     refc.name AS referrer_name,
                     (SELECT COUNT(*) FROM subscription_orders so
                       WHERE so.client_id = c.id AND so.status='paid'
                         AND so.amount_paid_card_kopecks > 0) AS payments_count,
                     ROW_NUMBER() OVER (PARTITION BY ({CRM_CASE_SQL})
                                        ORDER BY c.created_at DESC) AS rn
                FROM clients c
                LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
                LEFT JOIN tariffs t ON t.id = cs.tariff_id
                LEFT JOIN tech_specialists own ON own.id = c.tech_specialist_id
                LEFT JOIN clients ownc ON ownc.id = own.client_id
                LEFT JOIN tech_specialists refs
                       ON refs.client_id = c.referred_by_client_id
                LEFT JOIN clients refc ON refc.id = refs.client_id
               WHERE {cond}
            ) b WHERE b.rn <= 100""",
        *args)

    # ── Лиды: зашли в бот ПЛЮСОНа, но кабинет не завели ──────────────────
    # ⚠️⚠️ ЛИД — ЭТО КОНТАКТ, А НЕ КЛИЕНТ (решение владельца 23.09.2026).
    # Он в базе подписчиков сервисного кабинета (`@pluson_bot` и боты ВК/MAX),
    # а среди `clients` его нет вовсе — кабинет он и не заводил. Поэтому лиды
    # собираются ОТДЕЛЬНЫМ запросом: в общий, который идёт по `clients`, они
    # физически не попадают.
    #
    # ⚠️ Отбираем только тех, кто заходил в БОТ (telegram/vk/max): контакт
    # мог появиться из импорта или формы, и называть такого «зашёл в бот»
    # неверно.
    #
    # ⚠️ «Кабинет не завёл» = нет клиента с той же почтой. Сравниваем
    # `LOWER(TRIM(...))`, как в `plusson_match`: регистр расходится постоянно.
    lead_rows = await db.fetch(
        """SELECT ct.id, ct.name, ct.phone,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = ct.id AND pe.platform_slug = 'email'
                    LIMIT 1) AS email,
                  (SELECT array_agg(DISTINCT pb.platform_slug)
                     FROM platform_users pb
                    WHERE pb.contact_id = ct.id
                      AND pb.platform_slug IN ('telegram','vk','max')) AS platforms,
                  ct.created_at
             FROM contacts ct
            WHERE ct.client_id = (SELECT id FROM clients
                                   WHERE is_system_service LIMIT 1)
              AND EXISTS (SELECT 1 FROM platform_users pu
                           WHERE pu.contact_id = ct.id
                             AND pu.platform_slug IN ('telegram','vk','max'))
              AND NOT EXISTS (
                    SELECT 1 FROM clients cl
                     WHERE LOWER(TRIM(cl.email)) = LOWER(TRIM((
                           SELECT pe2.platform_user_id FROM platform_users pe2
                            WHERE pe2.contact_id = ct.id
                              AND pe2.platform_slug = 'email' LIMIT 1))))
            ORDER BY ct.created_at DESC
            LIMIT 100""")
    leads = [dict(r) for r in lead_rows]
    leads_total = await db.fetchval(
        """SELECT COUNT(*) FROM contacts ct
            WHERE ct.client_id = (SELECT id FROM clients
                                   WHERE is_system_service LIMIT 1)
              AND EXISTS (SELECT 1 FROM platform_users pu
                           WHERE pu.contact_id = ct.id
                             AND pu.platform_slug IN ('telegram','vk','max'))
              AND NOT EXISTS (
                    SELECT 1 FROM clients cl
                     WHERE LOWER(TRIM(cl.email)) = LOWER(TRIM((
                           SELECT pe2.platform_user_id FROM platform_users pe2
                            WHERE pe2.contact_id = ct.id
                              AND pe2.platform_slug = 'email' LIMIT 1))))""")

    board: dict[str, list] = {s: [] for s in CRM_STATUSES}
    for r in board_rows:
        d = dict(r)
        d.pop("rn", None)
        board.setdefault(d["crm_status"], []).append(d)

    # ⚠️ Лиды кладём в ту же доску: на экране это такая же колонка, просто
    # люди в ней другой природы (контакты, а не клиенты).
    board["lead"] = leads
    f = dict(funnel) if funnel else {}
    f["lead"] = int(leads_total or 0)
    # ⚠️ «Всего» считаем ВМЕСТЕ с лидами: иначе проценты в колонках врут —
    # база воронки без её первой ступени.
    f["total"] = int(f.get("total") or 0) + int(leads_total or 0)

    return {
        "clients": [dict(r) for r in rows],
        "total": int(total or 0),
        "limit": limit, "offset": offset,
        "funnel": f,
        "board": board,
    }


@router.get("/rates", summary="Ставки начислений")
async def get_rates(
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    # ⚠️⚠️ КАЖДЫЙ СПРАВОЧНИК ЧИТАЕТСЯ ОТДЕЛЬНО И ПАДЕНИЕ ОДНОГО НЕ УНОСИТ
    # ОСТАЛЬНЫЕ. Иначе выходит так: код выкатили, миграцию ещё не накатили —
    # `SELECT` по отсутствующей таблице роняет ВЕСЬ эндпоинт, и в админке
    # пропадают не только новые вилки, но и ставки с фиксом, которые есть.
    # Экран настроек должен показывать то, что уже работает, а не гаснуть
    # целиком из-за того, чего пока нет.
    # ⚠️ Каждый справочник — в СВОЁМ вложенном блоке (SAVEPOINT). Без него
    # первая же ошибка переводит транзакцию в состояние aborted, и следующие
    # запросы падают с «current transaction is aborted» — даже по таблицам,
    # которые существуют и права на которые есть.
    async def _safe(sql: str) -> list:
        try:
            async with db.transaction():
                return [dict(r) for r in await db.fetch(sql)]
        except asyncpg.PostgresError as e:          # нет таблицы / нет прав
            logger.warning("admin_tech: справочник недоступен (%s): %s", sql, e)
            return []

    rows = await _safe("SELECT * FROM tech_rates ORDER BY id")
    fix = await _safe("SELECT * FROM tech_fix_tiers ORDER BY clients_from")
    settings = await _safe("SELECT * FROM tech_settings ORDER BY key")
    qual = await _safe(
        "SELECT * FROM tech_qualification_tiers ORDER BY turnover_from")
    fund = await _safe("SELECT * FROM tech_fund_tiers ORDER BY profit_from")
    return {
        "rates": rows,
        "fix_tiers": fix,
        "qualification_tiers": qual,
        "fund_tiers": fund,
        "settings": settings,
    }


# ── Редактирование вилок ─────────────────────────────────────────────────
# ⚠️ Вилки правятся в админке, а не миграцией: лист «Ставки» прямо говорит —
# это единственное место, где меняются цифры, и правка не должна требовать
# выкатки.

class TierIn(BaseModel):
    id: Optional[int] = None
    range_from: int
    range_to: int
    value: float          # ₽ для фикса, % для квалификации и фонда
    note: Optional[str] = None


_TIERS = {
    "fix":           ("tech_fix_tiers", "clients_from", "clients_to", "amount_kopecks"),
    "qualification": ("tech_qualification_tiers", "turnover_from", "turnover_to", "percent"),
    "fund":          ("tech_fund_tiers", "profit_from", "profit_to", "percent"),
}


@router.post("/tiers/{kind}", summary="Добавить или изменить ступень")
async def set_tier(
    kind: str,
    data: TierIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    if kind not in _TIERS:
        raise HTTPException(404, "Нет такой вилки")
    table, c_from, c_to, c_val = _TIERS[kind]
    # Фикс хранит копейки, остальные — проценты.
    value = int(data.value * 100) if kind == "fix" else data.value
    if data.id:
        row = await db.fetchrow(
            f"""UPDATE {table} SET {c_from}=$1, {c_to}=$2, {c_val}=$3, note=$4
                 WHERE id=$5 RETURNING *""",
            data.range_from, data.range_to, value, data.note, data.id)
        if not row:
            raise HTTPException(404, "Ступень не найдена")
    else:
        row = await db.fetchrow(
            f"""INSERT INTO {table} ({c_from}, {c_to}, {c_val}, note)
                 VALUES ($1,$2,$3,$4) RETURNING *""",
            data.range_from, data.range_to, value, data.note)
    return dict(row)


@router.delete("/tiers/{kind}/{tier_id}", summary="Удалить ступень")
async def del_tier(
    kind: str, tier_id: int,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    if kind not in _TIERS:
        raise HTTPException(404, "Нет такой вилки")
    table = _TIERS[kind][0]
    await db.execute(f"DELETE FROM {table} WHERE id = $1", tier_id)
    return {"ok": True}


class RateIn(BaseModel):
    amount_kopecks: Optional[int] = None
    percent: Optional[float] = None
    is_active: Optional[bool] = None


@router.patch("/rates/{kind}", summary="Изменить ставку")
async def set_rate(
    kind: str,
    data: RateIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """⚠️ Новая ставка действует ВПЕРЁД: уже начисленное не пересчитывается.
    Пересчёт задним числом менял бы суммы, о которых с человеком договорились."""
    fs = data.model_fields_set
    sets, args = [], []
    for col in ("amount_kopecks", "percent", "is_active"):
        if col in fs:
            args.append(getattr(data, col))
            sets.append(f"{col} = ${len(args)}")
    if not sets:
        raise HTTPException(400, "Нечего менять")
    args.append(kind)
    row = await db.fetchrow(
        f"UPDATE tech_rates SET {', '.join(sets)}, updated_at=NOW() "
        f"WHERE kind = ${len(args)} RETURNING *",
        *args,
    )
    if not row:
        raise HTTPException(404, "Нет такой ставки")
    return dict(row)


@router.get("/accruals", summary="Начисления всех специалистов")
async def all_accruals(
    spec_id: Optional[int] = Query(None),
    period: Optional[str] = Query(None),
    unpaid: Optional[bool] = Query(None),
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    args: list = []
    where = ["TRUE"]
    if spec_id:
        args.append(spec_id); where.append(f"a.spec_id = ${len(args)}")
    if period:
        args.append(period); where.append(f"a.period = ${len(args)}")
    if unpaid:
        where.append("a.paid_at IS NULL")

    rows = await db.fetch(
        # ⚠️ Имя внедренца — из его клиента (миграция 486).
        f"""SELECT a.*, sc.name AS spec_name, c.name AS client_name
              FROM tech_accruals a
              JOIN tech_specialists ts ON ts.id = a.spec_id
              JOIN clients sc ON sc.id = ts.client_id
              LEFT JOIN clients c ON c.id = a.client_id
             WHERE {' AND '.join(where)}
             ORDER BY a.created_at DESC LIMIT 1000""",
        *args,
    )
    return {"accruals": [dict(r) for r in rows]}


class PayIn(BaseModel):
    ids: list[int]


@router.post("/accruals/mark-paid", summary="Отметить выплаченными")
async def mark_paid(
    data: PayIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """⚠️ Отметка, а не перевод денег: платит владелец сам, платформа только
    ведёт учёт. Повторная отметка уже выплаченного ничего не меняет."""
    if not data.ids:
        return {"updated": 0}
    n = await db.fetchval(
        """WITH upd AS (
             UPDATE tech_accruals SET paid_at = NOW()
              WHERE id = ANY($1::int[]) AND paid_at IS NULL RETURNING 1)
           SELECT COUNT(*) FROM upd""",
        data.ids,
    )
    return {"updated": int(n or 0)}


class ManualIn(BaseModel):
    spec_id: int
    amount_kopecks: int
    note: Optional[str] = None
    client_id: Optional[int] = None
    period: Optional[str] = None
    kind: Optional[str] = None   # bonus | setup | ticket


@router.post("/accruals/manual", summary="Начислить вручную")
async def manual_accrual(
    data: ManualIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Разовая доплата, настройки под ключ или тикеты.

    ⚠️ Настройки и тикеты вносятся РУКАМИ: события «клиент заказал настройку»
    и «внедренец закрыл тикет» в платформе нет, вычислить их нечем. Суммы — по
    таблице: настройки 60 % (клиент базы ПЛЮСОН) / 80 % (свой) / 100 % (мимо
    кассы), тикеты 250 ₽ простой и 600 ₽ сложный.

    ⚠️ Эти виды намеренно БЕЗ уникального индекса: за месяц у одного человека
    может быть и десять тикетов, и несколько настроек."""
    if data.amount_kopecks <= 0:
        raise HTTPException(400, "Сумма должна быть больше нуля")
    kind = data.kind or "bonus"
    if kind not in ("bonus", "setup", "ticket"):
        raise HTTPException(400, "Вручную начисляются только bonus, setup, ticket")
    row = await db.fetchrow(
        """INSERT INTO tech_accruals
             (spec_id, client_id, kind, amount_kopecks, period, note)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *""",
        data.spec_id, data.client_id, kind, data.amount_kopecks,
        data.period, data.note,
    )
    return dict(row)


# ── Премиальный фонд ─────────────────────────────────────────────────────
# ⚠️ Сумму фонда считает ВЛАДЕЛЕЦ в фин-модели (процент от прибыли компании) и
# вносит сюда одним числом. Платформа прибыль не знает: показывать её в кабинете
# внедренца нельзя, а считать «примерно» — значит разойтись с выплатой.

class FundIn(BaseModel):
    period: str                      # '2026-Q1'
    # ⚠️ Вводится ПРИБЫЛЬ, процент берётся из вилки `tech_fund_tiers`. Вводить
    # сразу сумму фонда — лишний шаг и место для ошибки: ступени заданы листом.
    profit_kopecks: Optional[int] = None
    amount_kopecks: Optional[int] = None   # запасной путь: задать фонд напрямую
    note: Optional[str] = None


@router.get("/bonus-funds", summary="Премиальные фонды по кварталам")
async def bonus_funds(
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    funds = await db.fetch(
        "SELECT * FROM tech_bonus_funds ORDER BY period DESC LIMIT 12")
    weights = await db.fetch(
        "SELECT * FROM tech_bonus_weights ORDER BY weight DESC")
    return {"funds": [dict(r) for r in funds],
            "weights": [dict(r) for r in weights]}


@router.post("/bonus-funds", summary="Внести фонд за квартал")
async def set_bonus_fund(
    data: FundIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """⚠️ Уже розданный фонд не меняется: сумма разошлась по людям, правка
    задним числом рассогласовала бы её с начислениями."""
    done = await db.fetchval(
        "SELECT distributed_at FROM tech_bonus_funds WHERE period = $1",
        data.period)
    if done:
        raise HTTPException(400, "Фонд за этот квартал уже роздан")

    profit = data.profit_kopecks or 0
    amount = data.amount_kopecks or 0
    percent = None
    if profit > 0:
        # Ступень по прибыли: процент задан листом «Ставки», не вводится руками.
        tier = await db.fetchrow(
            """SELECT percent FROM tech_fund_tiers
                WHERE $1 >= profit_from AND $1 < profit_to
                ORDER BY profit_from DESC LIMIT 1""", profit)
        percent = float(tier["percent"]) if tier else 0.0
        amount = int(round(profit * percent / 100))
    if amount <= 0:
        raise HTTPException(400, "Укажите прибыль за квартал или сумму фонда")

    row = await db.fetchrow(
        """INSERT INTO tech_bonus_funds
             (period, amount_kopecks, profit_kopecks, percent, note)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (period) DO UPDATE
             SET amount_kopecks = EXCLUDED.amount_kopecks,
                 profit_kopecks = EXCLUDED.profit_kopecks,
                 percent = EXCLUDED.percent,
                 note = EXCLUDED.note
           RETURNING *""",
        data.period, amount, profit or None, percent, data.note,
    )
    return dict(row)


@router.post("/bonus-funds/{period}/distribute", summary="Раздать фонд")
async def distribute_fund(
    period: str,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Делит фонд между работающими внедренцами по весам их ролей."""
    from app.services.tech_accruals import accrue_quarter_bonus
    n = await accrue_quarter_bonus(db, quarter=period)
    if not n:
        raise HTTPException(400, "Нечего раздавать: фонд не внесён или уже роздан")
    return {"ok": True, "accrued": n}


# ── Условия премии на квартал ────────────────────────────────────────────
# ⚠️⚠️ Задаются НА КАЖДЫЙ КВАРТАЛ: условия зависят от плана на период, а не
# фиксируются раз навсегда. Требуют СВЕЖЕЙ работы — оборот внедренца может
# складываться из старой, и премия за такое была бы платой за прошлое.

class QuarterReqIn(BaseModel):
    period: str                       # ключ: '2026-H2'
    # ⚠️ Границы — ДАТЫ, а не календарный квартал: рабочие периоды с ним не
    # совпадают (первый идёт с середины сентября до конца года).
    starts_on: Optional[str] = None   # '2026-09-15'
    ends_on: Optional[str] = None     # '2026-12-31'
    title: Optional[str] = None       # как называем вслух
    base_from_pluson: int             # тип Б: активаций от ПЛЮСОНА в месяц
    network_from_pluson: int          # тип В: от ПЛЮСОНА в месяц
    network_own: int                  # тип В: своих в месяц
    note: Optional[str] = None


@router.get("/quarter-requirements", summary="Условия премии по кварталам")
async def quarter_reqs(
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await db.fetch(
        "SELECT * FROM tech_quarter_requirements ORDER BY period DESC LIMIT 8")
    return {"requirements": [dict(r) for r in rows]}


@router.post("/quarter-requirements", summary="Задать условия на квартал")
async def set_quarter_req(
    data: QuarterReqIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """⚠️ Правка условий уже РОЗДАННОГО квартала ничего не пересчитывает:
    премия начислена по тем условиям, что действовали при раздаче."""
    for v in (data.base_from_pluson, data.network_from_pluson, data.network_own):
        if v < 0:
            raise HTTPException(400, "Пороги не могут быть отрицательными")
    from datetime import date as _date
    def _d(v):
        return _date.fromisoformat(v) if v else None

    row = await db.fetchrow(
        """INSERT INTO tech_quarter_requirements
             (period, starts_on, ends_on, title,
              base_from_pluson, network_from_pluson, network_own, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (period) DO UPDATE SET
             starts_on = EXCLUDED.starts_on,
             ends_on = EXCLUDED.ends_on,
             title = EXCLUDED.title,
             base_from_pluson = EXCLUDED.base_from_pluson,
             network_from_pluson = EXCLUDED.network_from_pluson,
             network_own = EXCLUDED.network_own,
             note = EXCLUDED.note
           RETURNING *""",
        data.period, _d(data.starts_on), _d(data.ends_on), data.title,
        data.base_from_pluson, data.network_from_pluson,
        data.network_own, data.note,
    )
    return dict(row)


# ── Диалоги из @pluson_bot ───────────────────────────────────────────────
# ⚠️ Распределяются ОТДЕЛЬНО от клиентов: в бот пишут и те, кто клиентом ещё не
# стал, — их в списке клиентов платформы попросту нет.

@router.get("/dialogs", summary="Диалоги бота и кому назначены")
async def bot_dialogs(
    unassigned_only: bool = Query(False),
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = await db.fetchval(
        "SELECT id FROM clients WHERE is_system_service = TRUE LIMIT 1")
    if not client_id:
        raise HTTPException(404, "Системный кабинет не найден")

    where = "dm.client_id = $1 AND dm.contact_id IS NOT NULL"
    rows = await db.fetch(
        f"""WITH agg AS (
              SELECT dm.contact_id,
                     MAX(dm.sent_at) AS last_at,
                     COUNT(*) FILTER (WHERE dm.direction='in' AND NOT dm.is_read) AS unread
                FROM direct_messages dm
               WHERE {where}
               GROUP BY dm.contact_id
            )
            -- ⚠️⚠️ ЧЕЙ РАЗГОВОР — СЧИТАЕТСЯ ПО КЛИЕНТУ (23.09.2026), а не по
            -- отдельной раздаче. Ручное назначение (`dialog_assignments`)
            -- удалено вместе с таблицей: диалоги от клиентов неотделимы, и
            -- второй механизм означал бы два ответа на вопрос «чей это
            -- разговор». На проде он приводил к пустым «Диалогам» у внедренца
            -- с шестью клиентами: раздать вручную никто не догадался.
            --
            -- ⚠️ Контакт бота и клиент платформы связываются ПО ПОЧТЕ: это
            -- разные записи, общее у них только она.
            SELECT c.id AS contact_id, c.name, a.last_at, a.unread,
                   own.id AS spec_id, sc.name AS spec_name
              FROM agg a
              JOIN contacts c ON c.id = a.contact_id
              LEFT JOIN clients cl
                     ON LOWER(TRIM(cl.email)) = LOWER(TRIM((
                          SELECT pe.platform_user_id FROM platform_users pe
                           WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                           ORDER BY pe.id LIMIT 1)))
              LEFT JOIN tech_specialists own ON own.id = cl.tech_specialist_id
              LEFT JOIN clients sc ON sc.id = own.client_id
             {"WHERE own.id IS NULL" if unassigned_only else ""}
             ORDER BY a.last_at DESC LIMIT 300""",
        client_id,
    )
    return {"dialogs": [dict(r) for r in rows]}
