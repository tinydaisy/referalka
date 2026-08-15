-- 306: реф-бонус к триалу — в настройки реф-программы, а не константой в коде.
--
-- Было: база триала 30 дней всем + 7 дней за реф-код (константа
-- REFERRAL_TRIAL_BONUS_DAYS в auth.py). То есть месяц бесплатного Профи
-- получал КАЖДЫЙ зашедший, а реф-ссылка добавляла всего неделю — партнёру
-- нечего было предложить.
--
-- Стало: 7 дней без реферала, 30 по реф-ссылке (7 + 23). Реф-ссылка
-- становится ценной, а «просто зашёл с улицы» получает короткую пробу.
--
-- Само число бонуса переезжает в referral_program_settings — рядом с
-- процентом кэшбэка и сроками. Так его меняют из админки, а не деплоем.
--
-- ⚠️ Уже выданные подписки НЕ пересчитываются: у клиента подписка выдана
-- один раз при регистрации, задним числом её никто не трогает.

ALTER TABLE referral_program_settings
    ADD COLUMN IF NOT EXISTS trial_bonus_days INTEGER NOT NULL DEFAULT 23;

ALTER TABLE referral_program_settings
    DROP CONSTRAINT IF EXISTS referral_program_settings_trial_bonus_check;
ALTER TABLE referral_program_settings
    ADD CONSTRAINT referral_program_settings_trial_bonus_check
        CHECK (trial_bonus_days >= 0 AND trial_bonus_days <= 365);

-- База триала: 30 → 7 дней. По реф-ссылке итог = 7 + 23 = 30.
UPDATE tariffs SET default_duration_days = 7 WHERE slug = 'trial';

-- Строка настроек существует не всегда (get_settings умеет отдавать дефолты) —
-- но если её нет, значение бонуса взять неоткуда. Заводим явно.
INSERT INTO referral_program_settings (id, trial_bonus_days)
     VALUES (1, 23)
ON CONFLICT (id) DO UPDATE SET trial_bonus_days = 23, updated_at = now();
