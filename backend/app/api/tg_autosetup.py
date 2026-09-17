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


def _kick_queue() -> None:
    """Двигает очередь НЕМЕДЛЕННО, не дожидаясь минутного тика.

    ⚠️⚠️ Без этого нажатие кнопки означало ожидание до 60 секунд НА ПУСТОЙ
    очереди: заказ просто ложился в `queued` и ждал ближайшего запуска
    `tg-setup-tick` (раз в минуту). Человек смотрел на неподвижный экран и
    решал, что услуга не работает.

    ⚠️ Сама работа всё равно идёт В ОЧЕРЕДИ, а не здесь: разговор с BotFather
    — это переписка с паузами на десятки секунд, HTTP-запрос из браузера
    столько не ждёт и отвалится по таймауту. Мы лишь будим поллер.

    ⚠️ Сбой отправки НЕ роняет запуск: заказ уже создан и лежит в очереди —
    его подхватит обычный тик через минуту. Тогда медленно, но не потеряно.
    """
    try:
        from app.celery_app import celery
        celery.send_task("app.tasks.tg_setup.tick")
    except Exception as e:  # pragma: no cover — очередь недоступна
        logger.warning("tg_setup: не удалось разбудить очередь сразу: %s", e)


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
        #
        # ⚠️⚠️ КАЖДЫЙ ПУНКТ — СВОЙ ФЛАГ, а не «похожий соседний». Раньше три
        # пункта чек-листа («бот подключён к кабинету», «группа прописана в
        # настройках», «служба заботы») рисовались по чужим отметкам — по факту
        # создания бота и группы. Из-за этого чек-лист показывал зелёные галочки
        # там, где работа не делалась, и расходился с отчётом ниже: клиент видел
        # два разных списка про одно и то же и не понимал, какому верить.
        "steps": {
            "bot_created": bool(row["bot_created_at"]),
            "bot_channel_linked": bool(row["bot_channel_id"]),
            "miniapp_linked": bool(row["miniapp_linked_at"]),
            "group_created": bool(row["group_created_at"]),
            # Группа считается прописанной, только если она реально стоит в
            # настройках клиента — их могли поменять руками уже после настройки.
            "group_in_settings": bool(row["group_chat_id"]),
            "client_joined": bool(row["client_joined_at"]),
            "client_started_bot": bool(row["client_started_bot_at"]),
            "bot_transferred": bool(row["bot_transferred_at"]),
            "group_transferred": bool(row["group_transferred_at"]),
            "channel_linked": bool(row["channel_linked_at"]),
            # Шаг 3 услуги: политика опубликована или осознанно пропущена.
            # ⚠️ Через `in row` — это asyncpg.Record, метода `.get()` у него нет,
            # а колонки появились поздней миграцией (421): на не накатанной базе
            # обращение по имени бросило бы KeyError и уронило весь экран.
            "policy_published": bool(
                row["policy_published_at"] if "policy_published_at" in row else None),
            "policy_skipped": bool(
                row["policy_skipped_at"] if "policy_skipped_at" in row else None),
        },
        # ⚠️ Поля формы больше НЕ правятся, когда процесс пошёл: данные уже
        # ушли в работу, и правка в форме ничего не изменит — только создаст
        # ложное ощущение, что изменит. Считаем ОДИН раз здесь, чтобы экран и
        # сервер одинаково понимали, что значит «уже поздно».
        "locked": row["setup_state"] in ("queued", "running", "awaiting_user", "done"),
        "created_at": row["created_at"],
    }


