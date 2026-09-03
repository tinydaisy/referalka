"""
Автозапись истории коллабораций (Коллабораторная / Хаб).

Рейтинг партнёра, Win-Win-коэффициент и число коллабов на карточке в Хабе
считаются из hub_collab_history (collab_hub.py / collab_events.py — только SELECT).
Раньше в эту таблицу НИКАКОЙ код не писал — наполнялась только ручным SQL (демо).
Из-за этого у реальных клиентов рейтинг всегда был «0 коллабов / — вклад».

Здесь — единственная точка автозаписи. Зовётся при ЗАВЕРШЕНИИ коллаб-события
(status → ended) из update_event. Идемпотентно (UPSERT по UNIQUE(client_id, event_id),
миграция 193): повторный перевод в ended не плодит дубли, а обновляет вклад.

Что пишем на КАЖДОГО организатора (event_owners.status='accepted'):
  - participants_total = всего участников события
  - brought_live       = сколько он привёл = участники, кого привёл ЭТОТ
    организатор (referrer_ref_code → contacts.ref_code → contacts.client_id = его id)
    И кто ЗАРЕГИСТРИРОВАЛСЯ (is_registered = TRUE)

    ⚠️ Считаем по РЕГИСТРАЦИЯМ, а не по `link_clicked_at` (решение владельца,
    2026-09-03). `link_clicked_at` ставится ТОЛЬКО при клике по кнопке «Смотреть
    стрим» в Mini App, а на эфир люди попадают откуда угодно: из бота, из ссылки
    в канале, из письма, по прямому адресу. Из-за этого у реальной коллабы
    (событие 92, Нурия + Лилия, 12 участников) `brought_live` вышел 0 у ОБЕИХ,
    Win-Win — NULL, и в карточке Хаба стояло «—». Регистрация — осознанное
    действие человека и единственный признак привлечения, который не зависит
    от того, каким путём он пришёл.
  - partner_client_id  = один из ДРУГИХ организаторов (для строки «с кем коллабился»)

⚠️ ПОКАЗАТЕЛЬ НА КАРТОЧКЕ — Win-Win КОЭФФИЦИЕНТ (2026-08-06), не процент.
См. `win_win_coefficient` ниже: `мои приведённые / среднее по организаторам`.
Ориентир 1.0 = сработал вровень с партнёрами.
"""
import logging

logger = logging.getLogger(__name__)


# ⚠️⚠️ ЕДИНСТВЕННОЕ выражение «сколько привёл организатор коллабы».
# Своих копий этого подсчёта НЕ писать: их уже было две (запись истории здесь и
# живой отчёт в collab_events.py), и они разъезжались — отчёт по ходу события
# показывал одно, карточка в Хабе после завершения другое.
#
# Критерий: участник пришёл по реф-коду контакта ЭТОГО клиента И зарегистрировался.
# Подстановки: $1 = event_id, второй параметр — client_id организатора; его номер
# задаётся аргументом, потому что в разных запросах он разный ($2 / o.client_id).
#
# ⚠️ Считаем по РЕГИСТРАЦИЯМ, а не по `link_clicked_at` (решение владельца,
# 2026-09-03). `link_clicked_at` ставится ТОЛЬКО при клике по кнопке «Смотреть
# стрим» в Mini App, а на эфир люди попадают откуда угодно: из бота, из ссылки в
# канале, из письма, по прямому адресу. Из-за этого у реальной коллабы (событие
# 92, Нурия + Лилия, 12 участников) `brought_live` вышел 0 у ОБЕИХ, Win-Win —
# NULL, и в карточке Хаба стояло «—». Регистрация — осознанное действие и
# единственный признак привлечения, не зависящий от пути, которым человек пришёл.
BROUGHT_COUNT_SQL = """(SELECT count(DISTINCT ep.id)
                          FROM event_participants ep
                          JOIN contacts rc ON rc.ref_code = ep.referrer_ref_code
                         WHERE ep.event_id = $1
                           AND ep.is_registered = TRUE
                           AND rc.client_id = {client})"""


def brought_count_sql(client: str = "$2") -> str:
    """SQL-выражение «сколько привёл организатор» — одно на все места.

    `client` — как в конкретном запросе адресуется клиент-организатор:
    номер подстановки (`$2`) или колонка внешнего запроса (`o.client_id`).
    """
    return BROUGHT_COUNT_SQL.format(client=client)


