# Коллабораторная (Хаб) — АРХИТЕКТУРА КАК ЕСТЬ

> Это описание **текущего состояния кода и БД** (сверено с продом **2026-08-14**).
> Концепция `CONCEPT-COLLAB-NETWORK.md` — это ТЗ, реализация от него **РАЗОШЛАСЬ**. Верить этому файлу.
> Схема прода целиком — [other_tasks/_prod_schema_snapshot.txt](../other_tasks/_prod_schema_snapshot.txt).

---

## ⚠️ ГЛАВНОЕ ПРАВИЛО

**КОЛЛАБА СВЯЗАНА С КЛИЕНТАМИ (`clients`), А НЕ СО СПИКЕРАМИ (`collaborators`).**

- Организаторы коллабы = **клиенты ПЛЮСОНа** (`event_owners.client_id → clients.id`).
- Карточка в каталоге Хаба = **клиент** (`clients`), а НЕ коллаборатор.
- К таблице `collaborators` (спикеры/партнёры) коллаба **не привязана вообще**.

**Почему так:** вся суть коллабы в том, что **каждый организатор ведёт СВОЮ базу через СВОЕГО бота**
(свой токен → свой лимит Telegram, базы не смешиваются). Это может только клиент со своим кабинетом
и своим ботом. Спикер без кабинета этого не может.

---

## Отдельной таблицы «коллаба» НЕ СУЩЕСТВУЕТ

**Коллаб-событие = обычная строка в `events` с флагом `is_collab=TRUE` + несколько владельцев в `event_owners`.**

Пример (прод, событие 73):
```
events:        id=73, title='Событие между Роман и ТЕСТ Маргарита Форбс',
               is_collab=TRUE, module_slug='base', status='draft'
event_owners:  (73, client_id=111 Роман,   role='owner',    status='accepted')
               (73, client_id=74  Маргарита, role='co_owner', status='accepted')
```

---

## Таблицы, которые РЕАЛЬНО использует Хаб

| Таблица | Что хранит |
|---|---|
| **`clients`** | **Карточка организатора в каталоге.** `name` (имя основателя), `brand_name` (проект), `owner_photo_url`, `bio` (регалии), `owner_achievements`, `owner_positioning`, `social_links`, **`media_assets`** (медийность), `hub_category`, `hub_niche`, **`hub_niches`** (массив, миграция 295, на проде), `hub_city`, `hub_about` («что предлагает партнёрам»), **`hub_impact` + `hub_impact_public`, `hub_wow` + `hub_wow_public`** (миграция 218), `is_published_in_hub`, `hub_published_at`, **`self_collaborator_id`**, `collab_hub_blocked` (запрет админа на покупку модуля) |
| **`event_owners`** | **Совладельцы коллаб-события:** `event_id`, `client_id`, `status` (pending/accepted/declined), `role` (owner/co_owner), `invited_by_client_id`, **`allow_collab_broadcasts`**. Единственный источник истины о владении событием (`events.client_id` удалён) |
| **`events`** | `is_collab` (это коллаба), `require_subscribe_all_owners` (рычаг «подписка на всех организаторов»), **`collab_finish_warned_at`** (миграция 295, на проде) |
| **`hub_niches`** | Справочник ниш (11: Психология, Здоровье, Духовность, Финансы, Инвестиции, Спорт, Бизнес, Продажи/маркетинг, Отношения, Творчество, Предназначение). ⚠️ Это **таблица-справочник**; не путать с колонкой-массивом `clients.hub_niches` |
| **`hub_collab_requests`** | Запросы: `from_client_id`, `to_client_id`, `event_id` (NULL = коллаба ещё не создана), `status`, `message`, `decline_reason` |
| **`hub_collab_history`** | История коллабов → рейтинг: `client_id`, `event_id`, `partner_client_id`, `participants_total`, `brought_live`, **`win_win_coefficient`**, **`organizers_count`** |
| **`hub_reviews`** | Отзывы: `client_id` (о ком), `author_client_id`, `rating`, `text` |
| **`collab_hub_settings`** | Ссылки на закрытый чат Хаба: `chat_url` (Telegram), **`chat_url_max`** (миграция 266), `chat_title`. Задаёт админ платформы |

