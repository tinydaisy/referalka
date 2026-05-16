-- Миграция 082: добавить режим «clicked_link» в event_referral_settings.gift_count_mode.
--
-- В дашборде во вкладке «Реф-программа» в блоке «За что выдаются подарки»
-- появляется третий вариант:
--   - 'registered'   — за зарегистрировавшихся (default)
--   - 'visited'      — за переходы по ссылке
--   - 'clicked_link' — за тех, кто нажал главную CTA-ссылку события
--                       (для мероприятий/конференций называется «За присутствовавших в эфире»,
--                        для конкурсов — «За проголосовавших»; смысл один и тот же
--                        — event_participants.link_clicked_at IS NOT NULL).
--
-- Старые значения остаются валидными, существующие записи не трогаем.

ALTER TABLE event_referral_settings
    DROP CONSTRAINT IF EXISTS event_referral_settings_gift_count_mode_check;

ALTER TABLE event_referral_settings
    ADD CONSTRAINT event_referral_settings_gift_count_mode_check
    CHECK (gift_count_mode IN ('registered', 'visited', 'clicked_link'));

COMMENT ON COLUMN event_referral_settings.gift_count_mode IS
    'За что считать подарки: registered (только зарегистрированные) | visited (любые переходы) | clicked_link (нажавшие главную CTA-ссылку события)';
