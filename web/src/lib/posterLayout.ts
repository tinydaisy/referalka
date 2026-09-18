/**
 * Раскладка людей на афише: кто где стоит.
 *
 * ⚠️ ОТДЕЛЬНО ОТ ВЁРСТКИ. Порядок и разбивка по рядам считаются здесь, а рисует
 * их полотно. Так один и тот же порядок показывает и афиша, и список внизу
 * редактора, где спикеров перетаскивают: иначе перетащил в списке одно, а на
 * афише встало другое.
 */

export type PosterPerson = {
  id: number
  name: string
  last_name?: string | null
  photo_url?: string | null
  cutout_photo_url?: string | null
  photo_focal?: string | null
  cutout_photo_focal?: string | null
  role: string
  is_company?: boolean | null
  /** Логотип компании для СВЕТЛОГО фона (миграция 450). */
  logo_on_light_url?: string | null
  is_commercial?: boolean | null
  media_assets?: { platform?: string; subscribers?: number }[] | null
}

/** Роли, которые на афише стоят отдельной строкой сверху. */
export const ORGANIZER_ROLES = ['organizer']
/** Выделяемые роли: им положена плашка/лента с подписью роли. */
export const BADGE_LABELS: Record<string, string> = {
  organizer: 'Организатор',
  headliner: 'Хедлайнер',
  general_partner: 'Генеральный партнёр',
}

/** Суммарные подписчики — «крупность» человека. */
export function subscribersOf(p: PosterPerson): number {
  const list = Array.isArray(p.media_assets) ? p.media_assets : []
  return list.reduce((acc, m) => acc + (Number(m?.subscribers) || 0), 0)
}

/**
 * Автопорядок спикеров (без ручного перетаскивания).
 *
 * ⚠️ ПРАВИЛО ВЛАДЕЛЬЦА: самые крупные по медийным активам — ближе к
 * организаторам и ПО КРАЯМ ряда, коммерческие — в середине, остальные дальше.
 * Поэтому просто отсортировать по убыванию нельзя: тогда крупные встали бы
 * подряд слева, а правый край ряда оказался бы пустым по весу.
 *
 * Делаем «ёлочкой»: самый крупный — с краю, следующий — с другого края, и так
 * к центру. Ряд получается симметричным по весу, а середина остаётся под
 * коммерческих.
 */
export function autoOrder(people: PosterPerson[]): PosterPerson[] {
  const commercial = people.filter(p => p.is_commercial)
  const rest = people.filter(p => !p.is_commercial)

  // Крупные вперёд — дальше разложим их по краям.
  const byWeight = [...rest].sort((a, b) => {
    const d = subscribersOf(b) - subscribersOf(a)
    if (d !== 0) return d
    // ⚠️ При равных подписчиках (а их часто вообще не заполняют) хедлайнер
    // всё равно должен стоять выше рядового спикера.
    const rank = (p: PosterPerson) => (p.role === 'headliner' ? 0 : 1)
    return rank(a) - rank(b)
  })

  // Ёлочка: 1-й влево, 2-й вправо, 3-й влево…
  const left: PosterPerson[] = []
  const right: PosterPerson[] = []
  byWeight.forEach((p, i) => (i % 2 === 0 ? left : right).push(p))

  // Коммерческие — ровно посередине, между половинами.
  return [...left, ...commercial, ...right.reverse()]
}

/**
 * Применяем ручной порядок (перетаскивание).
 *
 * ⚠️ Кого в сохранённом порядке нет — дописываем в конец, а не выбрасываем.
 * Иначе спикер, добавленный после того как клиент разложил афишу, молча не
 * попал бы на неё: в списке события он есть, на афише его нет.
 */
