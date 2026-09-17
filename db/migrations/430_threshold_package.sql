-- 430: порог реф-программы может выдавать ПАКЕТ лид-магнитов, а не только один.
--
-- ⚠️ Зачем. У порога было только `lead_magnet_id` — выдать набор материалов за
-- приглашённых друзей было нечем, хотя пакеты в системе есть давно и работают
-- во всех остальных местах выдачи (воронки, анкеты, /start бота, подарки
-- спикера). Решение владельца: лид-магниты и пакеты доступны ВЕЗДЕ одинаково.

ALTER TABLE event_referral_thresholds
  ADD COLUMN IF NOT EXISTS package_id INTEGER
    REFERENCES lead_magnet_packages(id) ON DELETE SET NULL;

-- ⚠️ ON DELETE SET NULL, не CASCADE: удаление пакета не должно уносить сам
-- порог с его числом приглашённых, сертификатом и текстом выдачи. Порог просто
-- останется без подарка, и клиент выберет новый.

-- ⚠️ Магнит ИЛИ пакет, но не оба сразу: иначе непонятно, что выдавать.
-- COALESCE обязателен — без него пара (NULL, 5) даёт NULL, а не FALSE, и
-- проверка такую строку ПРОПУСКАЕТ (на этом уже обжигались в миграции 305).
ALTER TABLE event_referral_thresholds
  DROP CONSTRAINT IF EXISTS threshold_gift_one_chk;
ALTER TABLE event_referral_thresholds
  ADD CONSTRAINT threshold_gift_one_chk
  CHECK (COALESCE(lead_magnet_id IS NULL, TRUE) OR COALESCE(package_id IS NULL, TRUE));

CREATE INDEX IF NOT EXISTS idx_threshold_package
  ON event_referral_thresholds(package_id) WHERE package_id IS NOT NULL;

COMMENT ON COLUMN event_referral_thresholds.package_id IS
  'Пакет лид-магнитов как подарок за порог. Взаимоисключающе с lead_magnet_id.';
