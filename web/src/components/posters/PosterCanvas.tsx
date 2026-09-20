'use client'

/**
 * Полотно афиши события.
 *
 * ⚠️⚠️ ОДИН КОМПОНЕНТ НА ПРЕДПРОСМОТР И НА ФАЙЛ — ровно как у обложек
 * (`covers/CoverCanvas.tsx`). Картинку снимает headless-браузер с ЭТОЙ ЖЕ
 * вёрстки, поэтому «в предпросмотре одно, в скачанном другое» не бывает по
 * построению. Отдельного рисовальщика (canvas, Pillow) заводить нельзя: он
 * разойдётся с предпросмотром на переносах длинных фамилий и на кегле — а
 * фамилий на афише два десятка.
 *
 * ⚠️ ВСЁ В ПРОЦЕНТАХ, а не в пикселях. На экране редактора полотно уменьшено,
 * в снимке — настоящего размера; в пикселях раскладка поехала бы.
 *
 * ⚠️⚠️ ПРОЦЕНТЫ СЧИТАЮТСЯ ОТ РАБОЧЕЙ ОБЛАСТИ, А НЕ ОТ ЛИСТА (миграция 440).
 * Рабочая область — это лист минус поля, заданные клиентом в миллиметрах с
 * четырёх сторон. Всё содержимое афиши лежит внутри неё, поэтому за поля не
 * выходит НИЧЕГО: ни спикеры, ни их подписи, ни логотипы, ни заголовок. До
 * этого от края отступал только блок спикеров, и то лишь по бокам — логотип с
 * координатой 0 % упирался прямо в край, а подпись нижнего ряда ложилась на
 * самый обрез. Снаружи области остаются ровно две вещи — фон и его
 * затемнение: они рисуются до края листа.
 */

import { brandFontCss, metallicTextStyle } from '@/lib/brandStyle'
import MaskedPhoto from '@/components/MaskedPhoto'
import { type CropShape } from '@/lib/photoCrop'
import {
  applyManualOrder, applyManualRows, splitRows, splitIntoRows, personLines,
  BADGE_LABELS, ORGANIZER_ROLES, type PosterPerson,
} from '@/lib/posterLayout'

export type PosterOrientation = 'horizontal' | 'vertical' | 'square'

/** День события со списком его спикеров (бэкенд отдаёт без дублей). */
export type PosterDay = {
  day: number
  date?: string | null
  start_time?: string | null
  /** Готовая подпись: «День 1 — 24.09 в 11:00». */
  label: string
  speaker_ids: number[]
}

/** Настоящий размер полотна. Снимок делается ровно в этих пикселях. */
export const POSTER_SIZE: Record<PosterOrientation, { w: number; h: number }> = {
  horizontal: { w: 1920, h: 1080 },
  vertical:   { w: 1080, h: 1920 },
  square:     { w: 1440, h: 1440 },
}

export type PosterLayout = {
  orientation: PosterOrientation
  bg_url?: string | null
  bg_dim?: number
  /** Поля от края В МИЛЛИМЕТРАХ (миграция 440). За них не выходит ничего. */
  margin_top?: number
  margin_bottom?: number
  margin_left?: number
  margin_right?: number
  speakers_top?: number
  speakers_bottom?: number
  /** @deprecated Миграция 440: боковое поле задаётся margin_left/right в мм. */
  speakers_side?: number
  /** Раскладка (миграция 454): full — текст сверху; left/right — колонками. */
  layout_mode?: 'full' | 'left' | 'right'
  speakers_width?: number
  /** Свободное размещение блоков (миграция 455) — интерфейс к ним будет позже. */
  logos_x?: number
  logos_w?: number
  logos_dir?: 'row' | 'column' | 'grid'
  text_x?: number
  text_w?: number
  speakers_x?: number
  text_align?: 'left' | 'center' | 'right'
  mask_shape?: 'portrait' | 'square' | 'circle' | 'oval' | 'egg' | 'cutout'
  mask_radius?: number
  per_row?: number | null
  gap?: number
  /** Промежуток между РЯДАМИ (миграция 453). Пусто — как по горизонтали. */
  gap_y?: number | null
  row_overlap?: number
  show_names?: boolean
  name_order?: 'first_last' | 'last_first'
  name_lines?: 1 | 2
  name_font?: string | null
  name_size?: number
  name_color?: string | null
  name_shadow?: boolean
  name_place?: 'below' | 'over'
  hl_style?: 'none' | 'border' | 'glow' | 'both'
  hl_color?: string | null
  hl_border_w?: number
  hl_glow?: number
  role_badge?: 'none' | 'pill' | 'ribbon' | 'suffix'
  role_badge_color?: string | null
  role_badge_text_color?: string | null
  title?: string | null
  /** Вторая часть заголовка — своим цветом (миграция 447). */
  title_2?: string | null
  title_2_color?: string | null
  title_2_newline?: boolean
  subtitle?: string | null
  /** Вторая часть подзаголовка — своим цветом (миграция 458). */
  subtitle_2?: string | null
  subtitle_2_color?: string | null
  subtitle_2_newline?: boolean
  show_title?: boolean
  show_subtitle?: boolean
  title_font?: string | null
  title_size?: number
  title_color?: string | null
  title_metallic?: boolean
  title_underline?: 'none' | 'line' | 'gradient'
  title_align?: 'left' | 'center' | 'right'
  subtitle_font?: string | null
  subtitle_size?: number
  subtitle_color?: string | null
  subtitle_metallic?: boolean
  subtitle_underline?: 'none' | 'line' | 'gradient'
  subtitle_align?: 'left' | 'center' | 'right'
  text_top?: number
  /** Отступы между текстовыми блоками, px полотна (миграция 458). */
  gap_pill_title?: number
  gap_title_subtitle?: number
  show_pill?: boolean
  pill_text?: string | null
  pill_text_2?: string | null
  pill_style?: 'border' | 'filled' | 'underline' | 'plain'
  pill_radius?: number
  pill_border_color?: string | null
  pill_border_color_2?: string | null
  pill_border_w?: number
  pill_bg_color?: string | null
  pill_text_color?: string | null
  pill_font?: string | null
  pill_size?: number
  show_brand_logo?: boolean
  brand_logo_variant?: 'light' | 'dark'
  brand_logo_x?: number
  brand_logo_y?: number
  brand_logo_size?: number
  show_partners?: boolean
  partners_y?: number
  partners_size?: number
  speaker_order?: number[]
  /** Вид макета (миграция 459): общая афиша, афиша дня, афиша спикера. */
  kind?: 'common' | 'day' | 'individual'
  /** Настройки индивидуальной афиши (миграция 459). */
  ind_show_role?: boolean
  ind_show_topic?: boolean
  ind_show_time?: boolean
  ind_show_event_title?: boolean
  ind_photo_size?: number
  ind_photo_x?: number
  ind_photo_y?: number
  ind_name_size?: number
  ind_role_size?: number
  ind_topic_size?: number
  /** Свои шрифты, размер и цвет темы/времени/имени/роли (миграция 473). */
  ind_topic_font?: string | null
  ind_time_font?: string | null
  ind_time_size?: number
  ind_time_color?: string | null
  ind_name_font?: string | null
  ind_role_font?: string | null
  ind_title_size?: number
  ind_title_color?: string | null
  ind_title_font?: string | null
  ind_title_align?: 'left' | 'center' | 'right'
  ind_role_align?: 'left' | 'center' | 'right'
  ind_role_color?: string | null
  ind_topic_color?: string | null
  /** Ряды спикеров (миграция 445): сколько положили в ряд — столько и будет. */
  speaker_rows?: number[][]
  /** Ряды ОТДЕЛЬНО по дням (миграция 466): ключ — номер дня строкой. */
  day_speaker_rows?: Record<string, number[][]>
  /** Потолок ширины карточки, % колонки спикеров (миграция 468). */
  card_max_w?: number
  /** Афиши этого вида показаны в кабинете спикера (миграция 469). */
  published_to_cabinet?: boolean
  /** ⚠️ Своя точка каждого элемента афиши спикера (миграция 470), % рабочей
   *  области. NULL — элемент стоит в общей колонке, как раньше. */
  ind_title_x?: number | null; ind_title_y?: number | null
  ind_role_x?: number | null; ind_role_y?: number | null
  ind_name_x?: number | null; ind_name_y?: number | null
  ind_topic_x?: number | null; ind_topic_y?: number | null
  ind_time_x?: number | null; ind_time_y?: number | null
  ind_topic_w?: number | null; ind_name_w?: number | null
  /** ⚠️ Положение блоков в ПИКСЕЛЯХ рабочей области (миграция 468).
   *  null/undefined — «как раньше», по прежним настройкам блока. */
  pos_logos_x?: number | null; pos_logos_y?: number | null
  pos_text_x?: number | null; pos_text_y?: number | null
  pos_pill1_x?: number | null; pos_pill1_y?: number | null
  pos_pill2_x?: number | null; pos_pill2_y?: number | null
  pos_speakers_x?: number | null; pos_speakers_y?: number | null
  pos_photo_x?: number | null; pos_photo_y?: number | null
  pos_topic_x?: number | null; pos_topic_y?: number | null
  pos_time_x?: number | null; pos_time_y?: number | null
  pill1_align?: 'left' | 'center' | 'right'
  pill2_align?: 'left' | 'center' | 'right'
  /** Добавленные клиентом пилюли (миграция 471). x/y пустые — в общем ряду. */
  extra_pills?: { text: string; x?: number | null; y?: number | null; align?: 'left' | 'center' | 'right' }[]
  topic_align?: 'left' | 'center' | 'right'
  time_align?: 'left' | 'center' | 'right'
  name_align?: 'left' | 'center' | 'right'
  /** На афише спикера: фото сверху (TRUE) или текст сверху (FALSE, как в ТЗ). */
  ind_photo_first?: boolean
  /** Порядок логотипов партнёров (миграция 445). */
  partner_order?: number[]
  /** Общая строка логотипов (миграция 446). */
  logos_align?: 'left' | 'center' | 'right'
  logos_gap?: number
  logos_variant?: 'light' | 'dark'
  /** Скрытые поштучно: id партнёров и 'brand'. */
  logos_hidden?: (number | string)[]
  logos_order?: (number | string)[]
}

