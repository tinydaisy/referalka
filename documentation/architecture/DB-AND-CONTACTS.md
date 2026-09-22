# База данных, контакты и идентичность

> ⚠️ Вынесено из `CLAUDE.md` 14.09.2026: файл вырос до 932 КБ и новая
> сессия перестала открываться вовсе — он один не помещался в окно.
> Текст перенесён ДОСЛОВНО. Правишь код — правь этот файл, а в
> `CLAUDE.md` держи только короткую ссылку.

### ⚠️⚠️ ПЕРЕД ЛЮБЫМ SQL — СВЕРИТЬ СХЕМУ. Ловушки, на которых уже ошибались

Документация ниже писалась годами и местами отстаёт от базы. **Источник истины — сама БД, а не этот файл.** Снимок реальной схемы прода лежит в [other_tasks/_prod_schema_snapshot.txt](other_tasks/_prod_schema_snapshot.txt) (формат `таблица|колонка|тип`, снят 2026-08-14). Обновить: `\copy (SELECT table_name||'|'||column_name||'|'||data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY 1) TO ...`

**Таблиц, которые часто пишут по привычке, НЕ СУЩЕСТВУЕТ:**

| Пишут по ошибке | Правильно |
|---|---|
| `speakers` | `collaborators` + `event_collaborators` |
| `conf_speaker_events` | **`event_collaborators`** |
| `client_assistants` | `assistants` + `assistant_grants` (миграция 209) |
| `telegram_users` | `platform_users` |
| `notifications_log` | нет замены, таблица удалена |

**Колонок, которых НЕТ (удалены), но они всплывают в старых текстах:**
`contacts.email` и `contacts.email_normalized` (мигр. 282 — почта только в `platform_users`), `clients.owner_name` (никогда не было — имя основателя берётся из `clients.name`), `events.link_mode` (мигр. 240), `events.telegram_chat_ids` (мигр. 171), `events.poster_url` (мигр. 044 — афиши в `event_posters`), `platform_users.is_unsubscribed` (мигр. 034 — живёт в `platform_user_channels`), `clients.bot_token` (мигр. 033 — в `channels.bot_token`), `conf_sessions.start_datetime`/`end_datetime` (время — строки `HH:MM` в `start_time`/`end_time`), `conf_conferences.registration_url` и `.description` (мигр. 092), `collaborators.hub_*` и `collaborators.is_published_in_hub` (**дропнуты мигр. 218** — карточка Хаба живёт в `clients`), `collaborators.poster_url` / `event_collaborators.poster_url` (мигр. 121 — библиотека `collaborator_posters`), `materials.kind/url/body/duration_sec/size_bytes` (**мигр. 294** — содержимое в `material_blocks`).

**Типы, на которых легко ошибиться:**
`collaborators.tg_channel_id` — `character varying`, НЕ integer. `*_kopecks` (бонусы), `entry_link_log.id`, `event_chat_greetings.id` — `bigint`. `client_testimonials.tags` — `ARRAY`. `product_orders.amount` — `numeric(12,2)`, а `product_tariffs.price` — `integer` (приводить явно). `event_landing_pages.event_id` — теперь **nullable** (полиморфизм, мигр. 293).

**⚠️ Роль `plusson` не владелец таблиц.** DDL на проде — только `sudo -u postgres psql -d plusson`, и после `CREATE TABLE` обязателен `GRANT` на таблицу и её sequence, иначе API получит `permission denied`.

**✅ Технические backup-таблицы `_bak_*` удалены с прода 2026-08-14** (было 12 шт., суммарно ~0,4 МБ — снимки данных перед ручными правками за июнь–август). Перед удалением снят дамп: `/var/backups/plusson/bak_tables_20260814_0516.sql.gz` на прод-сервере. Ссылок из кода и внешних ключей на них не было.

⚠️ **Правило на будущее:** снимок перед ручной правкой данных делать можно, но такие таблицы **временные** — после проверки результата удалять. Иначе они копятся годами и путают: `_bak_*` легко принять за рабочую таблицу. Долгое хранение — это дамп в `/var/backups/plusson/`, а не таблица в рабочей базе.
### ✅ DDL мимо миграций восстановлен (миграция 337 от 2026-09-02)

Часть структуры жила **только на проде** — её заводили прямым `ALTER`, а файла миграции не писали. Базу с нуля по `db/migrations` собрать было нельзя: код падал на несуществующих колонках. Восстановлено (файл безопасен, на проде отработал вхолостую):

- **`event_participants.is_registered` / `is_in_chat` / `entry_link`** — миграция 130 честно писала «существующее поле», но создающей миграции не было никогда.
- **Фича `surveys`** — код требовал её (`surveys.py`), а ни одна миграция не заводила: на чистой базе анкеты не открылись бы даже у admin.

⚠️ **Правило:** колонку или фичу заводим ФАЙЛОМ миграции, даже если правка делается руками на сервере. Иначе о ней не узнает ни следующий разработчик, ни следующая копия базы.
### ✅ Миграция 295 накачена на прод (проверено 2026-08-14)

`clients.hub_niches TEXT[]` и `events.collab_finish_warned_at` **есть на проде**, код (коммит `5c2e9abe`) задеплоен. Раньше в этом месте было предупреждение о рассинхроне — оно снято по факту проверки.

⚠️ **Не путать две сущности с одним именем:** `hub_niches` — это И таблица-справочник ниш (сид миграции 134, `slug`/`title`/`sort_order`), И колонка-массив `clients.hub_niches`. В запросах смотреть на префикс.

⚠️ **Старая колонка `clients.hub_niche` (единственное число) НЕ удалена** и хранит первую нишу из списка — на неё завязаны ещё не переведённые места. Фильтр каталога умеет оба варианта: `$1 = ANY(cl.hub_niches) OR cl.hub_niche = $1`.

⚠️ **Переход на мульти-ниши не завершён.** По одной нише до сих пор работают: **сват `/matchmaker`** ([collab_events.py](backend/app/api/collab_events.py) — `hub_niche IS NOT DISTINCT FROM`, вторая и третья ниши в подборе партнёров не участвуют) и карточка организатора [org/[id]/page.tsx](web/src/app/dashboard/collab-hub/org/%5Bid%5D/page.tsx).

**Общее правило на будущее:** миграция считается сделанной только когда она накачена на прод. Пока не накачена — помечать «⚠️ ещё не на проде», иначе документация обещает поля, которых в базе нет.
### Подсистемы, которых раньше не было в этом файле (сверено с кодом 2026-08-14)

Все перечисленные ниже — **живые**, роутеры зарегистрированы в [main.py](backend/app/main.py), задачи — в [celery_app.py](backend/app/celery_app.py).

