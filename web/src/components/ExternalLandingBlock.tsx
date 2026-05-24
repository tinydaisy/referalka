'use client'
import { useState } from 'react'
import { Copy, Check, Globe } from 'lucide-react'
import { useMe } from '@/hooks/useMe'

interface Props {
  slug?: string | null
  value: string
  onChange: (v: string) => void
}

// Возврат после регистрации на стороннем лендинге — по-платформенно.
//
// ⚠️ TG идёт ТОЛЬКО через pluson.ru/r/{slug}, не через прямой t.me/.../pluson?startapp=.
// Причина — типовой сценарий: участник открыл лендинг ИЗНУТРИ Mini App webview
// (через events.landing_url), зарегался, кликнул кнопку возврата. Если кнопка
// прямой t.me — Telegram перехватывает universal link и открывает ЧАТ, не Mini
// App (нельзя открыть второй Mini App поверх текущего webview). Промежуточная
// страница /r/{slug} делает window.location.replace в ТОМ ЖЕ webview → Mini App
// продолжается, юзер не выпадает в чат. Если SDK недоступен (обычный браузер) —
// /r/{slug} сама фолбэчится на t.me/.../pluson?startapp=..._reg.
// (См. memory: feedback_landing_return_dont_break.md.)
//
// VK / MAX — прямые ссылки. Промежуточной страницы под них нет, и сценарий
// «лендинг внутри Mini App» решается по-другому (VK Bridge / MAX SDK).
//
//   TG  → pluson.ru/r/{slug}               (universal — работает в обоих контекстах)
//   VK  → vk.com/app{vk_app_id}#ref_pg{slug}_reg
//   MAX → max.ru/{handle}?startapp=ref_pg{slug}_reg
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://pluson.ru'

type Platform = 'telegram' | 'vk' | 'max'
const PLATFORM_LABEL: Record<Platform, string> = {
  telegram: 'Telegram',
  vk: 'VK',
  max: 'MAX',
}