export type PosterTheme = {
  fonts?: { key: string; label: string }[]
  lp_bg_color?: string
  lp_bg_color_2?: string
  lp_bg_angle?: number
  lp_bg_gradient?: boolean
  lp_font_heading?: string
  lp_font_body?: string
  lp_color_heading?: string
  lp_color_body?: string
  brand_logo_url?: string | null
  brand_logo_light_url?: string | null
}

/** Золото бренда — запасной цвет выделения и заголовка. */
const GOLD = '#FFCFA4'

/** Выключка текста → justify-content. ⚠️ Одна точка перевода: иначе в разных
 *  местах «right» once превращается в flex-end, once в end, и блоки ведут себя
 *  по-разному при одной и той же настройке. */
/** Задана ли своя точка. ⚠️ null — законное «стоит в общем потоке». */
function isFreePt(x?: number | null, y?: number | null): boolean {
  return (typeof x === 'number' && Number.isFinite(x))
      || (typeof y === 'number' && Number.isFinite(y))
}

function alignToFlex(a?: 'left' | 'center' | 'right'): string {
  return a === 'left' ? 'flex-start' : a === 'right' ? 'flex-end' : 'center'
}

export default function PosterCanvas({
  layout: L, theme: th, people, scale = 1, showMargins = false, suggested,
  days, sessions, day, speakerId,
}: {
  layout: PosterLayout
  theme: PosterTheme
  /** Чем заполнить ПУСТЫЕ поля: название события, подзаголовок лендинга, дата.
   *  ⚠️ Подставляется только в пустое — вписал клиент своё, остаётся его. */
  suggested?: { title?: string; subtitle?: string; pill_text?: string; pill_text_2?: string }
  /** Дни события со своими спикерами — для афиш по дням. */
  days?: PosterDay[]
  /** Тема и время выступления по id спикера — для индивидуальных афиш. */
  sessions?: Record<string, { topic?: string; when?: string; day?: number }>
  /** Какой ДЕНЬ рисуем (вид `day`). Пусто — берётся первый. */
  day?: number | null
  /** Какого СПИКЕРА рисуем (вид `individual`). */
  speakerId?: number | null
  /** Все люди события: организаторы, спикеры, партнёры. */
  people: PosterPerson[]
  /** Во сколько раз уменьшить на экране. В снимке всегда 1. */
  scale?: number
  /** ⚠️ Пунктир границы полей — ТОЛЬКО экран редактора. В снимок не попадает:
   *  страница отрисовки его не включает, и в макете он не хранится. Иначе
   *  клиент однажды получил бы готовый файл с пунктиром поверх афиши. */
  showMargins?: boolean
}) {
  const size = POSTER_SIZE[L.orientation] || POSTER_SIZE.vertical
  const { w: W, h: H } = size

  const label = (k?: string | null) => th.fonts?.find(f => f.key === k)?.label
  const gold = L.hl_color || th.lp_color_heading || GOLD

  // ⚠️⚠️ ВИД МАКЕТА (миграция 459). Один и тот же компонент рисует три афиши:
  // общую (все спикеры сеткой), дневную (только спикеры этого дня) и
  // индивидуальную (один человек крупно). Заводить три отдельных полотна
  // нельзя: они разойдутся на переносах строк и кегле — ровно та причина, по
  // которой афиши вообще рисуются браузером, а не отдельным рисовальщиком.
  const kind = L.kind || 'common'
  const dayList = Array.isArray(days) ? days : []
  // Пусто — берём первый день: клиент открыл вкладку и сразу видит афишу, а не
  // пустое полотно с просьбой что-то выбрать.
  const curDay = dayList.find(d => d.day === day) || dayList[0] || null
  const curSession = speakerId != null ? (sessions || {})[String(speakerId)] : undefined

  // ⚠️⚠️ РАБОЧАЯ ОБЛАСТЬ (миграция 440). Поля задаются в МИЛЛИМЕТРАХ со всех
  // четырёх сторон, и за них не выходит НИЧЕГО: ни спикеры, ни их подписи, ни
  // логотипы, ни заголовок. Всё, что ниже, считается внутри этой области, а не
  // от края полотна — поэтому «50 % по горизонтали» это середина рабочей
  // области, и при смене полей раскладка не разъезжается.
  //
  // ⚠️ Миллиметр считается от опорной ширины листа: 297 мм у горизонтальной
  // афиши (A4 альбомная), 210 мм у вертикальной и квадратной (A4 книжная).
  // Одно и то же «10 мм» даёт на них разную долю ширины — и это верно: на
  // широком полотне то же поле в долях выглядело бы вдвое толще.
  const sheetMm = L.orientation === 'horizontal' ? 297 : 210
  const mmToPx = W / sheetMm
  const mTop = (L.margin_top ?? 10) * mmToPx
  const mBottom = (L.margin_bottom ?? 10) * mmToPx
  const mLeft = (L.margin_left ?? 10) * mmToPx
  const mRight = (L.margin_right ?? 10) * mmToPx
  // Размеры рабочей области в пикселях. ⚠️ Не даём ей схлопнуться: клиент
  // вправе выкрутить поля до 60 мм, и на узком полотне это больше половины.
  const AW = Math.max(1, W - mLeft - mRight)
  const AH = Math.max(1, H - mTop - mBottom)

  // ⚠️ Размеры КАРТОЧЕК и отступы — в процентах ШИРИНЫ рабочей области: тогда
  // карточка сохраняет пропорцию относительно ряда, а поля её не ломают.
  const px = (percent: number) => (percent * AW) / 100
  /** Проценты ширины КОЛОНКИ спикеров — для карточек и подписей. */
  const cpx = (percent: number) => (percent * AW * cols.sp.w) / 10000

  // ⚠️⚠️ КЕГЛЬ ТЕКСТА — ПРОСТО ПИКСЕЛИ. Проценты высоты листа давали разброс:
  // одно значение 2.6 превращалось в 42 px на горизонтальной афише и 75 px на
  // вертикальной — «то слишком большой, то слишком маленький», и подобрать
  // нормальный размер было нельзя. Каждый формат настраивается отдельно, так
  // что пиксели здесь честнее и понятнее: что задали, то и получите.
  //
  // ⚠️ Значения хранятся в единицах полотна (1920×1080 и т.п.), а снимок
  // делается в 1.5 раза крупнее — в готовом файле буква будет в 1.5 раза
  // больше указанного. Это нормально: пропорции сохраняются.
  const tx = (pxSize: number) => pxSize

  // ⚠️⚠️ РАСКЛАДКА В КОЛОНКИ (миграция 454). `full` — как было: текст сверху
  // во всю ширину, спикеры под ним. `left`/`right` — спикеры занимают свою
  // колонку сбоку, а логотипы и текст встают рядом. На горизонтальной афише
  // это главное: иначе спикерам достаётся узкая полоса внизу, хотя по бокам
  // полно места.
  const mode = L.layout_mode ?? 'full'
  const spW = Math.max(25, Math.min(80, L.speakers_width ?? 55))
  // Ширина и левый край каждой колонки в процентах рабочей области.
  const cols = mode === 'full'
    ? { sp: { w: 100, x: 0 }, tx: { w: 100, x: 0 } }
    : mode === 'left'
      ? { sp: { w: spW, x: 0 }, tx: { w: 100 - spW, x: spW } }
      : { sp: { w: spW, x: 100 - spW }, tx: { w: 100 - spW, x: 0 } }

  // Разделяем людей: партнёры-компании идут логотипами сверху, все остальные —
  // в сетку. Галочка `is_company` — единственный признак (миграция 425).
  // ⚠️ У кого нет фото — на афише нет: пустая рамка хуже отсутствия.
  const withPhoto = people.filter(p => p.photo_url || p.cutout_photo_url)
  // ⚠️⚠️ ДНЕВНАЯ АФИША — ТОЛЬКО СПИКЕРЫ ЭТОГО ДНЯ И БЕЗ ДУБЛЕЙ. Список id
  // приходит с бэкенда уже уникальным (`DISTINCT speaker_id`): человек с двумя
  // выступлениями в один день попадает на афишу ОДИН раз.
  // ⚠️ Логотипы компаний фильтр НЕ трогает: партнёры стоят на афише любого дня,
  // у них нет выступления, по которому их можно отнести к дню.
  const dayIds = curDay ? new Set(curDay.speaker_ids.map(Number)) : null
  const visible = kind === 'day' && dayIds
    ? withPhoto.filter(p => p.is_company || dayIds.has(Number(p.id)))
    : kind === 'individual'
      // Индивидуальная афиша: один человек. Логотипы остаются — бренд и
      // партнёры нужны и на ней.
      ? withPhoto.filter(p => p.is_company || Number(p.id) === Number(speakerId))
      : withPhoto
  // ⚠️ Порядок логотипов партнёров задаёт клиент перетаскиванием. Кого в списке
  // нет — в конец, а не выбрасываем: новый партнёр иначе не попал бы на афишу.
  const companies = orderByIds(visible.filter(p => p.is_company), L.partner_order)

  // ⚠️ Строка логотипов: бренд и партнёры в одном списке (миграция 446).
  // Скрытие — ПОШТУЧНОЕ (клиент прячет свой бренд, когда на афише уже есть
  // логотип ПЛЮСОНа), а вариант светлый/тёмный — ОБЩИЙ: фон афиши один.
  const hidden = new Set((Array.isArray(L.logos_hidden) ? L.logos_hidden : []).map(String))
  const logoOrder = Array.isArray(L.logos_order) ? L.logos_order.map(String) : []

  // ⚠️ Пустое поле = «взять из события» (название, подзаголовок лендинга,
  // даты). Подставляем ТОЛЬКО в пустое: вписал клиент своё — остаётся его.
  const titleText = (L.title ?? '').trim() || suggested?.title || ''
  // ⚠️ У ДНЕВНОЙ афиши подзаголовка НЕТ (решение владельца): его место занимает
  // метка дня, и два пояснения подряд превращают шапку в кашу.
  const subtitleText = kind === 'day'
    ? ''
    : (L.subtitle ?? '').trim() || suggested?.subtitle || ''
  // ⚠️⚠️ ПИЛЮЛЯ ДНЕВНОЙ АФИШИ — метка дня («День 1 — 24.09 в 11:00»), её
  // собирает бэкенд: время берётся из ПЕРВОЙ сессии дня, а не из `open_time`
  // (он часто пустой, и в пилюле выходило «в » с оборванным хвостом).
  // Вписал клиент свой текст — остаётся его: подстановка только в пустое.
  // ⚠️⚠️ У КАЖДОГО ДНЯ СВОЯ МЕТКА, И ОНА ГЛАВНЕЕ РУЧНОГО ПОЛЯ. Поле
  // `pill_text` одно на весь вид `day` — общее для всех дней. Стояло оно
  // первым, и любой текст в нём (в том числе подставленный автоматически при
  // первой загрузке) давал ОДНУ И ТУ ЖЕ пилюлю на всех днях: «День 2» не
  // появлялся никогда. Поэтому на дневной афише метка дня — не запасной
  // вариант, а основной: она и должна отличаться от дня к дню.
  const pill1 = kind === 'day'
    ? (curDay?.label || (L.pill_text ?? '').trim() || suggested?.pill_text || '')
    : (L.pill_text ?? '').trim() || suggested?.pill_text || ''
  // ⚠️ Добавленные пилюли (миграция 471). Проверяем, что это МАССИВ: jsonb из
  // базы умеет приезжать строкой, и `.map()` тогда пойдёт по символам.
  const extraPills = (Array.isArray(L.extra_pills) ? L.extra_pills : [])
    .filter(p => p && String(p.text || '').trim())
  // В общем ряду — те, у кого нет своей точки; остальные рисуются отдельно.
  const rowPills = extraPills.filter(p => !isFreePt(p.x, p.y))
  const freePills = extraPills.filter(p => isFreePt(p.x, p.y))

  // Вторая пилюля дневной афиши — «Онлайн-конференция» сверху (формат события).
  const pill2 = (L.pill_text_2 ?? '').trim() || suggested?.pill_text_2 || ''

  // Один выбор на всю строку логотипов: фон афиши один.
  const variantForLight = (L.logos_variant || L.brand_logo_variant || 'light') === 'dark'

  const brandUrl = brandLogo(L, th)
  const logoItems: { key: string; url: string; isBrand: boolean }[] = []
  // Бренд участвует наравне с партнёрами; `show_brand_logo` оставлен для
  // макетов, сохранённых до 446 — там скрытие жило галочкой.
  if (brandUrl && L.show_brand_logo !== false && !hidden.has('brand')) {
    logoItems.push({ key: 'brand', url: brandUrl, isBrand: true })
  }
  if (L.show_partners !== false) {
    for (const c of companies) {
      if (hidden.has(String(c.id))) continue
      // ⚠️ У компании ДВА логотипа (миграция 450): основной для тёмного фона и
      // версия для светлого. Раньше поле было одно, и переключатель
      // «для светлого фона» партнёров не касался вовсе — все логотипы
      // оставались светлыми и на белой афише пропадали.
      // Версии для светлого нет — берём основной: лучше показать хоть какой-то
      // логотип, чем пустое место.
      const u = variantForLight
        ? (c.logo_on_light_url || c.photo_url || c.cutout_photo_url)
        : (c.photo_url || c.cutout_photo_url)
      if (u) logoItems.push({ key: String(c.id), url: u, isBrand: false })
    }
  }
  // Порядок задаёт клиент; кого в списке нет — в конец, чтобы новый партнёр
  // не пропал с афиши молча.
  const logoRow = logoOrder.length
    ? [...logoItems.filter(l => logoOrder.includes(l.key))
         .sort((a, b) => logoOrder.indexOf(a.key) - logoOrder.indexOf(b.key)),
       ...logoItems.filter(l => !logoOrder.includes(l.key))]
    : logoItems
  const persons = visible.filter(p => !p.is_company)

  // Организаторы — всегда отдельной строкой сверху блока людей.
  // ⚠️⚠️ ОРГАНИЗАТОРЫ — В ОБЩЕЙ СЕТКЕ, а не отдельной строкой (решение
  // владельца 18.09.2026, сказано прямо и не раз). Отдельная строка съедала
  // целый ряд высоты, из-за чего остальные карточки ужимались, а часть людей
  // вовсе не влезала и обрезалась. Организаторы просто стоят ПЕРВЫМИ — они и
  // так оказываются в верхнем ряду, а выделение им даёт рамка/свечение.
  const organizers = persons.filter(p => ORGANIZER_ROLES.includes(p.role))
  const others = applyManualOrder(persons, L.speaker_order || [])

  const cutout = L.mask_shape === 'cutout'
  const gap = L.gap ?? 2
  // ⚠️ Вертикальный промежуток отдельный: под фото идёт подпись в две строки,
  // и вертикальный зазор визуально складывается с ней — ряды расходятся
  // сильнее, чем задумано. Пусто — как по горизонтали (прежнее поведение).
  const gapY = L.gap_y ?? gap
  const ratio = cutout ? 2.0 : shapeRatio(L.mask_shape)

  // ⚠️ Подпись и плашка роли занимают высоту СВЕРХ фото, и вычитать их как
  // фиксированную величину нельзя: на шести рядах они съедали всё место, и
  // карточка ужималась до ниточки — фото исчезало, оставались одни буквы.
  // Поэтому считаем их ДОЛЕЙ от карточки: мельче карточка — мельче подпись.
  // ⚠️⚠️ СЧИТАЕМ РОВНО ТО, ЧТО РИСУЕТСЯ. Раньше подпись оценивали «на глаз»
  // долей 0.16 на строку и забывали её ОТСТУП (0.06) — расчёт занижал высоту
  // ряда, блок не влезал, и верхний ряд обрезало сверху, хотя формула
  // говорила «помещается».
  //
  // Реально подпись состоит из: отступ сверху (0.06 ширины карточки) +
  // строки высотой 1.15 кегля. Кегль ограничен `cardW * 0.19` (см. nameSizeFit
  // ниже), то есть в долях карточки это 0.19 — от него и считаем.
  // ⚠️⚠️ ПРИПИСКА РОЛИ ЧЕРЕЗ ТИРЕ ДАЁТ ЛИШНЮЮ СТРОКУ. «Марго Форбс —
  // Организатор» не влезает в две строки, и подпись занимает три. Не учтёшь
  // это здесь — ряды наедут друг на друга ровно на высоту лишней строки.
  // ⚠️ Считаем по ХУДШЕМУ случаю (у кого-то в ряду роль есть), а не по
  // среднему: ряд выравнивается по самой высокой карточке, и место нужно под
  // неё. Роль есть только у выделенных, поэтому проверяем, попадаются ли они.
  const hasSuffixRole = (L.role_badge ?? 'pill') === 'suffix'
    && others.some(p => !!BADGE_LABELS[p.role])
  const nameLines = (L.name_lines ?? 2) + (hasSuffixRole ? 1 : 0)
  const nameShare = L.show_names === false || L.name_place === 'over'
    ? 0
    : 0.06 + 0.19 * 1.15 * nameLines
  // ⚠️⚠️ Плашка роли + ЕЁ ОТСТУП. В расчёте учитывали только саму плашку
  // (0.14), а под ней ещё 0.03 отступа — блок оказывался выше отведённого
  // места ровно на эту разницу, и верхняя плашка обрезалась линией старта,
  // а нижний ряд уезжал за нижний край.
  // Плашка (0.18) + её отступ (0.03).
  const badgeShare = (L.role_badge ?? 'pill') === 'pill' ? 0.21 : 0
  // Полная высота ряда в долях ШИРИНЫ карточки.
  const rowUnit = ratio + nameShare + badgeShare

  // Высота рабочей области в процентах её ШИРИНЫ — в этих же единицах задан
  // `rowUnit`, поэтому всё считается в одной системе.
  // ⚠️ Карточки считаются от ширины КОЛОНКИ спикеров, а не всей области:
  // иначе в колонке 55 % они вылезут за её край.
  const colW = AW * cols.sp.w / 100
  const hPctOfW = (AH / colW) * 100

  // ⚠️ Отсчёт — ОТ РАБОЧЕЙ ОБЛАСТИ, а не от полотна: 45 % означает «45 % высоты
  // рабочей области», поэтому линия спикеров не съезжает при смене полей.
  const top = L.speakers_top ?? defaultSpeakersTop(L.orientation)
  const bottom = L.speakers_bottom ?? 97
  const availH = Math.max(1, bottom - top) / 100 * hPctOfW


  // ⚠️ Проверяем, что это ИМЕННО массив: jsonb из базы может приехать строкой
  // («[]»), и тогда `.length` даёт длину текста, а `.map()` роняет страницу.
  // ⚠️⚠️ У АФИШИ ДНЯ СВОЙ ПОРЯДОК РЯДОВ (миграция 466). Общий `speaker_rows`
  // для дней не годится: в первый день выступают одни люди, во второй другие,
  // и один список рядов на всех оставлял бы половину дня в авторасстановке.
  // Дня нет в словаре — падаем на общий порядок, а дальше на авторасклад.
  const dayRowsMap = L.day_speaker_rows && typeof L.day_speaker_rows === 'object'
    ? L.day_speaker_rows : {}
  const dayRows = kind === 'day' && curDay ? dayRowsMap[String(curDay.day)] : undefined
  const rawRows = Array.isArray(dayRows) ? dayRows
    : Array.isArray(L.speaker_rows) ? L.speaker_rows : []
  const manualRows = rawRows.length > 0
  // ⚠️ Без ручной расстановки раскладываем на ЧИСЛО РЯДОВ по формату
  // (вертикальная — много коротких, горизонтальная — 3-4 длинных), а не
  // подбираем «сколько в ряд»: так афиша сразу похожа на макет, а не требует
  // получаса настройки.
  const rows = manualRows
    ? applyManualRows(others, rawRows)
    : (L.per_row
        ? splitRows(others, L.per_row)
        : splitIntoRows(others, defaultRowCount(L.orientation, others.length)))

  // ⚠️ Размер карточки задаёт САМЫЙ ДЛИННЫЙ ряд: по нему считается, сколько
  // помещается в ширину. Возьми среднее — длинный ряд вылез бы за поля.
  // ⚠️⚠️ НА АФИШАХ ДНЕЙ КАРТОЧКА ОДНОГО РАЗМЕРА ВО ВСЕ ДНИ. Размер считается
  // от числа людей в ряду, а в разные дни их разное количество: у события 89
  // это 8, 7, 3 и 1 человек. Каждый день подбирал размер сам — и блоки
  // выходили разной высоты (803 px против 500 px по расчёту), из-за чего
  // афиши выглядели «то высоковато, то гигантская карточка», хотя линия
  // старта у всех одна.
  //
  // Настройки у дней общие (одна строка макета на все дни), значит и размер
  // обязан быть общим: берём самый многолюдный день как образец.
  const maxDayPerRow = kind === 'day' && dayList.length > 0
    ? Math.max(...dayList.map(d => {
        const n = d.speaker_ids.length
        if (!n) return 1
        const src = Array.isArray(dayRowsMap[String(d.day)]) ? dayRowsMap[String(d.day)] : null
        if (src && src.length) return Math.max(1, ...src.map(r => r.length))
        return Math.max(1, ...splitIntoRows(new Array(n).fill(0), defaultRowCount(L.orientation, n)).map(r => r.length))
      }))
    : 0
  const perRow = Math.max(1, maxDayPerRow, ...rows.map(r => r.length))

  // ⚠️⚠️ РАЗМЕР КАРТОЧКИ ОГРАНИЧЕН И ШИРИНОЙ, И ВЫСОТОЙ — берём меньшее.
  // Только по ширине считать нельзя: на горизонтальной афише под людей
  // остаётся около трети высоты, и карточки вылезали бы за нижнее поле.
  const byWidth = (100 - gap * (perRow - 1)) / Math.max(1, perRow)

  const rowsCount = rows.length
  // Наложение рядов уменьшает суммарную высоту — учитываем, иначе при плотной
  // группе вырезок карточки ужимались бы зря.
  const overlapK = cutout ? 1 - (L.row_overlap ?? 0) / 100 : 1
  const rowsK = Math.max(1, 1 + (rowsCount - 1) * overlapK)

  const byHeight = Math.max(
    1,
    (availH - gapY * (rowsCount - 1)) / (rowUnit * rowsK),
  )

  // ⚠️⚠️ ПОТОЛОК РАЗМЕРА КАРТОЧКИ (миграция 468, `card_max_w`). При одном
  // человеке в ряду `byWidth` равен 100 %, и карточка раздувалась на всю
  // ширину — «карточку организатора расперло», а уменьшить её было нечем:
  // ползунок один на всех и задаёт ряды, а не размер.
  //
  // Проверено арифметикой на дне с одним организатором (вертикальная афиша,
  // поля 10 мм): byWidth = 100 %, byHeight = 57.7 % — и лицо занимало больше
  // половины листа. Потолок по умолчанию 30 % ширины колонки: примерно
  // столько же, сколько у карточки в ряду из трёх человек.
  const cardMax = Math.max(5, Math.min(100, L.card_max_w ?? 30))
  const cardW = Math.max(1, Math.min(byWidth, byHeight, cardMax))
  const cardH = cardW * ratio
  // Кегль подписи: либо заданный клиентом, либо ужатый под карточку — иначе
  // на плотной сетке фамилии наезжают друг на друга.
  // ⚠️⚠️ РАЗМЕР ИМЕНИ — ДОЛЯ КАРТОЧКИ, а не процент афиши. Раньше значение
  // резалось потолком `cardW * 0.19`: при карточке 8 % потолок 1.52, а
  // умолчание 1.6 — ползунок упирался в него, и ВСЯ ВЕРХНЯЯ ПОЛОВИНА ШКАЛЫ
  // ничего не меняла. Клиент двигал ручку и не видел реакции.
  //
  // Теперь `name_size` — это проценты ШИРИНЫ КАРТОЧКИ (15 % = кегль в шестую
  // часть её ширины). Понятнее и работает на всём диапазоне.
  const nameSizeFit = cardW * (L.name_size ?? 15) / 100

  const bodyFont = brandFontCss(th.lp_font_body || 'Roboto', label(th.lp_font_body))
  const pillFont = brandFontCss(L.pill_font || th.lp_font_body, label(L.pill_font || th.lp_font_body))

  /**
   * ⚠️⚠️ УНИВЕРСАЛЬНЫЙ СДВИГ БЛОКА (миграция 468). Каждый блок афиши двигается
   * сам по себе — в ПИКСЕЛЯХ полотна, а не в процентах: проценты
   * пересчитывались при каждой правке полей, и блок уезжал сам собой.
   *
   * ⚠️ Пусто (null) — блок стоит там же, где стоял раньше: по своим прежним
   * настройкам. Так уже собранные афиши не поедут от появления этого рычага.
   */
  const shift = (x?: number | null, y?: number | null): React.CSSProperties => {
    const dx = typeof x === 'number' && Number.isFinite(x) ? x : 0
    const dy = typeof y === 'number' && Number.isFinite(y) ? y : 0
    if (!dx && !dy) return {}
    return { transform: `translate(${dx}px, ${dy}px)` }
  }

  // ⚠️⚠️ ПИЛЮЛЯ ДНЯ СТАВИТСЯ КУДА УГОДНО (миграция 467). Раньше она жила
  // только в одном ряду с пилюлей формата и двигалась вместе со всем текстовым
  // блоком — поставить её ПОД ЗАГОЛОВОК было нельзя вовсе, хотя это главный
  // сценарий: название конференции крупно, под ним — какой это день.

  return (
    <div
      data-poster-canvas
      style={{
        width: W, height: H, position: 'relative', overflow: 'hidden',
        // ⚠️ Масштабируем трансформом, а не размерами: вёрстка внутри остаётся
        // в тех же пикселях, что и в снимке, — переносы и кегль совпадут.
        transform: scale === 1 ? undefined : `scale(${scale})`,
        transformOrigin: 'top left',
        fontFamily: bodyFont,
        ...bgStyle(L, th),
      }}
    >
      {/* Затемнение — только поверх своей картинки. ⚠️ ВО ВЕСЬ ЛИСТ, не по
          рабочей области: фон рисуется до края, и затемнение обязано покрывать
          его целиком, иначе по краям остались бы светлые полосы. */}
      {!!L.bg_url && (L.bg_dim ?? 0) > 0 && (
        <div style={{ position: 'absolute', inset: 0, background: `rgba(0,0,0,${(L.bg_dim ?? 0) / 100})` }} />
      )}

      {/* ⚠️⚠️ РАБОЧАЯ ОБЛАСТЬ (миграция 440). Всё содержимое афиши лежит ВНУТРИ
          этого слоя, поэтому за поля не выходит ничего — ни спикеры с
          подписями, ни логотипы, ни заголовок. `overflow: hidden` — последняя
          защита: если что-то всё же окажется шире, оно обрежется по полю, а не
          повиснет на самом краю листа.
          Фон и затемнение намеренно ОСТАЛИСЬ снаружи: они рисуются до края. */}
      <div style={{
        position: 'absolute',
        left: mLeft, top: mTop, width: AW, height: AH,
        overflow: 'hidden',
      }}>

      {/* Граница полей — только в редакторе, в снимок не попадает. */}
      {showMargins && (
        <div style={{
          position: 'absolute', inset: 0,
          border: `${Math.max(1, AW / 400)}px dashed rgba(239,68,68,0.9)`,
          pointerEvents: 'none', zIndex: 99,
        }} />
      )}

      {/* ⚠️⚠️ ОДНА СТРОКА ЛОГОТИПОВ: бренд и партнёры вместе (миграция 446).
          Раньше это были ДВА независимых слоя — партнёры строкой по центру и
          бренд по своим координатам X/Y. Две раскладки в одном месте листа
          неизбежно пересекались: логотип бренда наезжал на партнёров, и
          «подвинуть, чтобы не мешал» приходилось вручную на каждом формате.
          Теперь это один ряд с общим размером, промежутком и выравниванием —
          пересечься они больше не могут по построению. */}
      {logoRow.length > 0 && (
        <div style={{
          // В колоночной раскладке логотипы стоят над ТЕКСТОМ, а не над всей
          // афишей: иначе они висели бы над спикерами.
          position: 'absolute',
          left: `${cols.tx.x}%`, width: `${cols.tx.w}%`,
          top: `${L.partners_y ?? 5}%`,
          ...shift(L.pos_logos_x, L.pos_logos_y),
          display: 'flex', alignItems: 'center', flexWrap: 'wrap',
          justifyContent: L.logos_align === 'left' ? 'flex-start'
                        : L.logos_align === 'right' ? 'flex-end' : 'center',
          gap: px(L.logos_gap ?? 2.5),
        }}>
          {logoRow.map(l => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={l.key} src={l.url} alt=""
                 style={{
                   // Высота общая, ширина по пропорции: логотипы бывают и
                   // квадратные, и длинные — растягивать их нельзя.
                   height: px(l.isBrand ? (L.brand_logo_size ?? 6) : (L.partners_size ?? 5)),
                   objectFit: 'contain',
                 }} />
          ))}
        </div>
      )}

      {/* Текстовый блок: пилюля, заголовок, подзаголовок. Всё можно выключить —
          тогда фон приезжает со своим готовым заголовком. */}
      <div style={{
        position: 'absolute',
        left: `${cols.tx.x}%`, width: `${cols.tx.w}%`,
        top: `${L.text_top ?? 18}%`,
        ...shift(L.pos_text_x, L.pos_text_y),
        // Выравнивание блока внутри колонки (миграция 454).
        textAlign: L.text_align ?? 'center',
      }}>
        {/* ⚠️⚠️ ПИЛЮЛИ СТОЯТ В ОДНУ ЛИНИЮ — так было и так должно остаться
            (жалоба владельца 20.09.2026: «пилюли съехали», «было же в одну
            линию... и на вертикальной, и на горизонтальной, и на квадратной»).
            Когда я делал их двигаемыми по отдельности, я разнёс их на два
            блока друг под другом — и линия развалилась на всех форматах.

            ⚠️ Двигать по отдельности по-прежнему можно: сдвиг применяется к
            самой пилюле внутри общего ряда, а не к строке целиком. Ряд с
            `flex-wrap` переносит вторую пилюлю вниз сам, только если ей не
            хватило ширины.

            `pill_row_align` задаёт, где стоит вся пара; у каждой пилюли
            остаётся свой сдвиг. */}
        {L.show_pill !== false && (!!pill1 || !!pill2) && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'center',
            gap: px(1.5),
            justifyContent: alignToFlex(L.pill1_align),
            marginBottom: L.gap_pill_title ?? 18,
          }}>
            {!!pill1 && (
              <div style={shift(L.pos_pill1_x, L.pos_pill1_y)}>
                <Pill text={pill1} L={L} px={px} tx={tx} gold={gold} font={pillFont} />
              </div>
            )}
            {!!pill2 && (
              <div style={shift(L.pos_pill2_x, L.pos_pill2_y)}>
                <Pill text={pill2} L={L} px={px} tx={tx} gold={gold} font={pillFont} />
              </div>
            )}
            {/* Добавленные пилюли — в том же ряду и тем же оформлением: это
                те же пилюли, а не новый вид элемента. */}
            {rowPills.map((p, i) => (
              <Pill key={`x${i}`} text={p.text} L={L} px={px} tx={tx} gold={gold} font={pillFont} />
            ))}
          </div>
        )}

        {L.show_title !== false && !!titleText && (
          <Heading
            text={titleText}
            text2={L.title_2 || null}
            color2={L.title_2_color || th.lp_color_body || '#FFFFFF'}
            newline2={L.title_2_newline !== false}
            align={L.title_align || 'center'}
            font={brandFontCss(L.title_font || th.lp_font_heading || 'BebasNeue', label(L.title_font || th.lp_font_heading))}
            sizePx={tx(L.title_size ?? 76)}
            color={L.title_color || th.lp_color_heading || GOLD}
            metallic={L.title_metallic !== false}
            underline={L.title_underline || 'none'}
            px={px}
          />
        )}

        {L.show_subtitle !== false && !!subtitleText && (
          <div style={{ marginTop: L.gap_title_subtitle ?? 14 }}>
            <Heading
              text={subtitleText}
              text2={L.subtitle_2 || null}
              color2={L.subtitle_2_color || L.subtitle_color || th.lp_color_body || '#FFFFFF'}
              newline2={L.subtitle_2_newline === true}
              align={L.subtitle_align || 'center'}
              font={brandFontCss(L.subtitle_font || th.lp_font_body || 'Roboto', label(L.subtitle_font || th.lp_font_body))}
              sizePx={tx(L.subtitle_size ?? 28)}
              color={L.subtitle_color || th.lp_color_body || '#FFFFFF'}
              metallic={!!L.subtitle_metallic}
              underline={L.subtitle_underline || 'none'}
              px={px}
            />
          </div>
        )}

      </div>


      {/* ⚠️⚠️ ИНДИВИДУАЛЬНАЯ АФИША — ОДИН ЧЕЛОВЕК КРУПНО, без сетки.
          Сетка здесь не годится: у неё карточка считается от числа людей в
          ряду, и на одном человеке она заняла бы всю ширину, а подпись стала
          бы гигантской. Поэтому размер фото задаёт клиент (`ind_photo_size`,
          % ширины рабочей области), а положение — `ind_photo_x/y`.
          Текст (роль, имя, тема, время) идёт под фото и каждый пункт можно
          выключить: у части спикеров нет ни темы, ни точного времени. */}
      {kind === 'individual' ? (
        <IndividualBlock
          person={persons[0]}
          session={curSession}
          L={L} th={th} gold={gold} px={px} tx={tx} label={label}
          eventTitle={titleText} shift={shift}
        />
      ) : (
      <div style={{
        position: 'absolute',
        left: `${cols.sp.x}%`, width: `${cols.sp.w}%`,
        // ⚠️⚠️ БЛОК ЦЕНТРИРУЕТСЯ В ОТВЕДЁННОЙ ПОЛОСЕ, а не прижимается к её
        // верху. Прижатый блок при малом числе людей «уезжал вниз»: сверху
        // оставалась дыра между заголовком и лицами, снизу — ничего. Теперь
        // полоса задаёт ГРАНИЦЫ (от `top` до `bottom`), а блок встаёт в её
        // середину, и свободное место делится поровну.
        top: `${top}%`,
        height: `${Math.max(5, bottom - top)}%`,
        ...shift(L.pos_speakers_x, L.pos_speakers_y),
        display: 'flex', flexDirection: 'column',
        // ⚠️⚠️ БЛОК НАЧИНАЕТСЯ РОВНО С ЗАДАННОЙ ЛИНИИ. Было `center`: блок
        // висел посередине полосы от «начинать с высоты» до «не ниже», и при
        // малом числе людей свободное место делилось поровну — карточки
        // начинались заметно НИЖЕ заданной линии. Настройка называется
        // «начинать с высоты», значит она и есть линия старта (решение
        // владельца 19.09.2026), а не верхняя граница полосы, внутри которой
        // что-то плавает.
        alignItems: 'center', justifyContent: 'flex-start',
        // Лишнее прячем: если людей больше, чем влезает, они полезли бы за
        // нижнее поле и на снимке пропали бы молча.
        overflow: 'hidden',
        // ⚠️ Промежутки — от ширины РАБОЧЕЙ ОБЛАСТИ (AW), а не полотна: иначе
        // при больших полях ряды расходились бы шире, чем задумано.
        gap: cutout ? 0 : `${gapY * colW / 100}px`,
      }}>
        {rows.map((row, ri) => (
          <div key={ri} style={{
            // ⚠️⚠️ ВЫРАВНИВАНИЕ ПО ВЕРХУ, а не по низу. Было `flex-end`: ряд
            // прижимался к нижней границе, и карточка с длинной подписью
            // (роль через тире даёт третью строку) ТЯНУЛА СОСЕДЕЙ ВВЕРХ — их
            // фото уезжали выше остальных, сетка ломалась.
            // Теперь фото всех карточек ряда стоят на одной линии, а подпись
            // растёт вниз; следующий ряд просто начинается ниже.
            display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
            gap: `${gap * colW / 100}px`,
            // ⚠️ Наложение рядов — только у вырезанных людей: задний ряд
            // выглядывает из-за переднего, как в примере владельца. У карточек
            // с рамками это были бы наезжающие друг на друга прямоугольники.
            marginTop: ri > 0 && cutout ? `-${(L.row_overlap ?? 0) * cardH * colW / 10000}px` : undefined,
            // Передние ряды поверх задних.
            position: 'relative', zIndex: ri + 1,
          }}>
            {row.map(p => (
              <PersonCard key={p.id} p={p} L={L} gold={gold} px={cpx} nameSize={nameSizeFit}
                          wPct={cardW} wPx={cardW * colW / 100} hPx={cardH * colW / 100}
                          highlighted={p.role === 'headliner' || p.role === 'general_partner' || ORGANIZER_ROLES.includes(p.role)}
                          theme={th} label={label} />
            ))}
          </div>
        ))}
      </div>
      )}

      {/* ⚠️ Пилюли со СВОЕЙ точкой стоят прямо на листе, вне текстового блока:
          иначе их держали бы его границы — ровно та привязка, от которой мы
          уходили в миграции 470. Внутри рабочей области, так что за поля они
          всё равно не выйдут. */}
      {L.show_pill !== false && freePills.map((p, i) => (
        <div key={`fp${i}`} style={{
          position: 'absolute',
          left: `${Math.max(0, Math.min(100, p.x ?? 50))}%`,
          top: `${Math.max(0, Math.min(100, p.y ?? 50))}%`,
          // ⚠️ На краях прижимаем, а не центрируем — иначе при 100 % половина
          // пилюли уходит за поле (та же причина, что у текстовых элементов).
          transform: `translate(${
            (p.x ?? 50) <= 0 ? '0' : (p.x ?? 50) >= 100 ? '-100%' : '-50%'}, ${
            (p.y ?? 50) <= 0 ? '0' : (p.y ?? 50) >= 100 ? '-100%' : '-50%'})`,
          display: 'flex', justifyContent: alignToFlex(p.align),
        }}>
          <Pill text={p.text} L={L} px={px} tx={tx} gold={gold} font={pillFont} />
        </div>
      ))}

      </div>{/* конец рабочей области */}
    </div>
  )
}