@router.get("")
async def get_state(user=Depends(get_current_client), db=Depends(get_db)):
    """Текущее состояние: услуга, активный заказ, место в очереди."""
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)

    svc = await _service(db)
    # ⚠️⚠️ ЗАВЕРШЁННЫЙ ЗАКАЗ ТОЖЕ ОТДАЁМ — РАНЬШЕ ЭКРАН ОБНУЛЯЛСЯ.
    #
    # Здесь стояло `setup_state NOT IN ('done')`. Как только настройка
    # заканчивалась и права уходили клиенту, ручка переставала отдавать заказ:
    # фронт получал пустоту и рисовал ЧИСТУЮ ФОРМУ с нуля. Человек видел ровно
    # то, что видел до запуска, — как будто ничего не происходило и вся работа
    # пропала. Поймано на живом заказе 16.09.2026 (клиент 192, заказ 9): бот
    # создан, группа заведена, права переданы, в логе «Бот теперь ваш» — а на
    # экране пустые поля и предложение начать заново.
    #
    # Теперь отдаём последний заказ ЛЮБОГО состояния, включая `done`: итог
    # виден, пока человек сам не запустит новую настройку.
    order = await db.fetchrow(
        """SELECT * FROM service_orders
            WHERE client_id=$1 AND service_id=$2
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
        "SELECT telegram_username, work_tg_username, email, email_verified "
        "  FROM clients WHERE id=$1",
        client_id,
    )
    tg_nick = nick_row["telegram_username"] if nick_row else None

    # ⚠️ Отдаём САМИ значения, а не только признак «заполнено»: экран показывает
    # человеку, что у него уже настроено, и даёт поправить. Раньше приходил
    # лишь флаг `support_filled`, и служба заботы с каналом были не видны —
    # человек не понимал, что за него уже что-то записано.
    support_raw = (nick_row["work_tg_username"] if nick_row else "") or ""
    # В базе поддержка хранится ссылкой (`https://telegram.me/ник`) — наружу
    # отдаём НИКОМ: человек вводил ник, ссылку он не писал и узнать её не должен.
    support_nick = support_raw.rstrip("/").split("/")[-1].lstrip("@") if support_raw else ""

    # Канал основателя — первый из `social_links.telegram_channels` (там их может
    # быть несколько). Тоже отдаём ником, а не ссылкой.
    chan_nick = ""
    try:
        sl = await db.fetchval(
            "SELECT social_links FROM clients WHERE id=$1", client_id)
        if isinstance(sl, str):
            import json as _json
            sl = _json.loads(sl or "{}")
        chans = (sl or {}).get("telegram_channels") or []
        if chans:
            u = (chans[0] or {}).get("url") or ""
            chan_nick = u.rstrip("/").split("/")[-1].lstrip("@") if u else ""
    except Exception:  # noqa: BLE001
        chan_nick = ""
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
        "support_filled": bool(support_raw.strip()),
        # Ники (без «@» и без ссылки) — экран показывает их в полях.
        "support_username": support_nick,
        "channel_username": chan_nick,
        "suggestions": tgs.suggest_bot_usernames(brand or ""),
        "claim_days": 3,
        # ⚠️ ПОЧТА — ЕДИНСТВЕННЫЙ НАДЁЖНЫЙ КАНАЛ СВЯЗИ В ЭТОЙ УСЛУГЕ. Через
        # пару минут от человека потребуется действие (зайти в бота и принять
        # права), а в боте его ещё нет вовсе — позвать туда можно только
        # письмом. Непроверенный адрес означает, что позвать будет некуда, и
        # бот сгорит через 3 дня, заняв слот. Поэтому запуск требует
        # подтверждения (см. отказ в `/start`).
        "email": nick_row["email"] if nick_row else None,
        "email_verified": bool(nick_row["email_verified"]) if nick_row else False,
        # ⚠️ Демо-заготовки (миграция 411) — их показывает экран итога со
        # ссылками «проверьте выдачу на себе». Отдаём всегда, а не только на
        # «готово»: человек мог уйти со страницы и вернуться позже.
        "demo_magnets": await _demo_magnets(db, client_id),
        # ⚠️ Почему заказ ещё ждёт и когда вернёмся — то же, что уходит
        # письмом. Человек с открытой страницей должен видеть причину, а не
        # неподвижный «крутилку»: иначе он решает, что услуга сломалась.
        "queue_wait": await _queue_wait(db, order),
    }


async def _queue_wait(db, order) -> Optional[dict]:
    """Причина ожидания и время возврата — для экрана.

    ⚠️ Считает ТА ЖЕ функция, что и для писем (`_queue_wait_reason`): экран и
    письмо обязаны говорить одно и то же, иначе человек верит тому, что
    страшнее.
    """
    if not order or order["setup_state"] != "queued":
        return None
    try:
        from app.tasks.tg_setup import _queue_wait_reason
        reason, back_at = await _queue_wait_reason(db, dict(order))
        return {"reason": reason, "back_at": back_at}
    except Exception:  # noqa: BLE001 — без причины экран просто её не покажет
        return None


async def _demo_magnets(db, client_id: int) -> list[dict]:
    """Демо-лид-магниты, созданные автонастройкой, — со ссылкой на выдачу.

    ⚠️ Ссылка строится ОБЩЕЙ `build_funnel_landing_links`, как везде в
    проекте: своя склейка разошлась бы с тем, что разбирают боты.
    """
    rows = await db.fetch(
        """SELECT id, name, slug, demo_solution_num
             FROM lead_magnets
            WHERE client_id = $1 AND demo_solution_num IS NOT NULL
            ORDER BY demo_solution_num""",
        client_id,
    )
    if not rows:
        return []
    from app.services.share_links import build_funnel_landing_links
    out: list[dict] = []
    for r in rows:
        try:
            links = await build_funnel_landing_links(
                db, client_id=client_id, slug=r["slug"], kind="m",
            )
        except Exception:  # noqa: BLE001 — без ссылки карточка всё равно нужна
            links = {}
        out.append({
            "id": r["id"], "name": r["name"], "slug": r["slug"],
            "num": r["demo_solution_num"],
            "link": links.get("telegram") or next(iter(links.values()), None),
        })
    return out


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
    # ⚠️⚠️ ССЫЛКА НА КАНАЛ КЛИЕНТА — СПРАШИВАЕМ В НАЧАЛЕ, А НЕ УГАДЫВАЕМ.
    #
    # Раньше канал ловился апдейтом `my_chat_member` при добавлении бота — но
    # апдейт доходит, только пока бот в поллинге, а список ботов `plusson-bot`
    # читает один раз при старте: бот услуги создан позже и туда не попадает.
    # На живом заказе 09.09.2026 клиент бота добавил, а система об этом не
    # узнала и отвечала «не удалось подтвердить».
    #
    # ⚠️ Ссылка идёт в «Каналы основателя» (`clients.social_links`) — по ним
    # работает проверка подписки в воронках лид-магнитов и гейт в чатах.
    # `client_broadcast_chats` (куда рассылать) — ДРУГОЕ место и другая задача.
    channel_url: Optional[str] = None
    # ⚠️⚠️ ТРИ ОБЯЗАТЕЛЬНЫХ ПОЛЯ ПРИХОДЯТ ВМЕСТЕ С ЗАПУСКОМ, а не отдельной
    # кнопкой «Сохранить». Раньше кнопок было две, и человек не понимал, куда
    # именно сохраняет первая: она молча писала в три разных места кабинета.
    # Теперь запуск — единственное действие, а что куда легло, видно в логе.
    telegram_username: Optional[str] = None   # ник владельца (clients.telegram_username)
    support_username: Optional[str] = None    # служба заботы (clients.work_tg_username)


class ConfirmStartedIn(BaseModel):
    """Ответ на расхождение ников: чей аккаунт считать правильным.

    `take_entered` = «вошёл не тем» → человек выбрал «передать права на тот
    аккаунт, которым я вошёл». Пусто — обычное нажатие, расхождение только
    показываем и ничего не решаем за человека.
    """
    accept_entered: bool = False


async def _who_started_bot(bot_token: str,
                           exclude_ids: set[int]) -> tuple[list[dict], bool]:
    """Кто реально написал боту — читаем очередь апдейтов Telegram.

    ⚠️⚠️ ЗАЧЕМ ВООБЩЕ СПРАШИВАТЬ. Раньше нажатие «Сделано» просто ставило
    отметку `client_started_bot_at = NOW()` — на слово. На живом заказе
    16.09.2026 (клиент 192) человек НЕ нажимал «Старт» в боте, нажал «Сделано»,
    и система молча зачла шаг: `client_tg_user_id` остался пустым. А ведь весь
    смысл этого шага — поймать числовой id, узнать его больше неоткуда.

    ⚠️ БЕЗ `offset` — получение НЕ подтверждаем: апдейты должны остаться в
    очереди для `plusson-bot`, когда бот попадёт в его поллинг (Telegram отдаёт
    их одному получателю). Тот же приём, что в `_find_bot_channel`.

    ⚠️ Отсекаем сервисные аккаунты платформы (`exclude_ids`): бота создавал наш
    аккаунт, он же в нём первый «подписчик», и принять его за клиента нельзя.

    ⚠️⚠️ ВОЗВРАЩАЕМ ЕЩЁ И ПРИЗНАК «СПРОСИТЬ УДАЛОСЬ». Пустой список сам по себе
    двусмыслен: он одинаково означает «человек не заходил» и «Telegram не
    ответил». Сказать во втором случае «не видим вас среди подписчиков» —
    значит обвинить человека в том, чего он не делал, и отправить его нажимать
    «Старт» второй раз без всякого толку.
    """
    if not bot_token:
        return [], False
    out: list[dict] = []
    try:
        import httpx
        async with httpx.AsyncClient(timeout=20) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{bot_token}/getUpdates",
                params={"allowed_updates": '["message"]', "limit": 100},
            )
            # Токен отозван / бот удалён — это не «никто не писал».
            if r.status_code != 200 or not (r.json() or {}).get("ok"):
                logger.warning("tg_setup: getUpdates ответил %s", r.status_code)
                return [], False
            seen: set[int] = set()
            for upd in reversed((r.json() or {}).get("result") or []):
                frm = (upd.get("message") or {}).get("from") or {}
                uid = frm.get("id")
                if not uid or frm.get("is_bot") or int(uid) in seen:
                    continue
                if int(uid) in exclude_ids:
                    continue
                seen.add(int(uid))
                out.append({
                    "id": int(uid),
                    "username": (frm.get("username") or "").lstrip("@"),
                    "name": " ".join(filter(None, [frm.get("first_name"),
                                                   frm.get("last_name")])).strip(),
                })
    except Exception as e:  # noqa: BLE001 — сеть подвела: решает вызывающий
        logger.warning("tg_setup: не прочитал апдейты бота: %s", e)
        return [], False
    return out, True


@router.post("/confirm-started-bot", summary="Клиент подтверждает, что зашёл в бота")
async def confirm_started_bot(data: ConfirmStartedIn | None = None,
                              user=Depends(get_current_client), db=Depends(get_db)):
    """Отметка «я зашёл в бота» — С РЕАЛЬНОЙ ПРОВЕРКОЙ, а не на слово.

    ⚠️⚠️ НА СЛОВО НЕ ВЕРИМ (правило владельца 16.09.2026). Раньше нажатие
    просто ставило отметку. Человек, не нажавший «Старт» в боте, нажимал
    «Сделано» — и система зачитывала шаг, хотя числового id у неё не появлялось
    и передавать бота было, по сути, некому. Теперь спрашиваем у Telegram, кто
    боту действительно написал, и отвечаем честно.

    ⚠️⚠️ ЮЗЕРНЕЙМ ОБЯЗАТЕЛЕН. BotFather принимает ТОЛЬКО @username — по
    числовому id передать владение нельзя. Поэтому аккаунт без юзернейма
    получить права не может в принципе, и мы говорим об этом прямо, а не
    отмечаем шаг «сделанным».

    Четыре исхода (решение владельца):
      * никто не писал боту → «не видим вас среди подписчиков»;
      * вошёл, ник совпал → отмечаем, идём дальше;
      * вошёл, ник ДРУГОЙ → показываем выбор, за человека не решаем;
      * вошёл без юзернейма → передать нельзя, просим войти нужным аккаунтом.

    ⚠️ Права передаёт та же фоновая задача (`_finish_setup`) — здесь только
    отметка и пойманный id. Своей передачи не заводим, иначе логика раздвоится.
    """
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)

    order = await db.fetchrow(
        """SELECT id, bot_username, bot_token, bot_created_at,
                  client_started_bot_at
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
        return {"ok": True, "already": True, "verified": True}

    want = ((await db.fetchval(
        "SELECT telegram_username FROM clients WHERE id=$1", client_id
    )) or "").strip().lstrip("@").rstrip("/").split("/")[-1].lower()

    # Сервисные аккаунты платформы — не клиенты, их в подписчиках не считаем.
    service_ids = {
        int(r["tg_user_id"]) for r in await db.fetch(
            "SELECT tg_user_id FROM tg_setup_accounts WHERE tg_user_id IS NOT NULL")
        if r["tg_user_id"]
    }
    people, asked_ok = await _who_started_bot(order["bot_token"] or "", service_ids)

    if not asked_ok:
        # ⚠️ Спросить не смогли — НЕ обвиняем человека и НЕ отмечаем шаг.
        # «Не видим вас среди подписчиков» здесь было бы враньём: мы просто
        # не дозвонились до Telegram.
        return {
            "ok": False, "verified": False,
            "message": "Не смогли проверить — Telegram сейчас не отвечает. "
                       "Подождите минуту и нажмите «Сделано» ещё раз.",
        }

    if not people:
        return {
            "ok": False, "verified": False,
            "message": "Не видим вас среди подписчиков бота. Вы точно нажали "
                       "«Старт»? Откройте бота кнопкой выше, нажмите «Старт» "
                       "и вернитесь сюда — затем нажмите «Сделано» ещё раз.",
        }

    match = next((p for p in people if p["username"].lower() == want and want), None)
    chosen = match

    if not chosen:
        # ⚠️ Вошли не тем аккаунтом. За человека не решаем — спрашиваем
        # (решение владельца: показать выбор, а не молча подменить ник).
        other = people[0]
        if not other["username"]:
            # ⚠️ Без юзернейма BotFather передать владение не может ВООБЩЕ.
            return {
                "ok": False, "verified": False,
                "message": (
                    f"Вы вошли аккаунтом без юзернейма"
                    f"{' (' + other['name'] + ')' if other['name'] else ''} — "
                    "на такой аккаунт Telegram передать права не даёт. Войдите "
                    f"тем аккаунтом, что указали (@{want}), и нажмите «Сделано»."
                    if want else
                    "Вы вошли аккаунтом без юзернейма — на такой аккаунт "
                    "Telegram передать права не даёт. Заведите имя пользователя "
                    "(Telegram → Настройки → «Имя пользователя») и нажмите «Сделано»."
                ),
            }
        if not (data and data.accept_entered):
            return {
                "ok": False, "verified": False, "mismatch": True,
                "entered_username": other["username"],
                "expected_username": want,
                "message": (
                    f"Вы указали @{want}, а в бота вошли как @{other['username']}. "
                    f"Передать права на @{other['username']} или войдёте другим "
                    "аккаунтом?"
                ),
            }
        # Человек выбрал «передать на вошедший» — берём его и правим профиль,
        # иначе передача пойдёт по старому нику и уйдёт не туда.
        chosen = other
        await db.execute(
            "UPDATE clients SET telegram_username = $2 WHERE id = $1",
            client_id, chosen["username"],
        )

    await db.execute(
        """UPDATE service_orders
              SET client_started_bot_at = NOW(), client_tg_user_id = $2,
                  updated_at = NOW()
            WHERE id = $1""",
        order["id"], chosen["id"],
    )
    # Тот же побочный эффект, что у автоматической ловли: id идёт в тестовые
    # рассылки и в карточку клиента. Общие функции, своих копий не заводим.
    try:
        from app.services.tg_setup_events import (
            _remember_client_tg_id, _link_client_identity,
        )
        await _remember_client_tg_id(db, client_id, chosen["id"])
        await _link_client_identity(db, client_id, chosen["id"],
                                    chosen["username"])
    except Exception as e:  # noqa: BLE001 — главное (id заказа) уже записано
        logger.warning("tg_setup: побочная запись id клиента %s: %s", client_id, e)

    try:
        from app.tasks.tg_setup import _log_step
        await _log_step(db, order["id"], "bot",
                        f"Вы вошли в бота как @{chosen['username']} — "
                        "проверили и записали ваш Telegram "
                        "(Настройки → «Техническое»)")
    except Exception as e:  # noqa: BLE001
        logger.warning("tg_setup: не записал шаг захода в бота: %s", e)

    logger.info("tg_setup: клиент %s подтверждён в боте @%s как @%s (tg_id=%s)",
                client_id, order["bot_username"], chosen["username"], chosen["id"])
    return {"ok": True, "already": False, "verified": True,
            "username": chosen["username"],
            "message": f"Подтвердили: вы вошли как @{chosen['username']}"}


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


class PolicyIn(BaseModel):
    """Юр-данные для шага «политика конфиденциальности» автонастройки."""
    legal_form: str = ""        # individual | ip | ooo | other
    legal_name: str = ""
    legal_inn: str = ""
    legal_address: str = ""
    legal_operator_email: str = ""
    legal_ogrn: str = ""
    legal_operator_phone: str = ""


@router.post("/policy", summary="Шаг 3: заполнить юр-данные и опубликовать политику")
async def setup_policy(data: PolicyIn, user=Depends(get_current_client),
                       db=Depends(get_db)):
    """Записывает юр-данные клиента и ПУБЛИКУЕТ политику за него.

    ⚠️⚠️ ПОЧЕМУ ЭТО ЧАСТЬ УСЛУГИ (решение владельца 16.09.2026). Политика
    обработки персональных данных нужна по 152-ФЗ любому, кто собирает контакты
    через бота и лендинг, — то есть каждому клиенту платформы. Раздел для неё в
    кабинете есть, но пустой: на 16.09.2026 из клиентов её не заполнил НИКТО
    (проверено по базе прода). Настройка «под ключ» ровно эту возню и убирает.

    ⚠️ ОПЕРАТОР — САМ КЛИЕНТ, по введённым им реквизитам. Его база, его
    ответственность. ПЛЮСОН и провайдер серверов идут отдельным пунктом как
    привлечённые к обработке по поручению.

    ⚠️ ТЕКСТ БЕРЁМ ОБЩИЙ (`services/privacy_policy.py`) — тот же, что вставляет
    кнопка в «Юридических данных». Своей версии здесь нет: две копии текста
    разошлись бы, и у клиентов оказались бы разные политики.

    ⚠️ ПУБЛИКУЕМ ТОЙ ЖЕ ручкой-логикой, что и кабинет: запись версии в
    `client_policy_versions` + отметка в `clients`. Иначе история версий, на
    которую ссылаются согласия контактов, поехала бы.
    """
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)

    form = (data.legal_form or "").strip()
    if form not in ("individual", "ip", "ooo", "other"):
        raise HTTPException(400, "Выберите форму: самозанятый, ИП, ООО или другая")
    name = (data.legal_name or "").strip()
    inn = (data.legal_inn or "").strip()
    address = (data.legal_address or "").strip()
    email = (data.legal_operator_email or "").strip()
    if not name:
        raise HTTPException(400, "Укажите название — например «ИП Пупкин Василий Иванович»")
    if not inn:
        raise HTTPException(400, "Укажите ИНН — он обязателен в политике")
    if not address:
        raise HTTPException(400, "Укажите адрес — он указывается в реквизитах оператора")
    if not email:
        raise HTTPException(400, "Укажите email оператора — на него люди шлют отзыв согласия")

    # Юр-данные — в тот же раздел кабинета, что и всегда.
    await db.execute(
        """UPDATE clients
              SET legal_form = $2, legal_name = $3, legal_inn = $4,
                  legal_address = $5, legal_operator_email = $6,
                  legal_ogrn = COALESCE(NULLIF($7, ''), legal_ogrn),
                  legal_operator_phone = COALESCE(NULLIF($8, ''), legal_operator_phone)
            WHERE id = $1""",
        client_id, form, name, inn, address, email,
        (data.legal_ogrn or "").strip(), (data.legal_operator_phone or "").strip(),
    )

    from app.services.privacy_policy import build_policy_text, hosting_from_settings

    row = await db.fetchrow(
        """SELECT legal_form, legal_name, legal_inn, legal_inn_label, legal_ogrn,
                  legal_address, legal_operator_email, legal_operator_phone,
                  privacy_policy_version
             FROM clients WHERE id = $1""",
        client_id,
    )
    text = build_policy_text(dict(row), hosting=await hosting_from_settings(db))
    version = (row["privacy_policy_version"] or 0) + 1

    async with db.transaction():
        await db.execute(
            "UPDATE clients SET privacy_policy_text = $2, "
            "       privacy_policy_version = $3, privacy_policy_published_at = NOW() "
            " WHERE id = $1",
            client_id, text, version,
        )
        await db.execute(
            """INSERT INTO client_policy_versions (client_id, version, text)
                    VALUES ($1, $2, $3)
               ON CONFLICT DO NOTHING""",
            client_id, version, text,
        )

    order_id = await db.fetchval(
        """SELECT id FROM service_orders
            WHERE client_id = $1 ORDER BY id DESC LIMIT 1""",
        client_id,
    )
    if order_id:
        await db.execute(
            "UPDATE service_orders SET policy_published_at = NOW(), "
            "       policy_skipped_at = NULL WHERE id = $1",
            order_id,
        )
        try:
            from app.tasks.tg_setup import _log_step
            await _log_step(db, order_id, "policy",
                            f"Политика конфиденциальности опубликована "
                            f"(версия {version}) — оператор: {name}. "
                            "Проверить: Настройки → «Юридические данные»")
        except Exception as e:  # noqa: BLE001
            logger.warning("tg_setup: не записал шаг политики: %s", e)

    logger.info("tg_setup: политика клиента %s опубликована, версия %s",
                client_id, version)
    return {"ok": True, "version": version,
            "message": "Политика опубликована"}