export function applyManualOrder(people: PosterPerson[], order: number[]): PosterPerson[] {
  if (!order?.length) return autoOrder(people)
  const pos = new Map(order.map((id, i) => [id, i]))
  const known = people.filter(p => pos.has(p.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!)
  const added = autoOrder(people.filter(p => !pos.has(p.id)))
  return [...known, ...added]
}

/**
 * Сколько человек в ряду — ПОДБИРАЕМ РАСЧЁТОМ, а не угадываем.
 *
 * ⚠️⚠️ ЗДЕСЬ БЫЛИ КОНСТАНТЫ «по 4 / по 6 / по 7», подобранные на глаз, и они
 * давали жуткий результат: на горизонтальной афише 11 человек занимали треть
 * отведённого места, остальное пустовало, а карточки выходили с ноготь. Число
 * в ряду нельзя выбрать, не зная ФОРМЫ области: в одну и ту же «по 6» на
 * широкой и на узкой афише влезают карточки разного размера.
 *
 * Правильно — перебрать все варианты и взять тот, где карточка получается
 * КРУПНЕЕ ВСЕГО. Вариантов максимум дюжина, перебор мгновенный.
 *
 * Размер карточки при `perRow` ограничен двумя величинами:
 *   по ширине  — (100 − промежутки) / perRow;
 *   по высоте  — (высота места − промежутки) / (число рядов × высота ряда).
 * Берём меньшее из них, как и сама раскладка, — иначе подобрали бы вариант,
 * который в реальности не влезает.
 *
 * Всё в процентах ШИРИНЫ рабочей области, `areaH` — её высота в тех же единицах.
 */
export function bestPerRow(
  count: number,
  areaH: number,
  opts: { gap?: number; rowUnit?: number; extraRows?: number; max?: number } = {},
): number {
  if (count <= 1) return 1
  const gap = opts.gap ?? 2
  // Полная высота ряда в долях ширины карточки: фото + подпись + плашка роли.
  const rowUnit = opts.rowUnit ?? 1.81
  // Строка организаторов стоит отдельно и тоже занимает высоту.
  const extraRows = opts.extraRows ?? 0
  const maxPerRow = Math.min(opts.max ?? 12, count)

  let bestPr = 1
  let bestCard = 0
  for (let pr = 1; pr <= maxPerRow; pr++) {
    const rows = Math.ceil(count / pr) + extraRows
    const byWidth = (100 - gap * (pr - 1)) / pr
    const byHeight = (areaH - gap * (rows - 1)) / (rowUnit * rows)
    const card = Math.min(byWidth, byHeight)

    // ⚠️ Строго БОЛЬШЕ, с запасом на копейки. Когда размер упирается в ширину,
    // несколько вариантов дают одинаковую карточку — и тогда побеждает первый,
    // то есть МЕНЬШЕЕ число в ряду. Это и нужно: 11 человек «по 6 в два ряда»
    // читаются лучше, чем «по 8», а лица там ровно того же размера.
    if (card > bestCard + 0.05) {
      bestCard = card
      bestPr = pr
    }
  }
  return bestPr
}

/**
 * Ряды спикеров, заданные РУКАМИ (миграция 445).
 *
 * ⚠️ СКОЛЬКО ПОЛОЖИЛИ В РЯД — СТОЛЬКО И БУДЕТ. Ряды разной длины это норма:
 * так и верстают афиши — сверху двое хедлайнеров крупно, ниже пятеро плотнее.
 * Выравнивать ряды по одной длине нельзя, иначе перетаскивание теряет смысл:
 * человек уедет обратно, как только пересчитается разбивка.
 *
 * ⚠️ Кого в рядах нет — ДОПИСЫВАЕМ в последний ряд, а не выбрасываем. Иначе
 * спикер, добавленный после расстановки, молча не попал бы на афишу.
 * Кого уже нет в событии — убираем.
 */
export function applyManualRows(
  people: PosterPerson[],
  rows: number[][],
): PosterPerson[][] {
  const byId = new Map(people.map(p => [p.id, p]))
  const used = new Set<number>()
  const out: PosterPerson[][] = []

  for (const row of rows || []) {
    const line: PosterPerson[] = []
    for (const id of row || []) {
      const p = byId.get(id)
      // Человека могли удалить из события — тогда просто пропускаем.
      if (!p || used.has(id)) continue
      used.add(id)
      line.push(p)
    }
    if (line.length) out.push(line)
  }

  const rest = people.filter(p => !used.has(p.id))
  if (rest.length) {
    // Новые люди — в последний ряд, чтобы не создавать ряд из одного человека
    // при каждом добавлении. Если рядов ещё нет вовсе — новый ряд.
    if (out.length) out[out.length - 1].push(...rest)
    else out.push(rest)
  }
  return out
}

/**
 * Разложить людей на ЗАДАННОЕ число рядов.
 *
 * ⚠️ Остаток раскидываем по ВЕРХНИМ рядам, а не оставляем «хвост» в последнем.
 * 13 человек на 3 ряда — это 5+4+4, а не 5+5+3: сверху стоят те, кто важнее
 * (ряды идут по порядку), и верхний ряд логично сделать не короче нижнего.
 * Заодно ряды выходят почти одинаковой длины, и сетка не выглядит рваной.
 */
export function splitIntoRows<T>(items: T[], rowCount: number): T[][] {
  const n = Math.max(1, Math.min(rowCount, items.length || 1))
  const base = Math.floor(items.length / n)
  const extra = items.length % n
  const out: T[][] = []
  let i = 0
  for (let r = 0; r < n; r++) {
    const take = base + (r < extra ? 1 : 0)
    out.push(items.slice(i, i + take))
    i += take
  }
  return out.filter(r => r.length)
}

/**
 * Разбивка на ряды.
 *
 * ⚠️ Последний неполный ряд ЦЕНТРИРУЕТСЯ самой вёрсткой (justify-content:
 * center), а не добивается пустыми местами: два человека, прижатые к левому
 * краю под ровными рядами, выглядят как ошибка вёрстки. На примере владельца
 * (21 спикер) последний ряд из двух стоит ровно по центру.
 */
export function splitRows<T>(items: T[], perRow: number): T[][] {
  const n = Math.max(1, perRow)
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += n) rows.push(items.slice(i, i + n))
  return rows
}

/** Подпись человека по настройкам: порядок слов и перенос строк. */
export function personLines(
  p: PosterPerson,
  order: 'first_last' | 'last_first',
  lines: 1 | 2,
): string[] {
  // ⚠️ В базе `name` — это ИМЯ, фамилия отдельным полем. У части карточек
  // фамилия пустая (организация, один псевдоним) — тогда строка одна.
  const first = (p.name || '').trim()
  const last = (p.last_name || '').trim()
  const parts = order === 'last_first' ? [last, first] : [first, last]
  const clean = parts.filter(Boolean)
  if (clean.length === 0) return []
  if (lines === 1 || clean.length === 1) return [clean.join(' ')]
  return clean
}
