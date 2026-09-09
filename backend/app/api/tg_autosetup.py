"""Автонастройка Telegram — API кабинета клиента (миграция 364).

Клиент вводит имя будущего бота, оплачивает разовую услугу и смотрит на живой
статус: создаём бота → привязываем приложение → заводим группу → передаём права.

Гейт — фича `tg_autosetup` (никогда по tariff_slug), сейчас только admin.
Ассистенту запись закрыта общим middleware.

⚠️ УСЛУГА СЧИТАЕТСЯ ОКАЗАННОЙ, КОГДА БОТ СОЗДАН. Всё, что дальше, зависит от
действий клиента (зайти в бота, вступить в группу). Не забрал за 3 дня — бот
удаляется, но оплата НЕ сгорает: настройка запускается заново бесплатно.
"""
import json
import logging

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

from app.auth import get_current_client
from app.database import get_db
from app.services import tg_setup as tgs
from app.services.features import client_has_feature

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/clients/me/tg-autosetup", tags=["Автонастройка Telegram"])

# Вебхуки платёжных систем — свои роутеры без авторизации, как у аддонов.
leadpay_webhook_router = APIRouter(prefix="/integrations/leadpay", tags=["Услуги"])
prodamus_webhook_router = APIRouter(prefix="/integrations/prodamus", tags=["Услуги"])

SERVICE_SLUG = "tg_autosetup"
FEATURE_SLUG = "tg_autosetup"


# ⚠️⚠️ КОД ДОСТУПА К УСЛУГЕ — временный способ раздачи, пока идёт обкатка.
#
# Услуга бесплатна (0 ₽), но открывать её всем подряд рано: очередь упирается
# в единственный сервисный аккаунт, и десяток заказов подряд его исчерпает.
# Поэтому доступ выдаётся ТОЛЬКО тому, кто знает слово, — владелец даёт его
# точечно и может спокойно проверять услугу на живых кабинетах.
#
# ⚠️ Это НЕ промокод-скидка (миграция 382, `promo_codes`): там сущность про
# ДЕНЬГИ — процент или рубли на заказ, с лимитами применений и сроком. Здесь
# денег нет вовсе, слово открывает ДОСТУП. Тащить сюда механизм скидок значило
# бы завести код со скидкой 100% на услугу ценой 0 ₽ — конструкция, которая ни
# о чём не говорит и требует заказа там, где заказа быть не должно.
#
# ⚠️ Слово захардкожено намеренно: оно живёт неделями обкатки и меняется
# релизом, а не через админку. Заводить экран управления кодами ради одного
# временного слова — работа, которую придётся выбросить, когда услуга откроется
# всем. Открыть продажу = снять `coming_soon` в админке, код тогда не нужен.
ACCESS_CODE = "auto_pluson"


async def _assert_feature(db, client_id: int):
    if not await client_has_feature(db, client_id, FEATURE_SLUG):
        raise HTTPException(403, "Услуга пока недоступна")


class ActivateCodeRequest(BaseModel):
    code: str


