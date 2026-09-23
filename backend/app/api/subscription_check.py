"""
Публичный API для проверки подписки участника на каналы спикеров/организаторов
события (конференция и мероприятие) при попытке войти в чат события.

GET/POST /api/v1/public/conference/{event_id}/check-subscription?tg_id=...

Логика per канал:
1) Шаг А — VIABILITY: getChatMember(channel, speaker.personal_tg_id).
   Спикер/организатор гарантированно подписан на свой канал. Если ответ ok и
   статус ∈ {creator, administrator, member, restricted} — бот реально админ
   и видит подписки. Иначе (бот не админ / канал недоступен / personal_tg_id
   пустой) — «ложный пропуск», канал кладём в subscribed снизу с галочкой,
   участника не блокируем.
2) Шаг Б — USER CHECK: getChatMember(channel, user_tg_id). Подписан → в
   subscribed, не подписан → в not_subscribed.

`bot_in_channel` в БД — диагностический флаг для дашборда клиента, к рантайм-
логике не относится: проверяем «вживую» каждый раз. Если спикер случайно убрал
бота из админов — мы автоматически перестанем требовать его канал у участников,
а вернёт админа — снова подключим. Никаких ручных пере-нажиманий.

Ответ:
{
  "status": 1 | 0,                       // 1 если not_subscribed пустой
  "not_subscribed": [{...}],             // показывать наверху (требует подписки)
  "subscribed":     [{...}],             // показывать внизу с галочкой (включая ложные пропуски)
  "not_subscribed_text": "имя: url\n..." // legacy-поле для текстового вывода
}
"""
import asyncio
import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from app.config import settings
from app.database import get_db
from app.services.person_name import DISPLAY_NAME_SQL
import asyncpg

router = APIRouter(prefix="/api/v1/public", tags=["Публичные API"])


class SubscriptionCheckBody(BaseModel):
    tg_id: str

    def tg_id_int(self) -> int:
        return int(self.tg_id)


_SUBSCRIBED_STATUSES = ("member", "administrator", "creator", "restricted")


async def _get_chat_member(client: httpx.AsyncClient, token: str, channel_id: str, user_id: int) -> tuple[bool, str]:
    """Возвращает (ok, status). ok=False означает что Telegram не дал данных
    (бот не админ / канал недоступен / сетевой сбой). status — пустая строка
    при ok=False, иначе строка от Telegram."""
    try:
        r = await client.get(
            f"https://api.telegram.org/bot{token}/getChatMember",
            params={"chat_id": channel_id, "user_id": user_id},
            timeout=5.0,
        )
        data = r.json()
        if not data.get("ok"):
            return False, ""
        status = (data.get("result") or {}).get("status") or ""
        return True, status
    except Exception:
        return False, ""


async def _check_one_channel(
    http: httpx.AsyncClient,
    token: str,
    channel_id: str,
    speaker_personal_tg_id: int | None,
    user_tg_id: int,
) -> str:
    """Возвращает одну из меток: 'subscribed' | 'not_subscribed' | 'fake_pass'.

    fake_pass — бот не видит канал, пропускаем участника без проверки.
    """
    # ⚠️⚠️ «БОТ ВИДИТ ПОДПИСЧИКОВ?» — СПРАШИВАЕМ ПРО САМОГО БОТА.
    #
    # Раньше спрашивали про ВЛАДЕЛЬЦА канала: он на свой канал подписан
    # наверняка, значит ответ Telegram косвенно доказывал, что бот админ.
    # Но идентификатор владельца («ID личного аккаунта») к проверке подписки
    # отношения не имеет и у многих просто не заполнен — и тогда проверка
    # молча пропускала ВСЕХ. Так у коллаб-события человек видел «✅ вы
    # подписаны» на канал, где его нет.
    #
    # Бот знает свой номер из токена — это надёжнее и не зависит от того,
    # заполнил ли кто-то поле в карточке.
    try:
        bot_id = int(token.split(":", 1)[0])
    except (ValueError, AttributeError):
        return "fake_pass"

    viability_ok, bot_status = await _get_chat_member(http, token, channel_id, bot_id)
    if not viability_ok or bot_status not in ("administrator", "creator"):
        # Бот не админ / удалён / канал недоступен → подписки не видит.
        # Пропускаем участника, не блокируем из-за чужой ненастройки.
        return "fake_pass"

    user_ok, user_status = await _get_chat_member(http, token, channel_id, user_tg_id)
    if user_ok and user_status in _SUBSCRIBED_STATUSES:
        return "subscribed"
    return "not_subscribed"


