-- Переименование шаблона «за 30 мин» → «за 2 часа» и смещение очереди на 120 минут
-- Типы шаблонов остаются прежними (day_start_30min_unreg/reg) для обратной совместимости с расписаниями

UPDATE broadcast_templates
SET name = 'День конференции — за 2 часа (не зарегистрирован)',
    text = replace(
        replace(text, 'Через 30 минут', 'Через 2 часа'),
        'Уже через 30 минут', 'Уже через 2 часа'
    ),
    offset_minutes = 120
WHERE type = 'day_start_30min_unreg';

UPDATE broadcast_templates
SET name = 'День конференции — за 2 часа (зарегистрирован)',
    text = replace(
        replace(text, 'Через 30 минут', 'Через 2 часа'),
        'Уже через 30 минут', 'Уже через 2 часа'
    ),
    offset_minutes = 120
WHERE type = 'day_start_30min_reg';