Код: [collab_hub.py](../backend/app/api/collab_hub.py) (каталог, карточка, профиль), [collab_events.py](../backend/app/api/collab_events.py) (запросы, владельцы, сват, отзывы, подтверждение рассылок).

---

## Таблицы, которые Хаб НЕ использует

- **`collaborators`** — база «Партнёры» клиента (спикеры, жюри, партнёры, организаторы-карточки событий).
  ✅ **Исправлено 2026-08-14:** колонок `is_published_in_hub`, `hub_category`, `hub_niche`, `hub_city`, `hub_about`, `hub_published_at` в ней **уже НЕТ** — они **дропнуты миграцией 218**. Прежняя формулировка «они мёртвые, подлежат дропу» устарела: задача выполнена. Из «карточных» полей в `collaborators` осталась только `media_assets` — её читают карточка спикера и лендинги (осознанный дубль с `clients.media_assets`, у них разные потребители).

---

## Связь «клиент ↔ его карточка-коллаб»

`clients.self_collaborator_id → collaborators.id` — «моя собственная карточка эксперта».

Нужна, чтобы клиент мог **добавить САМ СЕБЯ** в событие (организатором/спикером) — карточкой с фото и
регалиями. Создаётся идемпотентно (`services/self_collaborator.py`, вызов при регистрации).

**Реф-код клиента** для реф-ссылок = `contacts.ref_code` контакта его self-коллаба
(`clients.self_collaborator_id → collaborators.contact_id → contacts.ref_code`).

---

## Потоки

1. **Публикация карточки** — `/dashboard/collab-hub/card` → `POST /collab-hub/me/card` → пишет в **`clients`**.
2. **Каталог** — `GET /collab-hub/catalog` → `SELECT FROM clients WHERE is_published_in_hub` + рейтинг из `hub_collab_history` + `hub_reviews`.
3. **Запрос коллаборации** — `POST /collab/requests` → строка в `hub_collab_requests` (pending, серый). `event_id` опционален.
4. **Принятие** — `POST /collab/requests/{id}/respond {accept:true}`:
   - нет `event_id` → **создаётся событие** в `events` (title «Событие между X и Y», slug 6 симв, `is_collab=TRUE`), оба пишутся в `event_owners`;
   - есть `event_id` → партнёр добавляется в `event_owners` как `co_owner`.
5. **Рассылки** — каждый организатор шлёт по СВОЕЙ базе через СВОЕГО бота (`broadcast_schedules.client_id` = создатель). Галочка «запросить подтверждение по базам соорганизаторов» → копии в статусе `awaiting_confirm` (пакет = 1 подтверждение, `confirm_batch_id`).
6. **Рейтинг** — при завершении коллаб-события (`status → ended`) `record_collab_history` пишет строку на каждого организатора в `hub_collab_history` (его `brought_live` / общий `participants_total`).

---

## Win-Win коэффициент — главный показатель карточки

```
коэффициент = мои приведённые / (сумма приведённых всеми организаторами / число организаторов)
```
То есть **моё число ÷ среднее по организаторам**. Ориентир **1.0** = сработал вровень с партнёрами, выше — вытянул коллабу.

Функция `win_win_coefficient` в [collab_history.py](../backend/app/services/collab_history.py), результат **хранится** в `hub_collab_history.win_win_coefficient` (+ `organizers_count`), а не считается на лету: он зависит от того, сколько привели остальные, и пересчитывать это на каждой карточке каталога значило бы тяжёлый запрос.

⚠️ Возвращает **`None`** (в UI «—», НЕ 0), если организатор один или никто никого не привёл. Коллабы с `NULL` в среднее по клиенту **не входят** — иначе пустая коллаба тянула бы рейтинг вниз.