/**
 * Линия, с которой начинаются спикеры, если клиент не задал сам.
 *
 * ⚠️ Отдаём людям БОЛЬШУЮ часть листа. Сверху идут логотипы, заголовок и
 * пилюля — им хватает четверти высоты, а всё остальное должно достаться
 * лицам: ради них афишу и смотрят. Прежние 45 % на вертикальной оставляли
 * спикерам половину листа, и карточки выходили вдвое мельче возможного.
 */
function defaultSpeakersTop(o: PosterOrientation): number {
  // ⚠️ Числа подобраны РАСЧЁТОМ под реальный состав (14 человек), а не на глаз:
  // при них блок людей занимает отведённую полосу целиком и никого не обрезает,
  // а фото выходит 170–230 px в готовом файле. Сверху остаётся место под
  // логотипы, заголовок и пилюлю.
  // ⚠️ У горизонтальной афиши высоты вдвое меньше, а текст занимает ту же
  // долю листа — спикерам оставалось втрое меньше места, чем на квадратной,
  // и всё (включая плашку роли) выходило мелким. Даём им больше: тексту
  // хватает и 28 %, проверено расчётом.
  if (o === 'horizontal') return 28
  if (o === 'square') return 38
  return 44
}

/**
 * Сколько рядов по умолчанию — ПО ФОРМАТУ (правило владельца 18.09.2026).
 *
 * ⚠️ На вертикальной афише рядов много и они короткие (бывает и 7), на
 * горизонтальной — 3-4 длинных. Одно число на все форматы давало на узкой
 * афише длинные ряды из горошин, а на широкой — башню в один столбец.
 */
