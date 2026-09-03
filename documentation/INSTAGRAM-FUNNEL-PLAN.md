# Воронка Instagram — план реализации

> Статус: **план, к реализации не приступали.** Составлен 2026-09-03.
> Фича `instagram_funnel`, гейт — **только тариф `admin`**.

---

## 1. Что делаем

Человек пишет комментарий под рилсом клиента (или отвечает на сторис) → бот отвечает ему **публично под комментарием** («отправила в директ ✉️») → **пишет в личку** → при желании проверяет подписку на аккаунт → выдаёт материал.

Ровно та механика, что у ManyChat и Salebot.

**Что выдаём — существующий лид-магнит или пакет.** Instagram-воронка это **надстройка над лид-магнитами**, а не вторая их копия: клиент выбирает, какой лид-магнит раздавать, а «как именно раздать» — настройка воронки.

**Два способа выдачи (выбор клиента):**

| Способ | Что происходит |
|---|---|
| `direct` | ссылка на материал приходит прямо в директ Instagram |
| `telegram` | в директ приходит ссылка на **телеграм-бота клиента** (`t.me/{бот}?start=m_{slug}`) — перелив аудитории из Instagram в Telegram, дальше работает уже существующая воронка `/m/` со своей проверкой подписки и Текстами 1/2/3 |

Второй способ — главный сценарий для тех, кто собирает базу в Telegram.

---

## 2. Проверка подписки — ВОЗМОЖНА

Это главный спорный вопрос, ответ: **да, проверить можно.**

В Instagram Messaging API есть **User Profile API**:

```
GET https://graph.facebook.com/v21.0/{igsid}
    ?fields=name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user
    &access_token={токен}
```

Поле **`is_user_follow_business`** = «подписан ли этот человек на ваш аккаунт». Именно на нём построено «подпишись → получи материал» у ManyChat и Salebot.

**Чего действительно нельзя:** получить список подписчиков и проверить подписку на *чужой* аккаунт. Для нашей воронки это и не нужно.

⚠️ **Профиль доступен только по человеку, с которым есть переписка.** Порядок обязателен: комментарий → приватный ответ в директ → человек ответил (нажал кнопку) → **теперь** проверяем подписку. Проверять до его ответа — рискованно, план построен на безопасном порядке. Если на практике окажется, что профиль отдаётся сразу после приватного ответа — можно будет сократить шаг.

---

## 3. Что уже проверено на прод-сервере (2026-09-03)

```
graph.facebook.com   → доступен  (ответ за 0,07 с)
graph.instagram.com  → НЕ доступен (таймаут)
api.instagram.com    → НЕ доступен (таймаут)
```

⚠️⚠️ **Отсюда жёсткое требование: только «Instagram API with Facebook Login»** (домен `graph.facebook.com`). Новый способ «Instagram API with Instagram Login» (домены `graph.instagram.com` / `api.instagram.com`) с нашего сервера **не работает** — заблокирован. Если понадобится он — нужен зарубежный прокси, это отдельная задача.

Следствие: у клиента Instagram должен быть **профессиональным** (Бизнес или Автор) и **связан с Facebook-страницей**.

---

## 4. Куда встраиваем в интерфейс

| Что | Где |
|---|---|
| Подключение аккаунта Instagram | раздел **«Каналы»**, рядом с ботами TG/VK/MAX/WhatsApp |
| Настройка воронок | **«Лид-магниты» → четвёртая подвкладка «Instagram»** |

Обоснование: аккаунт — это канал связи (там же живут все боты); воронка — это способ раздать уже существующий лид-магнит, поэтому она рядом с ним. Отдельный пункт меню развёл бы одну сущность по двум местам.

⚠️ **Instagram НЕ должен появляться в выборе каналов рассылки** — добавить `'instagram'` в `HIDDEN_PLATFORMS` в [BroadcastChannelPicker.tsx](../web/src/components/BroadcastChannelPicker.tsx) (там уже так спрятаны `email` и `whatsapp`). Рассылок по базе Instagram не допускает — только ответ в 24-часовом окне.

