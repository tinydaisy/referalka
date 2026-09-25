"""
Коллабораторная (Хаб) — биржа коллабораций между клиентами ПЛЮСОНа.

⚠️ Карточка в Хабе = профиль КЛИЕНТА-организатора (clients), а НЕ коллаборатора (collaborators).
Коллаборатор = спикер/жюри в чьём-то событии — ДРУГОЙ слой. Карточка тянет:
фото основателя (owner_photo_url / profile_photo_url), бренд (brand_name), био (bio),
регалии (owner_achievements), соцсети/каналы (social_links), медийность (clients.media_assets).
Хаб-специфика на clients: is_published_in_hub, hub_category/niche/city/about (миграция 135),
hub_impact/hub_wow + галочки *_public (миграция 218).

Термины: ВЛАДЕЛЬЦЫ совместного события = «Организаторы» (event_owners, клиенты-совладельцы).
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from app.auth import get_current_client
from app.database import get_db
from app.services.features import client_has_feature
# ⚠️ Импорт НА УРОВНЕ МОДУЛЯ. Раньше он делался внутри функций, и в
# каталоге его просто забыли — NameError глотался except, каталог молча
# показывал подписчиков без каналов.
from app.services.channel_audience import channel_audience
from app.services.person_name import display_name, DISPLAY_NAME_SQL
import asyncpg
import json
import logging


async def require_collab_hub(client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Гейт: Коллабораторная доступна только со 2-го тарифа (фича collab_hub — pro/vip/trial, не start)."""
    if not await client_has_feature(db, int(client["sub"]), "collab_hub"):
        raise HTTPException(403, "Коллабораторная доступна на тарифе ПРОФИ и выше")
    return client


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/collab-hub", tags=["Коллабораторная (Хаб)"],
                   dependencies=[Depends(require_collab_hub)])

HUB_CATEGORIES = ['offline_business', 'online_business', 'freelancer', 'private_practice', 'consultant', 'expert']


def _media_tier(total_subs: int):
    """Градация охвата по сумме подписчиков.

    ⚠️ Ноль подписчиков — это НЕ «до 1 000», а «неизвестно»: возвращаем None и
    не показываем плашку вовсе. Раньше всем, кто не заполнил медийные активы,
    рисовалось «до 1 000» — цифра выглядела как заявленный охват, хотя её никто
    не вводил, и партнёр в каталоге видел заведомо неверные данные.
    """
    if total_subs >= 10000:
        return 'over_10k'
    if total_subs >= 5000:
        return '5k_10k'
    if total_subs >= 1000:
        return '1k_5k'
    if total_subs > 0:
        return 'under_1k'
    return None


# Площадки, чьи цифры считает САМА система (базы ПЛЮСОНа). Их значения —
# в штуках и приходят из подсчёта, а не из введённого поля.
_AUTO_PLATFORMS = ('plusson_tg', 'plusson_email', 'plusson_max', 'plusson_vk',
                   'plusson_tg_ch', 'plusson_max_ch', 'plusson_vk_ch',
                   # ⚠️ Instagram считается САМ, если аккаунт подключён: число
                   # подписчиков отдаёт Meta при подключении и обновляет при
                   # проверке связи. Введённое руками устаревает и завышается,
                   # а подключённый аккаунт даёт правду без участия человека.
                   # Не подключён — остаётся обычным полем ввода.
                   'instagram')