- **МедиаЛифт** ([medialift.py](backend/app/api/medialift.py), [medialift_cabinet_html.py](backend/app/api/medialift_cabinet_html.py)) — виральная автоподписка на TG-каналы: человек заходит по реф-ссылке, видит до 7 участников своей ветки, обязан подписаться на 3 (`events.medialift_required_subscriptions`), затем сам добавляет канал и становится карточкой для следующих. Это **одно служебное событие на всю платформу** (`events.module_slug='medialift'`) на сервисном клиенте, а не список событий. Реф-цепочка **не хранится** — считается рекурсивным CTE по `event_participants.referrer_ref_code`. ⚠️ Проверка подписки **fail-open**: бот не админ в канале → подписка засчитывается. Фронт — [MediaLiftTab.tsx](mini-app/src/tabs/MediaLiftTab.tsx), пункт меню виден только `is_system_service`.
- **ПЛЮСОН Коннект** ([pluson_connect.py](backend/app/api/pluson_connect.py), [pluson_connect_token.py](backend/app/services/pluson_connect_token.py)) — человек, который есть у клиента контактом в боте, привязывает свой аккаунт ПЛЮСОНа. Бот выдаёт подписанный JWT (`kind='pluson_connect'`, 1 час), ссылка ведёт на `pluson.ru/link-pluson?token=`, там вводятся email/пароль → пишется `contacts.linked_client_id`. ⚠️ **Причина, по которой форма на нашем домене, — юридическая:** ПД вводятся на сервере в РФ с явной галочкой согласия (`consent_pd=False` → 422), в мессенджере ПД не собираем. ⚠️ Контакт ищется строго по `(client_id, platform, user_id)` **из токена**, не из URL — иначе по чужой ссылке можно было бы привязать чужой аккаунт.
- **Бонусы** ([bonuses.py](backend/app/services/bonuses.py)) — кошелёк клиента **в копейках**: `client_bonus_transactions` (источник правды) + `client_bonus_balance` (кэш). Типы: `accrual`, `payment`, `withdrawal_hold`, `withdrawal_cancel`, `withdrawal_done`. Наполняется кэшбэком 10% с реф-программы ПЛЮСОНа, тратится на подписку или выводится. ⚠️ Каждая функция берёт `SELECT ... FOR UPDATE` на баланс — **обновлять баланс мимо этих функций нельзя**. ⚠️ `mark_withdrawal_done` баланс НЕ трогает: деньги уже списаны на `hold`, иначе двойное списание.
- **Отзывы и кейсы** ([client_testimonials.py](backend/app/api/client_testimonials.py), фича `testimonials`, Экстра) — общая база на клиента, а не на событие: один отзыв нужен и на лендинге, и в рассылке. Отбор в галерею идёт **по тегам**, поэтому массовая загрузка сразу принимает общий набор тегов. ⚠️ `_norm_tags` жёстко нормализует (lowercase, ≤40 символов, ≤20 тегов) — иначе «Конференция» и «конференция» стали бы разными метками.
- **Оферты** ([client_offers.py](backend/app/api/client_offers.py), фича `offers`) — текст оферты хранится у нас, публичная страница `/o/{slug}`; если оферта уже есть снаружи — `external_url`. Ссылки: `events.offer_id`, `event_tariffs.offer_id`. ⚠️ **`slug` уникален только внутри клиента, а публичный URL клиента не содержит** — при коллизии выигрывает меньший `id` (осознанный риск). Смежная, но отдельная подсистема — [legal.py](backend/app/api/legal.py): юр-данные 152-ФЗ + версионируемая политика ПД (`client_policy_versions`), **без гейта по фиче** (обязательна всем).
- **Отзыв рассылки** ([broadcast_recall.py](backend/app/services/broadcast_recall.py)) — удаляет уже отправленные сообщения: TG `deleteMessage`, VK `messages.delete(delete_for_all=1)`, MAX `DELETE /messages`; **email отозвать невозможно**. ⚠️ `message_id` начали сохранять только с 2026-07-16 — более старые рассылки не отзываются. ⚠️ Telegram даёт удалять лишь в пределах **48 часов**. Статус `recalled` ставится только если реально что-то удалено, и отличается от `cancelled` (снята до отправки, можно запустить снова).
- **`identity_resolver` vs `contact_merge` — НЕ дубли.** [identity_resolver.py](backend/app/services/identity_resolver.py) ходит **во внешний API** платформы: `@username` → числовой id (TG `getChat` — работает, только если человек писал боту; VK `users.get` — почти всегда; **MAX публичного API не имеет, всегда None**). [contact_merge.py](backend/app/services/contact_merge.py) работает **с нашей БД**: найти/создать/склеить контакт. Резолвер в БД не пишет и никогда не кидает исключений.
- **Запись вебинара** ([tasks/webinar_recording.py](backend/app/tasks/webinar_recording.py)) — MediaMTX пишет сегменты на диск, задача склеивает их ffmpeg и заливает в R2 (`webinar_recordings`). ⚠️ Задача обязана выполняться **на той же машине**, где MediaMTX пишет файлы. ⚠️ Пишется **весь поток**, включая настройку спикера до эфира, и физически он **не обрезается** — вместо этого считается `live_offset_sec` (на какой секунде файла нажали «Начать эфир»), см. раздел «Нарезка записи по спикерам».

⚠️⚠️ **`asyncio.set_event_loop(loop)` ОБЯЗАТЕЛЕН в каждой Celery-задаче** (2026-08-19). `new_event_loop()` создаёт цикл, но **не делает его текущим**; библиотеки внутри зовут `asyncio.get_event_loop()` и получают **закрытый** цикл предыдущей задачи того же воркера → `RuntimeError('Event loop is closed')`. Из-за этого **молча терялись записи эфиров и Текст 3 воронок лид-магнитов** — задача принималась и падала, клиент месяц видел «обрабатывается…». Было сломано в 6 задачах (`broadcast`, `collab_finish`, `funnel`, `nurture`, `nurture_reg`, `webinar_recording`), исправлено во всех. Шаблон — `new_event_loop()` + `set_event_loop(loop)`, в `finally` — `close()` + `set_event_loop(None)`.

⚠️ **Заливка записи — только `r2_storage.upload_file`** (потоком, multipart), НЕ `upload_bytes`: запись весит гигабайты, чтение целиком в память кладёт воркер по OOM. Реальный эфир на 2,5 ГБ так и не залился.

⚠️ **Сегменты удаляются ТОЛЬКО после `status='ready'`** (`_cleanup_segments`) — до успешной заливки это единственная копия эфира. Заодно у MediaMTX свой таймер `recordDeleteAfter: 720h` (30 дней) в [mediamtx.yml](media-server/mediamtx.yml): он **сам сотрёт сегменты**, поэтому незалитая запись живёт максимум месяц.