@router.post("/activate-code", summary="Открыть услугу по коду доступа")
async def activate_by_code(data: ActivateCodeRequest,
                           user=Depends(get_current_client), db=Depends(get_db)):
    """Открывает услугу тому, кто ввёл верное слово.

    ⚠️ Гейта `_assert_feature` здесь НЕТ и быть не может: ручку зовёт как раз
    тот, у кого доступа ещё нет. Иначе код невозможно было бы ввести — человек
    упирался бы в 403 ровно там, где пытается получить доступ.

    ⚠️ Выдаём тем же способом, что и покупку модуля — строкой в `client_addons`
    (`source='promo'`, значение уже предусмотрено ограничением таблицы).
    Своего хранилища «кому открыт доступ» не заводим: тогда `client_has_feature`
    о нём не знала бы, и раздел остался бы закрытым, сколько ни выдавай.
    """
    client_id = int(user["sub"])

    # Регистр и пробелы не значимы: слово диктуют голосом и вставляют из чата.
    if (data.code or "").strip().lower() != ACCESS_CODE:
        raise HTTPException(400, "Неверный код")

    if await client_has_feature(db, client_id, FEATURE_SLUG):
        return {"ok": True, "already": True, "message": "Услуга уже подключена"}

    feature_id = await db.fetchval(
        "SELECT id FROM features WHERE slug=$1", FEATURE_SLUG
    )
    if not feature_id:
        raise HTTPException(500, "Услуга не настроена")

    # ⚠️ Срок — «навсегда» (2099), как у выданного админом: у РАЗОВОЙ услуги
    # срока действия нет по смыслу. Дата истечения здесь только потому, что
    # колонка NOT NULL — таблица рассчитана на модули с подпиской.
    await db.execute(
        """INSERT INTO client_addons (client_id, feature_id, expires_at,
                                      status, source, price, months)
                VALUES ($1, $2, TIMESTAMPTZ '2099-12-31', 'active', 'promo', 0, 1)
           ON CONFLICT DO NOTHING""",
        client_id, feature_id,
    )
    logger.info("tg_autosetup: доступ по коду выдан клиенту %s", client_id)
    return {"ok": True, "already": False, "message": "Услуга подключена"}


async def _service(db):
    row = await db.fetchrow(
        "SELECT * FROM services WHERE slug=$1 AND is_active=TRUE", SERVICE_SLUG
    )
    if not row:
        raise HTTPException(404, "Услуга не найдена")
    return row


def _order_out(row, service=None) -> dict:
    """Собирает то, что видит клиент. Токен бота наружу НЕ отдаём.

    ⚠️ bot_token — это полный доступ к боту. Пока бот не передан клиенту,
    он живёт на нашем сервисном аккаунте, и светить токен в браузере незачем:
    бот и так подключён к кабинету автоматически.
    """
    if not row:
        return {}
    log = row["setup_log"]
    if isinstance(log, str):
        import json
        try:
            log = json.loads(log)
        except Exception:  # noqa: BLE001
            log = []
    return {
        "id": row["id"],
        "status": row["status"],
        "setup_state": row["setup_state"],
        "setup_error": row["setup_error"],
        "setup_log": log or [],
        "bot_username": row["bot_username"],
        "bot_title": row["bot_title"],
        "group_invite_link": row["group_invite_link"],
        "group_chat_id": row["group_chat_id"],
        "amount": row["amount"],
        "paid_at": row["paid_at"],
        "claim_deadline": row["claim_deadline"],
        # Галочки шагов — по ним фронт рисует чек-лист.
        "steps": {
            "bot_created": bool(row["bot_created_at"]),
            "miniapp_linked": bool(row["miniapp_linked_at"]),
            "group_created": bool(row["group_created_at"]),
            "client_joined": bool(row["client_joined_at"]),
            "client_started_bot": bool(row["client_started_bot_at"]),
            "bot_transferred": bool(row["bot_transferred_at"]),
            "group_transferred": bool(row["group_transferred_at"]),
            "channel_linked": bool(row["channel_linked_at"]),
        },
        "created_at": row["created_at"],
    }