---

## 5. Сценарий работы (по шагам)

1. Человек пишет комментарий под рилсом: «ХОЧУ».
2. Meta шлёт нам вебхук `comments`.
3. Ищем подходящую воронку клиента: совпал ли рилс (конкретный или «любой») и слово (конкретное или «любое»).
4. **Публичный ответ под комментарием** — случайная фраза из набора вариаций («Отправила в директ ✉️», «Всё в личных сообщениях 💌», …).
5. **Приватный ответ в директ** — случайная фраза из набора `dm_intro`:
   - подписка требуется → «Подпишись на аккаунт и жми ГОТОВО» + кнопка **ГОТОВО**;
   - подписка не требуется → сразу материал (или ссылка на телеграм-бота).
6. Человек жмёт ГОТОВО → приходит вебхук `messages` с payload.
7. Проверяем `is_user_follow_business`:
   - подписан → выдаём материал (`dm_delivered`);
   - не подписан → `dm_not_subscribed` + кнопка ГОТОВО снова;
   - **сбой проверки → выдаём** (правило проекта: сбой не лишает человека подарка).
8. Пишем забег в `funnel_runs` — счётчики и CRM лид-магнитов заработают сами.

---

## 6. Вариации ответов — обязательны, и не для красоты

Instagram считает спамом повторяющиеся одинаковые публичные ответы и **режет охваты вплоть до блокировки аккаунта**. Поэтому у каждого шага — **набор фраз, из которого выбирается случайная** (та же механика, что у приветствий в чатах события, `event_chat_greetings`).

Четыре набора на воронку:

| Вид | Где показывается |
|---|---|
| `public_comment` | публично под комментарием |
| `dm_intro` | первое сообщение в директ |
| `dm_not_subscribed` | «не вижу подписки» |
| `dm_delivered` | выдача материала |

---

## 7. Схема БД

Последняя миграция в репозитории — **343**. Новые: **344** и **345**.

### Миграция 344 — платформа, фича, канал

```sql
-- платформа
INSERT INTO platforms (slug, display_name, color_hex, id_format,
                       max_message_length, supports_buttons, supports_photo, supports_video,
                       api_base_url, sort_order)
VALUES ('instagram', 'Instagram', '#E1306C', 'string',
        1000, TRUE, TRUE, FALSE,
        'https://graph.facebook.com', 5);

-- фича, только admin
INSERT INTO features (slug, name, description) VALUES ('instagram_funnel', 'Воронка Instagram', '...');
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id FROM tariffs t, features f
 WHERE t.slug = 'admin' AND f.slug = 'instagram_funnel';
```

Аккаунт клиента ложится в существующую **`channels`** — новых таблиц не нужно:

| Колонка | Что хранит |
|---|---|
| `platform_slug` | `'instagram'` |
| `handle` | `@ник` аккаунта |
| `bot_token` | long-lived access token (60 дней) |
| `platform_meta` | `{ig_user_id, page_id, page_name, token_expires_at, scopes}` |

Привязка к клиенту — как у всех, через `client_channels`.

### Миграция 345 — воронки и вариации ответов