@router.post("/policy/skip", summary="Пропустить шаг с политикой")
async def skip_policy(user=Depends(get_current_client), db=Depends(get_db)):
    """Человек решил заполнить политику сам — не настаиваем, но помним.

    ⚠️ Отметку ставим, чтобы ИТОГ услуги сказал честно: «политику настройте
    самостоятельно». Без неё «пропустил» и «ещё не дошёл» выглядят одинаково, и
    человек уходит с мыслью, что у него всё готово по 152-ФЗ, — а это не так.
    """
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)

    order_id = await db.fetchval(
        "SELECT id FROM service_orders WHERE client_id = $1 ORDER BY id DESC LIMIT 1",
        client_id,
    )
    if not order_id:
        raise HTTPException(404, "Нет настройки")
    await db.execute(
        "UPDATE service_orders SET policy_skipped_at = NOW() WHERE id = $1", order_id
    )
    try:
        from app.tasks.tg_setup import _log_step
        await _log_step(db, order_id, "policy",
                        "Шаг с политикой пропущен — настройте её сами: "
                        "Настройки → «Юридические данные»")
    except Exception as e:  # noqa: BLE001
        logger.warning("tg_setup: не записал пропуск политики: %s", e)
    return {"ok": True, "skipped": True}


class SaveChannelIn(BaseModel):
    channel: str


