-- Галочка «не усреднять» для пакета турнирных критериев.
-- aggregate = 'avg' (по умолчанию, как было — взвешенное среднее критериев)
--           | 'sum' (складывать взвешенные баллы критериев, без деления на сумму весов)
ALTER TABLE tournament_packages
    ADD COLUMN IF NOT EXISTS aggregate TEXT NOT NULL DEFAULT 'avg'
    CHECK (aggregate IN ('avg', 'sum'));