export function defaultRowCount(o: PosterOrientation, count: number): number {
  if (count <= 1) return 1
  // ⚠️ Правила заданы владельцем прямо (18.09.2026):
  //   горизонтальная и квадратная — до 7 человек один ряд, до 14 два, дальше три;
  //   вертикальная — по 4 человека в ряд.
  if (o === 'vertical') return Math.max(1, Math.ceil(count / 4))
  if (count <= 7) return 1
  if (count <= 14) return 2
  return Math.max(3, Math.ceil(count / 7))
}

/** Расставляет по заданному порядку id; кого нет в списке — в конец. */
function orderByIds<T extends { id: number }>(items: T[], order?: number[]): T[] {
  if (!order?.length) return items
  const pos = new Map(order.map((id, i) => [id, i]))
  const known = items.filter(x => pos.has(x.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!)
  return [...known, ...items.filter(x => !pos.has(x.id))]
}

/** Пропорция карточки (высота / ширина) по форме маски. */
function shapeRatio(shape?: string): number {
  switch (shape) {
    case 'square':   return 1
    case 'circle':   return 1
    case 'oval':     return 1.25
    case 'egg':      return 1.2
    default:         return 1.35   // portrait — вертикальный прямоугольник
  }
}

/** CSS-форма маски. */
function maskCss(L: PosterLayout): React.CSSProperties {
  switch (L.mask_shape) {
    // ⚠️⚠️ КРУГ — ЭТО 50 %, А НЕ 9999px. На прямоугольной карточке `9999px`
    // даёт «таблетку» — прямоугольник со скруглёнными торцами, что и было
    // видно на экране. Круг получается только когда карточка КВАДРАТНАЯ
    // (за это отвечает shapeRatio) и радиус задан в процентах.
    case 'circle': return { borderRadius: '50%' }
    // Овал — тот же 50 %, но карточка вытянута по высоте (shapeRatio 1.25).
    case 'oval':   return { borderRadius: '50%' }
    // Яйцо: снизу круглее, сверху уже — несимметричное скругление.
    case 'egg':    return { borderRadius: '50% 50% 50% 50% / 60% 60% 40% 40%' }
    case 'cutout': return {}
    // ⚠️ Квадрат и прямоугольник отличаются ПРОПОРЦИЕЙ (shapeRatio: 1 против
    // 1.35), а не скруглением. Радиус — общая настройка для обоих.
    // `mask_radius` в % от ширины: у квадрата 50 % дадут круг, и это законно —
    // клиент сам решает, насколько скруглить.
    case 'square':
    default:       return { borderRadius: `${L.mask_radius ?? 0}%` }
  }
}

/**
 * Форма маски → форма, для которой настроен кадр в карточке человека.
 *
 * ⚠️ Овал и яйцо близки к кругу, поэтому берут его настройку: заводить им свои
 * ползунки значило бы пять ручек на фото вместо трёх, а разница между кругом и
 * овалом для кадрирования невелика.
 */
function cropShapeOf(shape?: string): CropShape {
  if (shape === 'circle' || shape === 'oval' || shape === 'egg') return 'circle'
  if (shape === 'square') return 'square'
  return 'portrait'
}

function bgStyle(L: PosterLayout, th: PosterTheme): React.CSSProperties {
  if (L.bg_url) {
    return { backgroundImage: `url(${L.bg_url})`, backgroundSize: 'cover', backgroundPosition: 'center' }
  }
  const c1 = th.lp_bg_color || '#25455D'
  const c2 = th.lp_bg_color_2 || '#0a1520'
  if (th.lp_bg_gradient === false) return { background: c1 }
  return { background: `linear-gradient(${th.lp_bg_angle ?? 45}deg, ${c1}, ${c2})` }
}

function brandLogo(L: PosterLayout, th: PosterTheme): string | null {
  // ⚠️ Вариант ОБЩИЙ для строки логотипов (мигр. 446): фон афиши один, и
  // «этот логотип под тёмный, соседний под светлый» — бессмыслица.
  // `brand_logo_variant` читается только у макетов, сохранённых до 446.
  const variant = L.logos_variant || L.brand_logo_variant || 'light'
  if (variant === 'dark') return th.brand_logo_light_url || th.brand_logo_url || null
  return th.brand_logo_url || th.brand_logo_light_url || null
}

/** Стиль одной части заголовка: свой цвет, свой перелив. */
function partStyle(color: string, metallic: boolean): React.CSSProperties {
  return metallic ? metallicTextStyle(color) : { color }
}

/** Заголовок с металлическим переливом и подчёркиванием. */
function Heading({ text, text2, color2, newline2, align, font, sizePx, color, metallic, underline, px }: {
  text: string
  /** Вторая часть заголовка своим цветом (миграция 447). Пусто — одноцветный. */
  text2?: string | null
  color2?: string
  newline2?: boolean
  align: 'left' | 'center' | 'right'
  font: string
  sizePx: number
  color: string
  metallic: boolean
  underline: 'none' | 'line' | 'gradient'
  px: (n: number) => number
}) {
  return (
    <div style={{ textAlign: align }}>
      {/* ⚠️⚠️ `inline-block` + `overflow-wrap: anywhere` СХЛОПЫВАЛИ ЗАГОЛОВОК
          В СТОЛБИК ИЗ БУКВ: inline-block сжимается по содержимому, а «anywhere»
          разрешает разрыв после ЛЮБОГО символа — браузер и рвал после каждой
          буквы, получалась вертикальная полоска шириной в один знак.
          Теперь блок занимает всю ширину рабочей области (`display: block`), а
          перенос обычный, по словам. Длинное слово без пробелов ужимается
          кеглем ниже, а не рубится посимвольно. */}
      <span style={{
        display: 'block', width: '100%',
        fontFamily: font, fontSize: sizePx, lineHeight: 1.08,
        overflowWrap: 'break-word',
        ...(metallic ? metallicTextStyle(color) : { color }),
        // Ровная линия — обычной рамкой снизу. Градиентная рисуется ОТДЕЛЬНЫМ
        // элементом ниже (на самом тексте свойство background уже занято
        // металлическим переливом, второй фон туда не положить).
        // ⚠️ Подчёркивание — доля от КЕГЛЯ: на узкой афише линия, посчитанная
        // от ширины, выходила толще самих букв.
        ...(underline === 'line' ? {
          paddingBottom: sizePx * 0.18,
          borderBottom: `${Math.max(2, sizePx * 0.05)}px solid ${color}`,
        } : {}),
      }}>
        {text}
        {/* ⚠️ Вторая часть — ОТДЕЛЬНЫМ span со своим цветом. Металлический
            перелив у каждой части считается от своего цвета: он строится через
            background-clip, и один общий фон на две части дал бы переход
            посреди слова. */}
        {!!text2 && (newline2 ? <><br /><span style={partStyle(color2 || color, metallic)}>{text2}</span></>
                              : <span style={partStyle(color2 || color, metallic)}>{' ' + text2}</span>)}
      </span>
      {/* ⚠️ Градиентную линию рисуем ОТДЕЛЬНЫМ элементом: на самом тексте уже
          стоит градиент металла через background-clip, и второй фон туда не
          положить — они на одном свойстве. */}
      {underline === 'gradient' && (
        <div style={{
          height: Math.max(2, sizePx * 0.05),
          margin: `${sizePx * 0.18}px auto 0`,
          width: '55%',
          background: `linear-gradient(90deg, transparent, ${color}, transparent)`,
        }} />
      )}
    </div>
  )
}

/** Пилюля с датой / форматом события. */
function Pill({ text, L, px, tx, gold, font }: {
  text: string
  L: PosterLayout
  /** Проценты ШИРИНЫ области — для рамок и отступов. */
  px: (n: number) => number
  /** Проценты ВЫСОТЫ листа — для кегля: он должен читаться одинаково
   *  на узкой и широкой афише. */
  tx: (n: number) => number
  gold: string
  font: string
}) {
  const style = L.pill_style || 'border'
  const textColor = L.pill_text_color || '#FFFFFF'
  // Толщина рамки — тоже от кегля: иначе на широком формате рамка вдвое толще.
  const bw = Math.max(1, tx(L.pill_border_w ?? 0.15))
  const c1 = L.pill_border_color || gold
  const c2 = L.pill_border_color_2

  // ⚠️ Отступы внутри пилюли — доля от ЕЁ КЕГЛЯ, а не от ширины афиши:
  // иначе на горизонтальном формате пилюля раздувалась вдвое при том же тексте.
  const fs = tx(L.pill_size ?? 22)
  // ⚠️⚠️ СКРУГЛЕНИЕ — ДОЛЯ ОТ ВЫСОТЫ ПИЛЮЛИ, а не пиксели полотна. Раньше
  // «50» означало 50 px на афише шириной 1920 — глазом почти не видно, и
  // настройка выглядела нерабочей. Теперь 50 % = полукруглые торцы, как и
  // ожидается от «пилюли».
  const pillH = fs * 1.2 + fs * 0.42 * 2
  const radiusPx = (pillH / 2) * ((L.pill_radius ?? 50) / 50)

  const base: React.CSSProperties = {
    fontFamily: font, fontSize: fs,
    color: textColor, lineHeight: 1.2,
    padding: `${fs * 0.42}px ${fs * 1.0}px`,
    display: 'inline-block', whiteSpace: 'nowrap',
  }

  if (style === 'plain') return <span style={{ ...base, padding: 0 }}>{text}</span>

  if (style === 'underline') {
    return (
      <span style={{ ...base, padding: `0 0 ${fs * 0.28}px`, borderBottom: `${bw}px solid ${c1}` }}>{text}</span>
    )
  }

  if (style === 'filled') {
    return (
      <span style={{
        ...base,
        borderRadius: radiusPx,
        background: L.pill_bg_color || c1,
      }}>
        {text}
      </span>
    )
  }

  // border. ⚠️ Градиентная рамка делается ДВУМЯ слоями фона (внешний — градиент,
  // внутренний — свой фон), потому что CSS `border-color` градиент не принимает.
  const radius = radiusPx
  if (c2) {
    return (
      <span style={{
        display: 'inline-block', borderRadius: radius, padding: bw,
        background: `linear-gradient(90deg, ${c1}, ${c2})`,
      }}>
        <span style={{
          ...base, display: 'block', borderRadius: radius,
          background: L.pill_bg_color || 'rgba(0,0,0,0.35)',
        }}>
        {text}
      </span>
      </span>
    )
  }
  return (
    <span style={{
      ...base, borderRadius: radius,
      border: `${bw}px solid ${c1}`,
      background: L.pill_bg_color || 'transparent',
    }}>{text}</span>
  )
}

/** Карточка человека: фото в маске + подпись + выделение роли. */
function PersonCard({ p, L, gold, px, wPct, wPx, hPx, highlighted, theme, label, nameSize }: {
  p: PosterPerson
  L: PosterLayout
  gold: string
  px: (n: number) => number
  /** Ширина карточки в % ширины рабочей области — для размеров подписей. */
  wPct: number
  /** ⚠️ Ширина в ПИКСЕЛЯХ. Проценты здесь не годятся: `width: N%` считается от
   *  flex-ряда, а короткий ряд уже полного — и «квадрат» переставал быть
   *  квадратом, а круг превращался в таблетку. В пикселях форма гарантирована. */
  wPx: number
  hPx: number
  highlighted: boolean
  theme: PosterTheme
  label: (k?: string | null) => string | undefined
  /** Кегль подписи, уже ужатый под размер карточки (см. nameSizeFit). */
  nameSize: number
}) {
  const cutout = L.mask_shape === 'cutout'
  const hl = L.hl_style ?? 'border'
  const on = highlighted && hl !== 'none'
  const badge = L.role_badge ?? 'pill'
  const roleText = BADGE_LABELS[p.role]
  const showBadge = badge !== 'none' && !!roleText && highlighted

  // ⚠️ У вырезки своя точка лица: она кадрирована иначе, чем основное фото.
  const url = cutout ? (p.cutout_photo_url || p.photo_url) : (p.photo_url || p.cutout_photo_url)
  const focal = cutout ? (p.cutout_photo_focal || p.photo_focal) : p.photo_focal

  const lines = L.show_names === false ? [] : personLines(p, L.name_order || 'first_last', (L.name_lines || 2) as 1 | 2)
  const nameColor = L.name_color || theme.lp_color_body || '#FFFFFF'
  const nameFont = brandFontCss(L.name_font || theme.lp_font_body || 'Roboto', label(L.name_font || theme.lp_font_body))
  const borderW = Math.max(1, px(L.hl_border_w ?? 0.3))

  return (
    <div style={{ width: wPx, position: 'relative', zIndex: on ? 3 : 1 }}>
      {/* ⚠️ МЕСТО ПОД ПЛАШКУ РЕЗЕРВИРУЕТСЯ У ВСЕХ, а не только у выделенных.
          Требование: имена всех людей стоят на ОДНОМ уровне. Плашка только у
          хедлайнера сдвинула бы его карточку вниз, и ряд поехал бы. */}
      {/* ⚠️ Размеры плашки считаем ОТ КАРТОЧКИ (`wPct`), а не от полотна: на
          плотной сетке из двадцати человек плашка фиксированного размера
          оказывалась шире самой карточки и наезжала на соседей. */}
      {badge === 'pill' && (
        <div style={{
          height: px(wPct * 0.18), marginBottom: px(wPct * 0.03),
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          // ⚠️ Плашка не должна вылезать за свою строку: с padding она бывает
          // выше контейнера, и тогда её срезает верхняя граница блока людей.
          overflow: 'visible',
        }}>
          {showBadge && (
            <span style={{
              fontFamily: nameFont,
              fontSize: px(Math.min(nameSize * 0.85, wPct * 0.13)), lineHeight: 1,
              padding: `${px(wPct * 0.02)}px ${px(wPct * 0.06)}px`,
              borderRadius: 9999,
              background: L.role_badge_color || gold,
              color: L.role_badge_text_color || '#1b2a36',
              whiteSpace: 'nowrap',
            }}>{roleText}</span>
          )}
        </div>
      )}

      {/* Рамка с фото. */}
      <div style={{
        position: 'relative', width: '100%', height: hPx,
        overflow: cutout ? 'visible' : 'hidden',
        ...maskCss(L),
        ...(!cutout && on && (hl === 'border' || hl === 'both')
          ? { border: `${borderW}px solid ${gold}` } : {}),
        ...(on && (hl === 'glow' || hl === 'both')
          ? { boxShadow: `0 0 ${px(L.hl_glow ?? 1.5)}px ${px((L.hl_glow ?? 1.5) / 3)}px ${gold}` } : {}),
        boxSizing: 'border-box',
      }}>
        {url && (cutout ? (
          // ⚠️ Вырезку НЕ режем и прижимаем к низу: человек стоит на афише,
          // а не висит. Кадрирование к ней не применяется — у неё нет фона,
          // который надо было бы обрезать.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt=""
               style={{
                 width: '100%', height: '100%',
                 objectFit: 'contain', objectPosition: 'bottom center',
                 ...(on && (hl === 'glow' || hl === 'both')
                   ? { filter: `drop-shadow(0 0 ${px(L.hl_glow ?? 1.5)}px ${gold})` } : {}),
               }} />
        ) : (
          // ⚠️⚠️ ТОТ ЖЕ РАСЧЁТ, что в карточке спикера (`photoCrop`): отмеченная
          // точка лица встаёт РОВНО В ЦЕНТР маски, применяются приближение и
          // сдвиг, заданные клиентом. Раньше здесь был `object-position`, а он
          // совмещает точку N % картинки с точкой N % МАСКИ, а не с центром —
          // отсюда и уезжавший вбок нос.
          <MaskedPhoto
            url={url}
            shape={cropShapeOf(L.mask_shape)}
            focal={focal}
            settings={p}
            width={wPx}
            height={hPx}
            style={{ position: 'absolute', inset: 0 }}
          />
        ))}

        {/* Лента через угол — для прямоугольных карточек. */}
        {showBadge && badge === 'ribbon' && !cutout && (
          <div style={{
            position: 'absolute', top: hPx * 0.13, left: -hPx * 0.28,
            width: hPx * 0.9, transform: 'rotate(-45deg)',
            background: L.role_badge_color || gold,
            color: L.role_badge_text_color || '#1b2a36',
            fontFamily: nameFont, fontSize: px(Math.min(nameSize * 0.7, wPct * 0.09)), lineHeight: 1,
            padding: `${px(wPct * 0.025)}px 0`, textAlign: 'center', whiteSpace: 'nowrap',
          }}>{roleText}</div>
        )}

        {/* Подпись поверх нижнего края карточки. */}
        {L.name_place === 'over' && lines.length > 0 && (
          <NameBlock lines={lines} roleText={showBadge && badge === 'suffix' ? roleText : null}
                     L={L} px={px} font={nameFont} color={nameColor} size={nameSize}
                     cardWPct={wPct} gold={gold}
                     style={{ position: 'absolute', left: 0, right: 0, bottom: px(wPct * 0.05) }} />
        )}
      </div>

      {/* Подпись под фото. */}
      {L.name_place !== 'over' && lines.length > 0 && (
        <NameBlock lines={lines} roleText={showBadge && badge === 'suffix' ? roleText : null}
                   L={L} px={px} font={nameFont} color={nameColor} size={nameSize}
                   cardWPct={wPct} gold={gold}
                   style={{ marginTop: px(wPct * 0.06) }} />
      )}
    </div>
  )
}

function NameBlock({ lines, roleText, L, px, font, color, style, size, cardWPct, gold }: {
  lines: string[]
  roleText: string | null
  L: PosterLayout
  px: (n: number) => number
  font: string
  color: string
  style?: React.CSSProperties
  /** Кегль, уже ужатый под карточку: на плотной сетке заданный клиентом
   *  размер не влез бы и фамилии наехали бы друг на друга. */
  size: number
  /** Ширина карточки в тех же единицах, что и `size` — для авто-ужатия. */
  cardWPct: number
  /** Фирменный акцент — им выделяется приписка роли. */
  gold: string
}) {
  // ⚠️ Тень обязательна у вырезанных спикеров: подпись ложится прямо на людей
  // и фон, и на светлой одежде белые буквы пропадают.
  const shadow = L.name_shadow || L.mask_shape === 'cutout' || L.name_place === 'over'
  // Коэффициент ужатия под ширину карточки (см. комментарий ниже).
  const longest = lines.reduce((n, l) => Math.max(n, l.length), 0)
  const needW = longest * size * 0.55      // в тех же % , что и size
  const fitK = needW > cardWPct && cardWPct > 0 ? cardWPct / needW : 1
  return (
    <div style={{
      textAlign: 'center', fontFamily: font, color,
      // ⚠️⚠️ ДЛИННАЯ ФАМИЛИЯ УЖИМАЕТСЯ САМА. «Барвинская» и «Кондраченко» не
      // влезали в карточку по ширине и переносились по слогам в столбик.
      // Прикидываем ширину самой длинной строки (для кириллицы средняя буква
      // ≈ 0.55 кегля) и, если она шире карточки, уменьшаем кегль ровно во
      // столько раз. Короткие имена при этом не трогаются.
      fontSize: px(size * fitK), lineHeight: 1.15,
      fontWeight: 700,
      // ⚠️ Тень — доля от КЕГЛЯ, а не фикс: на мелких подписях фиксированная
      // тень размазывала бы буквы в пятно.
      textShadow: shadow
        ? `0 ${px(size * 0.08)}px ${px(size * 0.22)}px rgba(0,0,0,0.85)`
        : undefined,
      // ⚠️⚠️ НЕ `anywhere`: он разрешает разрыв после ЛЮБОГО символа, и в узкой
      // карточке фамилия рвалась по буквам в вертикальную колбасу («М-а-р-г-о»).
      // `break-word` рвёт только то, что иначе не влезает совсем.
      overflowWrap: 'break-word',
      // Подпись не должна вылезать за карточку вбок.
      maxWidth: '100%',
      ...style,
    }}>
      {lines.map((l, i) => (
        <div key={i}>
          {l}
          {/* Приписка роли через тире — на последней строке.
              ⚠️ ФИРМЕННЫМ ЦВЕТОМ, а не цветом имени: стояло `|| undefined`, и
              без заданного цвета приписка сливалась с фамилией.
              ⚠️⚠️ Комментарий стоит ЗДЕСЬ, а не внутри `&& (` — там он ломает
              сборку («')' expected»), это записанная ловушка проекта. */}
          {roleText && i === lines.length - 1 && (
            <span style={{ color: L.role_badge_color || gold }}> — {roleText}</span>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * Афиша ОДНОГО спикера: крупное фото, роль, Имя Фамилия, тема и время.
 *
 * ⚠️ Почему отдельным компонентом, а не веткой внутри сетки: у сетки размер
 * карточки выводится из числа людей в ряду, и на одном человеке вся эта
 * арифметика бессмысленна. Здесь размер задаёт клиент напрямую.
 *
 * ⚠️ Кадр фото берётся ТЕМ ЖЕ `MaskedPhoto`, что и в сетке, и в карточке
 * спикера: клиент настраивает лицо один раз, и оно обязано выглядеть
 * одинаково везде. Своя обрезка здесь развалила бы эту договорённость.
 */
function IndividualBlock({ person, session, L, th, gold, px, tx, label, eventTitle, shift }: {
  person?: PosterPerson
  session?: { topic?: string; when?: string; day?: number }
  L: PosterLayout
  th: PosterTheme
  gold: string
  px: (p: number) => number
  tx: (p: number) => number
  label: (k?: string | null) => string | undefined
  eventTitle: string
  /** Общий сдвиг блока — тот же, что у остальных блоков афиши. */
  shift: (x?: number | null, y?: number | null) => React.CSSProperties
}) {
  if (!person) return null

  const photoW = px(Math.max(10, Math.min(100, L.ind_photo_size ?? 45)))
  const shape = cropShapeOf(L.mask_shape)
  const cutout = L.mask_shape === 'cutout'
  const ratio = cutout ? 2.0 : shapeRatio(L.mask_shape)
  const photoH = photoW * ratio
  // Вырезка — своя картинка и свой фокус: у неё нет фона, и точка лица на ней
  // отмечена отдельно.
  const url = (cutout && person.cutout_photo_url) || person.photo_url || person.cutout_photo_url || ''
  const focal = cutout ? person.cutout_photo_focal : person.photo_focal

  // ⚠️ Имя собираем ТЕМ ЖЕ `personLines`, что и подписи в сетке: в базе
  // `name` — это ИМЯ, а фамилия отдельным полем, и порядок слов задаёт
  // клиент. Склеишь тут по-своему — на общей и индивидуальной афише у
  // человека окажутся разные подписи.
  const nameText = personLines(person, L.name_order || 'first_last', 1)[0] || ''
  const roleText = BADGE_LABELS[person.role] || ''
  const topic = (session?.topic || '').trim()
  const when = (session?.when || '').trim()

  const headFont = brandFontCss(
    L.name_font || th.lp_font_heading || 'Roboto',
    label(L.name_font || th.lp_font_heading),
  )
  // ⚠️ У каждого элемента свой шрифт (миграция 473). Пусто — наследует общий,
  // как было: так уже собранные афиши не меняют вид.
  const nameFont = L.ind_name_font
    ? brandFontCss(L.ind_name_font, label(L.ind_name_font)) : headFont
  const roleFont = L.ind_role_font
    ? brandFontCss(L.ind_role_font, label(L.ind_role_font)) : headFont
  const topicFont = L.ind_topic_font
    ? brandFontCss(L.ind_topic_font, label(L.ind_topic_font)) : undefined
  const timeFont = L.ind_time_font
    ? brandFontCss(L.ind_time_font, label(L.ind_time_font)) : undefined

  // ⚠️⚠️ ПОРЯДОК ПО ТЗ: пилюля, название, роль, Имя Фамилия, тема, время —
  // «а потом его фото». В первой версии фото стояло сверху, а подписи под ним:
  // ровно наоборот. Клиент может переставить их местами галочкой, но по
  // умолчанию — как в задании.

  /**
   * ⚠️⚠️ КАЖДЫЙ ЭЛЕМЕНТ СТОИТ САМ ПО СЕБЕ (миграция 470). Раньше все они
   * лежали в одной колонке, привязанной к фото: подвинуть тему к низу афиши
   * было нельзя — её держали границы колонки.
   *
   * Задана точка — элемент абсолютный и встаёт куда сказано. Точки нет —
   * остаётся в колонке, как было: иначе уже собранные афиши разъехались бы
   * в момент наката.
   */
  const freePos = (x?: number | null, y?: number | null, w?: number | null,
                   defX = 50, defY = 50): React.CSSProperties => {
    const hasX = typeof x === 'number' && Number.isFinite(x)
    const hasY = typeof y === 'number' && Number.isFinite(y)
    // ⚠️ Координата не задана — берём УМОЛЧАНИЕ этого элемента, а не середину:
    // иначе все пять подписей легли бы друг на друга в центре афиши.
    if (!hasX) x = defX
    if (!hasY) y = defY
    const px_ = Math.max(0, Math.min(100, hasX ? x! : 50))
    const py_ = Math.max(0, Math.min(100, hasY ? y! : 50))
    // ⚠️⚠️ НА КРАЯХ ПРИЖИМАЕМ, А НЕ ЦЕНТРИРУЕМ. Элемент ставился серединой на
    // указанную точку (`translate(-50%, -50%)`), поэтому при 100 % его нижняя
    // половина уходила за нижнее поле и обрезалась — «тема не двигалась вниз».
    // Теперь 0 % прижимает элемент верхом к верхнему полю, 100 % — низом к
    // нижнему, а между ними он по-прежнему центрируется по точке. Так ползунок
    // проходит ВСЮ рабочую область и ничего не выходит за поля.
    const tx_ = px_ <= 0 ? '0' : px_ >= 100 ? '-100%' : '-50%'
    const ty_ = py_ <= 0 ? '0' : py_ >= 100 ? '-100%' : '-50%'
    return {
      position: 'absolute',
      left: `${px_}%`,
      top: `${py_}%`,
      transform: `translate(${tx_}, ${ty_})`,
      width: `${Math.max(5, Math.min(100, w ?? 80))}%`,
      // ⚠️ Не даём уехать вбок: при выключке вправо длинная строка иначе
      // вылезла бы за правое поле.
      maxWidth: '100%',
    }
  }
  // ⚠️⚠️ КАЖДЫЙ ЭЛЕМЕНТ ВСЕГДА СТОИТ ПО СВОИМ КООРДИНАТАМ. Раньше он стоял в
  // общей колонке, пока клиент не включит галочку «своё место» — и ползунки
  // до этого ничего не двигали, выглядя сломанными. Колонки больше нет:
  // координата пустая — берём умолчание элемента, но он всё равно абсолютный.

  const photoEl = (
    <div style={{
      width: photoW, height: photoH, position: 'relative',
      overflow: 'hidden', flexShrink: 0, ...maskCss(L),
      ...shift(L.pos_photo_x, L.pos_photo_y),
    }}>
      {cutout ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" style={{
          width: '100%', height: '100%',
          objectFit: 'contain', objectPosition: 'bottom center',
        }} />
      ) : (
        <MaskedPhoto
          url={url} shape={shape} focal={focal} settings={person}
          width={photoW} height={photoH}
          style={{ position: 'absolute', inset: 0 }}
        />
      )}
    </div>
  )

  return (
    <>
    <div style={{
      position: 'absolute',
      // ⚠️ Отсчёт от РАБОЧЕЙ ОБЛАСТИ, как и всё остальное: при смене полей
      // блок не съезжает, а остаётся на той же доле свободного места.
      left: `${Math.max(0, Math.min(100, L.ind_photo_x ?? 50))}%`,
      top: `${Math.max(0, Math.min(100, L.ind_photo_y ?? 55))}%`,
      transform: 'translate(-50%, -50%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      // ⚠️ Не даём блоку вылезти за поля: он центрируется по своей точке, и
      // при крупном фото у края его половина ушла бы за рабочую область.
      maxWidth: '100%',
    }}>
      {/* Название конференции — СВЕРХУ (по ТЗ: пилюля, название, роль, имя…).
          Раньше стояло мелко внизу — это была моя вольность, в задании оно
          идёт вторым сверху. */}
      {photoEl}
    </div>

    {/* ⚠️ Элементы со своей точкой стоят ОТДЕЛЬНО от колонки — прямо на листе.
        Поэтому тему можно опустить к самому низу афиши, а время унести в
        угол: границы колонки их больше не держат. */}
    {L.ind_show_event_title !== false && !!eventTitle && (
      <div style={{
        ...freePos(L.ind_title_x, L.ind_title_y, 90, 50, 10),
        fontFamily: L.ind_title_font ? brandFontCss(L.ind_title_font, label(L.ind_title_font)) : undefined,
        fontSize: tx(L.ind_title_size ?? 22),
        color: L.ind_title_color || 'rgba(255,255,255,0.75)',
        textAlign: L.ind_title_align || 'center',
      }}>{eventTitle}</div>
    )}
    {L.ind_show_role !== false && !!roleText && (
      <div style={{
        ...freePos(L.ind_role_x, L.ind_role_y, 90, 50, 18),
        fontFamily: roleFont, fontSize: tx(L.ind_role_size ?? 24),
        color: L.ind_role_color || gold,
        textTransform: 'uppercase', letterSpacing: '0.08em',
        textAlign: L.ind_role_align || 'center',
      }}>{roleText}</div>
    )}
    {!!nameText && (
      <div style={{
        ...freePos(L.ind_name_x, L.ind_name_y, L.ind_name_w, 50, 26),
        fontFamily: nameFont, fontSize: tx(L.ind_name_size ?? 54), fontWeight: 700,
        color: L.name_color || '#fff',
        textAlign: L.name_align || 'center', lineHeight: 1.1,
      }}>{nameText}</div>
    )}
    {L.ind_show_topic !== false && !!topic && (
      <div style={{
        ...freePos(L.ind_topic_x, L.ind_topic_y, L.ind_topic_w, 50, 36),
        fontFamily: topicFont,
        fontSize: tx(L.ind_topic_size ?? 30),
        color: L.ind_topic_color || '#fff',
        textAlign: L.topic_align || 'center', lineHeight: 1.25,
      }}>{topic}</div>
    )}
    {L.ind_show_time !== false && !!when && (
      <div style={{
        ...freePos(L.ind_time_x, L.ind_time_y, 60, 50, 44),
        fontFamily: timeFont,
        fontSize: tx(L.ind_time_size ?? 24),
        color: L.ind_time_color || gold, textAlign: L.time_align || 'center',
      }}>{when}</div>
    )}
    </>
  )
}