@router.get("")
async def get_state(user=Depends(get_current_client), db=Depends(get_db)):
    """Текущее состояние: услуга, активный заказ, место в очереди."""
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)

    svc = await _service(db)
    order = await db.fetchrow(
        """SELECT * FROM service_orders
            WHERE client_id=$1 AND service_id=$2
              AND setup_state NOT IN ('done')
            ORDER BY id DESC LIMIT 1""",
        client_id, svc["id"],
    )

    # ─── Очередь ───
    #
    # ⚠️ Человек должен видеть, что он ПРОДВИГАЕТСЯ: услуга идёт минутами, и
    # без цифры экран выглядит зависшим — клиент решает, что ничего не
    # работает, и пишет в поддержку.
    #
    # ⚠️ Порядок — ПО `id`, а не по `paid_at`: при выдаче по промокоду оплаты
    # нет вовсе и `paid_at` пустой, сортировка по нему складывала бы такие
    # заказы в непредсказуемом порядке. `id` растёт всегда и по нему же берёт
    # задачи поллер (tasks/tg_setup.tick).
    #
    # ⚠️ Считаем и `running` тоже: заказ, который уже настраивается, занимает
    # слот аккаунта — для стоящего в очереди он «впереди».
    queue_position = None
    if order and order["setup_state"] == "queued":
        queue_position = await db.fetchval(
            """SELECT COUNT(*) + 1 FROM service_orders
                WHERE setup_state IN ('queued','running')
                  AND status = 'paid'
                  AND id < $1""",
            order["id"],
        )

    # Сколько всего задач в работе — видно и тому, кто ещё не запускал.
    queue_total = await db.fetchval(
        """SELECT COUNT(*) FROM service_orders
            WHERE setup_state IN ('queued','running') AND status = 'paid'"""
    ) or 0

    # Ник клиента в Telegram — без него передать права некому.
    # ⚠️ Рядом отдаём «Службу заботы»: экран правит ник и заодно заполняет её,
    # но ТОЛЬКО когда она пуста — у части клиентов поддержку ведёт отдельный
    # аккаунт, и затирать его настройку нельзя. Без этого поля фронт не знает,
    # занято ли оно, и перезаписал бы вслепую.
    nick_row = await db.fetchrow(
        "SELECT telegram_username, work_tg_username FROM clients WHERE id=$1",
        client_id,
    )
    tg_nick = nick_row["telegram_username"] if nick_row else None
    brand = await db.fetchval(
        "SELECT COALESCE(NULLIF(brand_name,''), name) FROM clients WHERE id=$1",
        client_id,
    )

    bullets = svc["bullet_points"]
    if isinstance(bullets, str):
        import json
        try:
            bullets = json.loads(bullets)
        except Exception:  # noqa: BLE001
            bullets = []

    return {
        "service": {
            "slug": svc["slug"],
            "name": svc["name"],
            "tagline": svc["tagline"],
            "description": svc["description"],
            "bullet_points": bullets or [],
            "price": svc["price"],
            # ⚠️ coming_soon=TRUE — карточка видна, кнопки оплаты нет.
            "coming_soon": bool(svc["coming_soon"]),
            "payable": (not svc["coming_soon"]) and bool(
                svc["leadpay_product_id"] or svc["prodamus_payment_url"]
            ),
        },
        "order": _order_out(order, svc),
        "queue_position": queue_position,
        "queue_total": queue_total,
        "telegram_username": tg_nick,
        # Заполнена ли «Служба заботы» — экран по ней решает, можно ли
        # подставить туда ник, не затирая уже настроенный аккаунт поддержки.
        "support_filled": bool((nick_row and nick_row["work_tg_username"] or "").strip()),
        "suggestions": tgs.suggest_bot_usernames(brand or ""),
        "claim_days": 3,
    }


class CheckNameRequest(BaseModel):
    username: str


@router.post("/check-name")
async def check_name(data: CheckNameRequest,
                     user=Depends(get_current_client), db=Depends(get_db)):
    """Проверка имени бота — ФОРМАТ и занятость через публичный Telegram.

    ⚠️⚠️ У BOTFATHER ИМЯ НЕ СПРАШИВАЕМ. Проверка через него означает команду
    `/newbot`, а BotFather считает попытки создания и выдаёт лимит — причём
    СУТОЧНЫЙ: на проде 07.09.2026 он ответил «try again in 61470 seconds»
    (17 часов) после нескольких прогонов подряд. То есть каждая проверка имени
    отъедала бы у клиента возможность создать бота, а две проверки подряд
    гарантированно упирались в отказ.

    Поэтому: формат проверяем сами, занятость — обычным обращением к
    `t.me/<имя>` (существующий бот там отвечает страницей с профилем).
    Окончательный ответ всё равно даст BotFather при создании — и это ОДНА
    попытка вместо двух.
    """
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)

    err = tgs.validate_bot_username(data.username)
    if err:
        return {"ok": False, "free": False, "message": err}

    # ⚠️ Через прокси сервисного аккаунта: с российского IP t.me отвечает
    # через раз («Network is unreachable»).
    proxy_raw = await db.fetchval(
        "SELECT proxy FROM tg_setup_accounts "
        " WHERE is_active=TRUE AND health='ok' ORDER BY id LIMIT 1"
    )
    taken = await tgs.username_looks_taken(
        data.username, tgs.proxy_to_url(proxy_raw or "")
    )
    if taken is True:
        return {"ok": True, "free": False,
                "message": "Это имя уже занято — придумайте другое"}
    if taken is False:
        return {"ok": True, "free": True, "message": "Имя свободно"}
    # Не смогли проверить (сеть) — не врём, но и не мешаем: занятость всё
    # равно окончательно выяснится при создании.
    return {"ok": True, "free": True,
            "message": "Имя выглядит подходящим — проверим при создании"}


