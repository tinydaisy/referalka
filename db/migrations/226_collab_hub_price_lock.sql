-- 226: Фиксация цены на модуль-аддон для ранних покупателей («заморозка цены»).
--
-- Зачем. Модуль «Коллабораторная» в активной доработке и продаётся сейчас дёшево.
-- Тем, кто оплатил ДО окончания акции, цена фиксируется на N месяцев ОТ ДАТЫ ОПЛАТЫ:
-- даже если цена вырастет (1000 → 2000), они продлевают по старой.
--
-- ⚠️ Настройки акции (срок действия и сколько месяцев держать цену) НЕ захардкожены —
-- живут в таблице `promotions` и правятся админом в /admin/promotions:
--     type   = 'price_lock'
--     value  = сколько МЕСЯЦЕВ держать цену (напр. 3)
--     ends_at= до какой даты нужно успеть оплатить (напр. 31.07.2026)
--     target_feature_slug = какой модуль (напр. 'collab_hub')
--     is_active = вкл/выкл
--
-- ⚠️ Почему нужна ОТДЕЛЬНАЯ карточка LeadPay: сумму платежа задаём не мы, а карточка
-- товара на стороне LeadPay (мы передаём только product_id). Поэтому «подставить
-- старую цену» в коде мало — нужна вторая карточка со старой ценой, куда мы уводим
-- клиентов с активным локом.
--
-- Порядок действий при повышении цены:
--   1. В LeadPay СОЗДАТЬ НОВУЮ карточку с новой ценой (старую НЕ трогать!).
--   2. features.leadpay_product_id / price_monthly        = НОВАЯ карточка и цена.
--   3. features.leadpay_product_id_locked / price_monthly_locked = СТАРАЯ карточка и цена.
-- Тогда: обычный клиент → новая цена, клиент с активным локом → старая.

-- ── 1. Карточка и цена «для тех, у кого цена зафиксирована» ──
ALTER TABLE features
    ADD COLUMN IF NOT EXISTS leadpay_product_id_locked TEXT,
    ADD COLUMN IF NOT EXISTS price_monthly_locked      INTEGER;

COMMENT ON COLUMN features.leadpay_product_id_locked IS
    'Карточка LeadPay со СТАРОЙ ценой — для клиентов с активным price lock';
COMMENT ON COLUMN features.price_monthly_locked IS
    'Старая (зафиксированная) цена ₽/мес. Показывается клиенту с активным локом';

-- ── 2. Настройка акции живёт в promotions (правится админом, не в коде) ──
ALTER TABLE promotions
    ADD COLUMN IF NOT EXISTS target_feature_slug TEXT;

COMMENT ON COLUMN promotions.target_feature_slug IS
    'Для type=price_lock: slug модуля-аддона, на который действует заморозка цены';

-- Разрешаем новый тип акции.
ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_type_check;
ALTER TABLE promotions ADD CONSTRAINT promotions_type_check
    CHECK (type IN ('trial_bonus_days', 'price_lock'));

-- ── 3. Кому и до какой даты зафиксирована цена ──
CREATE TABLE IF NOT EXISTS client_price_locks (
    id           SERIAL PRIMARY KEY,
    client_id    INTEGER NOT NULL REFERENCES clients(id)  ON DELETE CASCADE,
    feature_id   INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    locked_price INTEGER NOT NULL,          -- цена ₽/мес, зафиксированная за клиентом
    expires_at   TIMESTAMPTZ NOT NULL,      -- N месяцев от даты оплаты
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Один активный лок на (клиент, фича): повторная оплата в акционный период
    -- продлевает лок (UPSERT), а не плодит дубли.
    UNIQUE (client_id, feature_id)
);

CREATE INDEX IF NOT EXISTS idx_price_locks_active
    ON client_price_locks (client_id, feature_id, expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON client_price_locks TO plusson;
GRANT USAGE, SELECT ON SEQUENCE client_price_locks_id_seq TO plusson;

-- ── 4. Сама акция: Коллабораторная, оплата до 31.07.2026, цена держится 3 месяца ──
INSERT INTO promotions (slug, name, description, type, value,
                        target_feature_slug, ends_at, is_active)
VALUES ('collab_hub_price_lock_2026_07',
        'Заморозка цены: Коллабораторная',
        'Оплатившим до 31.07.2026 цена не повышается 3 месяца от даты оплаты',
        'price_lock', 3, 'collab_hub',
        '2026-07-31 23:59:59+03', TRUE)
ON CONFLICT (slug) DO NOTHING;
