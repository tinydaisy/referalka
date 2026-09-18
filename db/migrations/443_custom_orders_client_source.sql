-- 441. Персональный заказ — на конкретного клиента платформы, с источником.
--
-- ⚠️⚠️ ЧЕЙ ЛИД БОЛЬШЕ НЕ СПРАШИВАЕМ, А ВЫЧИСЛЯЕМ. В миграции 439 источник
-- (`lead_source`) выбирался руками кнопкой «из базы ПЛЮСОНА / свой». Это было
-- неверно: кто привёл клиента, УЖЕ записано в самой платформе —
-- `clients.referred_by_tech_id` (привёл внедренец) и
-- `clients.referred_by_client_id` (привёл партнёр). Просить человека повторить
-- известное системе — значит дать ему ошибиться в свою пользу: ставка 80 %
-- вместо 60 % ставится одним кликом и ничем не проверяется.
--
-- Теперь в заказе хранится ССЫЛКА НА КЛИЕНТА, а `lead_source` вычисляется при
-- сохранении: 'own' только если клиента привёл ЭТОТ ЖЕ внедренец.

ALTER TABLE custom_orders
    ADD COLUMN IF NOT EXISTS client_id INTEGER
        REFERENCES clients(id) ON DELETE SET NULL,
    -- Кто привёл клиента — снимок на момент заказа, для показа в списке.
    -- ⚠️ Снимок, а не только ссылка: партнёра могут удалить, а в заказе должно
    -- остаться видно, от кого пришёл человек.
    ADD COLUMN IF NOT EXISTS source_kind TEXT
        CHECK (source_kind IN ('tech', 'partner', 'none')),
    ADD COLUMN IF NOT EXISTS source_title TEXT,
    ADD COLUMN IF NOT EXISTS source_email TEXT;

CREATE INDEX IF NOT EXISTS idx_custom_orders_client
    ON custom_orders(client_id) WHERE client_id IS NOT NULL;

COMMENT ON COLUMN custom_orders.client_id IS
    'Клиент платформы, которому оказывается услуга. По нему вычисляется lead_source.';
COMMENT ON COLUMN custom_orders.source_kind IS
    'Кто привёл клиента: tech — внедренец, partner — клиент-партнёр, none — база ПЛЮСОНА.';
COMMENT ON COLUMN custom_orders.source_title IS
    'Имя того, кто привёл — снимок на момент заказа. ⚠️ Реферальный процент с '
    'персональных заказов НЕ платится, поле только для понимания, от кого человек.';
