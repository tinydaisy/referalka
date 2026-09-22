-- 485. Кнопка шага догрева: новый вид `gifts` — «Подарки за рекомендации»
--
-- Шаблон догрева зарегистрированных «Подарки за рекомендации» (22.09.2026)
-- ведёт человека на вкладку подарков его кабинета, а не на программу события,
-- как вид `event`. Вкладка называется так, как настроил клиент
-- (`clients.tab_label_game`), и ссылка на неё зависит от площадки и от режима
-- «Mini App или веб» — поэтому это отдельный вид кнопки, а не ссылка руками:
-- вручную вписанный URL был бы одним на все три площадки и увёл бы человека
-- туда, где его нет.
--
-- ⚠️ CHECK переписываем ЦЕЛИКОМ (DROP + ADD): добавить значение в существующий
-- CHECK нельзя, а `IF NOT EXISTS` для констрейнта не бывает. Имена взяты с
-- прода (pg_constraint), поэтому DROP ... IF EXISTS отработает и там, и на
-- пустой базе.
--
-- Идемпотентно: повторный прогон снимает и ставит тот же констрейнт.

ALTER TABLE event_nurture_reg_steps
    DROP CONSTRAINT IF EXISTS event_nurture_reg_steps_button_kind_check;
ALTER TABLE event_nurture_reg_steps
    ADD CONSTRAINT event_nurture_reg_steps_button_kind_check
    CHECK (button_kind IN ('event', 'support', 'gifts'));

-- Незарегистрированным подарки за рекомендации не шлём (им сначала надо
-- зарегистрироваться), но вид держим единым на обеих таблицах: они правятся
-- одним и тем же кодом, и разошедшиеся констрейнты дали бы ошибку вставки
-- ровно в тот момент, когда кто-нибудь скопирует шаг из одной воронки в другую.
ALTER TABLE event_nurture_steps
    DROP CONSTRAINT IF EXISTS event_nurture_steps_button_kind_check;
ALTER TABLE event_nurture_steps
    ADD CONSTRAINT event_nurture_steps_button_kind_check
    CHECK (button_kind IN ('event', 'support', 'gifts'));
