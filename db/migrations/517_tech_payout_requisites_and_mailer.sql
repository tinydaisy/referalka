-- 517: Внедренцу — реквизиты для выплат и аккаунт в Авторассыльщике (мейлере).
--
-- ── Реквизиты для выплат ────────────────────────────────────────────────
-- ⚠️ Живут на `tech_specialists`, а НЕ на `clients`: это данные для выплат
-- ВНЕДРЕНЦУ за работу. У клиента-невнедренца их нет и быть не должно.
--
-- ⚠️ Платим по СБП, поэтому телефон + банк: номера без банка для перевода мало.
-- Самозанятость — отметка самого человека (решение владельца 26.09.2026:
-- проверку через налоговую НЕ делаем). Оферту и подписание документов перед
-- выводом владелец добавит отдельно.
ALTER TABLE tech_specialists
    ADD COLUMN IF NOT EXISTS payout_full_name     TEXT,
    ADD COLUMN IF NOT EXISTS payout_inn           TEXT,
    ADD COLUMN IF NOT EXISTS payout_sbp_phone     TEXT,
    ADD COLUMN IF NOT EXISTS payout_bank          TEXT,
    ADD COLUMN IF NOT EXISTS payout_self_employed BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS payout_updated_at    TIMESTAMPTZ;

-- ── Авторассыльщик (mailer.pluson.ru) ───────────────────────────────────
-- ⚠️⚠️ ВЫДАЁТ И БЛОКИРУЕТ ВЛАДЕЛЕЦ КНОПКОЙ, А НЕ АВТОМАТ (решение 26.09.2026).
-- «Стал внедренцем → аккаунт сам» и «уволили → закрыли сам» не делаем: выдача
-- доступа к чужому сервису — осознанное действие владельца.
--
-- ⚠️ ПАРОЛЬ ХРАНИМ ОТКРЫТО: мейлер отдаёт его ОДИН раз при регистрации (у себя
-- держит только хеш), а внедренцу надо видеть его в кабинете. Если человек
-- сменит пароль в самом мейлере — здесь останется старый, об этом написано
-- в кабинете.
--
-- ⚠️ mailer_password = NULL при mailer_email не NULL — аккаунт на эту почту
-- в мейлере УЖЕ был (409 email_taken): пароль у человека, нам его не узнать.
ALTER TABLE tech_specialists
    ADD COLUMN IF NOT EXISTS mailer_email      TEXT,
    ADD COLUMN IF NOT EXISTS mailer_password   TEXT,
    ADD COLUMN IF NOT EXISTS mailer_login_url  TEXT,
    ADD COLUMN IF NOT EXISTS mailer_issued_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS mailer_blocked_at TIMESTAMPTZ;

COMMENT ON COLUMN tech_specialists.mailer_password IS
    'Пароль мейлера, выданный при регистрации. NULL при заполненной почте = аккаунт уже был.';

-- ── Ник владельца для кнопки «Запросить доступ» ─────────────────────────
-- ⚠️ Храним НИК, а ссылку t.me/<ник> собираем в коде: в поле вводят просто
-- ник, и ссылка не ломается от лишнего «@» или «https://».
ALTER TABLE platform_settings
    ADD COLUMN IF NOT EXISTS tech_owner_tg_username TEXT;

UPDATE platform_settings SET tech_owner_tg_username = 'margo_forbs'
 WHERE id = 1 AND tech_owner_tg_username IS NULL;
