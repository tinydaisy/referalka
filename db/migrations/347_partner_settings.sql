-- 347: Партнёрка — настройки кабинета, участие событий/продуктов, вознаграждение
--
-- Зачем. Где задаётся вознаграждение: МЕСТА ДВА, не три (решение № 29).
--
--   Настройки кабинета  — умолчание для всего + уровни + затухание + режим
--   Событие / продукт   — ТОЛЬКО галочка «участвует», процента здесь НЕТ
--   Тариф               — своё вознаграждение, перетирает умолчание
--
-- Почему процент на ТАРИФЕ, а не на событии: у разных тарифов одного события
-- разная маржинальность. «Онлайн-доступ» расходов не требует — 10% отдаются
-- легко; «Офлайн с залом и питанием» — там из цены вычтены реальные затраты,
-- и те же 10% отдавать больно. Промежуточный уровень «процент на событии»
-- сознательно отсутствует, чтобы не гадать, чьё значение сильнее.

-- ── Настройки кабинета клиента ───────────────────────────────────────────────
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS partner_default_reward_kind  TEXT,
  ADD COLUMN IF NOT EXISTS partner_default_reward_value NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS partner_levels               INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS partner_level_decay          NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS partner_payout_mode          TEXT NOT NULL DEFAULT 'passive',
  ADD COLUMN IF NOT EXISTS tab_label_partner            TEXT;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_partner_reward_chk;
ALTER TABLE clients ADD CONSTRAINT clients_partner_reward_chk CHECK (
    (partner_default_reward_kind IS NULL AND partner_default_reward_value IS NULL)
    OR COALESCE(partner_default_reward_kind = 'percent'
                AND partner_default_reward_value > 0
                AND partner_default_reward_value <= 100, FALSE)
    OR COALESCE(partner_default_reward_kind = 'fixed'
                AND partner_default_reward_value > 0, FALSE)
);

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_partner_payout_mode_chk;
ALTER TABLE clients ADD CONSTRAINT clients_partner_payout_mode_chk
    CHECK (partner_payout_mode IN ('active', 'passive'));

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_partner_levels_chk;
ALTER TABLE clients ADD CONSTRAINT clients_partner_levels_chk
    CHECK (partner_levels >= 1 AND partner_levels <= 10);

COMMENT ON COLUMN clients.partner_default_reward_kind IS
  'percent|fixed|NULL. Умолчание вознаграждения для всех тарифов кабинета. Нужны ОБА вида (№ 21): процент — когда цена может меняться; фикс — когда у тарифа большие расходы и отдаём ровно оговорённую сумму (в тарифе за 50 000 ₽, где 30 000 — затраты, «10%» ничего не говорит, а «3 000 ₽ партнёру» говорит).';
COMMENT ON COLUMN clients.partner_levels IS
  'Сколько уровней вознаграждения. ⚠️ Уровни работают ТОЛЬКО в пассивном режиме (№ 44): в активном на заказе лежит один реф-код, вверх идти не из чего.';
COMMENT ON COLUMN clients.partner_level_decay IS
  'Во сколько раз вознаграждение следующего уровня меньше предыдущего (№ 11). Работает и для рублей: 3000 ₽ и «вчетверо» → 750 ₽ на втором уровне.';
COMMENT ON COLUMN clients.partner_payout_mode IS
  'ОБЩИЙ режим выплат кабинета. passive = платим закреплённому партнёру со ВСЕХ покупок этого человека; active = платим тому, кто привёл на ЭТУ покупку. Смешанного режима нет (№ 32). ⚠️ По умолчанию passive (№ 39): он не оставляет покупку без выплаты и это главный аргумент для набора партнёров.';
COMMENT ON COLUMN clients.tab_label_partner IS
  'Название вкладки «Партнёру» в Mini App — переименовывается клиентом, как остальные tab_label_* (№ 3). Пусто → «Партнёру».';

