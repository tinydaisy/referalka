-- 414. Автонастройка: суточный лимит ботов, пауза между созданиями,
--      статистика и участие аккаунта в очереди (14.09.2026).
--
-- ЗАЧЕМ. Очередь брала аккаунт по одному признаку — сколько ботов висит
-- непереданными (`max_slots`). Этого мало:
--
-- ⚠️⚠️ У BOTFATHER НАРАСТАЮЩИЙ ЛИМИТ НА СОЗДАНИЕ. Несколько ботов подряд —
-- «try again in 129 seconds», около десятка — «61470 seconds» (17 часов).
-- `max_slots` его не ловит вовсе: бота передали, слот освободился, а счётчик
-- созданий у Telegram продолжает расти. Три живых аккаунта могут создать
-- ботов за минуты и лечь все разом.
--
-- ⚠️ Отсюда ДВА новых ограничителя, оба задаются в админке на КАЖДЫЙ аккаунт:
--   • `daily_bot_limit`      — сколько ботов этот аккаунт создаёт за сутки;
--   • `min_create_gap_min`   — сколько минут ждать после предыдущего создания.
-- Они не заменяют `max_slots`, а дополняют: слоты — про «сколько висит
-- непереданными сейчас», эти два — про темп.
--
-- ⚠️ `last_bot_created_at` — отметка для паузы. Без неё пришлось бы каждый раз
-- обходить `service_orders`, а это лишний запрос в поллере раз в минуту.
--
-- ⚠️ `bots_created_total` — счётчик для админки: сколько ботов аккаунт создал
-- за всю жизнь. Сутки считаются запросом по `service_orders` (там дата), а
-- общее число нужно видеть, даже когда старые заказы удалены.

BEGIN;

ALTER TABLE tg_setup_accounts
  -- 0 или NULL = без суточного ограничения (прежнее поведение).
  ADD COLUMN IF NOT EXISTS daily_bot_limit     INTEGER,
  -- 0 или NULL = без паузы (прежнее поведение).
  ADD COLUMN IF NOT EXISTS min_create_gap_min  INTEGER,
  ADD COLUMN IF NOT EXISTS last_bot_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bots_created_total  INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN tg_setup_accounts.daily_bot_limit IS
  'Сколько ботов аккаунт создаёт за сутки. NULL или 0 — без ограничения.';
COMMENT ON COLUMN tg_setup_accounts.min_create_gap_min IS
  'Пауза в минутах после предыдущего создания бота. NULL или 0 — без паузы.';
COMMENT ON COLUMN tg_setup_accounts.last_bot_created_at IS
  'Когда этот аккаунт последний раз создал бота — по нему считается пауза.';
COMMENT ON COLUMN tg_setup_accounts.bots_created_total IS
  'Сколько ботов создано за всю жизнь аккаунта (заказы могли быть удалены).';

-- ⚠️ Заполняем отметку и счётчик по уже существующим заказам: без этого
-- пауза и статистика начали бы отсчёт с нуля, и аккаунт, создавший бота
-- минуту назад, взял бы следующий заказ немедленно.
UPDATE tg_setup_accounts a
   SET last_bot_created_at = s.last_at,
       bots_created_total  = s.cnt
  FROM (
        SELECT setup_account_id AS id,
               MAX(bot_created_at) AS last_at,
               COUNT(*)            AS cnt
          FROM service_orders
         WHERE setup_account_id IS NOT NULL
           AND bot_created_at IS NOT NULL
         GROUP BY setup_account_id
       ) s
 WHERE a.id = s.id;

COMMIT;