⚠️ `duration_sec` заполняется через `ffprobe` (`_probe_duration`); нет ffprobe → NULL, задача не падает.
- **Приветствия в чатах события** ([event_chat_greetings.py](backend/app/api/event_chat_greetings.py)) — набор случайных фраз, бот отвечает на кодовое слово. ⚠️ Настройки раскиданы: сами фразы в `event_chat_greetings`, а включатель и кодовое слово — в **`events.chat_greeting_enabled` / `chat_greeting_keyword` / `chat_greeting_exact`** (правятся через `PATCH /events/{id}`). ⚠️ Дефолтный набор **авто-сидится на GET** — чтение с побочным эффектом записи.
- **Детектор чужого вебхука** ([bot_webhook_watch.py](backend/app/services/bot_webhook_watch.py), [tasks/bot_webhook_check.py](backend/app/tasks/bot_webhook_check.py), миграция 288) — Telegram отдаёт сообщения только одному получателю: если клиент подключил бота ещё и к BotHelp/Salebot, наш polling молча перестаёт получать всё, и у клиента отваливаются воронки, подарки и регистрации. Раз в час обходим ботов через `getWebhookInfo` (`channels.webhook_url` / `webhook_checked_at` / `webhook_notified_at`). ⚠️ **Вебхук сами НЕ снимаем** — это сломает клиенту его сервис; только сообщаем. ⚠️ `''` (вебхука нет) и `None` (спросить не удалось) — **разные** вещи: при `None` состояние не трогаем, иначе плашка погасла бы у сломанного бота. Письмо — один раз на проблему, плашка висит, пока проблема есть. Фронт — [BrokenBotsBanner.tsx](web/src/components/BrokenBotsBanner.tsx), данные приходят в `/auth/me` полем `broken_bots`.
- **Экспорт участников/контактов** ([participants_export.py](backend/app/api/participants_export.py), [contacts_export.py](backend/app/api/contacts_export.py)) — read-only API для сторонних сервисов, авторизация **не JWT, а `X-Integration-Token`**. Списки: все / зарегистрированные / нет / в чате / оплатившие / неоплатившие. ⚠️ **Из всех списков вычитаются коллабораторы события** — отдаётся чистая аудитория зрителей. ⚠️ Двойная проверка: токен обязан принадлежать владельцу события, иначе 403.
- **Ставка рефералки** ([referral_rate.py](backend/app/services/referral_rate.py), миграция 227) — процент **замораживается на приведённом клиенте при регистрации** (`clients.referral_rate_percent`, `referral_accrual_until`), а не читается глобально при начислении. Поэтому смена процента в админке действует только на новых: обещание «10% до 2027» для уже приведённых остаётся. ⚠️ Истёк `referral_accrual_until` → `effective_percent` возвращает 0.
- **Лог входов** ([entry_link_log.py](backend/app/services/entry_link_log.py)) — сырьё каждого захода по ссылке, до создания чего-либо. Нужен, потому что **VK при холодном открытии Mini App теряет `startParam`**, и рефовод не доезжает; по логу видно, пришёл `pid` от платформы или нет. ⚠️ Таблица **write-only** (API её не читает) и **растёт без ретенции**. ⚠️ Вопреки докстрингу, подключён **только к VK** ([vk_event.py](backend/app/api/vk_event.py)), не к TG/MAX/вебу.
- **Удалённое медиа** ([remote_media.py](backend/app/services/remote_media.py)) — клиент даёт ссылку на фото в облаке, мы скачиваем и перезаливаем в R2, потому что мессенджеры не открывают «страницу просмотра» Google Drive. Нормализует Google Drive → `uc?export=download`, Dropbox → `dl=1`. ⚠️ Лимит **20 МБ**; Google Drive на больших файлах отдаёт HTML вместо файла — это ловится и объясняется клиенту по-русски.

**Мёртвый код / расхождения с докстрингами:** `bot_webhook_watch.banner_text()` не вызывается нигде (фронт рисует плашку сам); обрезка записи вебинара заявлена, но не реализована; `referrals.py:132` содержит захардкоженный `COALESCE(...,10)` мимо `DEFAULT_PERCENT`; докстринг [collab_history.py](backend/app/services/collab_history.py) до сих пор обещает «UPSERT обновляет вклад», хотя код переведён на `DO NOTHING`.
### ⚠️⚠️ В ЧЬЮ БАЗУ ПОПАДАЕТ ЧЕЛОВЕК — только `resolve_event_client` (2026-08-17)

**Клиент события НИКОГДА не выбирается запросом «первый из `event_owners`» там, где речь о ЧЕЛОВЕКЕ** — его контакте, регистрации, реф-коде или боте, которым ему пишут. Единая точка — [event_client.py](backend/app/services/event_client.py).

**Почему.** У обычного события владелец один, и «первый из списка» = он же. У коллабы владельцев несколько и они равноправны: суть в том, что каждый ведёт СВОЮ базу через СВОЕГО бота. «Первый» там определяется порядком строк (`ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1`), то есть тем, кто раньше принял приглашение.

**Что ломалось** (прод, событие 92): человек шёл по ссылке Нурии, а попадал в базу Лилии — контакт и регистрация уходили не тому; реф-код Нурии искался в базе Лилии, не находился и **молча терялся** (привлечение не засчитывалось никому); уведомления слал чужой бот; догрев не находил бота и умирал с `no_channel`; заход и регистрация расходились по разным базам, и Mini App показывал человека незарегистрированным — **все вкладки под замками**.

**Правило выбора:** реф-код в ссылке → база его владельца; иначе клиент бота/Mini App, через который зашли; иначе как передали. Оба кандидата проверяются на участие в событии (`event_owners`), иначе по чужому коду человека уводили бы в постороннюю базу. Если контакт уже известен — берётся его база, это надёжнее всего.

⚠️ **Подзапрос «первый владелец» встречается в 87 местах (32 файла), из них ~36 критичных.** Чинить по одному бесполезно — баг всплывает в следующей точке входа. Переведены: TG-бот (`ref_pg`, `evsignup`), VK-меню, MAX-вебхук, форма регистрации Mini App, `event_start`, кнопка чата на веб-странице, welcome-email. **Остальные — при следующем касании переводить на `resolve_event_client`, а не копировать подзапрос.**

⚠️ **Mini App шлёт своего клиента полем `client_id`** (из адреса `/c/{N}/tg/`) — и в `event_start`, и в форму регистрации. Без него при заходе без реф-кода снова сработает «первый владелец». Адрес Main Mini App клиент прописывает в @BotFather **вручную**, и проверить его со стороны платформы нельзя (Telegram эту настройку по API не отдаёт) — поэтому реф-код важнее.
### Единый набор GET-параметров на все внешние URL клиента (миграция 105+, обновлено 2026-05-24)

**Где применяется:** ВСЕ места, где открывается сторонний URL клиента:
- `events.landing_url` — лендинг события (Mini App `redirectToExternalLanding`, SSR `/l/[slug]`, `/landing-redirect` endpoint)
- `events.vip_url` — кнопка VIP-тарифа в Mini App (ProgramTab/TurnirProgramTab/WelcomePage/ResultsTab — все через `onVipClick`)
- `clients.partner_landing_url` — партнёрский сервис клиента (url-кнопка в боте, миграция 105)