async def _check_collab_owners(event_id: int, tg_id: int, db: asyncpg.Connection,
                               first_client_id: int | None = None):
    """Коллаб-событие с рычагом require_subscribe_all_owners: участник должен быть
    подписан на TG-каналы каналов-основателей ВСЕХ организаторов (event_owners).

    ⚠️ У каждого организатора СВОЙ VIP-бот и СВОЙ канал — getChatMember канала
    надо звать ЕГО ботом (который админ его канала), не одним общим токеном.
    Возвращает {not_subscribed[], subscribed[]} (формат как у спикеров)."""
    from app.services.channels import get_client_telegram_token
    owners = await db.fetch(
        """SELECT eo.client_id,
                  -- ⚠️ ПОДПИСЫВАЕМ ЧЕЛОВЕКОМ: «Имя Фамилия (@ник)».
                  -- Названия канала у карточки коллаба нет — там только ссылка
                  -- и номер. Раньше сюда подставлялось имя/бренд КЛИЕНТА, и в
                  -- одном списке оказывались вперемешку имя человека и название
                  -- канала из профиля — один канал выходил дважды под разными
                  -- подписями.
                  TRIM(COALESCE(col.name,'') || ' ' || COALESCE(col.last_name,'')) AS name,
                  col.tg_channel_id, col.tg_channel_url,
                  pu.platform_user_id AS personal_tg_id
             FROM event_owners eo
             JOIN clients cl ON cl.id = eo.client_id
             LEFT JOIN collaborators col ON col.id = cl.self_collaborator_id
             LEFT JOIN platform_users pu
               ON pu.contact_id = col.contact_id AND pu.platform_slug = 'telegram'
            WHERE eo.event_id = $1 AND eo.status = 'accepted'
              AND col.tg_channel_id IS NOT NULL AND col.tg_channel_id <> ''""",
        event_id)

    # ⚠️ ПЕРВЫМ — КАНАЛ ВЛАДЕЛЬЦА ТОГО БОТА, В КОТОРОМ ЧЕЛОВЕК СЕЙЧАС.
    # Он пришёл к конкретному организатору и знает именно его; чужой канал
    # первой строкой читается как «подпишитесь непонятно на кого». Порядок
    # строк в event_owners (кто раньше принял приглашение) тут ни при чём.
    if first_client_id:
        owners = sorted(owners, key=lambda o: o["client_id"] != first_client_id)

    not_subscribed, subscribed = [], []
    async with httpx.AsyncClient() as http:
        for o in owners:
            token = await get_client_telegram_token(o["client_id"], db)
            item = {"speaker_id": None, "name": o["name"],
                    "tg_channel_id": o["tg_channel_id"], "tg_channel_url": o["tg_channel_url"]}
            if not token:
                # нет своего бота у организатора → проверить нельзя, не блокируем
                subscribed.append(item)
                continue
            verdict = await _check_one_channel(
                http, token, o["tg_channel_id"], o.get("personal_tg_id"), tg_id)
            (not_subscribed if verdict == "not_subscribed" else subscribed).append(item)
    return not_subscribed, subscribed