@router.post("/save-channel", summary="Сохранить ник Telegram-канала основателя")
async def save_channel(data: SaveChannelIn, user=Depends(get_current_client),
                       db=Depends(get_db)):
    """Кладёт канал в «Каналы основателя» — ДО запуска настройки.

    ⚠️ Раньше канал принимался только вместе с запуском (`/start`), и поправить
    его отдельно было нечем: человек видел в форме поле, но сохранить не мог,
    пока не запустит услугу.

    ⚠️ ТОЛЬКО ПУБЛИЧНЫЙ КАНАЛ (по нику). У закрытого Telegram не отдаёт
    идентификатор, и проверка подписки на нём работать не будет — поэтому
    ссылку-приглашение здесь не принимаем.
    """
    client_id = int(user["sub"])
    nick = (data.channel or "").strip().lstrip("@").rstrip("/").split("/")[-1]
    if not nick:
        raise HTTPException(400, "Укажите ник канала")

    # ⚠️⚠️ ПРОВЕРЯЕМ, ЧТО ТАКОЙ КАНАЛ ВООБЩЕ СУЩЕСТВУЕТ И ЧТО ЭТО КАНАЛ.
    #
    # Поле принимало ЛЮБУЮ строку. На живом заказе 12 (клиент 196) человек
    # вписал `margoforbs_bot` вместо `margoforbs_business` — то есть ник БОТА
    # вместо канала, причём несуществующий (`chat not found`). Система молча
    # это сохранила, а потом шаг «добавьте бота в канал» отбивал раз за разом:
    # бот был админом настоящего канала, но искали его в том, которого нет.
    #
    # Ошибку надо ловить здесь, на вводе, а не через полчаса непонятными
    # отказами на другом шаге.
    err = await _check_channel_exists(db, client_id, nick)
    if err:
        raise HTTPException(400, err)

    await _save_founder_channel(db, client_id, nick)
    return {"ok": True, "channel": nick}


async def _founder_channel_nick(db, client_id: int) -> str:
    """Ник первого канала основателя из профиля клиента (без «@»).

    ⚠️ Нужен, чтобы говорить в ошибках КОНКРЕТНО: «не видим бота в канале
    @такой-то», а не «в канале». Человек должен видеть, какой именно ник у нас
    записан, — именно там и была ошибка на заказе 12.
    """
    try:
        from app.services.social_links import get_founder_tg_channels
        social = await db.fetchval(
            "SELECT social_links FROM clients WHERE id=$1", client_id)
        if isinstance(social, str):
            social = json.loads(social or "{}")
        for ch in get_founder_tg_channels(social or {}):
            nick = (ch.get("url") or "").rstrip("/").split("/")[-1].lstrip("@")
            if nick and not nick.startswith("+"):
                return nick
    except Exception as e:  # noqa: BLE001 — без ника просто скажем общими словами
        logger.warning("tg_setup: ник канала клиента %s не прочитан: %s",
                       client_id, e)
    return ""