export default function ExternalLandingBlock({ slug, value, onChange }: Props) {
  const { me } = useMe()
  const [copied, setCopied] = useState<string | null>(null)

  function copy(key: string, text: string) {
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  const slugStr = slug || ''
  const available: string[] = Array.isArray(me?.available_platforms)
    ? me!.available_platforms
    : []
  const handles = (me?.bot_handles || {}) as {
    telegram?: string | null; vk?: string | null; max?: string | null
  }
  const vkAppId = me?.vk_app_id ? Number(me.vk_app_id) : null

  // Ссылка возврата для платформы. `null` — платформа недоступна для
  // этого клиента (нет своего канала, и системного нет/не используется).
  function urlFor(p: Platform): string | null {
    if (!slugStr) return null
    if (p === 'telegram') {
      // ВАЖНО: через нашу промежуточную /r/{slug}, не через прямой t.me.
      // /r/{slug} остаётся в том же webview (если лендинг открыт внутри Mini App)
      // и фолбэчится на t.me/.../pluson?startapp=..._reg в обычном браузере.
      return `${APP_URL}/r/${encodeURIComponent(slugStr)}`
    }
    if (p === 'vk') {
      // VK работает только при собственном Mini App клиента — системный
      // ПЛЮСОНовский VK не используется для чужих клиентов (нет права писать).
      if (!handles.vk || !vkAppId) return null
      return `https://vk.com/app${vkAppId}#ref_pg${encodeURIComponent(slugStr)}_reg`
    }
    if (p === 'max') {
      const handle = (handles.max || '').replace(/^@/, '')
      if (!handle) return null
      return `https://max.ru/${handle}?startapp=ref_pg${encodeURIComponent(slugStr)}_reg`
    }
    return null
  }

  // Какие платформы показывать. TG показываем всегда (fallback на pluson_bot).
  // VK / MAX — только если у клиента подключён свой канал (см. urlFor).
  const platforms: Platform[] = (['telegram', 'vk', 'max'] as Platform[]).filter(p => {
    if (p === 'telegram') return true
    if (!available.includes(p)) return false
    return urlFor(p) !== null
  })

  // Для синего блока «можно сразу передать email/телефон» используем TG-ссылку
  // как универсальный пример — параметры через ?/& работают одинаково на всех.
  const exampleUrl = urlFor('telegram') || ''
  const hasAnyUrl = slugStr && platforms.some(p => urlFor(p))

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <Globe size={16} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-gray-800">
          Подключение стороннего лендинга
        </h3>
      </div>
      <p className="text-xs text-gray-500 mb-3 leading-relaxed">
        Если у вас уже есть лендинг события на Tilda, GetCourse, Taplink или
        другом конструкторе — вставьте сюда его адрес. Mini App будет
        открывать ваш лендинг для участников вместо встроенной страницы.
      </p>

      <label className="block text-sm font-medium text-gray-700 mb-1.5">
        URL вашего лендинга
      </label>
      <input
        type="url"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="https://yoursite.com/event"
        className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
      />

      {hasAnyUrl && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-3.5">
          <p className="text-xs font-semibold text-amber-900 mb-1">
            После регистрации направляйте людей сюда:
          </p>
          <p className="text-xs text-amber-800 mb-3 leading-relaxed">
            В настройках формы вашего лендинга укажите редирект после успешной
            регистрации на ссылку под нужную платформу — человек попадёт в Mini App
            и сразу увидит экран поздравления. Выберите ту платформу, через
            которую вы привлекаете участников.
          </p>

          <div className="space-y-2">
            {platforms.map((p) => {
              const url = urlFor(p)
              if (!url) return null
              return (
                <div key={p} className="flex gap-2 items-center">
                  <span className="w-20 shrink-0 text-xs font-semibold text-gray-500">
                    {PLATFORM_LABEL[p]}
                  </span>
                  <input
                    type="text"
                    value={url}
                    readOnly
                    className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-white border border-amber-200 text-[11px] text-gray-700 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => copy(p, url)}
                    className="px-2.5 py-2 rounded-lg border border-amber-200 bg-white hover:bg-amber-50 shrink-0"
                    title="Скопировать"
                  >
                    {copied === p
                      ? <Check size={13} className="text-green-600" />
                      : <Copy size={13} className="text-amber-900" />}
                  </button>
                </div>
              )
            })}
          </div>

          {exampleUrl && (
            <div className="mt-3 rounded-lg bg-blue-50 border border-blue-200 p-2.5">
              <p className="text-[11px] font-bold text-blue-900 mb-1">
                💡 Можно сразу передать email/телефон/имя
              </p>
              <p className="text-[11px] text-blue-800 leading-relaxed mb-1.5">
                Допишите параметры через <code className="bg-white px-1 rounded">&amp;</code>{' '}
                — мы создадим контакт сразу с этими данными, без отдельного webhook.
                GetCourse/Tilda сами подставят значения вместо плейсхолдеров:
              </p>
              <code className="block text-[10px] text-blue-900 font-mono bg-white px-2 py-1.5 rounded break-all leading-relaxed">
                {exampleUrl}&amp;email={'{email}'}&amp;phone={'{phone}'}&amp;first_name={'{first_name}'}
              </code>
              <p className="text-[10px] text-blue-700 mt-1.5 leading-relaxed">
                Поддерживаемые параметры: <code className="bg-white px-1 rounded">email</code>,{' '}
                <code className="bg-white px-1 rounded">phone</code>,{' '}
                <code className="bg-white px-1 rounded">first_name</code>,{' '}
                <code className="bg-white px-1 rounded">last_name</code>,{' '}
                <code className="bg-white px-1 rounded">pid</code> (партнёрский код),{' '}
                <code className="bg-white px-1 rounded">utm_source</code>.
              </p>
            </div>
          )}

        </div>
      )}
    </div>
  )
}