class StartRequest(BaseModel):
    bot_username: str
    bot_title: Optional[str] = None


@router.post("/confirm-started-bot", summary="Клиент подтверждает, что зашёл в бота")
async def confirm_started_bot(user=Depends(get_current_client), db=Depends(get_db)):
    """Отметка «я зашёл в бота» — РУКАМИ КЛИЕНТА, кнопкой в кабинете.

    ⚠️⚠️ ЗАЧЕМ РУЧНАЯ ОТМЕТКА, ЕСЛИ ЕСТЬ АВТОМАТИЧЕСКАЯ.
    Автоматическая (`on_client_started_bot`) ловит момент, когда человек пишет
    боту, и работает — но ТОЛЬКО если бот уже слушается процессом `plusson-bot`.
    Список ботов там читается ОДИН РАЗ при старте (`bot/main.py:_load_vip_tokens`),
    а бот услуги создаётся позже — и до ближайшего перезапуска сервиса его
    сообщения до нас не доходят. Поймано на живом заказе: клиент нажал
    «Запустить», а отметки не появилось, и настройка встала намертво.
    Перезапустить сервис из Celery нельзя — задача идёт под www-data, systemctl
    требует root.

    Поэтому отметка ещё и ручная: человек видит бота у себя и подтверждает сам.
    Автоматическая при этом остаётся — если сработает раньше, кнопка просто не
    понадобится.

    ⚠️ Права на бота передаёт та же фоновая задача, что и раньше: она сверяет
    `client_started_bot_at` и вызывает Transfer Ownership. Здесь мы только
    ставим отметку — своей передачи не заводим, иначе логика раздвоится.
    """
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)

    order = await db.fetchrow(
        """SELECT id, bot_username, bot_created_at, client_started_bot_at
             FROM service_orders
            WHERE client_id = $1 AND setup_state = 'awaiting_user'
            ORDER BY id DESC LIMIT 1""",
        client_id,
    )
    if not order:
        raise HTTPException(404, "Нет настройки, ожидающей ваших действий")
    # ⚠️ Пока бот не создан, подтверждать нечего: человек физически не мог в
    # него зайти, а отметка запустила бы передачу несуществующего бота.
    if not order["bot_created_at"]:
        raise HTTPException(400, "Бот ещё создаётся — подождите немного")
    if order["client_started_bot_at"]:
        return {"ok": True, "already": True}

    await db.execute(
        "UPDATE service_orders SET client_started_bot_at = NOW(), updated_at = NOW() "
        " WHERE id = $1",
        order["id"],
    )
    logger.info("tg_setup: клиент %s подтвердил заход в бота @%s вручную",
                client_id, order["bot_username"])
    return {"ok": True, "already": False}