async def _check_channel_exists(db, client_id: int, nick: str) -> Optional[str]:
    """Существует ли такой публичный канал. Возвращает текст ошибки или None.

    ⚠️ Fail-safe: нет токена бота или Telegram не ответил — НЕ мешаем сохранить.
    Лучше пропустить сомнительный ник, чем заблокировать человека с настоящим
    каналом из-за нашей сетевой проблемы.
    """
    token = await db.fetchval(
        """SELECT bot_token FROM service_orders
            WHERE client_id = $1 AND bot_token IS NOT NULL
            ORDER BY id DESC LIMIT 1""",
        client_id,
    )
    if not token:
        # Бота ещё нет (канал спрашивают до запуска) — спросить некому.
        return None
    try:
        import httpx
        async with httpx.AsyncClient(timeout=15) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{token}/getChat",
                params={"chat_id": f"@{nick}"},
            )
            data = r.json() or {}
            if not data.get("ok"):
                return (
                    f"Канал @{nick} не найден в Telegram. Проверьте ник: он "
                    "пишется как в адресе канала (t.me/ваш_канал) и без «bot» "
                    "на конце — это ник КАНАЛА, а не бота."
                )
            kind = (data.get("result") or {}).get("type")
            if kind not in ("channel", "supergroup"):
                return (
                    f"@{nick} — это не канал, а {kind or 'другой чат'}. "
                    "Укажите ник вашего публичного Telegram-канала."
                )
    except Exception as e:  # noqa: BLE001 — сеть подвела: не мешаем сохранить
        logger.warning("tg_setup: не проверил канал @%s: %s", nick, e)
    return None


@router.post("/confirm-channel", summary="Клиент подтверждает, что добавил бота в свой канал")
async def confirm_channel(user=Depends(get_current_client), db=Depends(get_db)):
    """Отметка «я добавил бота в свой канал» — руками, кнопкой в кабинете.

    ⚠️ ЗАЧЕМ, ЕСЛИ ЕСТЬ АВТОМАТИКА. Добавление бота в канал платформа ловит
    апдейтом `my_chat_member` — но только пока бот СЛУШАЕТСЯ процессом
    `plusson-bot`, а список ботов там читается один раз при старте. Бот услуги
    создан позже, и до перезапуска сервиса его апдейты до нас не доходят: у
    клиента 176 ровно так и вышло — бот в канал добавлен, а отметки нет и
    сказать об этом нечем.

    Поэтому шаг подтверждается и вручную, как заход в бота и вступление в
    группу. Автоматика остаётся: сработала раньше — отметка уже стоит.

    ⚠️⚠️ НО НА СЛОВО НЕ ВЕРИМ — СПРАШИВАЕМ У TELEGRAM.
    Раньше нажатие просто ставило галочку, и человек уходил в уверенности, что
    рассылки в канал заработают, — а бот мог быть добавлен без прав или не
    добавлен вовсе. Проверяем по-настоящему и отвечаем прямо: подтвердили или
    подтвердить не удалось (тогда — в службу заботы).
    """
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)

    order = await db.fetchrow(
        """SELECT id, bot_token, bot_username, channel_linked_at
             FROM service_orders
            WHERE client_id = $1 AND setup_state IN ('awaiting_user', 'done')
            ORDER BY id DESC LIMIT 1""",
        client_id,
    )
    if not order:
        raise HTTPException(404, "Нет настройки, ожидающей ваших действий")
    if order["channel_linked_at"]:
        return {"ok": True, "already": True, "verified": True}

    found = await _find_bot_channel(db, client_id, order["bot_token"] or "")

    if not found:
        # ⚠️ Отметку НЕ ставим: иначе шаг выглядел бы выполненным, а рассылки в
        # канал молча не работали бы. Честный ответ лучше зелёной галочки.
        #
        # ⚠️⚠️ ГОВОРИМ КОНКРЕТНО: КАКОЙ БОТ, В КАКОЙ КАНАЛ (16.09.2026).
        # Общее «бот не в админах канала» не помогает вовсе: у человека
        # несколько ботов и каналов, и он не понимает, что именно проверять.
        # На живом заказе 12 в профиле вообще стоял НЕ ТОТ ник — а сообщение
        # об этом молчало, и человек по кругу добавлял бота в правильный
        # канал, получая один и тот же отказ.
        bot = (order["bot_username"] or "ваш бот").lstrip("@")
        chan = await _founder_channel_nick(db, client_id)
        where = f"в канал @{chan}" if chan else "в ваш канал"
        return {
            "ok": False,
            "verified": False,
            # Ник канала отдаём отдельно — экран покажет его в поле для правки.
            "channel": chan or "",
            "message": (
                f"Не видим бота @{bot} среди администраторов {where}. "
                f"Проверьте два момента: 1) правильно ли указан канал — "
                f"{'сейчас записан @' + chan if chan else 'он не указан'}; "
                f"2) добавлен ли @{bot} администратором с правом «Публикация "
                f"сообщений». Ник канала можно поправить прямо здесь."
            ),
        }

    await db.execute(
        "UPDATE service_orders SET channel_linked_at = NOW(), updated_at = NOW() "
        " WHERE id = $1",
        order["id"],
    )
    logger.info("tg_setup: бот клиента %s подтверждён в канале %s (%s)",
                client_id, found.get("title"), found.get("chat_id"))
    return {
        "ok": True,
        "already": False,
        "verified": True,
        "chat_title": found.get("title"),
        "message": f"Бот подтверждён администратором канала "
                   f"«{found.get('title') or 'без названия'}» — рассылки в канал заработают.",
    }


async def _resolve_channel_id(db, client_id: int, nick: str) -> int | None:
    """Числовой id публичного канала по его нику — через `getChat`.

    ⚠️⚠️ ID НУЖЕН ОБЯЗАТЕЛЬНО. Без него проверка подписки в воронках работать
    не может: `getChatMember` принимает `@ник` только у публичных каналов, а
    хранить сам id надёжнее — ник могут сменить.

    ⚠️ Спрашиваем ЛЮБЫМ ботом клиента, а не только ботом услуги: на момент
    запуска бот услуги ещё не создан. Бот при этом не обязан быть в канале —
    для публичного канала `getChat` по нику отвечает и постороннему боту
    (проверено на живом канале).
    """
    try:
        from app.services.channels import get_client_telegram_token
        token = await get_client_telegram_token(client_id, db)
        if not token:
            return None
        import httpx
        async with httpx.AsyncClient(timeout=15) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{token}/getChat",
                params={"chat_id": f"@{nick}"},
            )
            res = (r.json() or {}).get("result") or {}
            cid = res.get("id")
            return int(cid) if cid else None
    except Exception as e:  # noqa: BLE001
        logger.warning("tg_setup: не резолвится канал @%s клиента %s: %s",
                       nick, client_id, e)
    return None


