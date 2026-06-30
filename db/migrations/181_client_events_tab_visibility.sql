-- 181: видимость вкладки «События» (Календарь) в хабе клиента (Mini App + веб).
-- always — всегда; active — только если есть текущие/предстоящие; any — если есть любые.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS events_tab_visibility TEXT NOT NULL DEFAULT 'always';

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_events_tab_visibility_chk;
ALTER TABLE clients
  ADD CONSTRAINT clients_events_tab_visibility_chk
  CHECK (events_tab_visibility IN ('always', 'active', 'any'));
