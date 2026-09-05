"""Единая точка записи человека в участники события (2026-09-03).

⚠️⚠️ ПРЯМОЙ `INSERT INTO event_participants` В КОДЕ БОЛЬШЕ НЕ ПИШЕМ.
Вместо него — `upsert_event_participant` отсюда.

Зачем. К сентябрю 2026 вставка участника жила в 27 местах: Mini App, три бота,
вебхуки, розыгрыш, вебинар, заказы, карточки спикеров, веб-страница. Каждая
новая точка входа дописывала свой INSERT рядом — быстрее, чем разбираться с
чужим кодом. Места разъехались по всему, что можно:

* три разных поведения при повторе на одну таблицу — где-то `is_registered`
  ставился принудительно, где-то `old OR new`, где-то `DO NOTHING`. Из-за
  последнего реф-код, пришедший вторым заходом, молча терялся;
* `registered_at` заполнялся в трёх местах из шестнадцати — по этой колонке
  нельзя было строить отчёты;
* в трёх местах не было `ON CONFLICT` вовсе: два одновременных запроса давали
  человеку 500 прямо в форме регистрации;
* уведомление «Новый интерес» определялось по-разному, а в одном месте —
  вообще без проверки, поэтому уходило повторно.

Правила, одинаковые теперь везде:

1. **`is_registered` только повышается.** FALSE→TRUE можно, обратно — нет.
   Человек, уже зарегистрированный, не должен «разрегистрироваться» оттого,
   что открыл страницу события ещё раз. Снять галочку может только организатор
   вручную (`PATCH /events/{id}/participants/{pid}`) — это отдельное действие.

2. **`registered_at` ставится в момент перехода в TRUE**, а не при вставке
   строки: строка часто рождается со статусом «интересовался», и время
   создания записи — не время регистрации.

3. **Реф-код пишется, только если пуст.** Первый приведший в приоритете:
   человека привёл один, а по ссылке второго он мог зайти позже.

4. **Возвращаем `is_new`** — «первое касание». По нему шесть мест шлют
   организатору «Новый интерес»; без этого признака уведомления бы замолчали.
   Считаем через `xmax = 0`: у вставленной строки он нулевой, у обновлённой —
   нет. Это надёжнее, чем `RETURNING` при `DO NOTHING` (там строка вообще не
   возвращается, и приходится доselect-ить).

⚠️ Функция НЕ решает, в чью базу писать человека, и НЕ создаёт контакт. Она
получает готовый `contact_id`. Резолв клиента — `resolve_event_client`, резолв
человека — `upsert_contact_with_identity` (см. contact_merge). Разделение
намеренное: у трёх задач разные ключи и разные точки вызова.
"""
import logging
from typing import Optional, Tuple

logger = logging.getLogger(__name__)