**Стандартный набор параметров** (только непустые значения; имена жёстко зафиксированы для GetCourse/Tilda/Bizon360 — клиент один раз настраивает скрытые поля):

| Параметр | Что |
|---|---|
| `pluson_contact_id` | `contacts.id` (наш ID контакта в ПЛЮСОНе) |
| `pluson_participant_id` | `event_participants.id` (только для событий) |
| `tg_id` | Telegram user ID |
| `vk_id` | VK user ID |
| `email` | почта человека — ⚠️ берётся из `platform_users(platform_slug='email').platform_user_id`, колонки `contacts.email` НЕ существует |
| `phone` | `contacts.phone` |
| `name` | `contacts.name` |
| `tg_nickname` | username из platform_users (без @) |
| `pid` | реф-код того, кто привёл (для совместимости) |
| `utm_source` | UTM-метка источника |
| `event_slug` | slug события (только для events.landing_url и vip_url) |
| `{external_ref_param}` | партнёрский код во внешней системе клиента (например `gcpc=fdd97`) — приклеивается как есть, в конец URL |

### ⚠️⚠️ Разбор ссылки: значение маркера может содержать `_` (23.09.2026)

Стартовый параметр — одна слитная строка: `ref_pg{slug}_pid{код}_cid{N}_tab{имя}`
(так же устроены `m_`, `p_`, `evl_`, `pr_`). Раньше каждый обработчик резал её
своим `split("_")` и брал один кусок — **и обрубал значение на первом же
подчёркивании внутри него**.

**Что ломалось.** Реф-коды апрельского импорта выглядят как `tg_392695076` и
`sp_2a1a351a` — таких в базе **95** (89 `tg_<id>` + 6 `sp_<хеш>`, среди них 12
спикеров). Переход по ссылке
`t.me/ivision_conf_bot?startapp=ref_pgivision9_pidtg_392695076_cid1` давал
`pid = "tg"`. Контакта с кодом `tg` нет, `resolve_ref_code` возвращал пусто, и
человек записывался как **«пришёл сам»** — привлечение не засчитывалось никому
и нигде не всплывало. Найдено на проде: событие 89, переход по ссылке Элины
Бутенко (`contacts.id=4732`).

**Как теперь.** Единая точка — [start_param.py](backend/app/services/start_param.py):
кусок, который сам не начинается с известного маркера, приклеивается обратно к
предыдущему через `_`. Зеркало для фронта — `splitMarkers` в
[App.tsx](mini-app/src/App.tsx) (Mini App читает `startapp` сам, до бэкенда).

⚠️ Новый обработчик ссылок пишем **через этот разборщик**, а не «примерно таким
же» `split("_")`: такая поломка не видна ни человеку, ни рефоводу, ни в отчётах.

⚠️ **Query-параметр `?pid=` этим не болел** — там код приходит отдельным полем и
не режется. Болели только слитные payload: боты (`/start`) и Mini App (`startapp`).

### ⚠️⚠️ Журнал переходов видел не все площадки (23.09.2026)

[entry_link_log](backend/app/services/entry_link_log.py) писался **только в
`/start` у TG-бота и в ВК**. В базе за всё время жили ровно две платформы:
`telegram` и `vk`. Не фиксировались:

- **MAX — вообще**, ни одной строки в коде, 0 записей;
- **Mini App и веб-версия** — ссылка `?startapp=…` открывает приложение
  **напрямую**, сообщения боту нет, обработчик `/start` не срабатывает.

Из-за этого переход по ссылке Элины на событие 89 не нашёлся в журнале вовсе —
разбираться было не по чему (в журнале 55 заходов на `ivision9` при 289
участниках, и 44 из них — ВК).

**Где пишется теперь** — все пять путей:

| Путь | Точка записи | `platform` |
|---|---|---|
| TG-бот `/start` | [start.py](backend/bot/handlers/start.py) | `telegram` |
| ВК | [vk_main.py](backend/bot/vk_main.py), [vk_event.py](backend/app/api/vk_event.py) | `vk` |
| MAX-бот `/start` | `_process_start` в [max_webhook.py](backend/app/api/max_webhook.py) | `max` |
| MAX Mini App | [max_event.py](backend/app/api/max_event.py) | `max` |
| Mini App / веб — **открытие** | `POST /event` ([event.py](backend/app/api/event.py)) | `{площадка}-app` |
| Mini App / веб — **регистрация** | `POST /participants/register` ([participants.py](backend/app/api/participants.py)) | `{площадка}-reg` |

⚠️ В `POST /event` запись идёт **до** отсечки по платформе и до проверки
`event_slug`: заход должен попасть в журнал, даже если дальше мы ничего не
отправляем. Иначе не-TG-площадки снова стали бы невидимыми.

**Хелперы** ([backend/app/services/external_landing.py](backend/app/services/external_landing.py)):
- `enrich_external_url(url, *, ...)` — собирает URL с полным набором параметров. Универсальный.
- `get_contact_landing_params(db, contact_id)` — асинх. подтягивает name/email/phone/tg_id/vk_id/tg_nickname/external_ref_param контакта.
- `build_external_landing_url(...)` — обратная совместимость для events landing.

**⚠️ Очистка полей визитки (фото/регалии/тексты) — через `model_fields_set` (2026-06-30, коммит 36e2f2c).** `PATCH /clients/me/profile` ([client_profile.py](backend/app/api/client_profile.py)) раньше использовал `if data.X is not None` — Pydantic не различает «прислали null» и «не прислали», поэтому очистить фото/регалии было нельзя (старое значение оставалось). Теперь смотрим `data.model_fields_set`: ключ есть в JSON (хоть `null`) → применяем (очищаем на None / `[]`); ключа нет → не трогаем. Файл из R2 удаляет сам `FileUploader` (DELETE `/uploads/by-url`) при снятии фото в форме. ⚠️ При новых полях визитки в PATCH — использовать тот же паттерн `if "field" in fs`, не `is not None`.

**Endpoints для Mini App:**
- `GET /api/v1/public/events/{slug}/landing-redirect?tg_id=&vk_id=&pid=&utm_source=` → `{redirect_url}`. Используется для events.landing_url.
- `GET /api/v1/public/events/{slug}/vip-redirect?tg_id=&vk_id=&pid=&utm_source=` → `{redirect_url}`. Используется для events.vip_url.

**Webhook** ([backend/app/api/integrations.py](backend/app/api/integrations.py)) принимает алиасы: `pluson_contact_id` (стандарт), `pluson_cid` (legacy), `contact_id` (явный) — все мапятся в `data.contact_id`. То же для `pluson_participant_id` → `participant_id`.

**Партнёрский сервис** ([backend/app/services/partner_service.py](backend/app/services/partner_service.py) `_build_partner_landing_url`) использует общий `enrich_external_url` — на партнёрский лендинг шлёт `external_ref_param` РЕФОВОДА (это его код), не свой.

