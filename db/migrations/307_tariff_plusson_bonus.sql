-- 307: бонус в ПЛЮСОНе за оплату тарифа события.
--
-- Зачем. Клиент продаёт тариф конференции и кладёт внутрь доступ к модулю
-- ПЛЮСОНа (напр. Коллабораторную за 1000 ₽). Раньше после оплаты человека
-- заводили в ПЛЮСОН РУКАМИ: создать кабинет, выдать модуль, выслать пароль.
-- Теперь это делает вебхук оплаты — тот же, что регистрирует участника.
--
-- ⚠️ ПОЧЕМУ ТОЛЬКО ПО ФИЧЕ, А НЕ ВСЕМ. Деньги за тариф события уходят на кассу
-- КЛИЕНТА, а модуль списывается с ПЛЮСОНа. У клиента 1 касса общая с
-- платформой, поэтому ему это ничего не стоит; любой другой клиент так
-- раздавал бы наш платный модуль за свои деньги. Гейт — фича
-- `tariff_plusson_bonus`, привязана к скрытому тарифу `admin`. Никакого
-- хардкода по client_id или tariff_slug: понадобится открыть кому-то ещё —
-- строка в tariff_features, без правок кода.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Фича-гейт
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO features (slug, name, description)
     VALUES ('tariff_plusson_bonus',
             'Бонус в ПЛЮСОНе за оплату тарифа',
             'Тариф события может выдавать покупателю кабинет ПЛЮСОНа с модулем. '
             'Доступно только там, где касса общая с платформой.')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t, features f
 WHERE t.slug = 'admin' AND f.slug = 'tariff_plusson_bonus'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Что выдавать — настройка на тарифе события
-- ─────────────────────────────────────────────────────────────────────────────
-- bonus_feature_id: какой модуль ПЛЮСОНа выдать (features.id, is_addon=TRUE).
--   NULL = бонуса нет, тариф работает как раньше.
-- bonus_months: на сколько месяцев. Уже есть модуль → срок ПРИБАВЛЯЕТСЯ к
--   текущему expires_at, а не считается с сегодня — иначе оплаченные дни
--   сгорали бы.
ALTER TABLE event_tariffs
    ADD COLUMN IF NOT EXISTS bonus_feature_id INTEGER
        REFERENCES features(id) ON DELETE SET NULL;

ALTER TABLE event_tariffs
    ADD COLUMN IF NOT EXISTS bonus_months INTEGER NOT NULL DEFAULT 1;

ALTER TABLE event_tariffs
    DROP CONSTRAINT IF EXISTS event_tariffs_bonus_months_chk;
ALTER TABLE event_tariffs
    ADD CONSTRAINT event_tariffs_bonus_months_chk
        CHECK (bonus_months >= 1 AND bonus_months <= 36);

-- ⚠️ ON DELETE SET NULL, не CASCADE: удаление фичи не должно уносить сам тариф
-- события вместе с его заказами и покупателями. Слетело в NULL → тариф просто
-- перестал выдавать бонус.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Кому уже выдали
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ Платёжные системы шлют оповещение по нескольку раз — это норма. Без
-- журнала повторный вебхук выдавал бы модуль ещё раз (и второй раз слал
-- письмо с доступами). UNIQUE по заказу = ровно одна выдача на оплату.
CREATE TABLE IF NOT EXISTS tariff_bonus_grants (
    id               SERIAL PRIMARY KEY,
    order_id         INTEGER NOT NULL UNIQUE
                     REFERENCES event_participant_tariffs(id) ON DELETE CASCADE,
    event_tariff_id  INTEGER REFERENCES event_tariffs(id) ON DELETE SET NULL,
    feature_id       INTEGER REFERENCES features(id) ON DELETE SET NULL,
    months           INTEGER NOT NULL DEFAULT 1,
    -- Кабинет, которому выдали. Мог существовать до оплаты, мог родиться здесь.
    client_id        INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    client_created   BOOLEAN NOT NULL DEFAULT FALSE,
    email            TEXT,
    -- Итог выдачи: granted | failed. Причина неудачи — в note (например,
    -- «нет почты покупателя»): молча терять оплаченный бонус нельзя.
    status           TEXT NOT NULL DEFAULT 'granted',
    note             TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tariff_bonus_grants_client
    ON tariff_bonus_grants (client_id);

-- Роль plusson не владелец таблиц — без GRANT'ов API получит permission denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON tariff_bonus_grants TO plusson;
GRANT USAGE, SELECT ON SEQUENCE tariff_bonus_grants_id_seq TO plusson;
