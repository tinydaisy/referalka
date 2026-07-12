# Коллабораторная (Хаб) — АРХИТЕКТУРА КАК ЕСТЬ

> Это описание **текущего состояния кода и БД** (сверено с продом 2026-07-12).
> Концепция `CONCEPT-COLLAB-NETWORK.md` — это ТЗ, реализация от него **РАЗОШЛАСЬ**. Верить этому файлу.

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
| **`clients`** | **Карточка организатора в каталоге.** `name` (имя основателя), `brand_name` (проект), `owner_photo_url`, `bio` (регалии), `owner_achievements`, `owner_positioning`, `social_links`, **`media_assets`** (медийность → «до 1000 / 5–10 тыс»), `hub_category`, `hub_niche`, `hub_city`, `hub_about` («что предлагает партнёрам»), `is_published_in_hub`, `hub_published_at`, **`self_collaborator_id`** |
| **`event_owners`** | **Совладельцы коллаб-события:** `event_id`, `client_id`, `status` (pending/accepted/declined), `role` (owner/co_owner), `invited_by_client_id`. Единственный источник истины о владении событием (`events.client_id` удалён) |
| **`events`** | `is_collab` (это коллаба), `require_subscribe_all_owners` (рычаг «подписка на всех организаторов») |
| **`hub_niches`** | Справочник ниш (11: Психология, Здоровье, Духовность, Финансы, Инвестиции, Спорт, Бизнес, Продажи/маркетинг, Отношения, Творчество, Предназначение) |
| **`hub_collab_requests`** | Запросы: `from_client_id`, `to_client_id`, `event_id` (NULL = коллаба ещё не создана), `status`, `message`, `decline_reason` |
| **`hub_collab_history`** | История коллабов → рейтинг и «Win-Win / средний вклад»: `client_id`, `event_id`, `partner_client_id`, `participants_total`, `brought_live` |
| **`hub_reviews`** | Отзывы: `client_id` (о ком), `author_client_id`, `rating`, `text` |

Код: [collab_hub.py](../backend/app/api/collab_hub.py) (каталог, карточка, профиль), [collab_events.py](../backend/app/api/collab_events.py) (запросы, владельцы, сват, отзывы, подтверждение рассылок).

---

## Таблицы, которые Хаб НЕ использует

- **`collaborators`** — база «Партнёры» клиента (спикеры, жюри, партнёры, организаторы-карточки событий).
  ⚠️ В ней ЕСТЬ колонки `is_published_in_hub`, `hub_category`, `hub_niche`, `hub_city`, `hub_about` —
  **они МЁРТВЫЕ**: 0 записей, код Хаба к ним не обращается. Подлежат дропу.
- **`event_collaborators`** — карточки людей внутри конкретного события.
  ⚠️ В коллаб-событиях там **0 записей** → раздел «Люди» пустой.

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

## ⚠️ Известные дыры (на 2026-07-12)

1. **`media_assets` — ДУБЛЬ в двух таблицах:**
   - `clients.media_assets` → читает **Хаб** (медийность в карточке каталога);
   - `collaborators.media_assets` → читает **карточка спикера** (лендинги, виджеты).
   **Формы для медийности в «Моей карточке» Хаба НЕТ** → у всех «до 1 000», повлиять нельзя.
   Решение: свести к одной точке (Хаб читает медийность из self-коллаба) ЛИБО добавить форму.

2. **В коллаб-событии нет карточек организаторов.** `event_owners` = 2, `event_collaborators` = 0 →
   раздел «Люди» пуст, нет ни «Организаторов», ни их реф-ссылок.
   Решение: при принятии коллаборации авто-добавлять self-коллаб каждого организатора в
   `event_collaborators` с ролью `organizer`.

3. **Реф-ссылки в коллабе.** Общий `/events/{id}/share-links` строит ссылку **по боту владельца** —
   для коллабы неверно. Нужен раздел, где у КАЖДОГО организатора ссылка **через ЕГО бота** и с ЕГО реф-кодом
   (иначе приведённые им люди не засчитаются ему в `brought_live`).

4. **Мёртвые колонки** `collaborators.hub_*` + `collaborators.is_published_in_hub` — дропнуть.