```sql
CREATE TABLE instagram_funnels (
  id                  BIGSERIAL PRIMARY KEY,
  client_id           INT  NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel_id          INT  NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,

  -- ТРИГГЕР
  trigger_kind        TEXT NOT NULL DEFAULT 'comment'   -- comment | story_reply
                      CHECK (trigger_kind IN ('comment','story_reply')),
  media_scope         TEXT NOT NULL DEFAULT 'any'       -- any | specific
                      CHECK (media_scope IN ('any','specific')),
  media_ids           TEXT[] NOT NULL DEFAULT '{}',     -- id конкретных рилс/постов
  keyword_mode        TEXT NOT NULL DEFAULT 'any'       -- any | specific
                      CHECK (keyword_mode IN ('any','specific')),
  keywords            TEXT[] NOT NULL DEFAULT '{}',     -- слова в нижнем регистре

  -- ЧТО ВЫДАЁМ (ровно одно из двух)
  lead_magnet_id      INT    REFERENCES lead_magnets(id)          ON DELETE CASCADE,
  package_id          BIGINT REFERENCES lead_magnet_packages(id)  ON DELETE CASCADE,

  -- КАК ВЫДАЁМ
  delivery_mode       TEXT NOT NULL DEFAULT 'direct'    -- direct | telegram
                      CHECK (delivery_mode IN ('direct','telegram')),

  -- УСЛОВИЯ
  require_subscription BOOLEAN NOT NULL DEFAULT TRUE,
  public_reply_enabled BOOLEAN NOT NULL DEFAULT TRUE,

  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order          INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK ((lead_magnet_id IS NOT NULL)::int + (package_id IS NOT NULL)::int = 1)
);

CREATE TABLE instagram_funnel_replies (
  id          BIGSERIAL PRIMARY KEY,
  funnel_id   BIGINT NOT NULL REFERENCES instagram_funnels(id) ON DELETE CASCADE,
  kind        TEXT   NOT NULL
              CHECK (kind IN ('public_comment','dm_intro','dm_not_subscribed','dm_delivered')),
  text        TEXT   NOT NULL,
  sort_order  INT    NOT NULL DEFAULT 0
);
```

⚠️ **После CREATE TABLE обязателен GRANT** — роль `plusson` не владелец таблиц:
```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON instagram_funnels, instagram_funnel_replies TO plusson;
GRANT USAGE, SELECT ON instagram_funnels_id_seq, instagram_funnel_replies_id_seq TO plusson;
```
DDL на проде — только `sudo -u postgres psql -d plusson`.

### Забеги — переиспользуем `funnel_runs`

Отдельной таблицы не заводим. Пишем в существующую с `platform_slug='instagram'`, `platform_user_id = IGSID`. Тогда сами заработают: счётчик «зашло» в списке лид-магнитов, CRM лид-магнитов, фильтр контактов по лид-магниту, аналитика UTM.

Добавить только:
```sql
ALTER TABLE funnel_runs ADD COLUMN instagram_funnel_id BIGINT
  REFERENCES instagram_funnels(id) ON DELETE SET NULL;
```

⚠️ В `funnel_runs` есть UNIQUE `(client_id, platform_slug, platform_user_id, lead_magnet_id)` — повторный комментарий того же человека **обновляет** существующий забег, а не плодит новый. Так и нужно.

### Контакт

Человек из Instagram заводится **только через `upsert_contact_with_identity`** ([contact_merge.py](../backend/app/services/contact_merge.py)) — идентичность `platform_slug='instagram'`, `platform_user_id = IGSID`, `username = @ник`. Своих `SELECT ... FROM contacts` не писать (правило проекта — иначе дубли людей).

---

## 8. Подключение аккаунта (OAuth)

Кнопка «Подключить Instagram» в Каналах → окно Facebook Login → выбор Facebook-страницы → мы получаем токен.

Порядок запросов:
1. `GET /oauth/access_token` — обмен кода на короткий токен.
2. `GET /oauth/access_token?grant_type=fb_exchange_token` — обмен на **long-lived** (60 дней).
3. `GET /me/accounts` — список Facebook-страниц.
4. `GET /{page-id}?fields=instagram_business_account` — id Instagram-аккаунта.
5. `POST /{page-id}/subscribed_apps?subscribed_fields=comments,messages` — подписка страницы на вебхуки.