**Произвольные флаги `_q{key}` для активации блоков на стороннем лендинге (2026-05-25).** К стандартному набору можно добавить произвольные «маркеры тарифа» — например, чтобы в Tilda/GetCourse показывался скрытый блок при наличии `?shpw` в URL.

| Откуда приходит флаг | Формат прямой ссылки | Что попадает на лендинг |
|---|---|---|
| TG (прямая ссылка) | `t.me/{bot}?start=ref_pg{slug}_qshpw_qvip` | `&shpw=1&vip=1` |
| VK Mini App | `vk.com/app{aid}#ref_pg{slug}_qshpw` | `&shpw=1` |
| MAX | `max.ru/{handle}?startapp=ref_pg{slug}_qshpw` | `&shpw=1` |
| Веб-вход | `pluson.ru/l/{slug}?shpw` (или `?app=tg&shpw`) | `&shpw=1` (либо `_qshpw` в startapp при `?app=tg`) |

Алфавит ключа `[a-z0-9-]`, длина 1..16, до 5 флагов на один URL. Лишнее или несоответствие — тихо игнорируется. Значения не передаются — это всегда `=1`. Если нужно полноценное `key=value` — используйте `utm_source` или `external_ref_param`.

Хелперы и точки кода: `normalize_landing_flags` + параметр `flags=` в `enrich_external_url` ([external_landing.py](backend/app/services/external_landing.py)); CSV-параметр `?q=shpw,vip` на эндпоинтах `/landing-redirect` и `/vip-redirect` ([client_profile.py](backend/app/api/client_profile.py)); парсер `_q…` в [`parseStartParam`](mini-app/src/App.tsx) (Mini App), [`parse_startapp_ref_payload`](backend/app/services/max_auth.py) (MAX-бэк), inline-скрипт [index_tg.html](mini-app/index_tg.html), [redirect_web_app.js](web/public/redirect_web_app/redirect_web_app.js) (веб-вход).
### Время программы — строки "HH:MM" + " МСК" везде (миграция 048 от 28.04.2026)

Чтобы убрать сдвиги часовых поясов в Mini App / веб / рассылках, время программы хранится строкой "HH:MM" и считается МСК по соглашению.

**Поля:**
- `conf_days.open_time` / `close_time` — TEXT ("10:00" / "18:00") или NULL.
- `conf_sessions.start_time` / `end_time` — TEXT ("11:30" / "12:00") или NULL. Колонки `start_datetime` / `end_datetime` УДАЛЕНЫ. День сессии — поле `day` (INT) и/или JOIN на `conf_days`.

**Отображение:**
- Везде, где показывается время программы — приписывается " МСК": "11:30–12:00 МСК", "Встречаемся завтра в 12:00 МСК на День 2".
- Mini App ([ProgramTab.tsx](mini-app/src/tabs/ProgramTab.tsx), [LandingTab.tsx](mini-app/src/tabs/LandingTab.tsx), [SelectorEventsTab.tsx](mini-app/src/tabs/SelectorEventsTab.tsx)) и дашборд: для дат событий жёстко `timeZone: 'Europe/Moscow'` + " МСК" — никаких `toLocaleTimeString` без `timeZone`.
- Бэкенд ([message_builder.py](backend/app/services/message_builder.py), [conference.py](backend/app/api/modules/conference.py)) форматирует время через `_fmt_time(val)` — это просто `str(val)[:5]`, без `.strftime`/`.astimezone`.

**Под капотом для расчёта `fire_at` рассылок** ([broadcasts.py](backend/app/api/modules/broadcasts.py)) — хелпер `_msk_str_to_utc(day_date, "HH:MM")` собирает naive datetime, вычитает 3 часа и возвращает UTC. Это внутренняя кухня — пользователь видит только "HH:MM МСК".

**Валидация ввода**: хелпер `_normalize_hhmm` в [conference.py](backend/app/api/modules/conference.py) принимает "HH:MM" или ISO с временем, отсекает лишнее, валидирует через regex `^([01]\d|2[0-3]):([0-5]\d)$`.
### ⚠️ Почта человека — ТОЛЬКО идентичность, колонки `contacts.email` НЕТ (миграция 282 от 2026-08-12, ПРОД)

Email живёт в **`platform_users(platform_slug='email')`**, где адрес лежит в `platform_user_id`. Колонки `contacts.email` и `contacts.email_normalized` **удалены** вместе с индексом `idx_contacts_email_norm`.

**Почему.** Они остались хвостом от миграции 036 (та переносила почту из `platform_users.email` в контакт). Резолв контакта, дедуп и рассылки давно работали по идентичности ([contact_merge.py](backend/app/services/contact_merge.py):116, [tasks/broadcast.py](backend/app/tasks/broadcast.py) берёт адрес из `platform_users`), а колонка жила параллельно и расходилась с реальностью: у 1446 контактов почта была только в идентичности, у 1407 — только в колонке.

⚠️ **Это было источником дублей людей.** Импорт, искавший человека по `contacts.email`, не видел тех, у кого почта лежит в идентичности, и заводил вторую карточку. На импорте базы GetCourse так родилось 1300 дублей (откачены). **Искать человека по почте — только через `platform_users`.**

```sql
-- как получить почту контакта
(SELECT pe.platform_user_id FROM platform_users pe
  WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
  ORDER BY pe.id LIMIT 1) AS email
```

⚠️ **Уникальность почты гарантирует БД** — `UNIQUE(client_id, platform_slug, platform_user_id)`. Одна почта не может принадлежать двум контактам, поэтому «дублей почт» технически не бывает; бывают дубли людей, у которых почта записана по-разному.

**Переведены на идентичность:** [auth.py](backend/app/api/auth.py) (поиск реф-кода при регистрации), [admin.py](backend/app/api/admin.py) (поиск клиента), [subscriptions.py](backend/app/api/subscriptions.py), [integrations.py](backend/app/api/integrations.py) (вебхуки больше не пишут email в контакт — идентичность синхронизирует `sync_email_identity_and_subscription`), [contacts.py](backend/app/api/contacts.py) (обезличивание). ⚠️ `c.email` в коде почти везде — это **`clients.email`** (почта клиента платформы), её не трогать.
### ⚠️ Требование нарисовано на экране — значит его нет (2026-09-03, ПРОД)

Разбор задвоения показал общую причину: **проверки жили в браузере, а на сервере их не было**. Любой повторный, отложенный или пересланный запрос их обходил — и это происходило само, без всякого злого умысла. Четыре случая, все починены:

| Где | Что было | Как это срабатывало |
|---|---|---|
| **Форма заказа** | кнопка блокировалась состоянием React | Состояние применяется к следующей перерисовке. Два быстрых нажатия входили оба — **два контакта и два заказа по 10 000 ₽**. Теперь замок обычной переменной (`useRef`), до перерисовки |
| **Розыгрыш** | замок «зарегистрируйтесь» только в интерфейсе | Сервер регистрации не требовал и сам заводил участника. Теперь требование на сервере, участие здесь не создаётся вовсе |
| **Вебинар, вход** | номер контакта из ссылки брался как есть | Ссылку пересылают в чат вместе с хвостом `?c=142` — **все зашедшие записывались одним человеком**; организатор, скопировав ссылку из адресной строки, рассылал свой номер. Сверяем с клиентом события |
| **Вебинар, форма** | хватало одного имени | Контакт без единого способа связи — его не найти ничем. Теперь нужен хотя бы один ключ; когда организатор не включил ни одного поля, **почта показывается сама** (иначе человеку нечего ввести) |