def win_win_coefficient(mine: int, all_brought: list[int], organizers_count: int):
    """Win-Win коэффициент организатора коллабы: во сколько раз он привёл
    больше/меньше СРЕДНЕГО по организаторам этой коллабы.

        коэффициент = мои приведённые / (сумма приведённых всеми / число организаторов)

    Ориентир — **1.0**: привёл столько же, сколько в среднем каждый организатор.
    Больше 1.0 — вытянул коллабу на себе, меньше — недоработал.

    ⚠️ Почему НЕ «процент от всех участников» (старая формула):
      1. Наказывала за масштаб. Вдвоём поровну = 50%, вчетвером поровну = 25%:
         один и тот же человек при одинаковой работе получал вдвое меньше только
         потому, что собрал больше партнёров. Коллабораторная — про объединение,
         метрика не должна обесценивать то, ради чего продукт существует.
      2. Знаменатель врал: `participants_total` включает участников с пустым
         `referrer_ref_code` (зашли из своего бота, из списка событий, по прямой
         ссылке без pid) — их никто себе не засчитает, и высокий процент был
         физически недостижим.

    ⚠️ Деление на СРЕДНЕЕ, а не на сумму: доля от суммы вчетвером поровну даёт
    25% — проблема №1 остаётся.

    Возвращает float, округлённый до 2 знаков, либо None когда коэффициент
    не имеет смысла: организатор один (сравнивать не с кем) или никто никого
    не привёл (среднее = 0). None → в UI показывать «—», а НЕ 0.
    """
    if organizers_count < 2:
        return None
    avg = sum(all_brought) / organizers_count
    if avg <= 0:
        return None
    return round(mine / avg, 2)


async def record_collab_history(db, event_id: int) -> int:
    """Записать вклад каждого организатора коллаб-события в hub_collab_history.

    Вызывать ТОЛЬКО для коллаб-события (is_collab=TRUE) в момент завершения.
    Возвращает число записанных/обновлённых строк. Ошибки глушит (не роняет PATCH).
    """
    try:
        ev = await db.fetchrow(
            "SELECT is_collab FROM events WHERE id = $1", event_id)
        if not ev or not ev["is_collab"]:
            return 0

        owners = await db.fetch(
            "SELECT client_id FROM event_owners WHERE event_id = $1 AND status = 'accepted'",
            event_id)
        owner_ids = [o["client_id"] for o in owners]
        if len(owner_ids) < 2:
            return 0  # не коллаб по факту — один владелец

        participants_total = await db.fetchval(
            "SELECT count(*) FROM event_participants WHERE event_id = $1", event_id) or 0

        # ⚠️ Сначала собираем цифры ПО ВСЕМ организаторам и только потом пишем:
        # Win-Win коэффициент считается от среднего по коллабе, то есть зависит
        # от того, сколько привели остальные. По одному организатору за раз его
        # не посчитать.
        brought_by: dict[int, int] = {}
        for cid in owner_ids:
            # Сколько привёл именно этот организатор — общее выражение,
            # см. brought_count_sql выше. Своего SELECT здесь быть не должно.
            brought_by[cid] = await db.fetchval(
                "SELECT " + brought_count_sql("$2"), event_id, cid) or 0

        all_brought = list(brought_by.values())
        organizers_count = len(owner_ids)

        written = 0
        for cid in owner_ids:
            brought_live = brought_by[cid]
            coef = win_win_coefficient(brought_live, all_brought, organizers_count)

            # «С кем коллабился» — любой другой организатор (для карточки-строки).
            partner_cid = next((o for o in owner_ids if o != cid), None)

            await db.execute(
                """INSERT INTO hub_collab_history
                       (client_id, event_id, partner_client_id, participants_total,
                        brought_live, win_win_coefficient, organizers_count)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)
                   -- ⚠️ Цифры пишутся ОДИН РАЗ и больше не меняются
                   -- (DO NOTHING, не DO UPDATE). Раньше повторное завершение
                   -- пересчитывало вклад и Win-Win заново: вернув событие в
                   -- черновик, сдвинув дату и завершив снова, можно было
                   -- переписать себе показатели набранными позже регистрациями.
                   -- Результат коллаборации — свершившийся факт, он фиксируется.
                   ON CONFLICT (client_id, event_id) WHERE event_id IS NOT NULL
                   DO NOTHING""",
                cid, event_id, partner_cid, participants_total,
                brought_live, coef, organizers_count)
            written += 1

        logger.info("collab_history: event %s → %s owner-rows written", event_id, written)
        return written
    except Exception:
        logger.exception("collab_history: failed for event %s", event_id)
        return 0