Нужные разрешения: `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `business_management`.

⚠️⚠️ **Токен живёт 60 дней и его надо обновлять** — иначе воронка через два месяца молча умрёт. Нужен Celery-таск раз в сутки: обновлять токены, которым осталось меньше 10 дней, и предупреждать клиента, если обновление не удалось.

⚠️ **Клиенту нужен VPN на момент подключения** — окно Facebook открывается у него в браузере, а в РФ сайт заблокирован. Один раз при подключении; дальше работает само, потому что запросы к API идут с нашего сервера. Написать это прямо в интерфейсе, иначе будет «у меня ничего не открывается».

---

## 9. Вебхук

⚠️ **У Meta один вебхук на всё приложение** — в отличие от MAX, где у каждого бота свой адрес. Все клиенты приходят на один URL, клиент определяется по `entry[].id` (это `ig_user_id`) → ищем канал → находим клиента.

```
GET  /api/v1/instagram/webhook   — верификация Meta (отдать hub.challenge)
POST /api/v1/instagram/webhook   — события
```

⚠️ **Подпись обязательна** — заголовок `X-Hub-Signature-256`, HMAC-SHA256 тела по `app_secret`. Без проверки любой сможет слать нам фальшивые комментарии и вытаскивать материалы.

⚠️ **Отвечать 200 сразу**, обработку — в фон. Meta считает медленный ответ сбоем и отключает вебхук после серии неудач.

⚠️ Правило nginx — дописать в [nginx-public-locations.conf](../deploy/nginx-public-locations.conf), иначе на домене клиента не отработает.

Подписываемся на поля: `comments` (комментарии, в т.ч. под рилс) и `messages` (директ, включая ответы на сторис).

---

## 10. Бэкенд — файлы

| Файл | Что делает |
|---|---|
| `backend/app/services/instagram_api.py` | обёртка над Graph API: публичный ответ, приватный ответ, отправка в директ, профиль пользователя, список медиа, обновление токена |
| `backend/app/api/instagram_webhook.py` | приём вебхуков, проверка подписи, резолв клиента |
| `backend/app/services/instagram_funnel.py` | движок: подбор воронки, вариации ответов, проверка подписки, выдача |
| `backend/app/api/instagram_funnels.py` | CRUD воронок для кабинета |
| `backend/app/tasks/instagram_tokens.py` | Celery: обновление токенов раз в сутки |

Ключевые вызовы Graph API:

```
POST /{comment-id}/replies              — публичный ответ под комментарием
POST /{comment-id}/private_replies      — первое сообщение в директ (1 раз, 7 дней)
POST /{ig-user-id}/messages             — сообщение в директ (24-часовое окно)
GET  /{igsid}?fields=is_user_follow_business,username
GET  /{ig-user-id}/media?fields=id,caption,media_type,media_product_type,permalink,thumbnail_url
```

---

## 11. Фронт

**Каналы** ([channels/page.tsx](../web/src/app/dashboard/channels/page.tsx)) — Instagram как обычная площадка: кнопка «Подключить», после подключения карточка с @ником, сроком токена и кнопкой «Отключить».

**Лид-магниты** ([lead-magnets/page.tsx](../web/src/app/dashboard/lead-magnets/page.tsx)) — тип `Tab` расширить: `'magnets' | 'packages' | 'template' | 'instagram'`. Внутри — список воронок и форма:

- название;
- триггер: комментарий / ответ на сторис;
- под каким рилс: любой / выбрать из списка (список тянем через `/media` — с превью и подписью, не руками вводить id);
- слово: любое / список слов;
- что выдаём: выпадающий список лид-магнитов и пакетов;
- как выдаём: «ссылкой в директ» / «ссылкой на телеграм-бота»;
- галочка «требовать подписку на аккаунт»;
- галочка «отвечать публично под комментарием»;
- четыре набора фраз-вариаций (добавить/удалить/переставить).

⚠️ Страница уже использует `useSearchParams` — новая вкладка внутри неё, отдельной страницы не создаём, поэтому `<Suspense>` дополнительно не нужен.

---

## 12. Ограничения Meta — знать заранее

| Ограничение | Что значит на практике |
|---|---|
| Приватный ответ на комментарий — **1 раз** и в течение **7 дней** | на один комментарий одно сообщение в директ; новый комментарий = новая возможность |
| Переписка в директ — **24 часа** с последнего сообщения человека | если человек ушёл на два дня и вернулся — писать нельзя, пока не напишет сам |
| Аккаунт должен быть **Бизнес/Автор** + связан с Facebook-страницей | обычный личный не подойдёт |
| Вебхуки не приходят на комментарии владельца и под рекламными постами | реклама — отдельная подписка |
| «Конкретная сторис» живёт 24 часа | практично только «любая сторис» + слово; конкретную придётся переназначать каждый день |
| Повторяющиеся одинаковые ответы = спам | поэтому вариации фраз обязательны |

---

## 13. Модерация Meta — и почему её можно НЕ ждать

Обычно для чужих аккаунтов нужен **App Review** (заявка с видео-демо, политикой конфиденциальности, верификацией бизнеса) — это недели ожидания.

⚠️⚠️ **Но фича на тарифе `admin`** — то есть только для своих кабинетов. Приложение Meta в режиме разработки полноценно работает с аккаунтами, у которых есть **роль в приложении** (администратор / разработчик / тестировщик). Значит:

- аккаунт Марго добавляем ролью в приложение → **всё работает сразу, без модерации**;
- App Review понадобится только если фичу откроют клиентам.

Это снимает главный риск по срокам: делать и тестировать можно немедленно.

---

## 14. Что нужно от владельца (до старта работ)

1. Аккаунт на [developers.facebook.com](https://developers.facebook.com), создать приложение типа Business, добавить продукт **Instagram** и **Facebook Login**.
2. Instagram Марго перевести в **Бизнес/Автор** и связать с Facebook-страницей (если ещё не связан).
3. Передать `App ID` и `App Secret` — положим в переменные окружения (`IG_APP_ID`, `IG_APP_SECRET`, `IG_WEBHOOK_VERIFY_TOKEN`).
4. Добавить свой Instagram-аккаунт ролью в приложение.
5. VPN на время подключения.

---

## 15. Порядок работ

- [ ] **0.** Подготовка Meta (пункт 14) — делается параллельно с кодом
- [ ] **1.** Миграции 344 + 345, GRANT, фича `instagram_funnel` на `admin`
- [ ] **2.** `instagram_api.py` — обёртка Graph API
- [ ] **3.** OAuth-подключение аккаунта + карточка в Каналах
- [ ] **4.** Вебхук: приём, проверка подписи, резолв клиента, ответ 200 сразу
- [ ] **5.** Движок воронки: подбор, вариации, проверка подписки, выдача (оба способа)
- [ ] **6.** CRUD воронок + подвкладка «Instagram» в лид-магнитах
- [ ] **7.** Celery: обновление токенов + предупреждение клиенту
- [ ] **8.** Скрыть Instagram из выбора каналов рассылки
- [ ] **9.** Проверка на живом аккаунте: комментарий → директ → подписка → материал
- [ ] **10.** Обновить `CLAUDE.md`, `PLAN.md`, `BACKEND-PLAN.md`, `TESTING.md`

---

## 16. Открытые вопросы (решить перед этапом 5)

1. **Повторный комментарий того же человека** — выдавать материал снова или отвечать «уже отправляла»? Предлагаю выдавать снова (человек мог потерять сообщение), но не чаще раза в час.
2. **Если человек не подписался и молчит** — слать ли напоминание, как Текст 3 в наших воронках? Мешает 24-часовое окно: напомнить можно только внутри него.
3. **При выдаче ссылкой на телеграм-бота** — проверять ли подписку ещё и в Instagram, или пусть проверяет уже телеграм-воронка? Сейчас в плане галочки независимы, можно включить обе.
