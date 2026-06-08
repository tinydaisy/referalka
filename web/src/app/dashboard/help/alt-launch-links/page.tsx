'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, ExternalLink, Copy, Check, Bot, MonitorSmartphone, Globe } from 'lucide-react'
import { api } from '@/lib/api'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

interface EventRow { id: number; slug: string; title: string; module_slug: string; status: string }

// Три варианта запуска ссылки в Telegram.
const MODES = [
  {
    id: 'bot_app',
    label: 'Бот → кнопка на приложение',
    note: 'Сначала открывается чат с ботом. Бот пишет приветствие с кнопкой, по которой человек открывает Mini App. Удобно, когда важно, чтобы человек сначала «подписался» на бота и получил от него сообщение.',
    icon: Bot,
  },
  {
    id: 'bot_landing',
    label: 'Бот → кнопка на лендинг события',
    note: 'Сначала открывается чат с ботом. Бот пишет приветствие с кнопкой на ваш сторонний лендинг события (Tilda / GetCourse и т.п.). Если у события лендинг не задан — кнопка откроет приложение (как первый вариант).',
    icon: Globe,
  },
  {
    id: 'app_nolend',
    label: 'Сразу приложение, без лендинга',
    note: 'Открывает Mini App напрямую (как обычная ссылка), НО даже если у события задан сторонний лендинг — он не показывается. Регистрация идёт через встроенную страницу события. Подходит, когда нужно «отключить» лендинг для конкретной рассылки/потока.',
    icon: MonitorSmartphone,
  },
] as const

