-- 389. Подписи на обложке: имя, бренд и где их ставить.
--
-- Раньше была одна галочка `show_brand` — либо бренд под названием, либо ничего.
-- Но подписи две и они разные: «Марго Форбс» (кто) и «ВИДЕНИЕ / iViSiON» (что за
-- проект). Клиент вправе показать любую из них, обе или ни одной — и поставить
-- их над названием или под ним.
--
-- ⚠️ ДВЕ ОТДЕЛЬНЫЕ ГАЛОЧКИ, а не список «имя / бренд / оба». Список пришлось бы
-- разбирать при каждом показе, а галочки читаются как есть и позволяют показать
-- обе строки без союза «и» — именно так, как просил владелец.
--
-- ⚠️ Положение ОДНО на обе строки: имя над названием, а бренд под ним — это
-- рассыпает композицию, и просили не этого. Строки идут вместе.
--
-- ⚠️ Старая `show_brand` НЕ удаляется: на неё ссылается уже работающий шаблон.
-- Её значение переносится в `show_brand_name`, дальше поле не используется —
-- дропнуть можно, когда все шаблоны перезапишутся.

ALTER TABLE cover_templates
    -- Имя человека (clients.name + last_name).
    ADD COLUMN IF NOT EXISTS show_owner_name BOOLEAN NOT NULL DEFAULT FALSE,
    -- Название бренда (clients.brand_name).
    ADD COLUMN IF NOT EXISTS show_brand_name BOOLEAN NOT NULL DEFAULT TRUE,
    -- Где обе строки: над названием, под ним или нигде.
    ADD COLUMN IF NOT EXISTS brand_position TEXT NOT NULL DEFAULT 'below'
        CHECK (brand_position IN ('above', 'below', 'none'));

-- Перенос старой настройки: у кого бренд был выключен — остаётся выключенным.
UPDATE cover_templates
   SET show_brand_name = show_brand
 WHERE show_brand IS NOT NULL;

COMMENT ON COLUMN cover_templates.show_owner_name IS
    'Показывать имя человека (clients.name + last_name).';
COMMENT ON COLUMN cover_templates.show_brand_name IS
    'Показывать название бренда (clients.brand_name).';
COMMENT ON COLUMN cover_templates.brand_position IS
    'Где подписи: above — над названием, below — под ним, none — не показывать.';