async def _save_founder_channel(db, client_id: int, nick: str) -> None:
    """Кладёт канал клиента в «Каналы основателя» (`clients.social_links`).

    ⚠️⚠️ ЭТО НЕ ТО ЖЕ, ЧТО «Каналы для рассылок». Два разных места под каналы,
    и путать их нельзя:
      • `clients.social_links.telegram_channels` — по ним идёт ПРОВЕРКА ПОДПИСКИ
        в воронках лид-магнитов (`get_founder_tg_channels`) и гейт в чатах;
      • `client_broadcast_chats` — КУДА РАССЫЛАТЬ.
    Автонастройка раньше не заполняла первое вовсе: после «настройки под ключ»
    у клиента оставался пустой `social_links`, и проверка подписки в воронках
    проверять было нечего.

    ⚠️ Не перетираем уже заведённые каналы — только дописываем свой, если его
    там ещё нет: у клиента их может быть несколько.
    """
    try:
        from app.services.social_links import (
            normalize_telegram_link, normalize_telegram_channels,
        )
        # ⚠️ Клиент вводит ГОЛЫЙ НИК (символ @ уже стоит в форме) — ссылку
        # собираем сами, чтобы в настройках лежал канонический вид, как во
        # всём проекте: https://t.me/ник.
        link = normalize_telegram_link(nick)
        if not link:
            return

        # ⚠️ Числовой id резолвим сразу: по нему работает проверка подписки, и
        # он переживает смену ника. Не резолвится — канал всё равно записываем
        # (человек увидит его в настройках), но без id.
        chat_id = await _resolve_channel_id(db, client_id, nick)

        social = await db.fetchval(
            "SELECT COALESCE(social_links, '{}'::jsonb) FROM clients WHERE id=$1",
            client_id,
        )
        if isinstance(social, str):
            social = json.loads(social)
        social = dict(social or {})

        channels = normalize_telegram_channels(social.get("telegram_channels") or [])
        same = link.rstrip("/").lower()
        if not any((c.get("url") or "").rstrip("/").lower() == same for c in channels):
            channels.append({
                "url": link,
                "chat_id": str(chat_id) if chat_id else None,
                "name": "",
            })
            social["telegram_channels"] = channels
            await db.execute(
                "UPDATE clients SET social_links = $2::jsonb WHERE id = $1",
                client_id, json.dumps(social, ensure_ascii=False),
            )
            logger.info("tg_setup: канал %s (id=%s) записан в каналы основателя "
                        "клиента %s", link, chat_id, client_id)

        # ⚠️⚠️ И В КАРТОЧКУ ОСНОВАТЕЛЯ (self-коллаб) — это ВТОРОЕ место, где
        # живёт канал, и по нему идёт проверка подписки на события
        # (`subscription_check.py` читает `collaborators.tg_channel_id`).
        # Заполнить одно и забыть второе — значит оставить половину проверок
        # неработающими, а внешне всё будет выглядеть настроенным.
        from app.services.self_collaborator import ensure_self_collaborator
        collab_id = await ensure_self_collaborator(db, client_id)
        if collab_id:
            await db.execute(
                """UPDATE collaborators
                      SET tg_channel_url = COALESCE(NULLIF(tg_channel_url,''), $2),
                          tg_channel_id  = COALESCE(NULLIF(tg_channel_id,''), $3)
                    WHERE id = $1""",
                collab_id, link, str(chat_id) if chat_id else None,
            )
    except Exception as e:  # noqa: BLE001
        # Fail-safe: настройка не должна падать из-за канала.
        logger.warning("tg_setup: не записал канал основателя клиенту %s: %s",
                       client_id, e)


async def _find_bot_channel(db, client_id: int, bot_token: str) -> dict | None:
    """Проверяет, что бот РЕАЛЬНО админ в канале клиента.

    ⚠️⚠️ ИЩЕМ В ДВУХ МЕСТАХ: сначала база, потом очередь апдейтов Telegram.

    Добавление бота ловит штатный обработчик `on_bot_added_to_channel` и кладёт
    канал в `client_broadcast_chats`. Но доходит апдейт, только пока бот в
    поллинге, а список ботов `plusson-bot` читает ОДИН раз при старте: бот
    услуги создан позже — и апдейт до нас не доходит вовсе.

    Ровно так и вышло на живом заказе 09.09.2026: бот создан в 14:29, поллер
    стартовал в 14:02. Клиент добавил бота в свой канал, а проверка отвечала
    «не удалось подтвердить» — потому что смотрела только в пустую базу.
    Апдейт при этом ЛЕЖАЛ в очереди Telegram и ждал.

    ⚠️ Очередь читаем ТОЛЬКО когда в базе пусто, и БЕЗ `offset` — то есть не
    подтверждаем получение. Иначе апдейты пропали бы для поллера, когда бот в
    него всё-таки попадёт (Telegram отдаёт их одному получателю).

    ⚠️ Права в любом случае перепроверяем `getChatMember`: между добавлением и
    нажатием кнопки их могли снять. У КАНАЛА нужен ещё и `can_post_messages` —
    без него бот числится админом, но публиковать не может, и рассылка молча
    не уходит.
    """
    if not bot_token:
        return None
    try:
        # ⚠️ Группу уведомлений исключаем: её создали мы сами, к каналам
        # клиента она отношения не имеет и в рассылки не идёт.
        rows = await db.fetch(
            """SELECT cbc.chat_id, cbc.title
                 FROM client_broadcast_chats cbc
                WHERE cbc.client_id = $1 AND cbc.platform = 'telegram'
                  AND cbc.is_active = TRUE
                  AND NOT EXISTS (
                        SELECT 1 FROM service_orders so
                         WHERE so.group_chat_id::text = cbc.chat_id)
                ORDER BY cbc.id DESC""",
            client_id,
        )
        import httpx
        bot_id = bot_token.split(":", 1)[0]
        # Кандидаты: сначала база, затем — очередь апдейтов (см. докстринг).
        candidates: list[tuple[str, str]] = [
            (r["chat_id"], r["title"] or "") for r in rows
        ]

        # ⚠️⚠️ КАНАЛ ОСНОВАТЕЛЯ — ПЕРВЫЙ И САМЫЙ ПРЯМОЙ КАНДИДАТ (16.09.2026).
        #
        # Раньше искали только в базе рассылок и в очереди апдейтов. Но апдейт
        # `my_chat_member` приходит ОДИН раз и только пока его кто-то читает:
        # бот услуги в поллинг `plusson-bot` не попадает, а нашу очередь мог
        # вычитать предыдущий вызов проверки. В итоге бот РЕАЛЬНО админ канала,
        # а проверка отвечает «не удалось подтвердить» — поймано на живом
        # заказе 11: getChatMember вручную вернул `administrator` +
        # `can_post_messages: true`, при этом кнопка отбивала.
        #
        # Канал основателя записан у клиента в профиле (его спрашивают на
        # первом шаге услуги) — по нему можно спросить Telegram НАПРЯМУЮ, без
        # всяких апдейтов. Это и делаем, первым делом.
        try:
            from app.services.social_links import get_founder_tg_channels
            social = await db.fetchval(
                "SELECT social_links FROM clients WHERE id=$1", client_id)
            if isinstance(social, str):
                social = json.loads(social or "{}")
            for ch in get_founder_tg_channels(social or {}):
                nick = (ch.get("url") or "").rstrip("/").split("/")[-1].lstrip("@")
                cid = ch.get("chat_id")
                # Числовой id знаем — берём его; иначе спросим по нику.
                if cid:
                    candidates.insert(0, (str(cid), ch.get("name") or ""))
                elif nick and not nick.startswith("+"):
                    candidates.insert(0, (f"@{nick}", ch.get("name") or ""))
        except Exception as e:  # noqa: BLE001 — не нашли, идём прежним путём
            logger.warning("tg_setup: канал основателя не прочитан: %s", e)

        async with httpx.AsyncClient(timeout=20) as http:
            if not candidates:
                # ⚠️ БЕЗ `offset` — получение не подтверждаем, апдейты остаются
                # в очереди для поллера, когда бот в него попадёт.
                u = await http.get(
                    f"https://api.telegram.org/bot{bot_token}/getUpdates",
                    params={"allowed_updates": '["my_chat_member"]', "limit": 100},
                )
                seen: set[str] = set()
                for upd in reversed((u.json() or {}).get("result") or []):
                    chat = (upd.get("my_chat_member") or {}).get("chat") or {}
                    cid, ctype = chat.get("id"), chat.get("type")
                    if not cid or ctype not in ("channel", "supergroup", "group"):
                        continue
                    # Группу уведомлений пропускаем — она не канал клиента.
                    is_ours = await db.fetchval(
                        "SELECT EXISTS(SELECT 1 FROM service_orders "
                        " WHERE group_chat_id = $1)", int(cid),
                    )
                    if is_ours or str(cid) in seen:
                        continue
                    seen.add(str(cid))
                    candidates.append((str(cid), chat.get("title") or ""))

            for chat_id, title in candidates:
                m = await http.get(
                    f"https://api.telegram.org/bot{bot_token}/getChatMember",
                    params={"chat_id": chat_id, "user_id": bot_id},
                )
                res = (m.json() or {}).get("result") or {}
                status = res.get("status", "")
                if status not in ("administrator", "creator"):
                    continue
                # У канала право публикации отдельным тумблером; у создателя оно есть всегда.
                if status != "creator" and res.get("can_post_messages") is False:
                    continue

                # ⚠️⚠️ В БАЗУ — ТОЛЬКО ЧИСЛОВОЙ id. Кандидат мог прийти ником
                # (`@channel`) из каналов основателя: по нику рассылка не
                # уйдёт — `client_broadcast_chats.chat_id` читают отправщики,
                # которым нужен id. Спрашиваем его у Telegram тем же запросом.
                real_id, real_title = str(chat_id), title
                if str(chat_id).startswith("@"):
                    try:
                        g = await http.get(
                            f"https://api.telegram.org/bot{bot_token}/getChat",
                            params={"chat_id": chat_id},
                        )
                        gr = (g.json() or {}).get("result") or {}
                        if gr.get("id"):
                            real_id = str(gr["id"])
                            real_title = real_title or gr.get("title") or ""
                    except Exception as e:  # noqa: BLE001
                        logger.warning("tg_setup: id канала %s не получен: %s",
                                       chat_id, e)
                    # Числовой id не узнали — записывать ник нельзя.
                    if real_id.startswith("@"):
                        continue

                # ⚠️ Найденный канал записываем в базу рассылок — иначе он
                # потеряется: поллер этот апдейт уже не обработает.
                await db.execute(
                    """INSERT INTO client_broadcast_chats
                           (client_id, platform, chat_id, title, added_via,
                            is_active, use_for_broadcasts)
                       VALUES ($1, 'telegram', $2, $3, 'manual', TRUE, TRUE)
                       ON CONFLICT (client_id, platform, chat_id) DO UPDATE
                           SET is_active = TRUE, updated_at = NOW()""",
                    client_id, real_id, real_title or None,
                )
                return {"chat_id": real_id, "title": real_title}
    except Exception as e:  # noqa: BLE001
        logger.warning("tg_setup: проверка канала клиента %s не удалась: %s",
                       client_id, e)
    return None


