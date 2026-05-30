'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, ExternalLink, Copy, Check, Gift, CalendarDays, Ticket, Globe } from 'lucide-react'
import { api } from '@/lib/api'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

interface EventRow { id: number; slug: string; title: string; module_slug: string; status: string }

// Вкладки, на которые можно сразу открыть Mini App.
// id = значение для startapp (_tab{id}), label — как видит участник.
const TABS = [
  { id: 'game',      label: '🎁 Подарки',   note: 'вкладка с реферальной игрой и подарками за приглашённых друзей', icon: Gift },
  { id: 'program',   label: '📅 Программа', note: 'расписание выступлений события',                                   icon: CalendarDays },
  { id: 'raffle',    label: '🎟 Розыгрыш',  note: 'билеты и кодовые слова (если розыгрыш включён)',                  icon: Ticket },
  { id: 'ecosystem', label: '🌐 Экосистема', note: 'визитка бренда, основатель и продукты',                          icon: Globe },
] as const

export default function MiniAppDeeplinksPage() {
  const [events, setEvents] = useState<EventRow[]>([])
  const [botHandle, setBotHandle] = useState<string | null>(null) // handle своего TG-бота клиента (без @) или null = системный @pluson_bot
  const [loading, setLoading] = useState(true)

  const [slug, setSlug] = useState('')
  const [tab, setTab] = useState<string>('game')
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

  // Сборка ссылки.
  // Свой бот клиента (VIP): t.me/{handle}?startapp=... (без short-name)
  // Общий @pluson_bot:      t.me/pluson_bot/pluson?startapp=... (со short-name pluson)
  function buildLink(targetTab: string, slugValue: string) {
    const startapp = `ref_pg${slugValue}_tab${targetTab}`
    if (useOwnBot && botHandle) return `https://t.me/${botHandle}?startapp=${startapp}`
    return `https://t.me/pluson_bot/pluson?startapp=${startapp}`
  }

  const selectedTab = TABS.find(t => t.id === tab)!

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Ссылки на нужную вкладку Mini App</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Ссылки на нужную вкладку Mini App</h1>
          <p className="text-sm text-gray-500 mt-1">
            Откройте Mini App участника сразу на «Подарках» или «Программе». Если человек ещё не зарегистрирован —
            ссылка сама приведёт его на страницу регистрации события.
          </p>
        </div>
      </div>

      {/* Как это работает */}
      <Section step="?" title="Как это работает">
        <p className="text-sm text-gray-700 mb-3">
          В ссылку зашита нужная вкладка. iViSiON: ПЛЮСОН сам решает, что показать человеку:
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
            <div className="text-sm font-semibold text-emerald-900 mb-1">✅ Уже зарегистрирован</div>
            <p className="text-xs text-emerald-800 leading-snug">
              Mini App откроется <strong>сразу на выбранной вкладке</strong> (Подарки / Программа / …).
            </p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
            <div className="text-sm font-semibold text-amber-900 mb-1">🔒 Ещё не зарегистрирован</div>
            <p className="text-xs text-amber-800 leading-snug">
              Вкладка пока закрыта — человек попадёт на <strong>лендинг с кнопкой «Хочу участвовать»</strong>.
              После регистрации откроет ссылку повторно — попадёт уже на нужную вкладку.
            </p>
          </div>
        </div>
      </Section>

      {/* Генератор */}
      <Section step="●" title="Соберите свою ссылку">
        {loading ? (
          <p className="text-sm text-gray-400 italic">Загружаем ваши события…</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-gray-600">
            У вас пока нет опубликованных событий. Создайте событие в разделе{' '}
            <Link href="/dashboard/events" className="text-blue-600 hover:underline">Мероприятия</Link> или{' '}
            <Link href="/dashboard/conferences" className="text-blue-600 hover:underline">Конференции</Link>.
          </p>
        ) : (
          <>
            {/* Событие */}
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">Событие</label>
            <select
              value={slug}
              onChange={e => setSlug(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm mb-4 bg-white"
            >
              {events.map(e => (
                <option key={e.id} value={e.slug}>{e.title} ({e.slug})</option>
              ))}
            </select>

            {/* Вкладка */}
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">Куда открыть</label>
            <div className="grid sm:grid-cols-2 gap-2 mb-4">
              {TABS.map(t => {
                const Icon = t.icon
                const active = t.id === tab
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`text-left rounded-xl border p-3 transition-all ${
                      active ? 'border-transparent text-white shadow-sm' : 'border-gray-200 bg-white hover:border-gray-300'
                    }`}
                    style={active ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : {}}
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <Icon size={15} className={active ? 'text-white' : 'text-gray-500'} />
                      <span className="text-sm font-semibold">{t.label}</span>
                    </div>
                    <span className={`text-xs leading-snug ${active ? 'text-white/80' : 'text-gray-500'}`}>{t.note}</span>
                  </button>
                )
              })}
            </div>

            {/* Выбор бота */}
            {botHandle && (
              <>
                <label className="block text-sm font-semibold text-gray-800 mb-1.5">Через какой бот</label>
                <div className="flex gap-2 mb-4">
                  <button
                    onClick={() => setUseOwnBot(true)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                      useOwnBot ? 'border-transparent text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                    }`}
                    style={useOwnBot ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : {}}
                  >
                    Ваш бот <span className="opacity-70">@{botHandle}</span>
                  </button>
                  <button
                    onClick={() => setUseOwnBot(false)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                      !useOwnBot ? 'border-transparent text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                    }`}
                    style={!useOwnBot ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : {}}
                  >
                    Общий @pluson_bot
                  </button>
                </div>
              </>
            )}

            {/* Результат */}
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
              <div className="text-xs font-semibold text-gray-600 mb-2">
                Готовая ссылка → {selectedTab.label}
              </div>
              <CopyBlock value={buildLink(tab, slug)} />
              <p className="text-xs text-gray-400 mt-2">
                Эту ссылку можно вставлять в посты, рассылки, кнопки на лендинге — куда угодно.
              </p>
            </div>
          </>
        )}
      </Section>

      {/* Справочник форматов */}
      <Section step="●" title="Все варианты — справочник">
        <p className="text-sm text-gray-700 mb-3">
          Подставьте <code>{'{slug}'}</code> вашего события (это «Код ссылки» во вкладке «Основное»).
          Бот: <code>https://t.me/pluson_bot/pluson</code> (общий) или <code>https://t.me/ваш_бот</code> (свой, VIP).
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left" style={{ color: BRAND }}>
                <th className="py-2 pr-3 border-b border-gray-200 font-semibold">Куда вести (если зарегистрирован)</th>
                <th className="py-2 pr-3 border-b border-gray-200 font-semibold">Хвост startapp</th>
                <th className="py-2 border-b border-gray-200 font-semibold">Если НЕ зарегистрирован</th>
              </tr>
            </thead>
            <tbody className="text-gray-700">
              <tr>
                <td className="py-2 pr-3 border-b border-gray-100">🎁 Подарки (реферальная игра)</td>
                <td className="py-2 pr-3 border-b border-gray-100"><code>ref_pg{'{slug}'}_tabgame</code></td>
                <td className="py-2 border-b border-gray-100">→ регистрация</td>
              </tr>
              <tr>
                <td className="py-2 pr-3 border-b border-gray-100">📅 Программа</td>
                <td className="py-2 pr-3 border-b border-gray-100"><code>ref_pg{'{slug}'}_tabprogram</code></td>
                <td className="py-2 border-b border-gray-100">→ регистрация</td>
              </tr>
              <tr>
                <td className="py-2 pr-3 border-b border-gray-100">🎟 Розыгрыш</td>
                <td className="py-2 pr-3 border-b border-gray-100"><code>ref_pg{'{slug}'}_tabraffle</code></td>
                <td className="py-2 border-b border-gray-100">→ регистрация</td>
              </tr>
              <tr>
                <td className="py-2 pr-3">🌐 Экосистема</td>
                <td className="py-2 pr-3"><code>ref_pg{'{slug}'}_tabecosystem</code></td>
                <td className="py-2">→ регистрация</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="mt-4 bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm text-blue-900">
          💡 К хвосту можно добавить партнёра и метку источника:{' '}
          <code>ref_pg{'{slug}'}_tabgame_pid{'{реф-код}'}_src{'{utm}'}</code>. Порядок частей не важен.
        </div>
      </Section>

      <div className="p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="text-sm font-semibold text-gray-800 mb-1">Не получилось?</div>
        <p className="text-sm text-gray-600">
          Напишите разработчику —{' '}
          <a href="https://t.me/margo_forbs?text=Вопрос_по_ссылкам_Mini_App"
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
