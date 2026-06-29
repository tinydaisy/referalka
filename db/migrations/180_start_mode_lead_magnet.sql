-- 180: режим /start = «лид-магнит» (открыть воронку лид-магнита по команде /start)
-- Добавляет к настройке «Что открывать при /start» третий вариант: запустить
-- воронку конкретного лид-магнита или пакета. start_mode получает значение
-- 'lead_magnet'; ссылку на сущность хранят новые поля.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS start_lead_magnet_id INTEGER
    REFERENCES lead_magnets(id) ON DELETE SET NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS start_package_id INTEGER
    REFERENCES lead_magnet_packages(id) ON DELETE SET NULL;
