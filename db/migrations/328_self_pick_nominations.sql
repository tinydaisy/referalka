-- 328: спикер/жюри сам выбирает номинации в кабинете + лимит на человека
--
-- ЗАЧЕМ. У премии номинаций бывает много, и участие в них покупают штучно:
-- кто-то берёт одну, кто-то три. Раньше номинации проставлял только
-- организатор руками на карточке каждого — при полусотне номинантов это
-- ручная работа на день, и она всё равно отстаёт от оплат.
--
-- Теперь человек отмечает свои номинации сам в кабинете, а сколько ему
-- доступно — считается из его тарифа.
--
-- ⚠️ Премия и чемпионат — ОДНО И ТО ЖЕ событие (module_slug='turnir'),
-- отличаются только словом (events.person_wording='nominee'). Поэтому
-- настройки живут у всех турниров: не заполнил — не работает.
--
-- ИТОГОВЫЙ ЛИМИТ ЧЕЛОВЕКА = минимум из заполненных:
--   • event_collaborators.nominations_limit  — его личное число
--   • conf_conferences.max_nominations_*     — потолок его роли на событии
--   • сколько всего номинаций у события      — всегда, защита от дурака
-- Ничего не заполнено → ограничения нет.

-- Кто вообще может выбирать сам. Две галочки, а не одна: жюри и номинанты
-- живут по разным правилам — номинант покупает участие, жюри приглашают.
ALTER TABLE conf_conferences
  ADD COLUMN IF NOT EXISTS self_pick_stages_speakers BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS self_pick_stages_jury     BOOLEAN NOT NULL DEFAULT FALSE;

-- Потолок на событие, отдельно по ролям. NULL = без ограничений.
ALTER TABLE conf_conferences
  ADD COLUMN IF NOT EXISTS max_nominations_speakers INT,
  ADD COLUMN IF NOT EXISTS max_nominations_jury     INT;

-- Личный лимит человека В ЭТОМ событии. Не поле контакта: у одного человека
-- в премии 2026 может быть 3 номинации, а в премии 2027 — одна, и оба числа
-- должны жить одновременно, ничего не затирая.
ALTER TABLE event_collaborators
  ADD COLUMN IF NOT EXISTS nominations_limit INT;

-- Сколько номинаций даёт тариф. Заполняется в форме тарифа события.
ALTER TABLE event_tariffs
  ADD COLUMN IF NOT EXISTS nominations_grant INT;

COMMENT ON COLUMN conf_conferences.self_pick_stages_speakers IS
  'Номинант/спикер сам отмечает свои номинации в кабинете.';
COMMENT ON COLUMN conf_conferences.self_pick_stages_jury IS
  'Жюри само отмечает номинации, которые судит.';
COMMENT ON COLUMN conf_conferences.max_nominations_speakers IS
  'Потолок номинаций на одного номинанта. NULL — без ограничений.';
COMMENT ON COLUMN conf_conferences.max_nominations_jury IS
  'Потолок номинаций на одного члена жюри. NULL — без ограничений.';
COMMENT ON COLUMN event_collaborators.nominations_limit IS
  'Сколько номинаций доступно человеку в ЭТОМ событии. Пишется при оплате '
  'тарифа (перезатирая прошлое значение) и подтягивается за отметками '
  'организатора. NULL — без ограничений.';
COMMENT ON COLUMN event_tariffs.nominations_grant IS
  'Сколько номинаций даёт этот тариф. При оплате пишется в '
  'event_collaborators.nominations_limit покупателя.';
