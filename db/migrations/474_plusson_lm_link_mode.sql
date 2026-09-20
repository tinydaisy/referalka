-- 474. Как отдавать Плюсоновский подарок в сообщении: кнопкой или кнопкой со
-- ссылкой (20.09.2026). Настройка платформенная, из админки.
--
-- ЗАЧЕМ.
-- Клиент этот подарок не редактирует вовсе (решение владельца): кнопку правки
-- у него убрали, а всё, что можно настроить, задаётся в админке один раз на
-- всех. Режим выдачи был последним, что оставалось за клиентом.
--
-- ⚠️ Настройка работает, когда подарок приходит СООБЩЕНИЕМ В БОТЕ — то есть
-- когда его выдают через бота клиента (подарок за рефералов, воронка события,
-- режим `funnel`). При прямом переходе по ссылке человек сразу уходит в бот
-- ПЛЮСОНа, и дальше им занимается НАША воронка — там отдавать нечего.
--
-- ⚠️ Значения только два. `text` (одна ссылка в тексте абзаца) у этого подарка
-- не предлагается осознанно: ссылка внутри абзаца на телефоне промахивается
-- мимо пальца, а подарок платформы должен забираться с первого тычка.

BEGIN;

ALTER TABLE platform_settings
    ADD COLUMN IF NOT EXISTS plusson_lm_link_mode TEXT NOT NULL DEFAULT 'both';

ALTER TABLE platform_settings DROP CONSTRAINT IF EXISTS platform_settings_plusson_lm_link_mode_check;
ALTER TABLE platform_settings
    ADD CONSTRAINT platform_settings_plusson_lm_link_mode_check
    CHECK (plusson_lm_link_mode IN ('button', 'both'));

COMMENT ON COLUMN platform_settings.plusson_lm_link_mode IS
    'Как отдавать Плюсоновский подарок в сообщении бота: button — только '
    'кнопкой; both — кнопкой и ссылкой. Применяется при выдаче через бота '
    'клиента; при прямом переходе человеком занимается воронка бота ПЛЮСОНа';

-- Приводим существующие к настройке (у всех и так 'both' — но пусть сходится).
UPDATE lead_magnets
   SET link_mode = (SELECT plusson_lm_link_mode FROM platform_settings WHERE id = 1)
 WHERE is_plusson;

COMMIT;