⚠️ Почему не «процент вклада» (`brought_live / participants_total`): он **наказывал за масштаб** (вдвоём поровну = 50%, вчетвером = 25% при той же работе), а знаменатель включал людей без `referrer_ref_code`, которых никто себе не засчитывает.

`brought_live` = участники, которых привёл этот организатор **и которые дошли до эфира** (`referrer_ref_code` → его контакт, `link_clicked_at IS NOT NULL`).

## Автозавершение коллаб-события

Celery-таск `finish_ended_collabs` ([tasks/collab_finish.py](../backend/app/tasks/collab_finish.py)), **раз в час**. Нужен потому, что вклад пишется только при переходе в `ended`: не нажали кнопку руками — рейтинг не начислялся никогда.

Конец события = `MAX(conf_days.day_date + close_time)`, иначе `events.end_at`. Нет ни того ни другого → событие не трогаем.

- **За сутки до** — предупреждение всем организаторам (`event_owners status='accepted'`), чтобы успели вмешаться, если просто забыли сдвинуть дату. Отметка `events.collab_finish_warned_at` (миграция 295) — без неё письмо уходило бы каждый час.
- **Не завершаем**, если среди участников нет никого, кроме самих организаторов — защита от «человек тестировал систему на себе».
- Статус и запись истории — **в одной транзакции**, результат `record_collab_history` проверяется явно: иначе событие стало бы `ended` без начисленного вклада и в выборку больше не попало бы.

⚠️ Даты завершённой коллабы менять нельзя (409 в `update_event`) — иначе её можно было бы перезавершить и переписать цифры.

---

## ✅ Дыры, перечисленные на 2026-07-12, — ЗАКРЫТЫ (проверено по коду 2026-08-14)

1. ~~Формы медийности в «Моей карточке» нет, у всех «до 1 000»~~ → **форма есть** (`<MediaAssetsField>` в [_components/shared.tsx](../web/src/app/dashboard/collab-hub/_components/shared.tsx)). Более того, при нулевых подписчиках `_media_tier` теперь возвращает `None`, и плашка охвата просто не показывается — «до 1 000» у всех больше не бывает. Дубль `clients.media_assets` / `collaborators.media_assets` сохраняется, но это осознанное разделение: у них разные потребители.
2. ~~В коллаб-событии `event_collaborators` = 0, раздел «Люди» пуст~~ → **закрыто**: при принятии коллаборации self-коллаб каждого организатора добавляется с ролью `organizer` (`ensure_self_collaborator` в [collab_events.py](../backend/app/api/collab_events.py)).
3. ~~Реф-ссылки строятся по боту владельца~~ → **закрыто**: есть `GET /collab/events/{id}/organizers` с реф-кодом каждого организатора и сервис [collab_referrer.py](../backend/app/services/collab_referrer.py) (`resolve_source_organizer`).
4. ~~Мёртвые колонки `collaborators.hub_*` — дропнуть~~ → **дропнуты миграцией 218**.

## ⚠️ Актуальные вопросы (на 2026-08-14)

1. **Мульти-ниши переведены НЕ везде.** `clients.hub_niches` (массив, миграция 295) читают каталог и «Моя карточка», но **`/matchmaker` (сват) до сих пор сравнивает одну свою нишу с одной чужой** ([collab_events.py](../backend/app/api/collab_events.py), `hub_niche IS NOT DISTINCT FROM`) — вторая и третья ниши в подборе партнёров не участвуют. Также одну нишу показывает [org/[id]/page.tsx](../web/src/app/dashboard/collab-hub/org/%5Bid%5D/page.tsx).
2. **Старая колонка `clients.hub_niche` (ед. ч.) не удалена** — хранит первую нишу из списка, на неё завязаны непереведённые места. Фильтр каталога умеет оба варианта.
3. **Докстринг [collab_history.py](../backend/app/services/collab_history.py) противоречит своему же коду** — обещает «UPSERT обновляет вклад», хотя запись переведена на `ON CONFLICT DO NOTHING` (цифры коллабы фиксируются один раз и позже не переписываются).