async def _do_check(event_id: int, tg_id: int, db: asyncpg.Connection,
                    *, point: str = "chat"):
    """point='chat' — проверка перед входом в чат; 'registration' — перед кабинетом.

    ⚠️ Точка нужна, чтобы уважать галочку «где проверять» (мигр. 344): подписка
    может требоваться только при регистрации, а вход в чат оставаться свободным.
    Без этого включение проверки при регистрации молча включило бы её и в чате.
    """
    event = await db.fetchrow(
        "SELECT id, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=events.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id, require_subscription, is_collab, require_subscribe_all_owners, sub_check_at_chat FROM events WHERE id = $1", event_id
    )
    if not event:
        return {"status": 0, "not_subscribed": [], "subscribed": [], "not_subscribed_text": ""}

    # Проверка при входе в чат выключена галочкой → пропускаем без вопросов.
    # ⚠️ Только для точки 'chat': шлюз кабинета живёт по своей галочке и сюда
    # приходит уже после её проверки.
    if point == "chat" and event["sub_check_at_chat"] is False:
        return {"status": 1, "not_subscribed": [], "subscribed": [], "not_subscribed_text": ""}

    # Коллаб-событие + рычаг «подписка на всех организаторов» — отдельная проверка
    # (каналы основателей всех совладельцев, каждый через свой бот).
    collab_ns, collab_ok = [], []
    if event["is_collab"] and event["require_subscribe_all_owners"]:
        collab_ns, collab_ok = await _check_collab_owners(event_id, tg_id, db)

    # Режим подписки задаётся в настройках:
    #   Конференция (есть запись в conf_conferences):
    #     subscription_mode: none / organizer / all_speakers
    #   Мероприятие (нет conf_conferences):
    #     events.require_subscription: false → none, true → organizer
    conf = await db.fetchrow(
        "SELECT subscription_mode FROM conf_conferences WHERE event_id = $1", event_id
    )
    if conf:
        mode = dict(conf).get("subscription_mode") or "all_speakers"
    else:
        mode = "organizer" if event["require_subscription"] else "none"

    def _finish(spk_ns, spk_ok):
        """Слить проверку спикеров с проверкой коллаб-организаторов в единый ответ.

        ⚠️⚠️ ОДИН КАНАЛ — ОДНА СТРОКА. У человека бывает ДВЕ карточки на один
        канал: как организатора коллабы и как спикера того же события. Ссылка
        одна, а номер канала заполнен только в одной из них — и проверка давала
        два разных ответа на один канал:

            1. Маркетинг услуг для частных практиков   ← карточка спикера, номера нет
            ✅ Нурия (karycheva_marketing)             ← карточка организатора, номер есть

        Человек видел «подпишитесь» и «вы подписаны» про ОДИН И ТОТ ЖЕ канал.

        Поэтому: склеиваем по ссылке (а без неё — по номеру). Подтвердилась
        подписка хоть в одной карточке — канал пройден. Иначе он навсегда
        остался бы в «подпишитесь»: у карточки без номера проверять нечем.
        """
        def _key(c):
            url = (c.get("tg_channel_url") or "").strip().lower().rstrip("/")
            if url:
                # t.me и t.me — один и тот же адрес.
                return url.replace("t.me/", "t.me/").replace("https://", "").replace("http://", "")
            return f"id:{c.get('tg_channel_id') or ''}"

        def _dedup(items, seen):
            out = []
            for c in items:
                k = _key(c)
                if not k or k in seen:
                    continue
                seen.add(k)
                out.append(c)
            return out

        # ⚠️⚠️ ПОРЯДОК ВАЖЕН: сперва разбираем проверку ОРГАНИЗАТОРОВ КОЛЛАБЫ,
        # потом общую по спикерам.
        #
        # Общая проверка ходит ОДНИМ ботом владельца события — в чужие каналы
        # он не добавлен и отвечает «не смогли, пропускаем», то есть кладёт
        # канал в «подписаны». Проверка организаторов ходит ботом КАЖДОГО (он
        # админ своего канала) и знает правду.
        #
        # Раньше подписанные разбирались первыми, и ложное «подписан» затирало
        # правдивое «не подписан»: Mini App показывал «вы подписаны на Нурию»
        # и пускал в чат, хотя Telegram отвечал «left».
        seen: set = set()
        ns = _dedup(collab_ns, seen)          # правда: не подписан
        ok = _dedup(collab_ok, seen)          # правда: подписан
        ok += _dedup(spk_ok, seen)            # остальное — по общей проверке
        ns += _dedup(spk_ns, seen)
        return {
            "status": 0 if ns else 1,
            "not_subscribed": ns,
            "subscribed": ok,
            "not_subscribed_text": "\n".join(
                f"{sp['name']}: {sp['tg_channel_url'] or sp['tg_channel_id']}" for sp in ns),
        }

    if mode == "none":
        return _finish([], [])

    role_filter = "AND cse.role = 'organizer'" if mode == "organizer" else ""

    # Сортировка как у конференций — сначала priority (меньше = выше),
    # потом sort_order, потом id для устойчивости.
    rows = await db.fetch(
        f"""SELECT sp.id AS speaker_id,
                   -- ⚠️ Имя + фамилия (23.09.2026): рядом в этом же файле
                   -- `_check_collab_owners` уже подписывает человеком «Имя
                   -- Фамилия», а список спикеров правку не получил — в одном
                   -- списке оказывались «Анастасия Вангулова» и «Анастасия».
                   {DISPLAY_NAME_SQL("sp")} AS name,
                   sp.tg_channel_id, sp.tg_channel_url,
                   pu_tg.platform_user_id AS personal_tg_id,
                   cse.priority, cse.sort_order
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = sp.contact_id AND pu_tg.platform_slug = 'telegram'
           WHERE cse.event_id = $1
             AND cse.exclude_channel_from_subscription = FALSE
             AND sp.tg_channel_id IS NOT NULL
             AND sp.tg_channel_id <> ''
             {role_filter}
           ORDER BY COALESCE(cse.priority, 60), cse.sort_order, cse.id""",
        event["id"],
    )

    if not rows:
        return _finish([], [])

    from app.services.channels import get_client_telegram_token
    token = await get_client_telegram_token(event["client_id"], db)
    if not token:
        # нет бота у основного владельца — спикеров не проверить, но коллаб-часть уже посчитана
        return _finish([], [])

    speakers = [dict(r) for r in rows]

    async with httpx.AsyncClient() as http:
        verdicts = await asyncio.gather(
            *(
                _check_one_channel(http, token, sp["tg_channel_id"], sp.get("personal_tg_id"), tg_id)
                for sp in speakers
            )
        )

    not_subscribed: list[dict] = []
    subscribed: list[dict] = []
    for sp, verdict in zip(speakers, verdicts):
        item = {
            "speaker_id": sp["speaker_id"],
            "name": sp["name"],
            "tg_channel_id": sp["tg_channel_id"],
            "tg_channel_url": sp["tg_channel_url"],
        }
        if verdict == "not_subscribed":
            not_subscribed.append(item)
        else:
            # subscribed | fake_pass — оба идут вниз с галочкой
            subscribed.append(item)

    return _finish(not_subscribed, subscribed)