def _sum_subscribers(media_assets, auto_counts: dict | None = None) -> int:
    """Суммарный охват в ЛЮДЯХ.

    Все значения — в ЛЮДЯХ. Раньше заявленные активы вводились в ТЫСЯЧАХ, а
    посчитанные системой — в штуках: в одном списке уживались две единицы, и
    охват выходил в тысячи раз меньше правды.

    Старые записи в тысячах пересчитаны миграцией 298 — разбора «дробь это
    тысячи или люди» в коде нет и быть не должно: он бы врал на числах вроде
    «1.5 человека» и жил в проекте вечно.

    Позиции ПЛЮСОНа берутся из auto_counts — в самом поле у них всегда 0.
    """
    if not media_assets:
        return 0
    try:
        arr = media_assets if isinstance(media_assets, list) else json.loads(media_assets)
        total = 0
        for a in arr:
            if not isinstance(a, dict):
                continue
            slug = a.get('platform')
            if slug in _AUTO_PLATFORMS:
                total += int((auto_counts or {}).get(slug) or 0)
            else:
                total += int(round(float(a.get('subscribers') or 0)))
        return total
    except Exception:
        return 0


def _parse_json(v, default):
    """JSONB из asyncpg часто приходит строкой — парсим в list/dict для фронта."""
    if v is None:
        return default
    if isinstance(v, str):
        try: return json.loads(v)
        except Exception: return default
    return v


def _plusson_base(raw) -> dict:
    """База клиента по площадкам → ключи медийных активов (plusson_tg и т.д.)."""
    d = _parse_json(raw, {}) or {}
    return {
        'plusson_tg':    int(d.get('telegram') or 0),
        'plusson_email': int(d.get('email') or 0),
        'plusson_max':   int(d.get('max') or 0),
        'plusson_vk':    int(d.get('vk') or 0),
    }


# Как площадки называются в разбивке охвата и что в какую сводится.
# ⚠️ Telegram и MAX объединяют бота и канал: для партнёра это одна площадка,
# а раздельные строки заставляли бы складывать в уме.
_REACH_GROUPS = [
    ('Telegram', ('plusson_tg', 'plusson_tg_ch', 'tg')),
    ('MAX',      ('plusson_max', 'plusson_max_ch', 'max')),
    ('ВКонтакте',('plusson_vk', 'plusson_vk_ch', 'vk')),
    ('Email',    ('plusson_email',)),
    ('YouTube',  ('youtube',)),
    ('Instagram',('instagram',)),
    ('TikTok',   ('tiktok',)),
    ('RuTube',   ('rutube',)),
    ('Чат-боты', ('chatbots',)),
    ('Суммарно', ('total',)),
]


def _reach_breakdown(media_assets, auto_counts: dict) -> list:
    """Разбивка охвата по площадкам: [{title, count, percent}], по убыванию.

    Нужна, чтобы цифра охвата не была «чёрным ящиком»: партнёр видит, из чего
    она сложилась и какая площадка даёт основную долю.
    """
    try:
        arr = media_assets if isinstance(media_assets, list) else json.loads(media_assets or '[]')
    except Exception:
        return []
    by_slug = {}
    for a in arr:
        if not isinstance(a, dict):
            continue
        slug = a.get('platform')
        if slug in _AUTO_PLATFORMS:
            by_slug[slug] = int((auto_counts or {}).get(slug) or 0)
        else:
            by_slug[slug] = int(round(float(a.get('subscribers') or 0)))
    rows = []
    for title, slugs in _REACH_GROUPS:
        n = sum(by_slug.get(sl, 0) for sl in slugs)
        if n > 0:
            rows.append({'title': title, 'count': n})
    total = sum(r['count'] for r in rows) or 1
    for r in rows:
        r['percent'] = round(r['count'] * 100 / total)
    return sorted(rows, key=lambda r: -r['count'])


