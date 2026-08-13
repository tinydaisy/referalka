/**
 * Справочник блоков конструктора лендинга — ОДНА точка истины для UI.
 *
 * `live: true` — блок сам тянет данные события (спикеры, программа, тарифы...).
 * У такого блока руками правится только заголовок и оформление; содержимое
 * приходит из базы и обновляется само, когда клиент правит спикера или программу.
 *
 * `repeatable: true` — блок можно добавить на страницу несколько раз
 * (произвольная секция и галерея/отзывы).
 */

export type BlockKind =
  | 'hero' | 'seats' | 'gifts' | 'audience' | 'benefits' | 'values' | 'mission'
  | 'numbers' | 'difference' | 'speakers' | 'organizer' | 'program'
  | 'tariffs' | 'gallery' | 'text' | 'support' | 'footer' | 'partners'
  | 'product_content'
  | 'el_button' | 'el_heading' | 'el_text' | 'el_image'

export interface BlockMeta {
  kind: BlockKind
  label: string
  hint: string
  live?: boolean
  repeatable?: boolean
  /** Какие поля показывать в редакторе блока. */
  fields: Array<'title' | 'subtitle' | 'body' | 'button' | 'list' | 'cards' | 'audience_cards' | 'numbers' | 'seats' | 'gallery'>
}

export const BLOCK_META: Record<BlockKind, BlockMeta> = {
  hero: {
    kind: 'hero',
    label: 'Шапка',
    hint: 'Название, описание и даты берутся из настроек события. Здесь — только подпись кнопки.',
    live: true,
    fields: ['button'],
  },
  seats: {
    kind: 'seats',
    label: 'Осталось мест',
    hint: 'Занятые места считаются сами по числу зарегистрированных. Заголовок — подпись над цифрой.',
    live: true,
    fields: ['title', 'body', 'seats', 'button'],
  },
  gifts: {
    kind: 'gifts',
    label: 'Подарки за регистрацию',
    hint: 'Берутся из реф-программы события.',
    live: true,
    fields: ['title', 'body', 'button'],
  },
  audience: {
    kind: 'audience',
    label: 'Для кого',
    hint: 'Кому подойдёт событие. У каждой карточки — название, описание и картинка.',
    fields: ['title', 'subtitle', 'audience_cards', 'button'],
  },
  benefits: {
    kind: 'benefits',
    label: 'Что вы получите',
    // ⚠️ cards, а не list: у пункта своё НАЗВАНИЕ и описание — двумя полями.
    // Одним полем название и описание приходилось разделять переносом строки
    // прямо в тексте: в кабинете это выглядело как одна каша, и было неясно,
    // что первая строка станет заголовком.
    hint: 'Пункты: у каждого своё название и описание под ним.',
    fields: ['title', 'subtitle', 'cards', 'button'],
  },
  values: {
    kind: 'values',
    label: 'Наши ценности',
    hint: 'Карточки: у каждой ценности своё название и короткое описание.',
    fields: ['title', 'subtitle', 'cards', 'button'],
  },
  mission: {
    kind: 'mission',
    label: 'Наша миссия',
    hint: 'Заголовок и текст.',
    fields: ['title', 'body', 'button'],
  },
  numbers: {
    kind: 'numbers',
    label: 'Цифры',
    hint: 'От 2 до 4 цифр с подписями — как регалии основателя.',
    fields: ['title', 'numbers', 'button'],
  },
  difference: {
    kind: 'difference',
    label: 'Чем отличаемся',
    hint: 'Карточки: у каждой особенности своё название и короткое описание.',
    fields: ['title', 'subtitle', 'cards', 'button'],
  },
  speakers: {
    kind: 'speakers',
    label: 'Спикеры',
    hint: 'Подтягиваются из события. Поправили карточку спикера — на лендинге обновилось.',
    live: true,
    // button — подпись кнопки, раскрывающей регалии («Подробнее о спикерах»).
    fields: ['title', 'subtitle', 'button'],
  },
  partners: {
    kind: 'partners',
    label: 'Партнёры',
    hint: 'Карточки партнёров события — из раздела «Люди», роли «Партнёр» и «Генеральный партнёр». Пока партнёров нет, секция на лендинге не показывается.',
    live: true,
    // Добавляется вручную — значит, должна и удаляться (крестик у секции).
    repeatable: true,
    fields: ['title', 'subtitle', 'button'],
  },
  organizer: {
    kind: 'organizer',
    label: 'Организатор',
    hint: 'Бренд и основатель — из вашей визитки в настройках Mini App.',
    live: true,
    fields: ['title', 'button'],
  },
  program: {
    kind: 'program',
    label: 'Программа',
    hint: 'Дни и выступления — из программы события. Сдвинули тайминг — обновилось.',
    live: true,
    fields: ['title', 'subtitle', 'button'],
  },
  product_content: {
    kind: 'product_content',
    label: 'Что входит',
    hint: 'Состав продукта берётся из вкладки «Состав» — здесь только заголовок и оформление. Ссылки на материалы на странице НЕ показываются.',
    live: true,
    fields: ['title', 'subtitle'],
  },
  tariffs: {
    kind: 'tariffs',
    label: 'Тарифы',
    hint: 'Из раздела «Тарифы» события, с кнопками оплаты.',
    live: true,
    fields: ['title', 'subtitle', 'button'],
  },
  gallery: {
    kind: 'gallery',
    label: 'Галерея / Отзывы',
    hint: 'Карусель или сетка. Картинки (скриншоты отзывов, фото) или видео по ссылке.',
    repeatable: true,
    fields: ['title', 'subtitle', 'gallery', 'button'],
  },
  // ── Отдельные элементы: собрать секцию по кусочкам ──────────────────
  el_heading: {
    kind: 'el_heading',
    label: 'Элемент: заголовок',
    hint: 'Только заголовок. Размер, цвет и выравнивание — во вкладке «Оформление».',
    repeatable: true,
    fields: ['title'],
  },
  el_text: {
    kind: 'el_text',
    label: 'Элемент: текст',
    hint: 'Только текст, без заголовка.',
    repeatable: true,
    fields: ['body'],
  },
  el_button: {
    kind: 'el_button',
    label: 'Элемент: кнопка',
    hint: 'Только кнопка. Можно вести на регистрацию, на секцию страницы (тарифы) или на свою ссылку.',
    repeatable: true,
    fields: ['button'],
  },
  el_image: {
    kind: 'el_image',
    label: 'Элемент: изображение',
    hint: 'Только картинка. Ширина и положение — во вкладке «Оформление».',
    repeatable: true,
    fields: [],
  },

  text: {
    kind: 'text',
    label: 'Своя секция',
    hint: 'Заголовок и любое содержимое.',
    repeatable: true,
    fields: ['title', 'subtitle', 'body', 'button'],
  },
  support: {
    kind: 'support',
    label: 'Есть вопросы?',
    hint: 'Кнопки обратной связи — из полей «Служба поддержки» в Настройках. Их цвет — «Оформление страницы» → «Цвет иконок и кнопок обратной связи».',
    live: true,
    fields: ['title', 'body', 'button'],
  },
  footer: {
    kind: 'footer',
    label: 'Подвал',
    hint: 'Реквизиты, политика и оферта — из Настроек и карточки события.',
    live: true,
    fields: ['body'],
  },
}