@router.post("/transfer-now", summary="Передать права на бота и группу прямо сейчас")
async def transfer_now(user=Depends(get_current_client), db=Depends(get_db)):
    """Кнопка «Передать права мне» — запускает передачу немедленно.

    ⚠️ ЗАЧЕМ ОТДЕЛЬНАЯ КНОПКА. Передачу и так делает фоновая задача, но она
    ходит РАЗ В МИНУТУ и только по своим условиям. Человек, отметивший шаги,
    смотрит в экран и не понимает, ждать ему или что-то сломалось. Кнопка даёт
    явное действие и мгновенный ответ.

    ⚠️ Своей ЛОГИКИ передачи здесь нет — только «разбудить» задачу: она уже
    умеет и передавать бота, и назначать админа группы, и писать в лог. Вторая
    реализация неминуемо разошлась бы с первой.

    ⚠️ Передать бота можно ТОЛЬКО после того, как человек написал ему: это
    требование Telegram, получателя иначе не выбрать. Поэтому проверяем отметку
    и объясняем причину, а не молча ничего не делаем.
    """
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)

    order = await db.fetchrow(
        # ⚠️ Ищем и в состоянии `failed`: после двух неудач настройка
        # останавливается, и кнопка «Передать мне» — единственный способ
        # повторить. Без этого она отвечала бы «нет настройки» именно тогда,
        # когда нужна больше всего.
        """SELECT id, client_started_bot_at, bot_transferred_at, bot_created_at,
                  group_transferred_at, client_joined_at
             FROM service_orders
            WHERE client_id = $1 AND setup_state IN ('awaiting_user', 'failed')
            ORDER BY id DESC LIMIT 1""",
        client_id,
    )
    if not order:
        raise HTTPException(404, "Нет настройки, ожидающей ваших действий")
    # ⚠️⚠️ «БОТ ПЕРЕДАН» ≠ «ВСЁ ГОТОВО» (17.09.2026). Здесь стоял безусловный
    # выход `already: True`, и заказ, у которого бот уже у клиента, а права на
    # ГРУППУ не отданы, доделать было нечем: кнопка отвечала «и так всё»,
    # фоновая задача стояла после двух неудач. Ровно так завис заказ 8 —
    # бот передан 16.09 в 12:24, а админом в группе человек не стал.
    if order["bot_transferred_at"] and order["group_transferred_at"]:
        return {"ok": True, "already": True}
    # ⚠️ Требование «сначала напишите боту» — про ПЕРЕДАЧУ БОТА: Telegram не
    # даёт выбрать получателя, который боту не писал. К правам на группу оно
    # отношения не имеет, поэтому когда бот уже передан — не мешаем доделать
    # группу этой проверкой.
    if not order["bot_transferred_at"] and not order["client_started_bot_at"]:
        raise HTTPException(
            400,
            "Сначала зайдите в бота и нажмите «Запустить», иначе Telegram "
            "не даст передать вам права — и отметьте шаг галочкой",
        )

    # ⚠️ Снимаем стоп: после неудачной передачи задача записывает причину в
    # `setup_error` и БОЛЬШЕ НЕ ПОВТОРЯЕТ — иначе она долбилась бы в BotFather
    # каждую минуту (на живом заказе так вышло 51 попытка подряд), а за это
    # Telegram ограничивает аккаунт. Повтор — только по явному нажатию человека.
    # ⚠️ Возвращаем настройку в рабочее состояние и обнуляем счётчик попыток:
    # человек нажал осознанно, значит это новая попытка, а не продолжение
    # прежней серии. Иначе после двух неудач кнопка была бы бесполезна —
    # задача осталась бы в `failed` и не взялась бы за работу.
    await db.execute(
        "UPDATE service_orders "
        "   SET setup_error = NULL, transfer_attempts = 0, "
        "       setup_state = 'awaiting_user', updated_at = NOW() "
        " WHERE id = $1",
        order["id"],
    )

    # ⚠️ Ставим задачу в очередь, а не выполняем здесь: разговор с BotFather —
    # это переписка с паузами на десятки секунд, HTTP-запрос из браузера
    # столько не ждёт и отвалится по таймауту.
    from app.celery_app import celery
    celery.send_task("app.tasks.tg_setup.tick")
    logger.info("tg_setup: клиент %s запросил передачу прав вручную", client_id)
    return {"ok": True, "started": True}


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

    # ─────────────────────────────────────────────────────────────────────
    # Три обязательных поля — записываем ПЕРВЫМ ДЕЛОМ, до создания заказа.
    #
    # ⚠️⚠️ ЭТО САМАЯ БЕЗОПАСНАЯ ЧАСТЬ УСЛУГИ, И ОНА ИДЁТ ПЕРВОЙ.
    # Расстановка полей по кабинету ничего не создаёт во внешнем мире (бота,
    # группу), ничего не расходует (лимит BotFather на `/newbot` суточный) и
    # не может «наполовину получиться». Раньше служба заботы прописывалась в
    # самом конце прогона — после бота и группы: если BotFather упирался в
    # лимит, человек не получал ВООБЩЕ НИЧЕГО, хотя три поля можно было
    # заполнить мгновенно.
    #
    # ⚠️ Пишем только в ПУСТОЕ поле службы заботы: у части клиентов поддержку
    # ведёт отдельный аккаунт, и затирать его настройку нельзя (то же правило,
    # что в `_run_setup`).
    # ─────────────────────────────────────────────────────────────────────
    own_nick = (data.telegram_username or "").strip().lstrip("@")
    if own_nick:
        await db.execute(
            "UPDATE clients SET telegram_username = $2 WHERE id = $1",
            client_id, own_nick,
        )

    tg_nick = own_nick or await db.fetchval(
        "SELECT telegram_username FROM clients WHERE id=$1", client_id
    )
    if not tg_nick:
        raise HTTPException(
            400,
            "Укажите свой ник в Telegram — без него мы не сможем передать "
            "вам права на бота и группу",
        )
    # ⚠️ В базе ник мог осесть со «собакой» или ссылкой (`t.me/ник`) — чистим
    # ОДИН раз здесь, иначе он так и уходит в лог и в BotFather.
    tg_nick = str(tg_nick).strip().lstrip("@").rstrip("/").split("/")[-1]

    # ⚠️⚠️ ЮЗЕРНЕЙМ ПРОВЕРЯЕМ НА ВХОДЕ, А НЕ НА ПРЕДПОСЛЕДНЕМ ШАГЕ.
    # BotFather принимает только @username, поэтому без публичного ника услуга
    # невыполнима целиком. Раньше это выяснялось в самом конце — после оплаты,
    # создания бота и группы: человек проходил половину пути и упирался в
    # стену, которую было видно с первой секунды.
    nick_err = tgs.validate_owner_username(tg_nick)
    if nick_err:
        raise HTTPException(400, nick_err)

    # ⚠️⚠️ ПОЧТА ДОЛЖНА БЫТЬ ПОДТВЕРЖДЕНА ДО ЗАПУСКА (решение владельца).
    # Через пару минут настройка упрётся в шаг, который делает сам человек:
    # зайти в бота и принять права. Позвать его туда можно только письмом — в
    # боте его ещё нет, а кабинет он к тому времени обычно закрыл. Непроверенный
    # адрес = звать некуда: бот повисит 3 дня, займёт слот и сгорит.
    #
    # ⚠️ Проверка на СЕРВЕРЕ, а не только на экране: кнопку легко обойти
    # обычным запросом мимо интерфейса.
    email_ok = await db.fetchrow(
        "SELECT email, email_verified FROM clients WHERE id=$1", client_id
    )
    if not email_ok or not email_ok["email_verified"]:
        raise HTTPException(
            400,
            "Сначала подтвердите почту — на неё мы пришлём ссылку на бота, "
            "когда настройка дойдёт до передачи прав. Письмо со ссылкой "
            "подтверждения уже у вас; если не нашли — отправьте заново "
            "в плашке вверху кабинета.",
        )

    # Служба заботы: наружу ник, в базе — ссылка (так это поле заполняется
    # во всём проекте, см. `tg_support_link`).
    support_nick = (data.support_username or "").strip().lstrip("@")
    support_kept = False
    if support_nick:
        from app.services.support_message import tg_support_link
        link = tg_support_link(support_nick)
        if link:
            filled = await db.fetchval(
                """UPDATE clients SET work_tg_username = $2
                    WHERE id = $1 AND COALESCE(work_tg_username, '') = ''
                RETURNING id""",
                client_id, link,
            )
            support_kept = not filled

    username = data.bot_username.strip().lstrip("@")
    title = (data.bot_title or "").strip() or username

    # ⚠️ Канал записываем СРАЗУ, до создания заказа: он нужен не настройке, а
    # самому клиенту (проверка подписки в воронках), и не должен зависеть от
    # того, чем закончится прогон.
    channel_nick = (data.channel_url or "").strip().lstrip("@")
    if channel_nick:
        # ⚠️ Ссылку вместо ника не принимаем молча: у закрытого канала id не
        # получить, и «настройка» вышла бы бутафорской. Скажем прямо.
        if "/" in channel_nick or "+" in channel_nick:
            raise HTTPException(
                400,
                "Укажите никнейм публичного канала без ссылки — например "
                "my_channel. У закрытого канала Telegram не отдаёт "
                "идентификатор, и проверка подписки на нём работать не будет.",
            )
        await _save_founder_channel(db, client_id, channel_nick)

    # Что записать в лог заказа первыми строками — чтобы человек видел, ЧТО
    # уже сделано и КУДА это легло, ещё до создания бота.
    prelog = [
        ("fields_own",
         f"Ваш Telegram записан в профиль: @{tg_nick} — на этот аккаунт "
         "передадим права на бота и группу. "
         "Проверить: Настройки → «Профиль»"),
    ]
    if support_nick:
        prelog.append((
            "fields_support",
            "Служба заботы уже была заполнена — оставили вашу настройку. "
            "Проверить: Настройки → «Профиль»"
            if support_kept else
            f"Служба заботы записана: @{support_nick} — заработают "
            "«Тех. поддержка» в боте и на лендинге. "
            "Проверить: Настройки → «Профиль»",
        ))
    if channel_nick:
        prelog.append((
            "fields_channel",
            f"Канал @{channel_nick} записан в «Каналы основателя» — "
            "по нему заработает проверка подписки в воронках подарков. "
            "Проверить: Mini App → «Основатель»",
        ))

    async def _write_prelog(order_id: int) -> None:
        """Кладёт записи о расставленных полях первыми строками лога заказа.

        ⚠️ Пишем ПОСЛЕ создания (или перезапуска) заказа, но ДО того, как его
        возьмёт поллер: лог принадлежит заказу, и раньше его записать некуда.
        При перезапуске лог обнуляется (`setup_log='[]'`) — значит эти строки
        встанут первыми и там.
        """
        import json
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc).isoformat()
        rows = [{"step": k, "text": t, "ok": True, "at": now} for k, t in prelog]
        if not rows:
            return
        await db.execute(
            """UPDATE service_orders
                  SET setup_log = COALESCE(setup_log, '[]'::jsonb) || $2::jsonb
                WHERE id = $1""",
            order_id, json.dumps(rows, ensure_ascii=False),
        )

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
        await _write_prelog(existing["id"])
        _kick_queue()
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
        # ⚠️ Бесплатная выдача (по промокоду) — тоже пишем первые строки лога.
        # Раньше они появлялись только при перезапуске, и человек, запускающий
        # услугу впервые, не видел расставленных полей вовсе.
        await _write_prelog(order_id)
        _kick_queue()
        return {"ok": True, "order_id": order_id, "paid": True,
                "message": "Настройка началась"}

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
            # Для v2 (когда карточки нет) — название и цена услуги из базы.
            title=svc["name"],
            price=svc["price"],
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
    # ⚠️ Человек только что оплатил и смотрит на экран — начинаем сразу, а не
    # через минуту. Если имя бота ещё не введено, будить очередь незачем.
    if next_state == "queued":
        _kick_queue()
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