export default function AltLaunchLinksPage() {
  const [events, setEvents] = useState<EventRow[]>([])
  const [botHandle, setBotHandle] = useState<string | null>(null) // handle своего TG-бота клиента (без @) или null = системный @pluson_bot
  const [loading, setLoading] = useState(true)

  const [slug, setSlug] = useState('')
  const [mode, setMode] = useState<string>('bot_app')
  const [useOwnBot, setUseOwnBot] = useState(false)

  useEffect(() => {
    Promise.all([
      api.events.list().then((r: any) => Array.isArray(r) ? r : (r?.events || [])).catch(() => []),
      api.auth.me().then((m: any) => m).catch(() => null),
    ]).then(([evs, me]: [EventRow[], any]) => {
      const published = evs.filter(e => e.status !== 'draft')
      setEvents(published.length ? published : evs)
      if (published.length) setSlug(published[0].slug)
      else if (evs.length) setSlug(evs[0].slug)
      const handle = me?.bot_handles?.telegram || null
      setBotHandle(handle)
      setUseOwnBot(!!handle) // если есть свой бот — по умолчанию собираем под него
      setLoading(false)
    })
  }, [])

  // Имя бота для ссылки.
  // Свой бот клиента (VIP): t.me/{handle}
  // Общий @pluson_bot:      t.me/pluson_bot (для startapp добавляем short-name /pluson)
  function botBase(forStartapp: boolean) {
    if (useOwnBot && botHandle) return `https://t.me/${botHandle}`
    return forStartapp ? `https://t.me/pluson_bot/pluson` : `https://t.me/pluson_bot`
  }

  // Сборка ссылки под выбранный режим.
  function buildLink(modeId: string, slugValue: string) {
    if (modeId === 'bot_app') {
      // Бот-флоу через ?start= : бот пришлёт кнопку на Mini App.
      return `${botBase(false)}?start=ref_pg${slugValue}`
    }
    if (modeId === 'bot_landing') {
      // Бот-флоу через ?start= с флагом _land : бот пришлёт кнопку на лендинг.
      return `${botBase(false)}?start=ref_pg${slugValue}_land`
    }
    // app_nolend — прямое открытие Mini App с флагом _nolend.
    return `${botBase(true)}?startapp=ref_pg${slugValue}_nolend`
  }

  const selectedMode = MODES.find(m => m.id === mode)!
  const link = slug ? buildLink(mode, slug) : ''

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Альтернативные ссылки запуска в Telegram</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Альтернативные ссылки запуска в Telegram</h1>
          <p className="text-sm text-gray-500 mt-1">
            Обычная ссылка на событие сразу открывает Mini App. Иногда нужно по-другому: чтобы сначала
            открылся чат с ботом, или чтобы человек попал на ваш лендинг, или наоборот — чтобы лендинг
            не показывался. Здесь — три готовых варианта.
          </p>
        </div>
      </div>

      {/* Три варианта */}
      <Section step="1" title="Выберите, как должна работать ссылка">
        <div className="space-y-2 mb-4">
          {MODES.map(m => {
            const Icon = m.icon
            const active = mode === m.id
            return (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className="w-full text-left rounded-xl border p-3 flex gap-3 transition"
                style={{
                  borderColor: active ? BRAND : '#e5e7eb',
                  background: active ? '#f0f5f9' : '#fff',
                }}>
                <div className="mt-0.5 flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-white"
                     style={{ background: active ? 'linear-gradient(45deg, #25455D, #0a1520)' : '#cbd5e1' }}>
                  <Icon size={17} />
                </div>
                <div>
                  <div className="text-sm font-semibold" style={{ color: BRAND }}>{m.label}</div>
                  <p className="text-xs text-gray-600 leading-snug mt-0.5">{m.note}</p>
                </div>
              </button>
            )
          })}
        </div>
      </Section>

      {/* Генератор */}
      <Section step="2" title="Готовая ссылка под ваше событие">
        {loading ? (
          <p className="text-sm text-gray-400">Загружаем ваши события…</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-gray-500">
            У вас пока нет опубликованных событий. Создайте и опубликуйте событие, тогда здесь появится генератор ссылок.
          </p>
        ) : (
          <>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Событие</label>
            <select
              value={slug}
              onChange={e => setSlug(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm mb-4 bg-white">
              {events.map(e => (
                <option key={e.id} value={e.slug}>{e.title} ({e.slug})</option>
              ))}
            </select>

            {botHandle && (
              <label className="flex items-center gap-2 mb-4 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useOwnBot}
                  onChange={e => setUseOwnBot(e.target.checked)}
                  className="w-4 h-4"
                />
                Собрать под свой бот <code className="text-xs">@{botHandle}</code>
                {!useOwnBot && <span className="text-gray-400 text-xs">(сейчас — общий @pluson_bot)</span>}
              </label>
            )}

            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 mb-2">
              <div className="text-xs font-semibold mb-1.5" style={{ color: BRAND }}>{selectedMode.label}</div>
              <CopyBlock value={link} />
            </div>
            <p className="text-xs text-gray-500">{selectedMode.note}</p>
          </>
        )}
      </Section>

      {/* Как это работает — таблица */}
      <Section step="?" title="Что за хвосты в ссылке">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left" style={{ color: BRAND }}>
                <th className="py-2 pr-3 border-b border-gray-200 font-semibold">Вариант</th>
                <th className="py-2 pr-3 border-b border-gray-200 font-semibold">Формат ссылки</th>
                <th className="py-2 border-b border-gray-200 font-semibold">Что делает</th>
              </tr>
            </thead>
            <tbody className="text-gray-700">
              <tr>
                <td className="py-2 pr-3 border-b border-gray-100">Бот → приложение</td>
                <td className="py-2 pr-3 border-b border-gray-100"><code>?start=ref_pg{'{slug}'}</code></td>
                <td className="py-2 border-b border-gray-100">Открывает бот, бот шлёт кнопку на Mini App</td>
              </tr>
              <tr>
                <td className="py-2 pr-3 border-b border-gray-100">Бот → лендинг</td>
                <td className="py-2 pr-3 border-b border-gray-100"><code>?start=ref_pg{'{slug}'}_land</code></td>
                <td className="py-2 border-b border-gray-100">Открывает бот, бот шлёт кнопку на сторонний лендинг события</td>
              </tr>
              <tr>
                <td className="py-2 pr-3">Приложение без лендинга</td>
                <td className="py-2 pr-3"><code>?startapp=ref_pg{'{slug}'}_nolend</code></td>
                <td className="py-2">Открывает Mini App сразу, сторонний лендинг не показывается</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="mt-4 bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900">
          💡 Ключевое отличие: <code>?start=</code> открывает <strong>сначала бота</strong> (он присылает сообщение
          с кнопкой), а <code>?startapp=</code> открывает <strong>сразу Mini App</strong>. К любой из ссылок можно
          добавить партнёра и метку источника: <code>_pid{'{реф-код}'}_src{'{utm}'}</code>.
        </div>
        <div className="mt-3 bg-amber-50 border border-amber-100 rounded-xl p-3 text-sm text-amber-900">
          ⚠️ В вариантах «через бота» в приветственном сообщении бот сам подставит строку
          «Если проблемы с регистрацией — пишите в @…» с вашим рабочим контактом. Он берётся из{' '}
          <Link href="/dashboard/settings" className="underline">Настроек</Link> →
          блок «Рабочий аккаунт» → поле «Никнейм». Если поле пустое — строка не добавляется.
        </div>
      </Section>

      <div className="p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="text-sm font-semibold text-gray-800 mb-1">Не получилось?</div>
        <p className="text-sm text-gray-600">
          Напишите разработчику —{' '}
          <a href="https://t.me/margo_forbs?text=Вопрос_по_альтернативным_ссылкам"
             target="_blank" rel="noopener noreferrer"
             className="text-blue-600 hover:underline inline-flex items-center gap-1">
            открыть чат в Telegram <ExternalLink size={12}/>
          </a>
        </p>
      </div>
    </div>
  )
}

function Section({ step, title, children }: { step: string; title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-100 p-5 mb-4 shadow-sm">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
             style={{ background: PEACH, color: BRAND }}>
          {step}
        </div>
        <h2 className="text-base font-bold" style={{ color: BRAND }}>{title}</h2>
      </div>
      <div className="pl-11">{children}</div>
    </section>
  )
}

function CopyBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <div className="flex gap-2">
      <code className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono overflow-x-auto whitespace-nowrap text-gray-800">
        {value}
      </code>
      <button
        onClick={copy}
        className="px-3 py-2.5 rounded-lg text-white font-medium text-sm flex items-center gap-1.5 flex-shrink-0"
        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        {copied ? <><Check size={15}/> Скопировано</> : <><Copy size={15}/> Копировать</>}
      </button>
    </div>
  )
}