⚠️ **На данных прода эта дыра ни разу не сработала**: из 102 побывавших в вебинарных комнатах контакт по одному имени не завёлся **ни у кого** (у всех 48 заведённых есть телефон, у 44 — аккаунт площадки). То есть это страховка на будущее, а не тушение пожара — прежняя формулировка «вебинар самое слабое место, каждый заход = новый контакт» **не подтвердилась**, проверять надо было по данным, а не по коду.

⚠️ **Спикеру, вписанному карточкой, гасится догрев** ([collaborator_participant.py](backend/app/services/collaborator_participant.py)). Раньше «не слать письма» понималось как «не трогать ничего», и человек получал письма «зарегистрируйтесь» на событие, в состав которого его только что включили. **Погасить воронку и отправить письмо — разные вещи.**
### Файловое хранилище R2 (миграция 037 от 26.04.2026)

**Все файлы клиента (афиши, лид-магниты, сертификаты, материалы шеринга, фото спикеров) грузятся через единый endpoint `POST /api/v1/uploads` (FastAPI, не Next.js).** Бэкенд: ресайз картинок (Pillow) → upload в R2 (boto3) → запись в `client_files` → инкремент `clients.storage_used_bytes`.

**Структура ключей в R2:**
```
clients/{client_id}/events/{event_id}/posters/{horizontal|vertical|square}/{uuid}.jpg
clients/{client_id}/events/{event_id}/certificates/{uuid}.jpg
clients/{client_id}/events/{event_id}/referral_materials/{uuid}.jpg
clients/{client_id}/lead_magnets/{uuid}.{ext}
clients/{client_id}/speakers/{collaborator_id}/{uuid}.jpg
```

**Ресайз** (Pillow LANCZOS, JPEG q=85): афиши/материалы → 1920px, сертификаты → 1600px, фото спикеров → 800px. Без потери визуального качества для веб/мобильного, экономит 10–16× места.

**Квота:** `clients.storage_quota_bytes` = 500 МБ по умолчанию (`clients.storage_used_bytes` — кэш). На каждый upload — проверка `used + new_size <= quota` → 413. Индикатор использования в `/dashboard/settings` (зелёный/жёлтый ≥70%/красный ≥90%).

**Таблица `client_files`** (id, client_id, kind, r2_key UNIQUE, url, size_bytes, content_type, event_id, collaborator_id, lead_magnet_id, created_at) — учёт каждого загруженного файла.

**API:** `POST /api/v1/uploads` (kind, event_id, poster_type, collaborator_id), `DELETE /api/v1/uploads/by-url?url=...`, `GET /api/v1/storage/usage`.

**На фронте:** универсальный компонент `<FileUploader />` ([`web/src/components/FileUploader.tsx`](web/src/components/FileUploader.tsx)) с `mode=single|multiple`, `kind`, drag&drop, превью, кнопками «Ссылка»/«Удалить». Используется во ВСЕХ местах загрузки.

**Старый Next.js `/api/upload-poster`** — оставлен для обратной совместимости со старыми afishами, новые загрузки идут через FastAPI.
### Структура БД (после миграции 036 от 26.04.2026 — иерархия Контактов)

**Пять связанных таблиц для контактов и каналов:**
- **`platforms`** — справочник платформ (telegram/vk/max + метаданные: иконка, цвет, лимит сообщения, поддержка кнопок). Везде FK вместо TEXT-значений — нельзя записать опечатку.
⚠️⚠️ **Телефон пишется ТОЛЬКО через `set_contact_phone`** ([contact_merge.py](backend/app/services/contact_merge.py)). Писать `contacts.phone` напрямую нельзя — рядом обязан обновляться `phone_normalized`, по нему ищутся дубли. Четыре места писали телефон и забывали нормализованный (анкеты, заказ события, заказ продукта, раздача контактов в коллабе) — поле поиска оставалось пустым, и один человек заводился дважды. У кабинета спикера жила ещё и своя копия нормализации, проще общей — убрана.

⚠️ **`phone_normalized` — ТОЛЬКО ЦИФРЫ, без плюса** (миграция 328). Это ключ поиска, а не то, что показывают человеку: плюс плодил разные написания одного номера (`+79161234567` и `79161234567` — для базы разные строки). Российские приводятся к `7XXXXXXXXXX`, ведущие нули набора (`+007…`, `+0037…`) срезаются, зарубежные — как есть цифрами. **`contacts.phone` не трогаем** — человек видит телефон в том виде, как ввёл.

⚠️ После выравнивания стало видно 21 группу дублей по телефону у клиента 1. **Автоматически их НЕ сливать:** среди совпадений есть фиктивные номера (`+79999999999` у 8 разных людей) и настоящие разные люди с одним номером.

- **`contacts`** — Контакт (ЧЕЛОВЕК). Один на клиента. Хранит: `name`, `phone` + `phone_normalized`, `ref_code` UNIQUE, `first_referrer_contact_id`, `tags`, `salebot_id`, `utm_source`, `last_contact_at`, `merged_into`, `merged_ref_codes`, `external_ref_param`, `linked_client_id`, `plusson_referrer_code`, `was_in_webinar`. Один человек = одна запись.
  ⚠️ **Колонок `email` и `email_normalized` в `contacts` НЕТ** (удалены миграцией 282). Почта — это идентичность в `platform_users(platform_slug='email')`, где адрес лежит в `platform_user_id`. Искать человека по почте только там (см. раздел «Почта человека — ТОЛЬКО идентичность»).
- **`platform_users`** — Идентичность контакта на платформе. `contact_id → contacts`, `platform_slug → platforms`. Один человек может иметь несколько идентичностей: TG-аккаунт + VK-аккаунт = две записи под одним contact_id. UNIQUE(contact_id, platform_slug).

⚠️⚠️ **Колонки `platform_users.client_id` НЕТ — дропнута миграцией 327 (2026-08-24).** Клиент берётся ТОЛЬКО из контакта: `JOIN contacts c_own ON c_own.id = pu.contact_id WHERE c_own.client_id = $1`. `WHERE pu.client_id=$1`, `client_id` в INSERT и `ON CONFLICT (client_id, platform_slug, platform_user_id)` падают с `column "client_id" does not exist`; вместо последнего — `ON CONFLICT (contact_id, platform_slug)`.

