-- 362: Воронки Instagram — комментарий под рилсом → директ → лид-магнит
--
-- Второй шаг фичи (первый — миграция 361, подключение аккаунта).
-- Полный план и обоснование решений — documentation/INSTAGRAM-FUNNEL-PLAN.md
--
-- ⚠️ Воронка — НАДСТРОЙКА над лид-магнитами, а не вторая их копия: клиент
-- выбирает, какой существующий лид-магнит раздавать, а воронка решает «как
-- именно раздать». Своих материалов у неё нет.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Воронки
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS instagram_funnels (
  id                  BIGSERIAL PRIMARY KEY,
  client_id           INT  NOT NULL REFERENCES clients(id)  ON DELETE CASCADE,
  channel_id          INT  NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,

  -- ТРИГГЕР
  trigger_kind        TEXT NOT NULL DEFAULT 'comment'
                      CHECK (trigger_kind IN ('comment','story_reply')),
  media_scope         TEXT NOT NULL DEFAULT 'any'
                      CHECK (media_scope IN ('any','specific')),
  media_ids           TEXT[] NOT NULL DEFAULT '{}',
  keyword_mode        TEXT NOT NULL DEFAULT 'any'
                      CHECK (keyword_mode IN ('any','specific')),
  keywords            TEXT[] NOT NULL DEFAULT '{}',

  -- ⚠️ У СТОРИС выбора конкретной публикации НЕТ (решение 2026-09-06):
  -- сторис живёт 24 часа, привязку пришлось бы переназначать каждый день, и
  -- настройка ломалась бы сама собой. Кодовое слово при этом обязательно: на
  -- сторис отвечают чем угодно («класс», стикером), и без слова воронка
  -- кидалась бы материалом на каждую реакцию.
  -- Ограничение в БД, а не только в форме: воронку правят и запросом мимо неё.
  CONSTRAINT ig_funnel_story_rules CHECK (
    trigger_kind <> 'story_reply'
    OR (media_scope = 'any' AND keyword_mode = 'specific')
  ),

  -- ЧТО ВЫДАЁМ — ровно одно из двух
  lead_magnet_id      INT    REFERENCES lead_magnets(id)         ON DELETE CASCADE,
  package_id          BIGINT REFERENCES lead_magnet_packages(id) ON DELETE CASCADE,
  CONSTRAINT ig_funnel_one_target CHECK (
    (lead_magnet_id IS NOT NULL)::int + (package_id IS NOT NULL)::int = 1
  ),

  -- КАК ВЫДАЁМ
  -- direct   — ссылка на материал прямо в директ
  -- telegram — ссылка на телеграм-бота клиента: перелив аудитории, дальше
  --            работает существующая воронка /m/ со своей проверкой подписки
  delivery_mode       TEXT NOT NULL DEFAULT 'direct'
                      CHECK (delivery_mode IN ('direct','telegram')),

  -- УСЛОВИЯ
  require_subscription BOOLEAN NOT NULL DEFAULT TRUE,
  public_reply_enabled BOOLEAN NOT NULL DEFAULT TRUE,

  -- НАПОМИНАНИЕ молчащему
  -- ⚠️ Meta разрешает писать только 24 ЧАСА с последнего сообщения человека.
  -- Задержка меньше суток — не прихоть: за её пределами напоминание просто не
  -- уйдёт, а серия отклонённых отправок портит репутацию приложения.
  reminder_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  reminder_delay_min   INT     NOT NULL DEFAULT 180,

  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order          INT     NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ig_funnels_client  ON instagram_funnels(client_id);
CREATE INDEX IF NOT EXISTS idx_ig_funnels_channel ON instagram_funnels(channel_id) WHERE is_active;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Вариации фраз
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️⚠️ Вариации — НЕ украшение. Instagram считает спамом повторяющиеся
-- одинаковые публичные ответы и режет охваты вплоть до блокировки аккаунта.
-- Поэтому у каждого шага набор фраз, из которого берётся случайная.
--
-- ⚠️ ВСЕ тексты — от лица «мы», не «я»: род клиента заранее неизвестен, а
-- сообщение уходит от имени его аккаунта. «Мы» снимает вопрос без настроек.
CREATE TABLE IF NOT EXISTS instagram_funnel_replies (
  id          BIGSERIAL PRIMARY KEY,
  funnel_id   BIGINT NOT NULL REFERENCES instagram_funnels(id) ON DELETE CASCADE,
  kind        TEXT   NOT NULL CHECK (kind IN (
                'public_comment',     -- публично под комментарием
                'dm_intro',           -- первое сообщение в директ
                'dm_not_subscribed',  -- «не видим подписки»
                'dm_delivered',       -- выдача материала
                'dm_repeat',          -- «уже отправляли — вот ещё раз»
                'dm_reminder'         -- напоминание молчащему
              )),
  text        TEXT   NOT NULL,
  sort_order  INT    NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ig_replies_funnel ON instagram_funnel_replies(funnel_id, kind);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Забеги — переиспользуем funnel_runs
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ Отдельной таблицы НЕТ намеренно. Пишем в существующую с
-- platform_slug='instagram' — тогда сами заработают счётчик «зашло» в списке
-- лид-магнитов, CRM лид-магнитов, фильтр контактов и аналитика UTM.
ALTER TABLE funnel_runs ADD COLUMN IF NOT EXISTS instagram_funnel_id BIGINT
  REFERENCES instagram_funnels(id) ON DELETE SET NULL;

-- Когда человек последний раз писал НАМ.
-- ⚠️ От этого, а не от нашей отправки, отсчитывается 24-часовое окно Meta.
-- Считать от своего сообщения — значит регулярно выходить за окно и получать
-- отказы.
ALTER TABLE funnel_runs ADD COLUMN IF NOT EXISTS ig_last_user_message_at TIMESTAMPTZ;

-- Напоминание отправлено.
-- ⚠️ Это «уже слали», а не «прошло ли N часов»: задача может выполниться
-- повторно (ретрай Celery, дубль вебхука), и проверка по времени пропустила бы
-- второе напоминание.
ALTER TABLE funnel_runs ADD COLUMN IF NOT EXISTS ig_reminder_sent_at TIMESTAMPTZ;

-- Когда выдали материал в прошлый раз — для правила «повтор не чаще раза в час».
ALTER TABLE funnel_runs ADD COLUMN IF NOT EXISTS ig_last_delivered_at TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Права
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ Роль plusson не владелец таблиц — без GRANT API получит permission denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON instagram_funnels, instagram_funnel_replies TO plusson;
GRANT USAGE, SELECT ON SEQUENCE instagram_funnels_id_seq, instagram_funnel_replies_id_seq TO plusson;

COMMIT;