def _with_plusson_assets(media_assets, auto_counts: dict) -> list:
    """Дописывает в активы позиции ПЛЮСОНа по РЕАЛЬНО подключённым площадкам.

    ⚠️ Эти строки не выбираются и не удаляются человеком — они факт: если у
    клиента есть боты и подписчики на площадке, охват там существует независимо
    от того, отметил он это в форме или нет. Раньше их надо было добавлять
    руками, никто этого не делал, и фильтр «Площадки» показывал почти пустой
    каталог при живых базах.

    Позиция появляется, только когда на площадке ЕСТЬ люди: пустая строка
    «Email: 0» у того, кто почту не подключал, — шум в карточке и ложное
    совпадение в фильтре.

    В базе эти строки не хранятся: цифра меняется с каждой подпиской, и
    сохранённое число разошлось бы с правдой в тот же день.
    """
    try:
        arr = list(media_assets if isinstance(media_assets, list)
                   else json.loads(media_assets or '[]'))
    except Exception:
        arr = []
    # Руками введённые дубли этих позиций убираем — значение всё равно наше.
    arr = [a for a in arr if isinstance(a, dict) and a.get('platform') not in _AUTO_PLATFORMS]
    for slug in _AUTO_PLATFORMS:
        if int((auto_counts or {}).get(slug) or 0) > 0:
            arr.append({'platform': slug, 'subscribers': 0})
    return arr


def _client_card(row, public: bool = False, channel_counts: dict | None = None) -> dict:
    """Собирает карточку организатора из строки clients.

    ⚠️ name (заголовок карточки) = ИМЯ ОСНОВАТЕЛЯ (clients.name) — человек, а не бренд.
    Название проекта отдаём отдельно (brand_name) — фронт рисует строкой «Проект: …».
    Раньше name = brand_name || name, из-за чего имя основателя терялось.

    public=True — карточка отдаётся ДРУГОМУ клиенту (каталог/профиль). Тогда поля
    hub_impact/hub_wow скрываются, если сняты галочки *_public. Владельцу своей
    карточки (public=False) поля отдаём всегда — он их редактирует.
    """
    d = dict(row)
    # ⚠️ Имя основателя — С ФАМИЛИЕЙ (миграция 381): карточку видит ДРУГОЙ
    # клиент, и по одному имени партнёра не опознать. Склейка общим хелпером.
    owner_full = display_name(d.get('name'), d.get('last_name'))
    _auto = {**_plusson_base(d.get('hub_base_by_platform')), **(channel_counts or {})}
    ma = _with_plusson_assets(_parse_json(d.get('media_assets'), []), _auto)
    impact_public = d.get('hub_impact_public')
    wow_public = d.get('hub_wow_public')
    return {
        'client_id': d.get('id'),
        'name': owner_full or d.get('brand_name'),
        'owner_name': owner_full,
        'brand_name': d.get('brand_name'),
        'photo_url': d.get('owner_photo_url') or d.get('profile_photo_url'),
        'bio': d.get('bio'),
        'positioning': d.get('owner_positioning') or d.get('positioning'),
        'achievements': _parse_json(d.get('owner_achievements'), []),
        # ⚠️ Контакты (Telegram, каналы, ВК, MAX) ЧУЖОМУ не отдаём (решение
        # владельца 25.09.2026): связаться можно только через «Отправить запрос».
        # Охват по каналам считается из строки clients, а не из этого поля.
        'social_links': {} if public else _parse_json(d.get('social_links'), {}),
        'media_assets': ma or [],
        'reach_breakdown': _reach_breakdown(ma, _auto),
        'media_tier': _media_tier(_sum_subscribers(ma, _auto)),
        'is_published_in_hub': d.get('is_published_in_hub'),
        'hub_category': d.get('hub_category'),
        'hub_niche': d.get('hub_niche'),
        # ⚠️ Ниш может быть несколько. hub_niche (одна) оставлен для старых
        # мест, которые ещё читают одиночное поле.
        'hub_niches': list(d.get('hub_niches') or ([d['hub_niche']] if d.get('hub_niche') else [])),
        'hub_city': d.get('hub_city'),
        'hub_about': d.get('hub_about'),
        'hub_impact': (None if public and not impact_public else d.get('hub_impact')),
        'hub_impact_public': impact_public,
        'hub_wow': (None if public and not wow_public else d.get('hub_wow')),
        'hub_wow_public': wow_public,
        # ⚠️ Размер базы в ПЛЮСОНе система считает САМА (в отличие от медийных
        # активов, которые вводят руками) — подделать его нельзя. Но в публичной
        # карточке показываем только по галочке: у новичка база в десяток
        # человек, и принудительный показ отвадил бы его от публикации.
        # Ключи под слаги медийных активов: plusson_tg / _email / _max / _vk.
        'plusson_base': _auto,
    }


