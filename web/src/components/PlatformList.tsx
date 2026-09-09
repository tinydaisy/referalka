'use client'

/**
 * Площадки человека — ИКОНКА + НИК, по одной на строку.
 *
 * ⚠️ Решение владельца 09.09.2026: значки в ряд без ников показывали только
 * факт «есть Telegram», а нужно видеть, под каким аккаунтом человек известен
 * и куда ему написать. Поэтому строка на площадку и ник рядом со значком.
 *
 * ⚠️ Один компонент на все места показа (список рефоводов и карточка
 * рефовода со списком его людей) — своей копии в экране быть не должно,
 * иначе экраны разъедутся, как это уже случалось с подсчётом оплат.
 */

export interface PlatformIdentities {
  tg_id?: string | null
  tg_username?: string | null
  vk_id?: string | null
  vk_username?: string | null
  max_id?: string | null
  max_username?: string | null
}

export default function PlatformList({ p }: { p: PlatformIdentities }) {
  const items: { key: string; label: string; color: string; nick: string; href?: string }[] = []

  const tgNick = p.tg_username ? String(p.tg_username).replace(/^@+/, '') : ''
  if (p.tg_id || tgNick) {
    items.push({
      key: 'tg', label: 'TG', color: '#229ED9',
      // Ника нет — показываем числовой id: он тоже опознаёт человека,
      // а ссылку на профиль по нему построить нельзя.
      nick: tgNick ? `@${tgNick}` : String(p.tg_id),
      href: tgNick ? `https://t.me/${tgNick}` : undefined,
    })
  }

  const vkNick = p.vk_username ? String(p.vk_username).replace(/^@+/, '') : ''
  if (p.vk_id || vkNick) {
    items.push({
      key: 'vk', label: 'VK', color: '#0077FF',
      nick: vkNick ? `@${vkNick}` : `id${p.vk_id}`,
      href: vkNick ? `https://vk.com/${vkNick}` : (p.vk_id ? `https://vk.com/id${p.vk_id}` : undefined),
    })
  }

  const maxNick = p.max_username ? String(p.max_username).replace(/^@+/, '') : ''
  if (p.max_id || maxNick) {
    items.push({
      key: 'max', label: 'MAX', color: '#C79A5B',
      nick: maxNick ? `@${maxNick}` : String(p.max_id),
      href: maxNick ? `https://max.ru/${maxNick}` : (p.max_id ? `https://max.ru/u/${p.max_id}` : undefined),
    })
  }

  if (items.length === 0) return <span className="text-gray-300">—</span>

  return (
    <div className="flex flex-col gap-1">
      {items.map(i => {
        const badge = (
          <span
            className="inline-flex items-center justify-center w-8 shrink-0 rounded text-[9px] font-bold text-white py-0.5"
            style={{ background: i.color }}
          >
            {i.label}
          </span>
        )
        return i.href ? (
          <a key={i.key} href={i.href} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-[#25455D] hover:underline">
            {badge}<span className="truncate">{i.nick}</span>
          </a>
        ) : (
          <span key={i.key} className="inline-flex items-center gap-1.5 text-xs text-gray-500">
            {badge}<span className="truncate">{i.nick}</span>
          </span>
        )
      })}
    </div>
  )
}
