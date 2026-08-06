-- 269_client_domains.sql
-- Свои домены клиента: публичные страницы (лендинги, кабинет спикера,
-- турнирные таблицы, воронки) и почта рассылок с домена клиента.
--
-- Домен ЛЕНДИНГОВ (kind='landing'):
--   клиент ставит CNAME на pluson.ru, мы выпускаем сертификат и добавляем
--   server-блок в nginx. Всё публичное начинает открываться на его домене.
--
-- Домен ПОЧТЫ (kind='mail'):
--   письма уходят с нашего Postfix, но From = @домен клиента. Клиент
--   добавляет SPF + DKIM + DMARC, мы генерим ему отдельный DKIM-ключ
--   в OpenDKIM (KeyTable/SigningTable — по строке на домен).
--
-- Кабинет клиента (/dashboard, /admin) на свой домен НЕ переезжает —
-- там JWT/cookies/вебхуки завязаны на один origin.

BEGIN;

CREATE TABLE IF NOT EXISTS client_domains (
    id              SERIAL PRIMARY KEY,
    client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

    -- Что этот домен обслуживает
    kind            TEXT NOT NULL CHECK (kind IN ('landing', 'mail')),

    -- Домен в нижнем регистре, без схемы и без завершающей точки: lp.example.ru
    domain          TEXT NOT NULL,

    -- Жизненный цикл:
    --   pending    — добавлен, DNS ещё не проверяли / не сошёлся
    --   dns_ok     — DNS проверен, можно выпускать сертификат (landing)
    --                либо SPF/DKIM/DMARC сошлись (mail)
    --   active     — работает
    --   error      — последняя операция не удалась, см. last_error
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'dns_ok', 'active', 'error')),

    -- Только один активный домен каждого вида на клиента — иначе непонятно,
    -- какой подставлять в ссылки рассылок и в адрес отправителя.
    is_primary      BOOLEAN NOT NULL DEFAULT TRUE,

    -- ── Проверка DNS ──
    dns_checked_at  TIMESTAMPTZ,
    dns_ok          BOOLEAN NOT NULL DEFAULT FALSE,
    -- Подробности последней проверки: для landing {cname: "..."},
    -- для mail {spf: true, dkim: false, dmarc: true, ...}
    dns_details     JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- ── Сертификат (только kind='landing') ──
    cert_issued_at  TIMESTAMPTZ,
    cert_expires_at TIMESTAMPTZ,
    -- Имя сертификата в certbot (--cert-name), чтобы перевыпускать точечно
    cert_name       TEXT,

    -- ── DKIM (только kind='mail') ──
    -- Селектор в DNS: <selector>._domainkey.<domain>
    dkim_selector   TEXT,
    -- Публичная часть ключа — её клиент кладёт в свой DNS.
    -- Приватная лежит только на сервере в /etc/opendkim/keys/<domain>/.
    dkim_public_key TEXT,
    -- Локальная часть адреса отправителя: <local>@<domain>
    mail_from_local TEXT NOT NULL DEFAULT 'noreply',
    -- Отображаемое имя отправителя; пусто → берём бренд клиента
    mail_from_name  TEXT,

    -- ── Диагностика ──
    last_error      TEXT,
    last_error_at   TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Домен не может обслуживать двух клиентов: иначе по Host невозможно
-- однозначно понять, чью страницу отдавать.
CREATE UNIQUE INDEX IF NOT EXISTS client_domains_domain_kind_uniq
    ON client_domains (domain, kind);

-- Один основной домен каждого вида на клиента.
CREATE UNIQUE INDEX IF NOT EXISTS client_domains_primary_uniq
    ON client_domains (client_id, kind)
    WHERE is_primary;

-- Резолв клиента по Host на каждый публичный запрос — должен быть быстрым.
CREATE INDEX IF NOT EXISTS client_domains_lookup_idx
    ON client_domains (domain)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS client_domains_client_idx
    ON client_domains (client_id, kind);

-- Ежедневный мониторинг сроков сертификатов ходит по этому индексу.
CREATE INDEX IF NOT EXISTS client_domains_cert_expiry_idx
    ON client_domains (cert_expires_at)
    WHERE kind = 'landing' AND status = 'active';

COMMENT ON TABLE  client_domains IS 'Свои домены клиента: публичные страницы (landing) и адрес отправителя писем (mail)';
COMMENT ON COLUMN client_domains.kind IS 'landing — публичные страницы через CNAME; mail — домен отправителя писем через SPF/DKIM/DMARC';
COMMENT ON COLUMN client_domains.dns_details IS 'Результат последней проверки DNS: landing {cname}, mail {spf,dkim,dmarc}';
COMMENT ON COLUMN client_domains.dkim_public_key IS 'Публичная часть DKIM — её клиент кладёт в свой DNS. Приватная только на сервере.';

-- ── Фича ──
-- Гейтим ТОЛЬКО по фиче, никогда по tariff_slug (правило проекта).
INSERT INTO features (slug, name, description, sort)
VALUES (
    'custom_domain',
    'Свой домен',
    'Публичные страницы (лендинги, кабинет спикера, турнирные таблицы) на своём домене и письма со своего адреса',
    (SELECT COALESCE(MAX(sort), 0) + 1 FROM features)
)
ON CONFLICT (slug) DO NOTHING;

-- Выдаём Экстра (vip) и админскому тарифу. Триал зеркалит pro автоматически
-- (_mirror_pro_features_to_trial), поэтому в trial руками не пишем.
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t
  CROSS JOIN features f
 WHERE f.slug = 'custom_domain'
   AND t.slug IN ('vip', 'admin')
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON client_domains TO plusson;
GRANT USAGE, SELECT ON SEQUENCE client_domains_id_seq TO plusson;

COMMIT;
