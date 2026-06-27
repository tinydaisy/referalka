'use client'

/**
 * Блок «Чаты события» — 3 ссылки на чаты (Telegram / ВКонтакте / MAX) +
 * radio «какой главный». Используется в Основном таб мероприятия, Настройках
 * конференции и Конкурсе. Главный чат показывается участникам выделенной
 * крупной кнопкой, остальные — как «резервные».
 *
 * Родитель хранит value/onChange, сам собирает diff и шлёт PATCH.
 */

export type ChatPlatform = 'telegram' | 'vk' | 'max'

export interface EventChatsValue {
  tg: string                 // events.chat_url_tg
  vk: string                 // events.chat_url_vk
  max: string                // events.chat_url_max
  primary: ChatPlatform | null  // events.primary_chat_platform
  tgChatId?: string          // events.tg_chat_id  (chat_id беседы — слушалка заданий)
  vkChatId?: string          // events.vk_chat_id
  maxChatId?: string         // events.max_chat_id
}

interface Props {
  value: EventChatsValue
  onChange: (next: EventChatsValue) => void
}

const PLATFORM_META: Record<ChatPlatform, { label: string; badge: string; color: string; placeholder: string }> = {
  telegram: { label: 'Telegram',  badge: 'TG',  color: '#229ED9', placeholder: 'https://t.me/your_chat' },
  vk:       { label: 'ВКонтакте', badge: 'VK',  color: '#0077FF', placeholder: 'https://vk.com/your_chat' },
  max:      { label: 'MAX',       badge: 'MAX', color: '#F45D22', placeholder: 'https://max.ru/your_chat' },
}

export default function EventChatsField({ value, onChange }: Props) {
  // Если primary не выбран, но какая-то ссылка есть — подсветим первую
  // заполненную в подсказке (UI), не записывая в value (это сделает родитель).
  const filledPlatforms: ChatPlatform[] = (['telegram', 'vk', 'max'] as const).filter(p => {
    const k = p === 'telegram' ? 'tg' : p
    return !!(value as any)[k]?.trim()
  })

  function setUrl(platform: ChatPlatform, url: string) {
    const key = platform === 'telegram' ? 'tg' : platform
    const next = { ...value, [key]: url }
    // Авто-выбор primary: если primary ещё не выбран и юзер только что заполнил
    // первое поле — ставим primary на эту платформу.
    if (!next.primary && url.trim()) {
      next.primary = platform
    }
    // Если очищена ссылка которая была primary — снимаем primary, выбираем
    // следующую заполненную (если есть).
    if (next.primary === platform && !url.trim()) {
      const others = (['telegram', 'vk', 'max'] as const).filter(p => p !== platform)
      const newPrimary = others.find(p => {
        const k = p === 'telegram' ? 'tg' : p
        return !!(next as any)[k]?.trim()
      })
      next.primary = newPrimary || null
    }
    onChange(next)
  }

  function setPrimary(platform: ChatPlatform) {
    const key = platform === 'telegram' ? 'tg' : platform
    if (!(value as any)[key]?.trim()) {
      // Нельзя выбрать главным пустое поле
      return
    }
    onChange({ ...value, primary: platform })
  }

  return (
    <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg space-y-3">
      <div>
        <label className="block text-sm font-semibold text-gray-800">Чаты события</label>
        <p className="text-xs text-gray-500 mt-1">
          Заполните ссылки на чаты для тех площадок, которые планируете использовать. Радио-кнопкой выберите <b>главный чат</b>: его участники увидят первым после проверки подписки, остальные — как «резервные».
        </p>
      </div>

      {(['telegram', 'vk', 'max'] as const).map(platform => {
        const meta = PLATFORM_META[platform]
        const key = platform === 'telegram' ? 'tg' : platform
        const url = (value as any)[key] as string
        const isPrimary = value.primary === platform
        const canBePrimary = !!url?.trim()
        return (
          <div key={platform} className="bg-white border border-gray-200 rounded p-3">
            <div className="flex items-center gap-3 mb-2">
              <input
                type="radio"
                name="primary_chat_platform"
                checked={isPrimary}
                onChange={() => setPrimary(platform)}
                disabled={!canBePrimary}
                className="w-4 h-4 cursor-pointer disabled:cursor-not-allowed"
                style={{ accentColor: '#25455D' }}
                title={canBePrimary ? 'Сделать главным чатом' : 'Сначала заполните ссылку'}
              />
              <span
                className="inline-flex items-center justify-center w-9 h-7 rounded text-[10px] font-bold text-white shrink-0"
                style={{ background: meta.color }}
              >
                {meta.badge}
              </span>
              <span className="text-sm font-medium text-gray-800">{meta.label}</span>
              {isPrimary && (
                <span className="ml-auto text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded"
                      style={{ background: '#FFCFA4', color: '#25455D' }}>
                  Главный
                </span>
              )}
            </div>
            <input
              type="url"
              value={url}
              onChange={e => setUrl(platform, e.target.value)}
              placeholder={meta.placeholder}
              className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-[#25455D]"
            />
            {platform === 'telegram' && (
              <p className="text-[11px] text-gray-500 mt-1">
                Для закрытого канала — инвайт-ссылка вида https://t.me/+abcDEF…
              </p>
            )}
            {(() => {
              const cidKey = platform === 'telegram' ? 'tgChatId' : platform === 'vk' ? 'vkChatId' : 'maxChatId'
              const cidVal = (value as any)[cidKey] as string
              return (
                <div className="mt-2 pt-2 border-t border-dashed border-gray-200">
                  <label className="block text-[11px] text-gray-600 mb-1">
                    ID чата для подсчёта заданий{' '}
                    <span className="text-gray-400">— бот считает выкладки в этом чате</span>
                  </label>
                  <input
                    type="text"
                    value={cidVal || ''}
                    onChange={e => onChange({ ...value, [cidKey]: e.target.value.trim() })}
                    placeholder="напишите /chatid в беседе → бот пришлёт ID"
                    className="w-full px-3 py-1.5 text-sm font-mono bg-white border border-gray-200 rounded focus:outline-none focus:border-[#25455D]"
                  />
                  <p className="text-[11px] text-gray-500 mt-1">
                    Добавьте вашего бота в этот чат и напишите там <code className="font-mono">/chatid</code> — бот ответит числовым ID. Вставьте его сюда.
                  </p>
                </div>
              )
            })()}
          </div>
        )
      })}

      {filledPlatforms.length === 0 && (
        <p className="text-xs text-gray-400 italic">
          Если ни одной ссылки не задано — плитка «Чат» в Mini App у участников не покажется.
        </p>
      )}
    </div>
  )
}
