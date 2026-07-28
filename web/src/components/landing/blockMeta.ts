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
  | 'tariffs' | 'gallery' | 'text' | 'support' | 'footer'

export interface BlockMeta {
  kind: BlockKind
  label: string
  hint: string
  live?: boolean
  repeatable?: boolean
  /** Какие поля показывать в редакторе блока. */
  fields: Array<'title' | 'subtitle' | 'body' | 'button' | 'list' | 'numbers' | 'seats' | 'gallery'>
}

export const BLOCK_META: Record<BlockKind, BlockMeta> = {
  hero: {
    kind: 'hero',
    label: 'Шапка',
    hint: 'Название, подзаголовок и даты берутся из события. Здесь — только подпись кнопки.',
    live: true,
    fields: ['subtitle', 'button'],
  },
  seats: {
    kind: 'seats',
    label: 'Осталось мест',
    hint: 'Занятые места считаются сами по числу зарегистрированных.',
    live: true,
    fields: ['title', 'body', 'seats'],
  },
  gifts: {
    kind: 'gifts',
    label: 'Подарки за регистрацию',
    hint: 'Берутся из реф-программы события.',
    live: true,
    fields: ['title', 'body'],
  },
  audience: {
    kind: 'audience',
    label: 'Для кого',
    hint: 'Кому подойдёт событие: «это для вас, если…». Список пунктов.',
    fields: ['title', 'subtitle', 'list'],
  },
  benefits: {
    kind: 'benefits',
    label: 'Что вы получите',
    hint: 'Список пунктов — что человек получит на событии.',
    fields: ['title', 'subtitle', 'list'],
  },
  values: {
    kind: 'values',
    label: 'Наши ценности',
    hint: 'Заголовок и текст.',
    fields: ['title', 'body'],
  },
  mission: {
    kind: 'mission',
    label: 'Наша миссия',
    hint: 'Заголовок и текст.',
    fields: ['title', 'body'],
  },
  numbers: {
    kind: 'numbers',
    label: 'Цифры',
    hint: 'От 2 до 4 цифр с подписями — как регалии основателя.',
    fields: ['title', 'numbers'],
  },
  difference: {
    kind: 'difference',
    label: 'Чем отличаемся',
    hint: 'Чем это событие отличается от других.',
    fields: ['title', 'body'],
  },
  speakers: {
    kind: 'speakers',
    label: 'Спикеры',
    hint: 'Подтягиваются из события. Поправили карточку спикера — на лендинге обновилось.',
    live: true,
    fields: ['title', 'subtitle'],
  },
  organizer: {
    kind: 'organizer',
    label: 'Организатор',
    hint: 'Бренд и основатель — из вашей визитки в настройках Mini App.',
    live: true,
    fields: ['title'],
  },
  program: {
    kind: 'program',
    label: 'Программа',
    hint: 'Дни и выступления — из программы события. Сдвинули тайминг — обновилось.',
    live: true,
    fields: ['title', 'subtitle'],
  },
  tariffs: {
    kind: 'tariffs',
    label: 'Тарифы',
    hint: 'Из раздела «Тарифы» события, с кнопками оплаты.',
    live: true,
    fields: ['title', 'subtitle'],
  },
  gallery: {
    kind: 'gallery',
    label: 'Галерея / Отзывы',
    hint: 'Карусель или сетка. Картинки (скриншоты отзывов, фото) или видео по ссылке.',
    repeatable: true,
    fields: ['title', 'subtitle', 'gallery'],
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
    hint: 'Кнопки связи — из полей «Служба поддержки» в Настройках.',
    live: true,
    fields: ['title', 'body'],
  },
  footer: {
    kind: 'footer',
    label: 'Подвал',
    hint: 'Реквизиты, политика и оферта — из Настроек и карточки события.',
    live: true,
    fields: ['body'],
  },
}

/** Блоки, которые можно добавить кнопкой «Добавить секцию». */
export const ADDABLE: BlockKind[] = ['text', 'gallery']

export function metaFor(kind: string): BlockMeta {
  return BLOCK_META[kind as BlockKind] || {
    kind: kind as BlockKind,
    label: kind,
    hint: '',
    fields: ['title', 'body'],
  }
}
