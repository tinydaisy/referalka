-- 319: Акцепт партнёрской оферты + налоговый статус партнёра
--
-- Зачем. Партнёрское вознаграждение можно выплачивать только ИП, юрлицу или
-- самозанятому: при выплате обычному физлицу Оферент становится налоговым
-- агентом (ст. 226 НК) и обязан удержать НДФЛ и заплатить взносы, а ИП на
-- НПД налоговым агентом быть не может. Так же устроено у Salebot (их п. 2.1.2)
-- и GetCourse («выплаты на счёт ИП, ООО или самозанятого»).
--
-- ⚠️ Сейчас заявку на вывод (referrals.py) может подать ЛЮБОЙ клиент с
-- балансом ≥ минимума и активной подпиской — статус не проверяется. Эти
-- колонки закрывают дыру: без подтверждённого статуса выплата невозможна.
--
-- ⚠️ Акцепт партнёрской оферты — ОТДЕЛЬНОЕ действие, а не часть регистрации.
-- В основной оферте акцепт — оплата и регистрация (клиент платит нам), а в
-- партнёрской платим МЫ ему: оплаты с его стороны нет, акцептовать нечем.
-- Поэтому акцептом служит нажатие кнопки «Стать партнёром» — конклюдентное
-- действие по п. 3 ст. 438 ГК. Фиксируем момент, редакцию и IP, как у
-- акцепта основной оферты (миграция 315).
ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS partner_offer_accepted_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS partner_offer_accepted_version TEXT,
    ADD COLUMN IF NOT EXISTS partner_offer_accepted_ip      TEXT,
    ADD COLUMN IF NOT EXISTS partner_tax_status             TEXT;

-- ⚠️ CHECK допускает NULL: у клиента, не вступавшего в партнёрскую программу,
-- статуса нет, и это нормальное состояние, а не ошибка.
ALTER TABLE clients
    DROP CONSTRAINT IF EXISTS clients_partner_tax_status_check;
ALTER TABLE clients
    ADD CONSTRAINT clients_partner_tax_status_check
    CHECK (partner_tax_status IS NULL
           OR partner_tax_status IN ('ip', 'company', 'self_employed'));

COMMENT ON COLUMN clients.partner_offer_accepted_at IS
  'Момент акцепта Оферты об участии в партнёрской программе (нажатие «Стать партнёром»). NULL = в программе не участвует.';
COMMENT ON COLUMN clients.partner_offer_accepted_version IS
  'Редакция партнёрской оферты на момент акцепта (YYYY-MM-DD).';
COMMENT ON COLUMN clients.partner_tax_status IS
  'Заявленный налоговый статус партнёра: ip (ИП) | company (юрлицо) | self_employed (самозанятый). Обычным физлицам вознаграждение не выплачивается — Оферент не может быть налоговым агентом.';
