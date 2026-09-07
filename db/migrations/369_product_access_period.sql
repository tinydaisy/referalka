-- 369: срок доступа к продукту + история заходов и событий доступа
--
-- ⚠️⚠️ ДОСТУП НЕ УДАЛЯЕТСЯ НИКОГДА (решение владельца, 07.09.2026).
-- Раньше «забрать доступ» = DELETE строки: после этого нельзя было ответить на
-- вопрос «а у кого доступ БЫЛ и когда кончился» — человек исчезал из списка
-- вместе с фактом покупки. Теперь закрытие — это `revoked_at`, строка остаётся
-- навсегда. Отсюда же `status` в интерфейсе считается, а не хранится:
--   открыт  — revoked_at IS NULL И (expires_at IS NULL ИЛИ expires_at > now)
--   истёк   — revoked_at IS NULL И expires_at <= now
--   закрыт  — revoked_at IS NOT NULL
--
-- ⚠️ NULL в `expires_at` = БЕССРОЧНО, а не «не заполнено». Это основной случай
-- (все существующие доступы такие), поэтому у колонки нет DEFAULT: пустота
-- здесь осмысленна и означает «навсегда».

ALTER TABLE product_access
  ADD COLUMN IF NOT EXISTS expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expiry_warned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS note         TEXT;

COMMENT ON COLUMN product_access.expires_at IS
  'До какого момента открыт доступ. NULL = бессрочно.';
COMMENT ON COLUMN product_access.revoked_at IS
  'Когда доступ закрыли руками. Строку не удаляем — история должна остаться.';
COMMENT ON COLUMN product_access.expiry_warned_at IS
  'Когда ушло письмо «доступ заканчивается». Без отметки письмо уходило бы каждый час.';

-- Отбор «чей доступ пора закрыть / о чьём предупредить» идёт по сроку.
CREATE INDEX IF NOT EXISTS idx_product_access_expires
  ON product_access (expires_at)
  WHERE expires_at IS NOT NULL AND revoked_at IS NULL;

-- ⚠️ Срок ЗАДАЁТСЯ У ТАРИФА и считается от даты оплаты (решение владельца).
-- В днях, а не «месяцах»: месяц — это то ли 30, то ли 31 день, а покупателю в
-- письме нужна точная дата. Тот же выбор, что у бонусов ПЛЮСОНа (`bonus_days`).
-- NULL = доступ по этому тарифу бессрочный (текущее поведение всех тарифов).
ALTER TABLE product_tariffs
  ADD COLUMN IF NOT EXISTS access_days INTEGER;

COMMENT ON COLUMN product_tariffs.access_days IS
  'На сколько дней открывается доступ после оплаты. NULL = навсегда.';

-- История событий доступа: выдан, продлён, закрыт, ушло письмо.
--
-- ⚠️ Отдельная таблица, а не колонки в product_access: событий по одному
-- доступу много (продлевали трижды, письмо уходило дважды), в колонки они не
-- ложатся. Плюс запись не должна теряться при правке самого доступа.
CREATE TABLE IF NOT EXISTS product_access_events (
  id          SERIAL PRIMARY KEY,
  access_id   INTEGER NOT NULL REFERENCES product_access(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,   -- granted | extended | revoked | restored | email_sent | expired
  detail      TEXT,
  actor       TEXT,            -- кто сделал: 'client' | 'system' | 'payment'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_access_events_access
  ON product_access_events (access_id, created_at DESC);

-- Заходы человека в кабинет покупателя и открытые материалы.
--
-- ⚠️ Пишем на КОНТАКТ, а не на доступ: человек заходит в кабинет целиком, а не
-- «в доступ». У него может быть несколько продуктов, и заходы общие.
--
-- ⚠️ Ретенции нет намеренно — история заходов и есть ценность этой таблицы;
-- растёт медленно (одна строка на вход/открытие материала).
CREATE TABLE IF NOT EXISTS product_cabinet_visits (
  id           SERIAL PRIMARY KEY,
  client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contact_id   INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,   -- login | code_requested | product | material
  product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL,
  material_id  INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  title        TEXT,            -- снимок названия: материал могут переименовать
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cabinet_visits_contact
  ON product_cabinet_visits (client_id, contact_id, created_at DESC);

-- ⚠️ Роль plusson не владелец таблиц — без GRANT API получит permission denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON product_access_events, product_cabinet_visits TO plusson;
GRANT USAGE, SELECT ON SEQUENCE product_access_events_id_seq TO plusson;
GRANT USAGE, SELECT ON SEQUENCE product_cabinet_visits_id_seq TO plusson;
