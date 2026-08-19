-- 317: Правовые документы платформы — оферта, политика ПД, партнёрская оферта
--
-- Зачем. Тексты Публичной оферты, Политики обработки персональных данных и
-- Оферты партнёрской программы должны быть доступны публично (на них ссылаются
-- чекбоксы при регистрации, миграция 315) и редактироваться владельцем без
-- участия разработчика — иначе правка запятой требует деплоя.
--
-- ⚠️ Таблица на ВСЮ ПЛАТФОРМУ, а не на клиента. Не путать с:
--   • clients.privacy_policy_text  — политика ПД САМОГО КЛИЕНТА (152-ФЗ),
--     её он пишет для своей аудитории;
--   • client_offers               — оферты КЛИЕНТА на его продукты.
-- Здесь документы Оферента (владельца платформы) для его Клиентов.
--
-- ⚠️ Версия документа (`version`) — дата редакции в формате YYYY-MM-DD. Она же
-- пишется клиенту при регистрации (clients.offer_accepted_version), поэтому
-- при правке ТЕКСТА её нужно менять осознанно: по ней потом видно, с какой
-- именно редакцией человек согласился.
CREATE TABLE IF NOT EXISTS platform_legal_docs (
    slug        TEXT PRIMARY KEY,          -- offer | privacy | partner_offer
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    version     TEXT,                      -- дата редакции YYYY-MM-DD
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE platform_legal_docs IS
  'Правовые документы САМОЙ платформы (оферта, политика ПД, партнёрская оферта). Редактируются в админке, отдаются публично на /offer, /privacy, /partner-offer.';
COMMENT ON COLUMN platform_legal_docs.version IS
  'Дата редакции (YYYY-MM-DD). Фиксируется клиенту при акцепте — см. clients.offer_accepted_version.';

INSERT INTO platform_legal_docs (slug, title, version) VALUES
    ('offer',         'Публичная оферта',                          '2026-06-14'),
    ('privacy',       'Политика обработки персональных данных',    '2026-06-14'),
    ('partner_offer', 'Оферта об участии в партнёрской программе', NULL)
ON CONFLICT (slug) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_legal_docs TO plusson;
