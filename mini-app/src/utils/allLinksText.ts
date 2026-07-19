/**
 * Текст «все площадки одним куском» для кнопки «Скопировать все ссылки».
 *
 * ⚠️ Формат должен совпадать с web/src/components/CopyAllLinksButton.tsx —
 * Mini App живёт в отдельном бандле и не может импортировать React-компонент
 * из web/, поэтому формат продублирован здесь. Меняете там — меняйте и тут.
 *
 * Между строками — пустая строка:
 *   Через ТГ: <ссылка>
 *
 *   Через MAX: <ссылка>
 *
 *   Через ВК: <ссылка>
 */

export type PlatformLinks = Partial<Record<'telegram' | 'vk' | 'max', string>>

const ORDER: Array<{ key: 'telegram' | 'max' | 'vk'; label: string }> = [
  { key: 'telegram', label: 'Через ТГ' },
  { key: 'max', label: 'Через MAX' },
  { key: 'vk', label: 'Через ВК' },
]

export function buildAllLinksText(links: PlatformLinks): string {
  return ORDER
    .filter(({ key }) => (links[key] || '').trim())
    .map(({ key, label }) => `${label}: ${(links[key] || '').trim()}`)
    .join('\n\n')
}

export function countLinks(links: PlatformLinks): number {
  return ORDER.filter(({ key }) => (links[key] || '').trim()).length
}
