-- 436. Подписка клиента на бота поддержки — «шаг ноль» (17.09.2026).
--
-- ЗАЧЕМ. Перед автонастройкой клиент должен подтвердить почту и зайти хотя бы
-- в одного нашего бота поддержки. Иначе повторяется история заказов 8 и 13:
-- услуга упирается в действие клиента, а сказать ему об этом НЕЧЕМ — письма
-- не дошли, в боте он ни разу не был, и человек после оплаты сидит в тишине.
--
-- ⚠️⚠️ СВЯЗКА ПО ССЫЛКЕ С ПАРАМЕТРОМ, А НЕ ПО НИКУ (решение владельца).
-- Ник не годится тремя способами сразу: в МАКС ников нет вовсе; при
-- регистрации ник может быть не указан; введённый руками ник может оказаться
-- чужим — и мы «подтвердим» не того человека. Поэтому клиент уходит по ссылке
-- вида `?start=s<client_id>_<подпись>`, и бот получает параметр ВМЕСТЕ с
-- настоящим id аккаунта в своей площадке. Ник не нужен, ошибиться нельзя.
--
-- ⚠️ Подпись в параметре обязательна: без неё любой желающий подставит чужой
-- client_id и отметит подписку за другого.
--
-- ⚠️ ОТДЕЛЬНАЯ ТАБЛИЦА, А НЕ КОЛОНКИ В `clients`. Площадок три (Telegram, MAX,
-- ВК), и у каждой свой id пользователя и своё время подписки. Тремя парами
-- колонок это выродилось бы в `tg_support_user_id`, `max_support_user_id`,
-- `vk_support_user_id`… — и четвёртая площадка потребовала бы миграции с
-- ALTER на живой таблице клиентов.

BEGIN;

CREATE TABLE IF NOT EXISTS client_support_subscriptions (
    id              BIGSERIAL PRIMARY KEY,
    client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    -- telegram | max | vk — те же слаги, что и в channels.platform_slug.
    platform_slug   TEXT    NOT NULL,
    -- id пользователя в этой площадке (у Telegram и ВК числовой, у MAX тоже,
    -- но храним текстом: платформы меняют формат, а нам его не вычислять).
    platform_user_id TEXT   NOT NULL,
    username        TEXT,                       -- если площадка его отдала
    subscribed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Откуда пришёл: zero (шаг ноль), question (вопрос в поддержку), …
    -- ⚠️ Нужен для статистики «сколько людей доходит до бота с какого экрана».
    reason          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE client_support_subscriptions IS
    'Кто из клиентов зашёл в наших ботов поддержки. Связка по ссылке с подписью, не по нику';
COMMENT ON COLUMN client_support_subscriptions.platform_user_id IS
    'Настоящий id аккаунта в площадке — его отдаёт сама площадка, подделать нельзя';

-- ⚠️ Одна подписка на пару «клиент + площадка»: повторный клик по ссылке не
-- должен плодить строки. Именно повторные клики и будут нормой — человек
-- открывает бота не с первого раза.
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_sub_client_platform
    ON client_support_subscriptions (client_id, platform_slug);

-- Обратный поиск: «этот аккаунт площадки — чей?»
CREATE INDEX IF NOT EXISTS idx_support_sub_platform_user
    ON client_support_subscriptions (platform_slug, platform_user_id);

-- ⚠️ Роль `plusson` НЕ владелец таблиц (DDL на проде идёт от postgres).
-- Без грантов API получит «permission denied» на первом же запросе.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plusson') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE
           ON client_support_subscriptions TO plusson;
        GRANT USAGE, SELECT
           ON client_support_subscriptions_id_seq TO plusson;
    END IF;
END $$;

COMMIT;