_CLIENT_COLS = """id, name, last_name, brand_name, owner_photo_url, profile_photo_url, bio,
    owner_positioning, positioning, owner_achievements, social_links, media_assets,
    is_published_in_hub, hub_category, hub_niche, hub_niches, hub_city, hub_about,
    hub_impact, hub_impact_public, hub_wow, hub_wow_public,
    -- ⚠️ База ПО ПЛОЩАДКАМ, а не одним числом: «5800 контактов» партнёру
    -- ничего не говорит — за ним и почта, и три бота, причём один человек
    -- часто есть сразу в нескольких. Считаем на лету: денормализованное
    -- число разъезжалось бы с правдой при каждой отписке.
    -- Отписавшиеся не в счёт — партнёру важны те, до кого рассылка дойдёт.
    -- ⚠️ Ссылка на внешнюю таблицу — ТОЛЬКО через алиас cl. Голое `id` внутри
    -- подзапроса Postgres разрешает в столбец platform_users, и условие
    -- превращается в «pu.client_id = pu.id»: совпадений нет, база всегда 0.
    -- Поэтому clients ВЕЗДЕ выбирается как `clients cl` — и в каталоге, и при
    -- запросе одной карточки.
    (SELECT jsonb_object_agg(t.slug, t.cnt) FROM (
        SELECT pu.platform_slug AS slug, count(DISTINCT pu.contact_id) AS cnt
          FROM platform_users pu
          JOIN contacts c_own ON c_own.id = pu.contact_id
         WHERE c_own.client_id = cl.id
           AND NOT EXISTS (SELECT 1 FROM platform_user_channels puc
                            WHERE puc.platform_user_id = pu.id AND puc.is_unsubscribed)
         GROUP BY pu.platform_slug
    ) t) AS hub_base_by_platform"""


