-- 348: Партнёрка — начисления и выплаты
--
-- ⚠️⚠️ НАЧИСЛЕНИЕ РОЖДАЕТСЯ ТОЛЬКО В МОМЕНТ ПОДТВЕРЖДЕНИЯ ОПЛАТЫ (решение № 27).
-- Это НЕ отчёт по таблице заказов, а запись, создаваемая один раз: пришёл
-- вебхук от платёжки (или клиент отметил «оплачено») → смотрим получателя →
-- пишем строку. Так уже работает кэшбэк ПЛЮСОНа (_credit_referral_cashback):
-- он вызывается из обработчика оплаты и по истории не ходит.
--
-- ⇒ Старые оплаты попасть в расчёт не могут: момент их подтверждения прошёл,
-- а кода, который ходит по истории, не существует.
--
-- ⚠️⚠️ МАССОВОГО ПЕРЕСЧЁТА БЫТЬ НЕ ДОЛЖНО — ни кнопкой, ни скриптом, ни в
-- админке. Начисление рождается вместе с оплатой и дальше ТОЛЬКО меняет статус
-- выплаты. Любая «кнопка пересчитать» — дыра и нарушение № 16: она способна
-- переписать уже выплаченное и увести деньги другому человеку.

CREATE TABLE IF NOT EXISTS partner_payouts (
    id         SERIAL PRIMARY KEY,
    client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    partner_id INTEGER NOT NULL REFERENCES client_partners(id) ON DELETE CASCADE,
    amount     NUMERIC(12,2) NOT NULL,
    paid_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note       TEXT
);

CREATE INDEX IF NOT EXISTS idx_partner_payouts_partner ON partner_payouts(partner_id);

COMMENT ON TABLE partner_payouts IS
  'Факт выплаты партнёру. ⚠️ Нужна ЗАПИСЬ, а не флаг у начисления: без неё нельзя ответить «когда и сколько я ему заплатил» — а это спрашивают и партнёры, и налоговая.';

CREATE TABLE IF NOT EXISTS partner_accruals (
    id               SERIAL PRIMARY KEY,
    client_id        INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    partner_id       INTEGER NOT NULL REFERENCES client_partners(id) ON DELETE CASCADE,
    level            INTEGER NOT NULL DEFAULT 1,
    source_kind      TEXT NOT NULL,
    source_order_id  INTEGER NOT NULL,
    buyer_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    base_amount      NUMERIC(12,2),
    amount           NUMERIC(12,2) NOT NULL,
    payout_id        INTEGER REFERENCES partner_payouts(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT partner_accruals_source_chk CHECK (source_kind IN ('event', 'product')),
    CONSTRAINT partner_accruals_level_chk  CHECK (level >= 1),
    -- ⚠️ Защита от ДВОЙНОГО НАЧИСЛЕНИЯ по одному заказу. Платёжные системы шлют
    -- оповещение по нескольку раз — это норма, а не сбой. Без этого ограничения
    -- партнёр получил бы двойные деньги за одну продажу.
    CONSTRAINT partner_accruals_unique UNIQUE (source_kind, source_order_id, level)
);

CREATE INDEX IF NOT EXISTS idx_partner_accruals_partner ON partner_accruals(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_accruals_client  ON partner_accruals(client_id);
CREATE INDEX IF NOT EXISTS idx_partner_accruals_unpaid  ON partner_accruals(partner_id)
    WHERE payout_id IS NULL;

COMMENT ON TABLE partner_accruals IS
  'Начисление вознаграждения партнёру. Рождается ТОЛЬКО в момент подтверждения оплаты (№ 27), дальше меняет лишь статус выплаты.';
COMMENT ON COLUMN partner_accruals.source_order_id IS
  'id в event_participant_tariffs (source_kind=event) или product_orders (product). ⚠️ FK на конкретную таблицу НЕ ставим — источника два, а внешний ключ смотрит в одну (тот же приём, что у analytics_cards.ref_id).';
COMMENT ON COLUMN partner_accruals.level IS
  'Уровень: 1 — прямой получатель, 2+ — цепочка вверх по contacts.partner_id. ⚠️ Уровни выше первого бывают только в пассивном режиме (№ 44).';
COMMENT ON COLUMN partner_accruals.payout_id IS
  'NULL = ещё не выплачено. ⚠️ Дважды за одну продажу не платим: начисление с проставленным payout_id в «к выплате» больше не попадает НИКОГДА.';
COMMENT ON COLUMN partner_accruals.base_amount IS
  'Сумма заказа, с которой считали. Хранится, чтобы партнёр видел, откуда взялось вознаграждение, и не пересчитывал его сам.';

-- ⚠️ Нажатие «Выплачено» = INSERT в partner_payouts + UPDATE payout_id У ТЕХ
-- начислений, что существовали НА МОМЕНТ НАЖАТИЯ (№ 42). Не «всё, что было у
-- партнёра»: продажа, пришедшая через минуту после нажатия, иначе окажется
-- помечена выплаченной, хотя денег за неё не давали.

GRANT SELECT, INSERT, UPDATE, DELETE ON partner_accruals, partner_payouts TO plusson;
GRANT USAGE, SELECT ON SEQUENCE partner_accruals_id_seq, partner_payouts_id_seq TO plusson;