**Почему убрали.** Колонка дублировала то, что известно через контакт, и два источника правды разъехались: на проде нашлись записи, где контакт принадлежит одному клиенту, а его платформенная запись числится в базе другого — внешний ключ смотрит только на `contacts.id` и клиента не сверяет. Человек попадал в чужую базу и получал рассылку дважды. Подробности — [[project_platform_users_client_id_dropped]].

⚠️ **Прежнее `UNIQUE (client_id, platform_slug, platform_user_id)` от дублей ЛЮДЕЙ не защищало** — оно ловит только буквальный повтор пары. Один человек, записанный числом `6125115628` и ником `@Nurikary`, дал два контакта: пары разные, конфликта нет. Настоящая причина дублей — псевдо-запись по нику, не доросшая до числового id (число уже занято другим контактом). **Не починено, отдельная задача.**

⚠️ **Правишь схему — не ищи по одному написанию.** Поиск `pu.client_id` пропустил 41 место из ~106: запросы бывают без алиаса и под `pe.`/`p.`. Надёжно — прогнать все SQL кода через `PREPARE` на базе без колонки.

### ⚠️⚠️ `contacts.form_nickname` — ник, введённый человеком в форме (мигр. 493, 22.09.2026)

**Справочное поле, НЕ идентичность и НЕ площадка.** Пишется из формы заказа тарифа ([event_orders.py](backend/app/api/event_orders.py)) и формы регистрации ([event_page_html.py](backend/app/api/event_page_html.py)) — **всегда**, каким бы путём ни определился контакт. Показывается в карточке контакта как «Ник, введённый в форме». Хранится без ведущего `@`, индекс по `LOWER()` (ник регистронезависим).

⚠️ **Зачем отдельное поле, если есть `platform_users`.** Туда нельзя: `platform_user_id` обязан быть настоящим числовым id от мессенджера. Псевдо-запись `'@ник'` в заказе **уже пробовали и убрали 29.07.2026** (коммит `d7cf2b68`): у человека с тем же ником в базе лежал настоящий числовой id, они не совпадали, и проверка считала это ЧУЖИМ аккаунтом — форма отказывала людям в регистрации **под их собственным ником** («email привязан к @margo_forbs», когда вводишь ровно @margo_forbs). Отдельное поле ничего не резолвит и ни с чем не конфликтует.

⚠️ **Что было до него.** Поле «Ник в Telegram» в форме заказа **обязательное**, но ник никуда не сохранялся: жил тремя строками, обе поисковые (`resolve_or_ask`, `lookup_telegram_username`), и пропадал вместе с запросом. Терялся на ВСЕХ ветках — человек выбрал себя на «Это вы?» (ветка дописывает только телефон, имя и email), пришёл по ссылке с `?c=` (`known_cid` перебивает, до поиска не доходит), никого не нашли (новый контакт без ника). На событии 89 так вышло 15 человек с одной лишь почтой; у одной из них почта ещё и оказалась мёртвой (`550 user is terminated`) — связаться нечем вовсе.

⚠️ **Ник не заменяет площадку.** Писать в бот по `@нику` нельзя, нужен числовой `chat_id`. Поле нужно для другого: найти человека руками, когда площадка не определилась. Саму площадку тянет через цепочку `tg_id`/`vk_id`/`max_id` (см. EVENTS.md).

⚠️ **Не перетираем** (`COALESCE(NULLIF(form_nickname,''), $2)`): прошлый ник ценнее набранного второпях.

⚠️ `_attach_tg` в форме регистрации (псевдо-запись) **оставлена** — она срабатывает, только когда у контакта НЕТ телеграма, и от `form_nickname` не зависит. У человека с MAX или ВК ник теперь сохранится в любом случае.
- **`channels`** — Каналы доставки клиента (его боты, группы VK, MAX-каналы). `platform_slug → platforms`.
- **`platform_user_channels`** — Подписка идентичности на канал. `platform_slug` дублируется + составные FK: TG-аккаунт нельзя подписать на VK-группу. `is_unsubscribed` per-канал.