-- ── Галочка участия: событие и продукт ───────────────────────────────────────
-- ⚠️ ТОЛЬКО галочка, процента здесь нет (№ 29).
-- ⚠️ DEFAULT FALSE: включать партнёрку задним числом на всех существующих
-- событиях нельзя — клиент не давал такого согласия и не знает о разделе.
ALTER TABLE events   ADD COLUMN IF NOT EXISTS partner_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS partner_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN events.partner_enabled IS
  'Участвует ли событие в партнёрской программе клиента (№ 29). Процент задаётся не здесь, а на тарифе или умолчанием кабинета.';
COMMENT ON COLUMN products.partner_enabled IS
  'Участвует ли продукт в партнёрской программе клиента (№ 29).';

-- ── Вознаграждение на тарифе ─────────────────────────────────────────────────
-- Сделано по образцу discount_kind/discount_value в этих же таблицах (мигр. 305),
-- включая COALESCE в CHECK: без него пара ('percent', NULL) давала бы NULL,
-- а не FALSE, и ограничение её ПРОПУСКАЛО (в SQL неизвестность считается
-- выполненной). На этих граблях уже стояли — повторять не надо.
ALTER TABLE event_tariffs
  ADD COLUMN IF NOT EXISTS partner_reward_kind  TEXT,
  ADD COLUMN IF NOT EXISTS partner_reward_value NUMERIC(12,2);

ALTER TABLE product_tariffs
  ADD COLUMN IF NOT EXISTS partner_reward_kind  TEXT,
  ADD COLUMN IF NOT EXISTS partner_reward_value NUMERIC(12,2);

ALTER TABLE event_tariffs DROP CONSTRAINT IF EXISTS event_tariffs_partner_reward_chk;
ALTER TABLE event_tariffs ADD CONSTRAINT event_tariffs_partner_reward_chk CHECK (
    (partner_reward_kind IS NULL AND partner_reward_value IS NULL)
    OR COALESCE(partner_reward_kind = 'percent'
                AND partner_reward_value > 0 AND partner_reward_value <= 100, FALSE)
    OR COALESCE(partner_reward_kind = 'fixed'  AND partner_reward_value > 0, FALSE)
);

ALTER TABLE product_tariffs DROP CONSTRAINT IF EXISTS product_tariffs_partner_reward_chk;
ALTER TABLE product_tariffs ADD CONSTRAINT product_tariffs_partner_reward_chk CHECK (
    (partner_reward_kind IS NULL AND partner_reward_value IS NULL)
    OR COALESCE(partner_reward_kind = 'percent'
                AND partner_reward_value > 0 AND partner_reward_value <= 100, FALSE)
    OR COALESCE(partner_reward_kind = 'fixed'  AND partner_reward_value > 0, FALSE)
);

COMMENT ON COLUMN event_tariffs.partner_reward_kind IS
  'percent|fixed|NULL. NULL = действует умолчание кабинета (clients.partner_default_reward_*). Перетирает умолчание (№ 29).';
COMMENT ON COLUMN product_tariffs.partner_reward_kind IS
  'percent|fixed|NULL. NULL = действует умолчание кабинета.';

-- ── Получатель вознаграждения по заказу продукта ─────────────────────────────
-- ⚠️⚠️ СМЫСЛ НЕ ТОТ, ЧТО У event_participants.referrer_ref_code (№ 34).
--
--   event_participants.referrer_ref_code — «КТО ПРИВЁЛ». Любой, в том числе
--     не партнёр. На нём держатся подарки и зачёт на событии.
--   product_orders.referrer_ref_code (здесь) — «КОМУ ПЛАТИМ». ТОЛЬКО партнёр.
--
-- Логику записи с событийного поля НЕ КОПИРОВАТЬ. Развилка по режиму выплат
-- живёт в МОМЕНТ ЗАПИСИ (№ 33): пассивный → закреплённый партнёр; активный →
-- приведший, если он партнёр; иначе поле пустое. Начисление потом читает одно
-- поле и не рассуждает (№ 36) — поэтому в истории не нужно хранить, какой
-- режим стоял на момент покупки.
ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS referrer_ref_code TEXT;

COMMENT ON COLUMN product_orders.referrer_ref_code IS
  'Реф-код ПОЛУЧАТЕЛЯ вознаграждения (contacts.ref_code партнёра). ⚠️ Здесь «кому платим», а не «кто привёл» — в отличие от event_participants.referrer_ref_code. Пусто = платить некому.';
