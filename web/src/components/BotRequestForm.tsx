'use client'

/**
 * «Опишите, что вам нужно» → текст уезжает в наш бот. ОДИН компонент на проект.
 *
 * ⚠️⚠️ ЗАЧЕМ ОБЩИЙ. Тот же сценарий нужен в услугах, в автонастройке и в
 * техподдержке: человек пишет текст на сайте, выбирает площадку и попадает в
 * бота, где мы его текст уже видим. Отличается только `kind` и подписи.
 * Появится следующее место — передайте свой `kind`, а не копируйте файл.
 *
 * ⚠️ ТЕКСТ НЕ ЕДЕТ В ССЫЛКЕ. В `?start=` у Telegram помещается 64 символа и
 * только латиница — кириллица ссылку ломает. Поэтому текст сохраняется у нас, а
 * в ссылку уходит короткий токен (разбор — services/bot_text_request.py).
 *
 * ⚠️ Ссылки на площадки собирает БЭКЕНД: у ВК параметр называется `ref`, а не
 * `start`, и знать об этом должно одно место, а не каждая форма.
 */
import { useState } from 'react'

type Platform = { slug: string; label: string; enabled: boolean; url: string }

const apiBase = process.env.NEXT_PUBLIC_API_URL || ''

// Иконка площадки — эмодзи, чтобы не тянуть картинки на публичную страницу.
const ICONS: Record<string, string> = { telegram: '✈️', max: '🅼', vk: 'ВК' }

export default function BotRequestForm({
  kind = 'service',
  placeholder = 'Например: нужно подключить свой домен и платёжную систему. Ещё хочу вести вебинары — не понимаю, как настроить комнату.',
  askName = true,
  onDone,
}: {
  kind?: 'service' | 'autosetup' | 'support'
  placeholder?: string
  askName?: boolean
  onDone?: () => void
}) {
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [platforms, setPlatforms] = useState<Platform[] | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (text.trim().length < 5) {
      return setError('Опишите, что нужно — хотя бы пару слов')
    }
    setBusy(true)
    try {
      const res = await fetch(`${apiBase}/api/v1/public/bot-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.trim(),
          kind,
          name: name.trim() || null,
          contact: contact.trim() || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail || 'Не удалось отправить')
      setPlatforms(data.platforms || [])
      onDone?.()
    } catch (e: any) {
      setError(e?.message || 'Что-то пошло не так')
    } finally {
      setBusy(false)
    }
  }

  // Текст сохранён — показываем, куда идти дальше.
  if (platforms) {
    const live = platforms.filter(p => p.enabled)
    return (
      <div className="text-center">
        <div className="text-3xl mb-3">📝</div>
        <h3 className="text-lg font-bold text-gray-900 mb-2">
          Записали. Остался один шаг
        </h3>
        <p className="text-gray-500 mb-6 text-sm">
          Откройте наш бот — ваше описание уже там. Мы посмотрим, что нужно
          сделать, и напишем вам: уточним детали и назовём стоимость.
        </p>

        <div className="flex flex-wrap justify-center gap-3">
          {live.map(p => (
            <a key={p.slug} href={p.url} target="_blank" rel="noreferrer"
               className="btn-gold inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold">
              <span aria-hidden>{ICONS[p.slug] || '💬'}</span>
              {p.label}
            </a>
          ))}
        </div>

        {/* Выключенные площадки показываем серыми, а не прячем: человек ищет
            свою и должен понимать, что она будет, а не что её нет. */}
        {platforms.some(p => !p.enabled) && (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {platforms.filter(p => !p.enabled).map(p => (
              <span key={p.slug}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                               bg-gray-100 text-gray-400 text-xs">
                {p.label} — скоро
              </span>
            ))}
          </div>
        )}

        {live.length === 0 && (
          <p className="text-sm text-red-600">
            Боты сейчас недоступны. Напишите нам на почту — мы ответим.
          </p>
        )}
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block">
        <span className="block text-sm text-gray-700 mb-1">
          Что нужно сделать?<span className="text-red-500"> *</span>
        </span>
        <textarea value={text} onChange={e => setText(e.target.value)}
                  rows={5} placeholder={placeholder} maxLength={4000}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5
                             focus:outline-none focus:ring-2"
                  style={{ ['--tw-ring-color' as any]: '#FFCFA4' }} />
        <span className="block text-xs text-gray-400 mt-1">
          Своими словами — как получится. Не знаете точно, что нужно? Опишите
          задачу, разберёмся вместе.
        </span>
      </label>

      {askName && (
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-sm text-gray-700 mb-1">Как вас зовут</span>
            <input value={name} onChange={e => setName(e.target.value)}
                   placeholder="Имя"
                   className="w-full rounded-lg border border-gray-300 px-3 py-2.5
                              focus:outline-none focus:ring-2"
                   style={{ ['--tw-ring-color' as any]: '#FFCFA4' }} />
          </label>
          <label className="block">
            <span className="block text-sm text-gray-700 mb-1">
              Телефон или почта
            </span>
            <input value={contact} onChange={e => setContact(e.target.value)}
                   placeholder="Необязательно"
                   className="w-full rounded-lg border border-gray-300 px-3 py-2.5
                              focus:outline-none focus:ring-2"
                   style={{ ['--tw-ring-color' as any]: '#FFCFA4' }} />
          </label>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <button type="submit" disabled={busy} className="btn-gold w-full">
        {busy ? 'Отправляем…' : 'Оставить заявку'}
      </button>
    </form>
  )
}