@router.get(
    "/conference/{event_id}/check-subscription",
    summary="Проверить подписку (GET) — все параметры в URL",
)
async def check_subscription_get(
    event_id: int,
    tg_id: str = Query(...),
    db: asyncpg.Connection = Depends(get_db),
):
    return await _do_check(event_id, int(tg_id), db)


@router.post(
    "/conference/{event_id}/check-subscription",
    summary="Проверить подписку (POST)",
)
async def check_subscription_post(
    event_id: int,
    body: SubscriptionCheckBody,
    db: asyncpg.Connection = Depends(get_db),
):
    return await _do_check(event_id, body.tg_id_int(), db)


# ── Шлюз подписки ПРИ ВХОДЕ В КАБИНЕТ (миграция 344) ─────────────────
#
# Отдельно от проверки для чата, хотя проверяет то же самое. Причина в отметке:
# у чата её нет — там подписку сверяют на каждый клик; у кабинета есть, и
# отметка ставится ОДИН РАЗ, при первом успехе.
#
# ⚠️ ОТМЕТКА НЕ СНИМАЕТСЯ ПРИ ОТПИСКЕ (решение владельца): требуем подписку до
# ПЕРВОГО ФАКТА. Иначе человек, отписавшийся через месяц, терял бы доступ к
# программе события, на которое давно зарегистрирован.
#
# ⚠️ Проверяем канал ТОЙ ПЛОЩАДКИ, откуда человек пришёл. Сейчас реально
# проверяется только Telegram (`_do_check` ходит в getChatMember) — во ВКонтакте
# и MAX проверка каналов организаторов пока не заведена. Поэтому не-Telegram
# заходы шлюз ПРОПУСКАЕТ, а не блокирует: закрыть кабинет проверкой, которой
# физически нет, значит запереть человека навсегда.