async def upsert_event_participant(
    db,
    *,
    event_id: int,
    contact_id: int,
    is_registered: bool = False,
    is_in_chat: bool = False,
    referrer_ref_code: Optional[str] = None,
    referrer_participant_id: Optional[int] = None,
    entry_link: Optional[str] = None,
    mark_link_clicked: bool = False,
    mark_live: bool = False,
    finalize: bool = True,
    send_menu: bool = True,
) -> Tuple[int, bool, bool]:
    """Заводит или обновляет участие. Идемпотентна.

    Возвращает `(participant_id, is_new, became_registered)`:

    * `is_new` — строки участия раньше не было. По нему шлют «Новый интерес».
    * `became_registered` — человек ИМЕННО СЕЙЧАС стал зарегистрированным.
      По нему шлют письма и подарки: у повторного вызова он False, поэтому
      второе письмо тому же человеку не уйдёт.

    `is_in_chat` — вошёл в чат события. Как и статус регистрации, только
    повышается: назад не откатываем.

    `mark_link_clicked` — клик по ссылке события (первый раз, дальше не
    сдвигается). `mark_live` — человек в эфире; это время, наоборот,
    обновляется каждый раз: по нему видно последнее присутствие.

    `finalize=True` (по умолчанию) — при переходе в «зарегистрирован» сама
    зовёт `finalize_participant_registration`: стоп догрева, меню бота,
    письмо, раздача контакта организаторам коллабы. Ставить False нужно, когда
    вызывающий работает ВНУТРИ транзакции: финализация ходит в сеть (Telegram,
    SMTP), и держать на ней открытую транзакцию нельзя — тогда её зовут сами,
    после коммита.

    ⚠️ `send_menu=False` — когда вызывающий шлёт меню сам (регистрация прямо в
    боте отвечает им на нажатие кнопки), иначе человек получит два подряд.
    """
    row = await db.fetchrow(
        # ⚠️ `was` берём ОТДЕЛЬНЫМ подзапросом, а не из RETURNING. Проверено на
        # боевой базе: `RETURNING event_participants.is_registered` отдаёт уже
        # ОБНОВЛЁННОЕ значение, а не прежнее — то есть «был зарегистрирован» и
        # «стал сейчас» по нему неразличимы, и письмо о регистрации не ушло бы
        # никому. CTE читает строку до записи, в том же снимке транзакции.
        """WITH before AS (
               SELECT is_registered FROM event_participants
                WHERE event_id = $1 AND contact_id = $2
           )
           INSERT INTO event_participants
               (event_id, contact_id, is_registered, is_in_chat, registered_at,
                referrer_ref_code, referrer_participant_id, entry_link,
                link_clicked_at, live_at)
           VALUES ($1, $2, $3, $7, CASE WHEN $3 THEN NOW() END, $4, $5, $6,
                   CASE WHEN $8 THEN NOW() END, CASE WHEN $9 THEN NOW() END)
           ON CONFLICT (event_id, contact_id) DO UPDATE SET
               -- Статус только повышается: повторный заход не снимает регистрацию.
               is_registered = event_participants.is_registered OR EXCLUDED.is_registered,
               -- То же с «в чате»: назад не откатываем.
               is_in_chat = event_participants.is_in_chat OR EXCLUDED.is_in_chat,
               -- Время регистрации — момент перехода в TRUE, не момент вставки.
               registered_at = CASE
                   WHEN event_participants.registered_at IS NOT NULL
                       THEN event_participants.registered_at
                   WHEN EXCLUDED.is_registered THEN NOW()
                   ELSE NULL END,
               -- Первый приведший в приоритете — пустое поле дозаполняем, чужое не трогаем.
               referrer_ref_code = COALESCE(
                   NULLIF(event_participants.referrer_ref_code, ''),
                   EXCLUDED.referrer_ref_code),
               referrer_participant_id = COALESCE(
                   event_participants.referrer_participant_id,
                   EXCLUDED.referrer_participant_id),
               entry_link = COALESCE(event_participants.entry_link, EXCLUDED.entry_link),
               -- Первый клик по ссылке и первый вход в эфир — время ПЕРВОГО
               -- раза, повторные заходы его не сдвигают.
               link_clicked_at = COALESCE(event_participants.link_clicked_at,
                                          EXCLUDED.link_clicked_at),
               -- А вот «был в эфире» обновляем каждый раз: по нему видно
               -- последнее присутствие, и так было до сведения точек.
               live_at = COALESCE(EXCLUDED.live_at, event_participants.live_at)
           RETURNING id,
                     (xmax = 0) AS is_new,
                     is_registered AS now_registered,
                     COALESCE((SELECT is_registered FROM before), FALSE) AS was_registered""",
        event_id, contact_id, bool(is_registered),
        (referrer_ref_code or None), referrer_participant_id, entry_link,
        bool(is_in_chat), bool(mark_link_clicked), bool(mark_live),
    )

    pid = int(row["id"])
    is_new = bool(row["is_new"])
    # Стал зарегистрированным именно сейчас: стоит TRUE, а до вызова не стоял.
    # У вставки строки «до» не было вовсе — считаем как FALSE.
    was = (not is_new) and bool(row["was_registered"])
    became = bool(row["now_registered"]) and not was

    # «Кто первым привёл человека в базу» (contacts.first_referrer_contact_id).
    #
    # ⚠️ Поле почти перестало заполняться с мая 2026: его писали только воронки
    # лид-магнитов, вебинар и заказ продукта, а единая точка входа человека —
    # нет. Из 22 485 контактов заполнено 3754. Пишем здесь, потому что это
    # единственное место, через которое проходят ВСЕ пути регистрации.
    #
    # ⚠️ Пишем ТОЛЬКО В ПУСТОЕ (COALESCE) — «первый» на то и первый: перезапись
    # означала бы, что поле хранит последнего, а на нём завязаны партнёрские
    # ссылки спикеров.
    #
    # ⚠️ К партнёрской программе отношения НЕ имеет: там своё поле
    # (contacts.partner_id) и свои правила. Это поле — для аналитики.
    if referrer_ref_code and contact_id:
        try:
            from app.services.contact_merge import resolve_ref_code
            _ref, referrer_contact_id = await resolve_ref_code(
                db, referrer_ref_code, None)
            if referrer_contact_id and referrer_contact_id != contact_id:
                await db.execute(
                    """UPDATE contacts
                          SET first_referrer_contact_id =
                                  COALESCE(first_referrer_contact_id, $2),
                              first_referred_at = COALESCE(first_referred_at, NOW())
                        WHERE id = $1""",
                    contact_id, referrer_contact_id,
                )
        except Exception as e:  # noqa: BLE001
            # Аналитическое поле: его сбой не должен ломать регистрацию.
            logger.warning("first_referrer не записан (contact=%s): %s", contact_id, e)

        # ⚠️⚠️ ПАРТНЁРСКОЕ ЗАКРЕПЛЕНИЕ — ЗДЕСЬ ЖЕ, и это принципиально.
        # Через эту функцию идут ВСЕ пути регистрации на событие: Mini App,
        # три бота, веб-форма, вебхуки. Если закреплять только в оформлении
        # заказа (event_orders), то человек, пришедший по ссылке партнёра на
        # БЕСПЛАТНОЕ событие или зарегистрировавшийся в боте, за партнёром не
        # закреплялся бы — а именно такие ссылки (`/l/{slug}?pid=`) партнёру
        # и выдаются в кабинете.
        #
        # ⚠️ Закрепление всё равно возникнет ТОЛЬКО если реф-код принадлежит
        # зарегистрированному партнёру и место свободно — решает
        # `try_bind_by_ref_code`. Обычная рефералка события (там любой
        # участник) сюда не попадает.
        try:
            from app.services.partner_binding import try_bind_by_ref_code
            client_id = await db.fetchval(
                "SELECT client_id FROM contacts WHERE id = $1", contact_id)
            if client_id:
                await try_bind_by_ref_code(
                    db, client_id=client_id, contact_id=contact_id,
                    ref_code=referrer_ref_code)
        except Exception as e:  # noqa: BLE001
            # Fail-open: партнёрка — надстройка, её сбой не должен ломать
            # регистрацию человека на событие.
            logger.warning("Партнёрка: закрепление при регистрации не удалось "
                           "(contact=%s): %s", contact_id, e)

    if became and finalize:
        try:
            from app.services.participant_registration import (
                finalize_participant_registration,
            )
            await finalize_participant_registration(
                db, event_id=event_id, contact_id=contact_id, send_menu=send_menu)
        except Exception as e:
            logger.warning(
                "finalize failed (event=%s contact=%s): %s", event_id, contact_id, e)

    return pid, is_new, became