@router.post("/confirm-joined-group", summary="Клиент подтверждает, что вступил в группу")
async def confirm_joined_group(user=Depends(get_current_client), db=Depends(get_db)):
    """Отметка «я вступил в группу» — руками, кнопкой в кабинете.

    ⚠️ ЗАЧЕМ. Добавить человека в группу мы можем далеко не всегда: у
    большинства закрыты настройки приватности («кто может добавлять в группы»),
    и Telegram нам это запрещает — тогда он вступает сам по ссылке. Автоматика
    ловит вступление через `chat_member`, но апдейт приходит, только пока наш
    сервисный аккаунт в группе и видит событие; если он уже вышел или апдейт
    потерялся, отметки не будет никогда, и настройка встанет.

    ⚠️ АДМИНОМ ДЕЛАЕМ ПОСЛЕ ВСТУПЛЕНИЯ, а не до: назначить права можно только
    участнику группы. Поэтому подтверждение и запускает выдачу прав — этим
    занимается та же фоновая задача, что и раньше (`_finish_setup`), здесь мы
    только ставим отметку.
    """
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)

    order = await db.fetchrow(
        """SELECT id, group_chat_id, client_joined_at
             FROM service_orders
            WHERE client_id = $1 AND setup_state = 'awaiting_user'
            ORDER BY id DESC LIMIT 1""",
        client_id,
    )
    if not order:
        raise HTTPException(404, "Нет настройки, ожидающей ваших действий")
    if not order["group_chat_id"]:
        raise HTTPException(400, "Группа ещё создаётся — подождите немного")
    if order["client_joined_at"]:
        return {"ok": True, "already": True}

    await db.execute(
        "UPDATE service_orders SET client_joined_at = NOW(), updated_at = NOW() "
        " WHERE id = $1",
        order["id"],
    )
    logger.info("tg_setup: клиент %s подтвердил вступление в группу вручную", client_id)
    return {"ok": True, "already": False}


@router.post("/start")
async def start_setup(data: StartRequest,
                      user=Depends(get_current_client), db=Depends(get_db)):
    """Запускает настройку.

    Два случая:
      * есть оплаченный заказ, который сгорел или сорвался → перезапускаем
        БЕСПЛАТНО (оплата привязана к заказу, а не к попытке);
      * оплаченного нет → создаём новый и отдаём ссылку на оплату.
    """
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    svc = await _service(db)

    err = tgs.validate_bot_username(data.bot_username)
    if err:
        raise HTTPException(400, err)

    tg_nick = await db.fetchval(
        "SELECT telegram_username FROM clients WHERE id=$1", client_id
    )
    if not tg_nick:
        raise HTTPException(
            400,
            "Сначала укажите свой ник в Telegram в настройках — "
            "без него мы не сможем передать вам права",
        )

    username = data.bot_username.strip().lstrip("@")
    title = (data.bot_title or "").strip() or username

    # ── перезапуск уже оплаченного ──
    existing = await db.fetchrow(
        """SELECT * FROM service_orders
            WHERE client_id=$1 AND service_id=$2 AND status='paid'
              AND setup_state IN ('expired','failed','new')
            ORDER BY id DESC LIMIT 1""",
        client_id, svc["id"],
    )
    if existing:
        await db.execute(
            """UPDATE service_orders
                  SET bot_username=$2, bot_title=$3, setup_state='queued',
                      setup_error=NULL, setup_log='[]'::jsonb,
                      claim_deadline=NULL, reminders_sent=0, last_reminder_at=NULL,
                      setup_account_id=NULL, updated_at=NOW()
                WHERE id=$1""",
            existing["id"], username, title,
        )
        return {"ok": True, "order_id": existing["id"], "paid": True,
                "message": "Настройка запущена — платить повторно не нужно"}

    # ── идёт прямо сейчас ──
    active = await db.fetchrow(
        """SELECT * FROM service_orders
            WHERE client_id=$1 AND service_id=$2
              AND setup_state IN ('queued','running','awaiting_user')
            ORDER BY id DESC LIMIT 1""",
        client_id, svc["id"],
    )
    if active:
        raise HTTPException(409, "Настройка уже идёт")

    # ── новый заказ ──
    #
    # ⚠️⚠️ БЕСПЛАТНАЯ УСЛУГА ЗАПУСКАЕТСЯ БЕЗ ОПЛАТЫ.
    #
    # Сюда доходит только тот, у кого доступ ЕСТЬ (_assert_feature выше), — то
    # есть услугу ему выдали по промокоду. Раньше поток шёл дальше в проверку
    # `coming_soon` и упирался в «Услуга скоро появится»: человек с доступом
    # вводил имя бота и получал отказ. Ветка «перезапуск оплаченного» его тоже
    # не спасала — она ищет ЗАКАЗ, а при выдаче по промокоду заказа нет вовсе.
    #
    # Цена 0 → заказ сразу `paid` и в очередь: платить нечего, а сгенерировать
    # ссылку на оплату нулевой суммы платёжная система всё равно не даст.
    if int(svc["price"] or 0) <= 0:
        order_id = await db.fetchval(
            """INSERT INTO service_orders (client_id, service_id, amount,
                                           bot_username, bot_title,
                                           status, setup_state,
                                           payment_provider, paid_at)
                    VALUES ($1, $2, 0, $3, $4, 'paid', 'queued', 'free', NOW())
                 RETURNING id""",
            client_id, svc["id"], username, title,
        )
        return {"ok": True, "order_id": order_id, "paid": True,
                "message": "Настройка поставлена в очередь"}

    # ⚠️ coming_soon — оплату не открываем вовсе. Услуга видна, но не продаётся.
    if svc["coming_soon"]:
        raise HTTPException(400, "Услуга скоро появится")

    order_id = await db.fetchval(
        """INSERT INTO service_orders (client_id, service_id, amount,
                                       bot_username, bot_title, status, setup_state)
                VALUES ($1, $2, $3, $4, $5, 'created', 'new')
             RETURNING id""",
        client_id, svc["id"], svc["price"], username, title,
    )

    pay_url = await _payment_link(db, svc, order_id, client_id)
    if not pay_url:
        raise HTTPException(500, "Оплата временно недоступна")
    return {"ok": True, "order_id": order_id, "paid": False, "payment_url": pay_url}


