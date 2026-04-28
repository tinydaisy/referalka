-- Миграция 045 (28.04.2026)
-- Фича-флаг тарифа: разрешает ли тариф клиенту подключать свой бот в Telegram (брендирование).
-- Используется в:
--   - GET /api/v1/auth/me (флаг отдаётся фронту)
--   - POST /api/v1/channels/* (бэкенд блокирует сохранение bot_token для дешёвых тарифов)
--   - /dashboard/channels (UI: read-only апсейл-блок vs полноценный CRUD)

ALTER TABLE tariffs
    ADD COLUMN IF NOT EXISTS allow_custom_bot BOOLEAN NOT NULL DEFAULT false;

-- VIP-тариф (пока единственный с правом на свой бот). Цена и лимиты — на будущее, в MVP не валидируются.
INSERT INTO tariffs (slug, name, price, trial_months, max_events, max_participants, is_active, allow_custom_bot)
VALUES ('vip', 'VIP', 0, 0, -1, -1, true, true)
ON CONFLICT (slug) DO UPDATE SET allow_custom_bot = EXCLUDED.allow_custom_bot,
                                 name              = EXCLUDED.name;