**Иерархия использования:**
- `event_participants.contact_id → contacts` (был `platform_user_id`). Один человек = одно участие в событии.
- `collaborators.contact_id → contacts` (был `platform_user_id`).
- `referrer_participant_id` ссылается на `event_participants` — реферальная связь контекстная, только внутри события.
- ⚠️ `telegram_users` и `notifications_log` — удалены.
- Модульные таблицы с префиксом `conf_` принадлежат модулю «Конференция».
- ⚠️ **Таблицы `conf_speaker_events` НЕ СУЩЕСТВУЕТ** — связь «коллаб ↔ событие» живёт в **`event_collaborators`** (`speaker_id → collaborators.id`, `event_id`, `role`, `notes`, `sort_order`, `is_visible`, `is_commercial`, `priority`, `poster_id`, `speaker_topic`, `use_photo_instead_of_poster`, `knowledge_base_*`, `gift_*`). Старое имя осталось только в тексте документации и в исторических миграциях — **в SQL его не использовать**.
- ⚠️ **Таблицы `speakers` тоже нет** — спикеры это `collaborators` + `event_collaborators`.
- Коллабораторы — глобальная база: `collaborators` + `event_collaborators`. У `collaborators` FK `contact_id → contacts(id)` **NOT NULL** (миграция 086 от 2026-05-18). Коллаб = «расширение контакта»: только должность, фото, регалии, бот-канал, личный TG и т.п.; имя/email/телефон — поля контакта. Создание идёт **только** из существующего контакта (`POST /api/v1/collaborators/ { contact_id }`) — модалка «Добавить из контактов» на `/dashboard/collaborations`. Импорт JSON (`POST /collaborators/import`) — если контакта с таким именем нет, авто-создаёт пустой и привязывает. На карточке коллаба блок «Контакт в общей базе» виден всегда; на карточке контакта (если есть запись в `collaborators`) — плашка «Этот контакт — коллаборатор» со ссылкой. Email/телефон контакта правятся inline на `/dashboard/clients` (`PATCH /api/v1/contacts/{id}`).
- `event_collaborators.notes` (миграция 041 от 2026-04-27; ⚠️ раньше в документации ошибочно называлась `conf_speaker_events.notes`) — произвольный текст под спикера в конкретном событии (шпаргалка ведущего, частушка, заметки по гонорару). Редактируется на странице спикера в дашборде, в публичные endpoints (`/speakers/public`, `/speakers/{id}/public`) не отдаётся. Спикер может заполнять её сам, если включён тумблер `event_collaborators.show_notes_field` (миграция 201).
- `contacts.external_ref_param` (миграция 058 от 2026-05-05, перенесено с `collaborators` на `contacts` миграцией 103 от 2026-05-23) — опаковая строка `key=value` (например, `gcpc=fdd97`) для связки **контакта** с партнёрской системой во внешней платформе (GetCourse, Bizon360 и т.п.). Поле живёт на уровне контакта — любой контакт может быть партнёром во внешней системе, не обязательно коллаборатор. Не парсим, не валидируем — клиент сам знает, к какой системе привязывает партнёра. Редактируется на карточке контакта в `/dashboard/clients` (строка «Партнёрский параметр» рядом с реф-кодом, `PATCH /contacts/{id} { external_ref_param }`). **Общая логика** — [`backend/app/services/external_landing.py`](backend/app/services/external_landing.py): `resolve_external_ref_param(client_id, pid)` + `build_external_landing_url(...)`. Резолв идёт по `contacts.ref_code` (или `merged_ref_codes`) → `contacts.external_ref_param`. **Где приписывается** — все 4 точки, в которых открывается `events.landing_url`:
  1. `GET /api/v1/public/events/{slug}/landing-redirect` ([client_profile.py](backend/app/api/client_profile.py)) — для inline-скрипта `mini-app/index_tg.html` ДО React. Только при `status='published'` и не-зарегистрированном пользователе.
  2. `GET /api/v1/public/events/{slug}/external-ref?pid=…` (новый, [client_profile.py](backend/app/api/client_profile.py)) — справочник pid→`external_ref_param`. Работает независимо от status. Используется фронтами там, где `landing-redirect` не срабатывает.
  3. SSR `/l/[slug]/page.tsx` ([web](web/src/app/l/%5Bslug%5D/page.tsx)) — 301-редирект веб-входа без `?app=tg`. Перед `redirect()` фетчит `external-ref`.
  4. Mini App `EventPage.tsx` ([mini-app](mini-app/src/pages/EventPage.tsx)), функция `redirectToExternalLanding(landingUrl)` — useEffect (SPA-навигация на event с `landing_url`) и `handleWantParticipate` (клик «Хочу участвовать»). Перед `window.location.href` фетчит `external-ref`.

  Без `pid` или без коллаборатора с непустым параметром — поведение не меняется. Любая ошибка резолва — тихо игнорируется (основной редирект работает).

  **Обратная связь от лендинга через webhook (2026-05-23).** В URL стороннего лендинга Mini App добавляет `&platform_user_id={id}&platform={tg|vk|max}` (+ legacy `tg_id` / `vk_id` для совместимости). GetCourse/Tilda через стандартную фичу «Сохранять GET-параметры в форме» кладёт их в скрытые поля и шлёт в webhook [`POST/GET /api/v1/integrations/salebot/register`](backend/app/api/integrations.py). Webhook расширен:
  - **`platform_user_id`** теперь опционален — для веб-форм без TG/VK-айди работаем через `find_or_create_contact` (поиск по email/phone/`telegram_username`).
  - **`telegram_username`** — fallback-поиск контакта по TG-нику, если email/phone не дали результата (новый параметр `lookup_telegram_username` в `find_or_create_contact` / `upsert_contact_with_identity`).
  - **`pid`** — резолвится в `ref_code` партнёра через `resolve_ref_code` (с учётом `merged_ref_codes`), пишется в `event_participants.referrer_ref_code` (приоритет над `partner_tg_id`).
  - **`external_ref_param`** — UPSERT в `contacts.external_ref_param` (свежее значение из GetCourse перезатирает старое — клиент стал партнёром во внешней системе, мы фиксируем его код).

  Так замыкается круг «гость → партнёр»: человек кликает чью-то ссылку → попадает в Mini App → редирект на лендинг клиента с его `platform_user_id` → заполняет форму → GetCourse выдаёт ему свой партнёрский код → webhook обновляет `contacts.external_ref_param` → его собственная ссылка `pluson.ru/l/{slug}?pid={его_ref_code}` дописывает к лендингу клиента его GetCourse-партнёрский код → GetCourse начисляет ему награду.

  **UI-защита от draft.** При `events.status='draft'` партнёрские ссылки и сторонний лендинг не открываются у участников (`/landing-redirect` отдаёт `{}`). Чтобы клиент случайно не разослал партнёрам мёртвые ссылки:
  - Жёлтый баннер «⚠️ Это черновик…» в шапке `/dashboard/events/[id]` и `/dashboard/conferences/[id]`.
  - В `<PublicLinks>` (вкладка «Основное» события) и `<RefLinkInline>` (карточка соорганизатора/спикера) при `eventStatus='draft'` URL **затуманен** через CSS `filter: blur(...)` + `userSelect: none`, кнопка «Копировать» дисейблена + tooltip «Сначала опубликуйте событие». При попытке клика — `alert()` с пояснением.
### Мердж контактов (миграция 036)

**Автомердж при создании идентичности** (TG /start, импорт Salebot, Event_leads, регистрация на лендинге):
1. Нормализуем email (lowercase + trim) и phone (только цифры, `8` → `+7`)
2. Ищем `contact` у того же клиента где `email_normalized` или `phone_normalized` совпали
3. Нашли → новая `platform_users` ссылается на найденный `contact_id`
4. Не нашли → создаём `contact` + `platform_users`

⚠️ Поиск **только при создании**, не при апдейте.

**Ручной мердж** — кнопка «Объединить» в карточке. Все `platform_users`/`event_participants`/`collaborators`/`referrer_*` → главный контакт. Реф-код второстепенного → в `merged_ref_codes` JSONB. Второстепенный: `merged_into = главный.id`, `is_active = false`.
### ⚠️ Мультиплатформа — каналы доставки (миграции 033+034+036, 26.04.2026)

⚠️⚠️ **Схема ниже УСТАРЕЛА с миграции 066** («Подписочная архитектура G», описана выше). Держим как историю; актуальные имена — там. Что изменилось:
- **у `channels` НЕТ `client_id`** — привязка канала к клиенту живёт в отдельной таблице `client_channels`;
- **у `platform_user_channels` НЕТ `channel_id` и `platform_slug`** — есть `client_channel_id → client_channels(id)`.

Старый текст (для истории):
- Таблица **`channels`** (id, ~~client_id~~, `platform_slug` → platforms, display_name, handle, bot_token, is_active) — каналы доставки клиента (бот в TG / группа VK / канал MAX). У клиента может быть несколько каналов.
- Таблица **`platform_user_channels`** (platform_user_id, ~~channel_id, platform_slug~~, is_unsubscribed, subscribed_at, unsubscribed_at) — подписка идентичности на конкретный канал, отписка per-канал.
- Поле `clients.bot_token` УДАЛЕНО (033) — живёт в `channels.bot_token`
- Поле `platform_users.is_unsubscribed` УДАЛЕНО (034) — живёт в `platform_user_channels.is_unsubscribed` per-канал
- Поле `platform_users.platform` ВОЗВРАЩЕНО как `platform_slug → platforms(slug)` (036) — без него нельзя интерпретировать `platform_user_id` (это tg_id или vk_id?)
- UNIQUE `platform_users`: `(contact_id, platform_slug)`. Вторая пара с `client_id` ушла вместе с колонкой (миграция 327).
- Helper `app/services/channels.py`: `get_client_telegram_token(client_id, db)`, `mark_unsubscribed_by_tg_id(client_id, tg_id, db)`, `upsert_client_telegram_token(client_id, token, db)`
