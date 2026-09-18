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
 * Сколько человек в ряду, если клиент не задал сам.
 *
 * ⚠️ Считаем от количества и формата, а не берём фиксированное число: 21 спикер
 * по 4 в ряд на горизонтальной афише даёт 6 рядов — карточки становятся
 * микроскопическими. На примерах владельца: горизонтальная 21 человек — по 7,
 * вертикальная — по 4.
 */
export function defaultPerRow(count: number, orientation: string): number {
  if (count <= 0) return 1
  if (orientation === 'horizontal') {
    if (count <= 4) return count
    if (count <= 8) return 4
    if (count <= 12) return 6
    return 7
  }
  if (orientation === 'square') {
    if (count <= 3) return count
    if (count <= 8) return 4
    return 5
  }
  // Вертикальная: узкая, больше 4 в ряд лица становятся неразличимы.
  if (count <= 2) return count
  if (count <= 6) return 3
  return 4
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
