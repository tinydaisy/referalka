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

/**
 * Достаёт чистый ник из того, что лежит в `platform_users.username`.
 *
 * ⚠️ Там бывает НЕ только ник: на проде 29 записей хранят полную ссылку
 * (`https://vk.com/natalya_barvinskaya`, 15 в VK, 10 в MAX, 4 в TG) — их
 * вписывали руками. Без очистки ссылка склеивалась бы сама с собой
 * (`vk.com/https://vk.com/...`) и вела в никуда.
 *
 * Данные в базе при этом НЕ трогаем — чиним только показ.
 */
function cleanNick(raw?: string | null): string {
  let v = String(raw || '').trim()
  if (!v) return ''

  // ⚠️ В поле бывает не только ник и не только ссылка, но и ЦЕЛАЯ ФРАЗА —
  // люди вставляют текст приглашения целиком: «Я пользуюсь мессенджером MAX.
  // Присоединяйся! https://max.ru/u/f9L…». Такая строка распирала колонку
  // «Площадки», и остальные колонки уезжали за край экрана. Вытаскиваем
  // ссылку из текста, а если её нет — обрезаем до вменяемой длины.
  const urlInText = v.match(/https?:\/\/\S+/i)
  if (urlInText) v = urlInText[0]

  // Полная ссылка или домен без схемы — берём последний непустой сегмент.
  if (/^https?:\/\//i.test(v) || /^(t\.me|telegram\.me|vk\.com|max\.ru)\//i.test(v)) {
    v = v.replace(/^https?:\/\//i, '').split(/[?#]/)[0]
    const parts = v.split('/').filter(Boolean)
    v = parts.length > 1 ? parts[parts.length - 1] : ''
  }

  v = v.replace(/^@+/, '').trim()
  // Ников длиннее 32 символов не бывает ни на одной площадке — значит это
  // мусор, и показывать его целиком незачем.
  return v.length > 32 ? v.slice(0, 32) + '…' : v
}

export default function PlatformList({ p }: { p: PlatformIdentities }) {
  const items: { key: string; label: string; color: string; nick: string; href?: string }[] = []

  // ⚠️ Псевдо-запись: у человека, ещё не заходившего в бота, в поле id лежит
  // «@ник» вместо числа. Показывать его как id незачем — это тот же ник.
  const isPseudo = (v?: string | null) => !!v && String(v).trim().startsWith('@')

  const tgNick = cleanNick(p.tg_username) || (isPseudo(p.tg_id) ? cleanNick(p.tg_id) : '')
  if (p.tg_id || tgNick) {
    items.push({
      key: 'tg', label: 'TG', color: '#229ED9',
      // Ника нет — показываем числовой id: он тоже опознаёт человека,
      // а публичной ссылки на профиль по нему не существует.
      nick: tgNick ? `@${tgNick}` : String(p.tg_id),
      href: tgNick ? `https://t.me/${tgNick}` : undefined,
    })
  }

  const vkNick = cleanNick(p.vk_username) || (isPseudo(p.vk_id) ? cleanNick(p.vk_id) : '')
  if (p.vk_id || vkNick) {
    const numericVk = p.vk_id && /^\d+$/.test(String(p.vk_id)) ? String(p.vk_id) : ''
    items.push({
      key: 'vk', label: 'VK', color: '#0077FF',
      nick: vkNick ? `@${vkNick}` : (numericVk ? `id${numericVk}` : String(p.vk_id)),
      href: vkNick ? `https://vk.com/${vkNick}` : (numericVk ? `https://vk.com/id${numericVk}` : undefined),
    })
  }

  const maxNick = cleanNick(p.max_username) || (isPseudo(p.max_id) ? cleanNick(p.max_id) : '')
  if (p.max_id || maxNick) {
    items.push({
      key: 'max', label: 'MAX', color: '#C79A5B',
      nick: maxNick ? `@${maxNick}` : String(p.max_id),
      // ⚠️ Ссылку по числовому id НЕ строим: `max.ru/u/{id}` битая — нужен
      // приватный хеш, которого Bot API не отдаёт (см. profile_links.py).
      href: maxNick ? `https://max.ru/${maxNick}` : undefined,
    })
  }

  if (items.length === 0) return <span className="text-gray-300">—</span>

  return (
    // ⚠️ Ширина ограничена: иначе длинное содержимое поля растягивает колонку,
    // и соседние («Регистрация», «Оплата») уезжают за край экрана.
    <div className="flex flex-col gap-1 max-w-[200px]">
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