# ═══════════════════════════════════════════════════════════════
# Справочник ниш
# ═══════════════════════════════════════════════════════════════
@router.get("/niches")
async def list_niches(db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch("SELECT slug, title FROM hub_niches ORDER BY sort_order, title")
    return {"niches": [dict(r) for r in rows]}


# ═══════════════════════════════════════════════════════════════
# Моя карточка в Хабе = мой профиль организатора (clients)
# ═══════════════════════════════════════════════════════════════
class HubCardIn(BaseModel):
    is_published_in_hub: bool = True
    hub_category: Optional[str] = None
    hub_niche: Optional[str] = None
    hub_niches: Optional[list] = None   # несколько ниш; hub_niche = первая из них
    hub_city: Optional[str] = None
    hub_about: Optional[str] = None
    hub_impact: Optional[str] = None        # «Что я создаю и меняю в стране/мире…»
    hub_impact_public: bool = True          # показывать impact в публичной карточке
    hub_wow: Optional[str] = None           # «Капелька безумия / WOW-факт»
    hub_wow_public: bool = True             # показывать wow в публичной карточке
    media_assets: Optional[list] = None   # [{platform, subscribers}]


@router.get("/me/card")
async def get_my_card(client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Моя карточка организатора — данные из профиля (clients). Редактируется фото/регалии в настройках Mini App."""
    row = await db.fetchrow(f"SELECT {_CLIENT_COLS} FROM clients cl WHERE cl.id=$1", int(client["sub"]))
    if not row:
        raise HTTPException(404, "Клиент не найден")
    # Подписчиков каналов спрашиваем у самих площадок — это подтверждённая
    # цифра, в отличие от заявленных вручную активов. Сбой площадки даёт 0
    # по каналу и карточку не роняет.
    ch = await channel_audience(db, int(client["sub"]), _parse_json(row.get("social_links"), {}))
    return {"card": _client_card(row, channel_counts=ch)}


@router.post("/me/card")
async def publish_my_card(data: HubCardIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Опубликовать/обновить свою карточку в Хабе (флаг + категория/ниша/город/о себе/медийность на clients)."""
    if data.hub_category and data.hub_category not in HUB_CATEGORIES:
        raise HTTPException(400, "Неизвестная категория")
    cid = int(client["sub"])
    # ⚠️ Позиции ПЛЮСОНа в базе НЕ храним: они подставляются при отдаче по
    # реально подключённым площадкам. Сохранить их значило бы заморозить цифру,
    # которая меняется с каждой подпиской, и получить расхождение с правдой.
    ma = (json.dumps([a for a in data.media_assets
                      if isinstance(a, dict) and a.get('platform') not in _AUTO_PLATFORMS])
          if data.media_assets is not None else None)
    # ⚠️ Ниши: пишем массив и синхронно кладём первую в старое одиночное поле —
    # его ещё читают места, не переведённые на список.
    niches = [n for n in (data.hub_niches or []) if n] or ([data.hub_niche] if data.hub_niche else [])
    first_niche = niches[0] if niches else None
    await db.execute(
        """UPDATE clients
              SET is_published_in_hub=$2, hub_category=$3, hub_niche=$4, hub_city=$5, hub_about=$6,
                  hub_niches=$12::text[],
                  media_assets=COALESCE($7::jsonb, media_assets),
                  hub_impact=$8, hub_impact_public=$9, hub_wow=$10, hub_wow_public=$11,
                  hub_published_at=CASE WHEN $2 AND hub_published_at IS NULL THEN NOW() ELSE hub_published_at END
            WHERE id=$1""",
        cid, data.is_published_in_hub, data.hub_category, first_niche, data.hub_city, data.hub_about, ma,
        data.hub_impact, data.hub_impact_public, data.hub_wow, data.hub_wow_public, niches
    )
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════
# Каталог Хаба — поиск партнёров (организаторов-клиентов)
# ═══════════════════════════════════════════════════════════════
@router.get("/catalog")
async def catalog(
    niche: Optional[str] = None,
    category: Optional[str] = None,
    media_tier: Optional[str] = None,
    platforms: Optional[str] = None,   # площадки через запятую: tg,vk,max,youtube…
    city: Optional[str] = None,
    q: Optional[str] = None,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    where = ["cl.is_published_in_hub=TRUE", "cl.id<>$1"]
    args: list = [int(client["sub"])]

    def _many(v):
        """«a,b,c» → ['a','b','c']. Фильтры принимают НЕСКОЛЬКО значений:
        партнёра ищут сразу в двух-трёх нишах, а не по одной за раз.
        Одиночное значение продолжает работать — это тот же список из одного."""
        return [x.strip() for x in (v or '').split(',') if x.strip()]

    niches_f = _many(niche)
    if niches_f:
        # Совпадение по ЛЮБОЙ из ниш человека и по любой из выбранных, плюс
        # старое одиночное поле — у кого массив ещё не заполнен, тот не должен
        # пропасть из выдачи.
        args.append(niches_f)
        where.append(f"(cl.hub_niches && ${len(args)}::text[] OR cl.hub_niche = ANY(${len(args)}::text[]))")
    tiers_f = _many(media_tier)
    plats_f = _many(platforms)
    cats_f = _many(category)
    if cats_f:
        args.append(cats_f); where.append(f"cl.hub_category = ANY(${len(args)}::text[])")
    if city:
        args.append(f"%{city}%"); where.append(f"cl.hub_city ILIKE ${len(args)}")
    if q:
        # Ищем и по имени основателя, и по названию проекта (бренду), и по «что предлагает».
        # ⚠️ Фамилия — тоже (миграция 381): людей чаще ищут именно по ней, и без
        # неё партнёра было бы не найти.
        args.append(f"%{q}%")
        where.append(
            f"(cl.name ILIKE ${len(args)} OR cl.last_name ILIKE ${len(args)}"
            f" OR {DISPLAY_NAME_SQL('cl')} ILIKE ${len(args)}"
            f" OR cl.brand_name ILIKE ${len(args)} OR cl.hub_about ILIKE ${len(args)})"
        )
    sql = f"""
        SELECT {_CLIENT_COLS},
               (SELECT count(*) FROM hub_collab_history h WHERE h.client_id=cl.id) AS collabs_count,
               -- Win-Win коэффициент: среднее по коллабам клиента (миграция 268).
               -- Коллабы без коэффициента (один организатор / никто никого не
               -- привёл) в среднее НЕ входят — иначе тянули бы показатель вниз.
               (SELECT round(avg(h.win_win_coefficient), 2)
                  FROM hub_collab_history h
                 WHERE h.client_id=cl.id AND h.win_win_coefficient IS NOT NULL) AS win_win,
               (SELECT round(avg(rating),1) FROM hub_reviews rv WHERE rv.client_id=cl.id) AS avg_rating
          FROM clients cl
         WHERE {' AND '.join(where)}
         ORDER BY collabs_count DESC NULLS LAST, cl.hub_published_at DESC NULLS LAST, cl.id DESC
         LIMIT 200
    """
    rows = await db.fetch(sql, *args)

    # ⚠️ Подписчиков ТГ/MAX/VK-каналов считаем и здесь, в каталоге. Без этого
    # карточка показывала охват только по базе ботов, а канал — у которого
    # подписчиков обычно больше — не учитывался ни в сумме, ни в плашке охвата,
    # ни в фильтре «Площадки» (у Гришиной так терялось 444 подписчика,
    # у Морарь — 389, при заполненных chat_id и подключённом боте).
    #
    # ⚠️ Последовательно, НЕ через gather: channel_audience сам ходит в базу за
    # токенами ботов, а одно соединение asyncpg не выполняет несколько запросов
    # разом — параллельный обход роняет ручку с «another operation is in
    # progress», и каталог не грузится вовсе. Карточек в каталоге единицы
    # (сейчас 9), а результат кешируется на 10 минут, так что повторные
    # открытия дополнительных запросов не делают.
    counts_by_client: dict[int, dict] = {}
    for r in rows:
        try:
            # ⚠️ r — строка asyncpg (Record), у неё НЕТ метода .get: обращение
            # к нему бросало AttributeError, который тут же глотался except, и
            # каталог молча показывал охват без каналов. Берём по ключу.
            counts_by_client[r['id']] = await channel_audience(
                db, r['id'], _parse_json(r['social_links'], {}))
        except Exception:
            # Логируем: молчаливый except уже один раз спрятал поломку на неделю.
            logger.exception("catalog: не посчитаны каналы клиента %s", r['id'])
            counts_by_client[r['id']] = {}

    out = []
    for r in rows:
        # чужие карточки — уважаем галочки *_public
        card = _client_card(r, public=True,
                            channel_counts=counts_by_client.get(r['id']))
        card['collabs_count'] = r['collabs_count']
        card['win_win'] = float(r['win_win']) if r['win_win'] is not None else None
        card['avg_rating'] = r['avg_rating']
        # Медийность фильтруется здесь, а не в запросе: градация считается
        # из суммы подписчиков уже после выборки. Значений может быть
        # несколько — как и у остальных фильтров каталога.
        # ⚠️ Фильтр по ПЛОЩАДКАМ: ищут партнёра «у кого есть телеграм и ВК».
        # Учитываем и заявленные активы, и посчитанные системой — человек с
        # ботом в ПЛЮСОНе присутствует на площадке не меньше, чем с каналом.
        if plats_f:
            have = {r['title'] for r in (card.get('reach_breakdown') or [])}
            if not (set(plats_f) & have):
                continue
        if tiers_f and card['media_tier'] not in tiers_f:
            continue
        out.append(card)
    # Моя собственная карточка — показывается ВВЕРХУ списка, подсвеченная (даже если не опубликована — видна только мне)
    me_row = await db.fetchrow(
        f"""SELECT {_CLIENT_COLS},
               (SELECT count(*) FROM hub_collab_history h WHERE h.client_id=cl.id) AS collabs_count,
               -- Win-Win коэффициент: среднее по коллабам клиента (миграция 268).
               -- Коллабы без коэффициента (один организатор / никто никого не
               -- привёл) в среднее НЕ входят — иначе тянули бы показатель вниз.
               (SELECT round(avg(h.win_win_coefficient), 2)
                  FROM hub_collab_history h
                 WHERE h.client_id=cl.id AND h.win_win_coefficient IS NOT NULL) AS win_win,
               (SELECT round(avg(rating),1) FROM hub_reviews rv WHERE rv.client_id=cl.id) AS avg_rating
          FROM clients cl WHERE cl.id=$1""", int(client["sub"]))
    me_card = None
    if me_row:
        # Своя карточка считается по тем же правилам, что чужие, — иначе
        # владелец видел бы у себя охват меньше, чем показывают его партнёрам.
        try:
            me_ch = await channel_audience(
                db, int(client["sub"]), _parse_json(me_row.get('social_links'), {}))
        except Exception:
            me_ch = {}
        me_card = _client_card(me_row, channel_counts=me_ch)
        me_card['collabs_count'] = me_row['collabs_count']
        me_card['win_win'] = float(me_row['win_win']) if me_row['win_win'] is not None else None
        me_card['avg_rating'] = me_row['avg_rating']
        me_card['is_me'] = True
    return {"me": me_card, "items": out, "total": len(out)}


@router.get("/profile/{client_id}")
async def hub_profile(client_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Карточка организатора в Хабе + рейтинг + история + отзывы + контакты для связи.
    Виден если опубликован ИЛИ между нами есть запрос на коллаборацию."""
    me = int(client["sub"])
    row = await db.fetchrow(
        f"SELECT {_CLIENT_COLS}, cl.telegram_username FROM clients cl WHERE cl.id=$1", client_id)
    if not row:
        raise HTTPException(404, "Организатор не найден")
    # Подписчики каналов — как и в своей карточке: иначе у человека с каналом
    # на 389 человек в профиле показывался только бот на 88.
    prof_ch = await channel_audience(db, client_id, _parse_json(row.get("social_links"), {}))
    has_link = await db.fetchval(
        """SELECT 1 FROM hub_collab_requests
            WHERE (from_client_id=$1 AND to_client_id=$2) OR (from_client_id=$2 AND to_client_id=$1) LIMIT 1""",
        me, client_id)
    if not row["is_published_in_hub"] and not has_link and me != client_id:
        raise HTTPException(403, "Карточка не опубликована")
    my_review = await db.fetchrow(
        "SELECT rating, text FROM hub_reviews WHERE client_id=$1 AND author_client_id=$2", client_id, me)
    history = await db.fetch(
        """SELECT h.event_id, e.title AS event_title, h.partner_client_id,
                  COALESCE(pc.brand_name,pc.name) AS partner_name, h.participants_total, h.brought_live, h.created_at
             FROM hub_collab_history h
             LEFT JOIN events e ON e.id=h.event_id
             LEFT JOIN clients pc ON pc.id=h.partner_client_id
            WHERE h.client_id=$1 ORDER BY h.created_at DESC LIMIT 50""", client_id)
    reviews = await db.fetch(
        """SELECT rv.rating, rv.text, rv.created_at, COALESCE(ac.brand_name,ac.name) AS author_name
             FROM hub_reviews rv LEFT JOIN clients ac ON ac.id=rv.author_client_id
            WHERE rv.client_id=$1 ORDER BY rv.created_at DESC LIMIT 50""", client_id)
    rating = await db.fetchrow(
        """SELECT count(*) AS collabs,
                  round(avg(win_win_coefficient) FILTER (WHERE win_win_coefficient IS NOT NULL), 2) AS win_win
             FROM hub_collab_history WHERE client_id=$1""", client_id)
    card = _client_card(row, public=(me != client_id), channel_counts=prof_ch)  # свой профиль — поля видны всегда
    # Ник — только своему профилю: чужим связь только через запрос (25.09.2026).
    card['telegram_username'] = row.get('telegram_username') if me == client_id else None
    return {
        "card": card,
        "rating": {"collabs_count": rating["collabs"],
                   "win_win": float(rating["win_win"]) if rating["win_win"] is not None else None},
        "history": [dict(h) for h in history],
        "reviews": [dict(r) for r in reviews],
        "my_review": dict(my_review) if my_review else None,
        "is_me": me == client_id,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Закрытый чат Коллабораторной (миграция 264)
# ─────────────────────────────────────────────────────────────────────────────
# ⚠️ ХАРДКОД (решение владельца 25.09.2026): чат открыт только тем, кто
# ОПЛАТИЛ средний тариф события 89 — «VIP С КОЛЛАБОРАТОРНОЙ» (event_tariffs.id=19).
# Покупатель — контакт в базе организатора, а смотрит клиент кабинета, поэтому
# сопоставляем: привязка ПЛЮСОН Коннект (contacts.linked_client_id), почта
# (идентичность platform_users 'email' = clients.email) или рабочий Telegram
# (clients.work_tg_id). Когда появится настройка «кому открыт чат» — заменить.
_COLLAB_CHAT_TARIFF_ID = 19


async def _has_collab_chat_access(db, client_id: int) -> bool:
    return bool(await db.fetchval(
        """WITH buyers AS (
               SELECT DISTINCT contact_id FROM event_participant_tariffs
                WHERE tariff_id = $2 AND status = 'paid' AND contact_id IS NOT NULL)
           SELECT EXISTS (
               SELECT 1 FROM clients cl
                WHERE cl.id = $1 AND (
                      EXISTS (SELECT 1 FROM contacts c JOIN buyers b ON b.contact_id = c.id
                               WHERE c.linked_client_id = cl.id)
                   OR EXISTS (SELECT 1 FROM platform_users pu JOIN buyers b ON b.contact_id = pu.contact_id
                               WHERE pu.platform_slug = 'email'
                                 AND lower(trim(pu.platform_user_id)) = lower(trim(cl.email)))
                   OR EXISTS (SELECT 1 FROM platform_users pu JOIN buyers b ON b.contact_id = pu.contact_id
                               WHERE pu.platform_slug = 'telegram'
                                 AND cl.work_tg_id IS NOT NULL
                                 AND pu.platform_user_id = cl.work_tg_id::text)))""",
        client_id, _COLLAB_CHAT_TARIFF_ID))


@router.get("/settings", summary="Настройки Коллабораторной (ссылка на чат)")
async def get_collab_hub_settings(client=Depends(get_current_client), db=Depends(get_db)):
    """Ссылки на закрытый чат участников — Telegram и MAX (миграция 266).

    Одни на всю Коллабораторную (таблица-одиночка, id=1). Обе пусты → в кабинете
    пункт «Закрытый чат» просто не показывается, а не ведёт в никуда.
    Нет доступа (см. _has_collab_chat_access) → ссылки отдаются пустыми:
    прятать надо на сервере, иначе адрес чата виден в ответе API.
    """
    row = await db.fetchrow(
        "SELECT chat_url, chat_url_max, chat_title FROM collab_hub_settings WHERE id = 1")
    allowed = await _has_collab_chat_access(db, int(client["sub"]))
    return {
        "chat_url": ((row["chat_url"] if row else None) or "") if allowed else "",
        "chat_url_max": ((row["chat_url_max"] if row else None) or "") if allowed else "",
        "chat_title": (row["chat_title"] if row else None) or "Закрытый чат",
        "has_access": allowed,
    }