class RegistrationGateBody(BaseModel):
    """Кто стучится в кабинет. Площадка нужна, чтобы понять, чем проверять."""
    platform: str = "telegram"
    platform_user_id: str = ""
    contact_id: int | None = None


@router.post(
    "/conference/{event_id}/registration-gate",
    summary="Пускать ли участника в кабинет: проверка подписки + отметка",
)
async def registration_gate(
    event_id: int,
    body: RegistrationGateBody,
    db: asyncpg.Connection = Depends(get_db),
):
    """`{allowed, reason, not_subscribed[], subscribed[]}`.

    `allowed=True` — открываем кабинет. `reason` объясняет, почему:
      off        — проверка при регистрации выключена
      already    — отметка уже стоит, второй раз не спрашиваем
      passed     — проверили сейчас, подписан → ставим отметку
      no_check   — проверить нечем (не Telegram / каналы не заданы) → пропускаем
      required   — не подписан, кабинет закрыт (единственный False)
    """
    ev = await db.fetchrow(
        "SELECT id, sub_check_at_registration FROM events WHERE id = $1", event_id
    )
    if not ev:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    if not ev["sub_check_at_registration"]:
        return {"allowed": True, "reason": "off", "not_subscribed": [], "subscribed": []}

    # Отметка уже стоит → пропускаем, не дёргая площадку лишний раз.
    # ⚠️ Ищем участника по КОНТАКТУ: contact_id приходит с фронта, а если его
    # нет — резолвим по идентичности площадки. Своего SELECT по contacts не
    # пишем: связка «идентичность → контакт» живёт в platform_users.
    contact_id = body.contact_id
    if not contact_id and body.platform_user_id:
        contact_id = await db.fetchval(
            """SELECT pu.contact_id FROM platform_users pu
                JOIN contacts c ON c.id = pu.contact_id
               WHERE pu.platform_slug = $1 AND pu.platform_user_id = $2
               LIMIT 1""",
            body.platform, str(body.platform_user_id),
        )

    if contact_id:
        done = await db.fetchval(
            """SELECT sub_checked_at FROM event_participants
                WHERE event_id = $1 AND contact_id = $2""",
            event_id, contact_id,
        )
        if done:
            return {"allowed": True, "reason": "already", "not_subscribed": [], "subscribed": []}

    # Проверять умеем только Telegram — см. предупреждение выше.
    if body.platform != "telegram" or not str(body.platform_user_id).isdigit():
        return {"allowed": True, "reason": "no_check", "not_subscribed": [], "subscribed": []}

    # ⚠️ point='registration': иначе снятая галочка «проверять при входе в чат»
    # выключила бы и шлюз кабинета — это разные точки с разными настройками.
    res = await _do_check(event_id, int(body.platform_user_id), db, point="registration")
    not_sub = res.get("not_subscribed") or []

    if not_sub:
        return {
            "allowed": False, "reason": "required",
            "not_subscribed": not_sub,
            "subscribed": res.get("subscribed") or [],
            "not_subscribed_text": res.get("not_subscribed_text") or "",
        }

    # Подписан (или проверять было нечего) → ставим отметку навсегда.
    if contact_id:
        await db.execute(
            """UPDATE event_participants SET sub_checked_at = NOW()
                WHERE event_id = $1 AND contact_id = $2 AND sub_checked_at IS NULL""",
            event_id, contact_id,
        )
    return {"allowed": True, "reason": "passed",
            "not_subscribed": [], "subscribed": res.get("subscribed") or []}
