-- 425. Убрать «настройки мимо кассы» из ставок.
--
-- ⚠️ ПОЧЕМУ ЭТОГО НЕ ДОЛЖНО БЫТЬ В СИСТЕМЕ. Ставка `setup_direct` (100 %)
-- означала «клиент заплатил внедренцу напрямую». Через платформу эти деньги не
-- проходят: начислять нечего, считать не из чего, выплачивать не нужно. Строка
-- в настройках создавала ложное впечатление, что платформа этим управляет.
--
-- ⚠️ Договорённость «мимо кассы оставляете себе всё» остаётся В ТАБЛИЦЕ как
-- условие сотрудничества — но это разговор внедренца с клиентом, а не расчёт
-- платформы.

DELETE FROM tech_rates WHERE kind = 'setup_direct';

-- ⚠️ Начисления с этим видом (если кто-то успел завести вручную) не трогаем:
-- это история уже выплаченного. Поэтому вид остаётся в CHECK у `tech_accruals`
-- и убирается только из `tech_rates`, откуда берутся ставки для новых.
ALTER TABLE tech_rates DROP CONSTRAINT IF EXISTS tech_rates_kind_check;
ALTER TABLE tech_rates ADD CONSTRAINT tech_rates_kind_check
    CHECK (kind IN ('activation', 'retention', 'revival', 'fix',
                    'referral', 'referral2', 'referral3',
                    'setup_pluson', 'setup_own',
                    'ticket_simple', 'ticket_hard'));