async def _payment_link(db, svc, order_id: int, client_id: int) -> Optional[str]:
    """Ссылка на оплату услуги.

    ⚠️ Префикс номера заказа — `svc-`, рядом с evt- / prd- / addon-.
    По нему вебхук отличает оплату услуги от всего остального.
    """
    from app.services.client_domains import platform_base_url

    base = platform_base_url().rstrip("/")
    if svc["leadpay_product_id"]:
        from app.services import leadpay

        return await leadpay.create_payment_link(
            order_id=order_id,
            product_id=svc["leadpay_product_id"],
            notification_url=f"{base}/api/v1/integrations/leadpay/service-webhook",
            order_id_prefix="svc-",
        )
    if svc["prodamus_payment_url"]:
        url = svc["prodamus_payment_url"]
        sep = "&" if "?" in url else "?"
        return (f"{url}{sep}order_id=svc-{order_id}"
                f"&customer_extra=client:{client_id};service:{svc['slug']}")
    return None


# ─────────────────────────────────────────────────────────────────────────
# Оплата: вебхуки
# ─────────────────────────────────────────────────────────────────────────
#
# ⚠️ ПРЕФИКС `svc-` — им вебхук отличает оплату услуги от подписки (голое
# число), заказа события (evt-), продукта (prd-) и модуля (addon-).
# Чужой префикс → отвечаем «ок, не наше», а не ошибкой: платёжная система
# иначе будет слать повторы сутки.