/** Блоки, которых может быть НЕСКОЛЬКО на странице — их добавляем всегда. */
// Блок продукта (миграция 293): состав — разделы и материалы. Показывается
// только у продуктов; в наборах события его нет.
export const PRODUCT_STANDARD: BlockKind[] = [
  'hero', 'audience', 'benefits', 'values', 'numbers', 'difference',
  'product_content', 'organizer', 'mission', 'tariffs', 'support', 'footer',
]

export const REPEATABLE: BlockKind[] = [
  'text', 'gallery', 'el_heading', 'el_text', 'el_button', 'el_image',
]

/** Стандартные секции — по одной на страницу.
 *  ⚠️ Раз удалить можно любую секцию, её надо и уметь вернуть: кнопка
 *  добавления показывает те из них, которых на странице сейчас нет. */
export const STANDARD: BlockKind[] = [
  'hero', 'seats', 'gifts', 'audience', 'benefits', 'values', 'mission',
  'numbers', 'difference', 'speakers', 'organizer', 'program', 'tariffs',
  'partners', 'support', 'footer',
]

export function metaFor(kind: string): BlockMeta {
  return BLOCK_META[kind as BlockKind] || {
    kind: kind as BlockKind,
    label: kind,
    hint: '',
    fields: ['title', 'body'],
  }
}

/**
 * Какие секции лендинга требуют платной возможности.
 *
 * ⚠️ Гейт ТОЛЬКО по фиче (slug), никогда по тарифу: состав тарифов меняется
 * данными, а фича — стабильный признак. Названия и цены здесь не хардкодим,
 * подпись собирается из справочника фич, который отдаёт бэк.
 *
 * `anyOf` — секция работает, если у клиента есть ХОТЯ БЫ ОДНА из фич.
 * Куда вести за покупкой, решает сам FeatureLock: модуль → к модулям,
 * тарифная возможность → к смене тарифа.
 */
export const BLOCK_FEATURE: Partial<Record<BlockKind, { anyOf: string[] }>> = {
  // Спикеры и программа приходят из модулей, где эти сущности вообще есть:
  // конференции, премии/турниры и коллаборации. Хватает ЛЮБОГО из них.
  speakers: { anyOf: ['conference', 'tournaments', 'collab_hub'] },
  program:  { anyOf: ['conference', 'tournaments', 'collab_hub'] },
  // ⚠️ Партнёры — ТОЛЬКО модуль «Конференции». У коллаборации партнёров нет:
  // там участники равноправные организаторы, а не спонсоры события.
  partners: { anyOf: ['conference'] },
  // Платные тарифы мероприятия — возможность старшего тарифа.
  tariffs:  { anyOf: ['event_tariffs'] },
}