async def _mark_service_paid(db, order_id: int, *, provider: str,
                             order_num: str = "", raw: dict | None = None) -> dict:
    """Помечает заказ оплаченным и ставит в очередь автонастройки.

    Идемпотентно: повторный вебхук (норма для платёжек) ничего не ломает.
    """
    order = await db.fetchrow(
        "SELECT id, client_id, status, setup_state, bot_username "
        "  FROM service_orders WHERE id=$1", order_id,
    )
    if not order:
        return {"ok": True, "ignored": "order not found"}
    if order["status"] == "paid":
        return {"ok": True, "already_paid": True}

    # ⚠️ В очередь ставим только если клиент уже назвал имя бота. Без имени
    # создавать нечего — заказ подождёт, пока клиент его введёт.
    next_state = "queued" if order["bot_username"] else "new"

    await db.execute(
        """UPDATE service_orders
              SET status='paid', paid_at=NOW(), payment_provider=$2,
                  payment_order_num=$3, payment_raw=$4::jsonb,
                  setup_state=$5, updated_at=NOW()
            WHERE id=$1""",
        order_id, provider, order_num or None,
        json.dumps(raw or {}, ensure_ascii=False), next_state,
    )
    logger.info("service order %s paid via %s → %s", order_id, provider, next_state)
    return {"ok": True, "status": "paid"}


def _parse_svc_order_id(raw: str) -> Optional[int]:
    if not raw.startswith("svc-"):
        return None
    try:
        return int(raw[len("svc-"):])
    except (ValueError, TypeError):
        return None


@leadpay_webhook_router.post("/service-webhook", summary="Оплата услуги (LeadPay)")
async def leadpay_service_webhook(request: Request,
                                  db: asyncpg.Connection = Depends(get_db)):
    from app.services import leadpay

    form = await request.form()
    data = {k: str(v) for k, v in form.items()}
    order_id_raw = (data.get("order_id") or "").strip()
    status = (data.get("status") or "").strip().lower()

    logger.info("LeadPay service webhook: order_id=%s status=%s", order_id_raw, status)

    if not leadpay.verify_webhook(data):
        logger.warning("LeadPay service webhook: invalid hash (%s)", order_id_raw)
        raise HTTPException(status_code=401, detail="Invalid hash")

    order_id = _parse_svc_order_id(order_id_raw)
    if order_id is None:
        return {"ok": True, "ignored": "not a service order"}

    if status not in ("success", "ok", "paid", "completed"):
        await db.execute(
            "UPDATE service_orders SET status='failed', payment_raw=$2::jsonb, "
            "       updated_at=NOW() WHERE id=$1 AND status <> 'paid'",
            order_id, json.dumps(data, ensure_ascii=False),
        )
        return {"ok": True, "status": "failed"}

    return await _mark_service_paid(
        db, order_id, provider="leadpay",
        order_num=data.get("card_id") or "", raw=data,
    )


@prodamus_webhook_router.post("/service-webhook", summary="Оплата услуги (Продамус)")
async def prodamus_service_webhook(request: Request,
                                   db: asyncpg.Connection = Depends(get_db)):
    from app.api.subscriptions import (
        PRODAMUS_VERIFY_SIGNATURE, _verify_prodamus_signature,
    )

    # ⚠️ Подпись Продамуса считается по СЫРОМУ телу запроса, а не по разобранному
    # словарю: пересборка формы меняет порядок и экранирование, и подпись не
    # сходится. Поэтому читаем body ДО разбора формы.
    raw_body = await request.body()
    form = await request.form()
    data = {k: str(v) for k, v in form.items()}
    order_id_raw = (data.get("order_num") or data.get("order_id") or "").strip()

    logger.info("Prodamus service webhook: order=%s", order_id_raw)

    if PRODAMUS_VERIFY_SIGNATURE:
        sign = request.headers.get("Sign") or request.headers.get("sign") or ""
        if not _verify_prodamus_signature(raw_body, sign):
            logger.warning("Prodamus service webhook: bad signature (%s)", order_id_raw)
            raise HTTPException(status_code=401, detail="Invalid signature")

    order_id = _parse_svc_order_id(order_id_raw)
    if order_id is None:
        return {"ok": True, "ignored": "not a service order"}

    # ⚠️ Продамус шлёт оповещение и о НЕЗАВЕРШЁННОЙ оплате — оплаченным
    # считаем только явный успех.
    if (data.get("payment_status") or "").strip().lower() != "success":
        return {"ok": True, "status": "pending"}

    return await _mark_service_paid(
        db, order_id, provider="prodamus",
        order_num=data.get("payment_init") or "", raw=data,
    )
