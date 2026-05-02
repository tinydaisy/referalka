'use client'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Copy, Check, RotateCcw, Trophy, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

type SubTab = 'settings' | 'participants' | 'tickets' | 'generator'

type Settings = {
  is_enabled: boolean
  draw_at: string | null
  subscription_grants_starter_ticket: boolean
  intro_text: string | null
}

type Keyword = { id: number; keyword: string; sort_order: number; is_active: boolean }

type Participant = {
  contact_id: number
  name: string | null
  username: string | null
  is_live: boolean
  live_at: string | null
  ticket_ids: number[]
  code_words: string[]
}

type Ticket = {
  ticket_id: number
  code_word: string
  created_at: string
  contact_id: number
  name: string | null
  username: string | null
  is_live: boolean
}

type Speaker = {
  id: number // это conf_speaker_events.id = speaker_event_id
  name: string
  gift_raffle_title: string
  gift_raffle_url: string
}

type Winner = {
  winner_id: number
  speaker_event_id: number
  ticket_id: number
  won_at: string
  code_word: string
  gift_raffle_title: string
  gift_raffle_url: string | null
  speaker_name: string
  speaker_tg_username: string | null
  contact_id: number
  winner_name: string | null
  winner_username: string | null
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function ticketNo(id: number): string {
  return '№' + String(id).padStart(5, '0')
}

function nameOf(x: { name: string | null }): string {
  return x.name || '—'
}

function userOf(x: { username: string | null }): string {
  return x.username ? '@' + x.username.replace(/^@/, '') : '—'
}

export default function RaffleTab() {
  const { id } = useParams()
  const eventId = Number(id)
  const [event, setEvent] = useState<any>(null)
  const [sub, setSub] = useState<SubTab>('settings')
  const [settings, setSettings] = useState<Settings>({
    is_enabled: false, draw_at: null, subscription_grants_starter_ticket: true, intro_text: null,
  })
  const [keywords, setKeywords] = useState<Keyword[]>([])
  const [savingSettings, setSavingSettings] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => { reloadAll() }, [eventId])

  async function reloadAll() {
    setLoading(true)
    try {
      const [ev, s, k] = await Promise.all([
        api.events.get(eventId),
        api.raffle.settings.get(eventId),
        api.raffle.keywords.list(eventId),
      ])
      setEvent(ev.event)
      setSettings(s)
      setKeywords(k.items || [])
    } finally {
      setLoading(false)
    }
  }

  async function toggleEnabled(next: boolean) {
    setSavingSettings(true)
    try {
      const updated = await api.raffle.settings.save(eventId, { ...settings, is_enabled: next })
      setSettings(updated)
    } catch (e: any) {
      alert(e.message || 'Не удалось сохранить')
    } finally {
      setSavingSettings(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="text-3xl" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Шапка с тумблером */}
      <div
        className="rounded-2xl p-5 flex flex-wrap items-center gap-4"
        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)', color: 'white' }}
      >
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-wider opacity-70 mb-1">Розыгрыш</div>
          <div className="text-xl font-bold" style={{ color: PEACH }}>
            {settings.is_enabled ? 'Включён — виден участникам в Mini App' : 'Выключен — у участников вкладка скрыта'}
          </div>
          <div className="text-xs opacity-70 mt-1">
            Тумблер влияет только на показ в Mini App. Подвкладки настроек открыты всегда — настройте сейчас, включите потом.
          </div>
        </div>
        <button
          onClick={() => toggleEnabled(!settings.is_enabled)}
          disabled={savingSettings}
          className="px-5 py-2.5 rounded-xl font-bold text-sm transition-opacity disabled:opacity-50"
          style={settings.is_enabled
            ? { background: PEACH, color: BRAND }
            : { background: 'rgba(255,255,255,0.1)', color: 'white', border: '1px solid rgba(255,255,255,0.3)' }}
        >
          {settings.is_enabled ? 'ВКЛ' : 'ВЫКЛ'}
        </button>
      </div>

      {/* Подвкладки */}
      <div className="flex gap-1 border-b border-gray-200 overflow-x-auto">
        {([
          ['settings',     'Настройки'],
          ['participants', 'Участники розыгрыша'],
          ['tickets',      'Билеты'],
          ['generator',    'Генератор победителей'],
        ] as [SubTab, string][]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setSub(k)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              sub === k ? 'text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            style={sub === k ? { borderBottomColor: BRAND, color: BRAND } : { borderBottomColor: 'transparent' }}
          >
            {label}
          </button>
        ))}
      </div>

      {sub === 'settings'     && <SettingsPane eventId={eventId} settings={settings} setSettings={setSettings} keywords={keywords} setKeywords={setKeywords} />}
      {sub === 'participants' && <ParticipantsPane eventId={eventId} eventSlug={event?.slug || ''} />}
      {sub === 'tickets'      && <TicketsPane eventId={eventId} />}
      {sub === 'generator'    && <GeneratorPane eventId={eventId} />}
    </div>
  )
}


/* ─────── Settings ─────── */
function SettingsPane({
  eventId, settings, setSettings, keywords, setKeywords,
}: {
  eventId: number
  settings: Settings
  setSettings: (s: Settings) => void
  keywords: Keyword[]
  setKeywords: (k: Keyword[]) => void
}) {
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [newKw, setNewKw] = useState('')

  async function save() {
    setSaving(true)
    try {
      const next = await api.raffle.settings.save(eventId, settings)
      setSettings(next)
      setSavedAt(Date.now())
      setTimeout(() => setSavedAt(null), 2000)
    } catch (e: any) {
      alert(e.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  async function addKw() {
    const raw = newKw.trim()
    if (!raw) return

    // Пакетный ввод: разрешаем перечислять слова через запятую, точку с
    // запятой или перенос строки. Пустые и дубли (case-insensitive) внутри
    // ввода отбрасываем сразу, не дёргая API.
    const seen = new Set<string>()
    const words = raw
      .split(/[,;\n]/)
      .map(w => w.trim())
      .filter(w => {
        if (!w) return false
        const key = w.toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    if (words.length === 0) return

    let sortBase = keywords.length
    let added = 0
    const duplicates: string[] = []
    const errors: string[] = []

    for (const w of words) {
      try {
        await api.raffle.keywords.create(eventId, { keyword: w, sort_order: sortBase++, is_active: true })
        added++
      } catch (e: any) {
        if (e?.message?.includes('409')) duplicates.push(w)
        else errors.push(`${w}: ${e?.message || 'ошибка'}`)
      }
    }

    setNewKw('')
    const k = await api.raffle.keywords.list(eventId)
    setKeywords(k.items || [])

    if (words.length === 1 && added === 1) return // тихий путь для одного слова
    const parts: string[] = []
    if (added) parts.push(`Добавлено: ${added}`)
    if (duplicates.length) parts.push(`уже были: ${duplicates.join(', ')}`)
    if (errors.length) parts.push(`ошибки: ${errors.join('; ')}`)
    if (parts.length) alert(parts.join('\n'))
  }

  async function delKw(id: number) {
    if (!confirm('Удалить кодовое слово?')) return
    await api.raffle.keywords.delete(eventId, id)
    setKeywords(keywords.filter(k => k.id !== id))
  }

  return (
    <div className="max-w-3xl space-y-8 pb-10">
      {/* Общие настройки */}
      <section className="space-y-3">
        <h3 className="text-base font-bold" style={{ color: BRAND }}>Общие настройки</h3>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.subscription_grants_starter_ticket}
            onChange={e => setSettings({ ...settings, subscription_grants_starter_ticket: e.target.checked })}
            className="w-4 h-4 rounded"
          />
          <span className="text-sm">Выдавать стартовый билет (Free) за выполненную подписку на каналы</span>
        </label>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Текст-приветствие в Mini App</label>
          <textarea
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            rows={3}
            placeholder="Краткое описание розыгрыша для участников (опционально)"
            value={settings.intro_text || ''}
            onChange={e => setSettings({ ...settings, intro_text: e.target.value || null })}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Дата финала (опционально)</label>
          <input
            type="datetime-local"
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            value={settings.draw_at ? settings.draw_at.slice(0, 16) : ''}
            onChange={e => setSettings({ ...settings, draw_at: e.target.value || null })}
          />
        </div>

        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
          style={{ background: PEACH, color: BRAND }}
        >
          {saving ? 'Сохраняем…' : savedAt ? '✓ Сохранено' : 'Сохранить настройки'}
        </button>
      </section>

      {/* Кодовые слова */}
      <section className="space-y-3">
        <h3 className="text-base font-bold" style={{ color: BRAND }}>Кодовые слова</h3>
        <p className="text-sm text-gray-500">
          Спикеры называют слова в эфире. За каждое слово участник получает один билет.
          Сравнение регистронезависимое — «Путешествие» = «путешествие». Один участник одно слово вводит один раз.
        </p>

        {keywords.length > 0 && (
          <div className="space-y-2">
            {keywords.map(k => (
              <div key={k.id} className="border border-gray-200 rounded-xl p-3 flex items-center gap-3">
                <span className="font-mono uppercase text-sm flex-1">{k.keyword}</span>
                <span className="text-xs text-gray-500 whitespace-nowrap">+1 билет</span>
                <button onClick={() => delKw(k.id)} className="text-red-500 hover:text-red-700 text-sm px-2">✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="border-2 border-dashed border-gray-300 rounded-xl p-3 space-y-2">
          <textarea
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono uppercase resize-y"
            rows={2}
            placeholder="ROCKETS, ПУТЕШЕСТВИЕ, СКОРОСТЬ"
            value={newKw}
            onChange={e => setNewKw(e.target.value)}
            onKeyDown={e => {
              // Ctrl/⌘+Enter — отправить, обычный Enter добавляет перенос строки
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                addKw()
              }
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-gray-500">
              Можно перечислить несколько слов через запятую или с новой строки — добавятся все сразу.
            </p>
            <button
              onClick={addKw}
              className="px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap"
              style={{ background: PEACH, color: BRAND }}
            >
              + Добавить
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}


/* ─────── Participants ─────── */
function ParticipantsPane({ eventId, eventSlug }: { eventId: number; eventSlug: string }) {
  const [items, setItems] = useState<Participant[]>([])
  const [onlyLive, setOnlyLive] = useState(false)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      const r = await api.raffle.participants(eventId, onlyLive)
      setItems(r.items || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [eventId, onlyLive])

  const liveLink = useMemo(() => {
    if (!eventSlug) return ''
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://pluson.ru'
    return `${origin}/l/${eventSlug}?app=tg&live=1`
  }, [eventSlug])

  return (
    <div className="space-y-5">
      {/* Live-ссылка */}
      <LiveLinkBlock link={liveLink} />

      {/* Фильтр + обновить */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2 cursor-pointer text-sm">
          <input type="checkbox" checked={onlyLive} onChange={e => setOnlyLive(e.target.checked)} className="w-4 h-4" />
          <span>Только участники в эфире (за последние 120 минут)</span>
        </label>
        <button onClick={load} className="px-3 py-1.5 rounded-lg text-sm border border-gray-300 hover:bg-gray-50 ml-auto">
          Обновить
        </button>
      </div>

      {/* Таблица */}
      {loading ? (
        <div className="py-10 text-center text-gray-500"><Spinner /></div>
      ) : items.length === 0 ? (
        <div className="p-10 text-center text-gray-500 text-sm bg-white rounded-2xl border border-gray-100">
          Пока никто не получил билеты.
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="overflow-auto max-h-[60vh]">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr className="text-left text-gray-500 text-xs uppercase tracking-wider">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Имя</th>
                  <th className="px-3 py-2 font-medium">Ник</th>
                  <th className="px-3 py-2 font-medium">Билеты</th>
                  <th className="px-3 py-2 font-medium">Кодовые слова</th>
                  <th className="px-3 py-2 font-medium">В эфире</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((p, i) => (
                  <tr key={p.contact_id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/clients?focus=${p.contact_id}`} className="text-[#25455D] hover:underline">
                        {nameOf(p)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/clients?focus=${p.contact_id}`} className="text-[#25455D] hover:underline">
                        {userOf(p)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {p.ticket_ids.map(id => ticketNo(id)).join(', ')}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {p.code_words.map((w, k) => (
                        <span key={k} className="inline-block px-2 py-0.5 mr-1 mb-1 rounded-md bg-gray-100 text-gray-700">{w}</span>
                      ))}
                    </td>
                    <td className="px-3 py-2">
                      {p.is_live
                        ? <span className="inline-block px-2 py-0.5 text-xs rounded-md font-semibold" style={{ background: PEACH, color: BRAND }}>В эфире</span>
                        : <span className="text-xs text-gray-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}


/* ─────── Live-link with copy + instruction ─────── */
function LiveLinkBlock({ link }: { link: string }) {
  const [copied, setCopied] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  return (
    <div className="rounded-2xl p-4 border border-gray-200 bg-white">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-sm font-bold" style={{ color: BRAND }}>Публичная ссылка для эфира</div>
        <button
          onClick={() => setShowHelp(s => !s)}
          className="text-xs text-gray-500 hover:text-gray-700 underline"
        >
          {showHelp ? 'Скрыть' : 'Как использовать?'}
        </button>
      </div>

      <div className="flex gap-2">
        <input
          readOnly
          value={link || '—'}
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 font-mono"
          onFocus={e => e.target.select()}
        />
        <button
          onClick={copy}
          disabled={!link}
          className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
          style={{ background: PEACH, color: BRAND }}
        >
          {copied ? <><Check size={14} /> Скопировано</> : <><Copy size={14} /> Копировать</>}
        </button>
      </div>

      {showHelp && (
        <div className="mt-3 p-3 rounded-lg bg-blue-50 text-sm text-blue-900 space-y-1.5">
          <div className="flex gap-2 items-start">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p>Скопируйте ссылку и в начале эфира опубликуйте её в чат / в эфирное окно.</p>
              <p>Когда участник кликает по ссылке — открывается ваш Mini App, и он автоматически отмечается «в эфире» на 120 минут.</p>
              <p>В подвкладке «Генератор победителей» по умолчанию участвуют только люди в эфире — это защищает от тех, кто ушёл с трансляции.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


/* ─────── Tickets ─────── */
function TicketsPane({ eventId }: { eventId: number }) {
  const [items, setItems] = useState<Ticket[]>([])
  const [onlyLive, setOnlyLive] = useState(false)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      const r = await api.raffle.tickets(eventId, onlyLive)
      setItems(r.items || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [eventId, onlyLive])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2 cursor-pointer text-sm">
          <input type="checkbox" checked={onlyLive} onChange={e => setOnlyLive(e.target.checked)} className="w-4 h-4" />
          <span>Только участники в эфире</span>
        </label>
        <span className="text-sm text-gray-500 ml-2">Всего: <strong>{items.length}</strong></span>
        <button onClick={load} className="px-3 py-1.5 rounded-lg text-sm border border-gray-300 hover:bg-gray-50 ml-auto">
          Обновить
        </button>
      </div>

      {loading ? (
        <div className="py-10 text-center text-gray-500"><Spinner /></div>
      ) : items.length === 0 ? (
        <div className="p-10 text-center text-gray-500 text-sm bg-white rounded-2xl border border-gray-100">
          Пока ни одного билета.
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="overflow-auto max-h-[60vh]">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr className="text-left text-gray-500 text-xs uppercase tracking-wider">
                  <th className="px-3 py-2 font-medium">№ билета</th>
                  <th className="px-3 py-2 font-medium">Кодовое слово</th>
                  <th className="px-3 py-2 font-medium">Имя</th>
                  <th className="px-3 py-2 font-medium">Ник</th>
                  <th className="px-3 py-2 font-medium">Дата</th>
                  <th className="px-3 py-2 font-medium">В эфире</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map(t => (
                  <tr key={t.ticket_id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono font-semibold text-gray-900">{ticketNo(t.ticket_id)}</td>
                    <td className="px-3 py-2 text-gray-700">
                      {t.code_word === 'Free' ? (
                        <span className="px-2 py-0.5 rounded-md text-xs font-semibold" style={{ background: PEACH, color: BRAND }}>Free</span>
                      ) : t.code_word}
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/clients?focus=${t.contact_id}`} className="text-[#25455D] hover:underline">
                        {nameOf(t)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/clients?focus=${t.contact_id}`} className="text-[#25455D] hover:underline">
                        {userOf(t)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(t.created_at)}</td>
                    <td className="px-3 py-2">
                      {t.is_live
                        ? <span className="inline-block px-2 py-0.5 text-xs rounded-md font-semibold" style={{ background: PEACH, color: BRAND }}>В эфире</span>
                        : <span className="text-xs text-gray-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}


/* ─────── Generator ─────── */
function GeneratorPane({ eventId }: { eventId: number }) {
  const [speakers, setSpeakers] = useState<Speaker[]>([])
  const [winners, setWinners] = useState<Winner[]>([])
  const [onlyLive, setOnlyLive] = useState(true)
  const [loading, setLoading] = useState(true)
  const [drawing, setDrawing] = useState<number | null>(null) // speaker_event_id

  async function load() {
    setLoading(true)
    try {
      const [sp, w] = await Promise.all([
        api.conference.speakers.list(eventId),
        api.raffle.winners(eventId),
      ])
      setSpeakers((sp.speakers || []).map((s: any) => ({
        id: s.id,
        name: s.name,
        gift_raffle_title: s.gift_raffle_title || '',
        gift_raffle_url: s.gift_raffle_url || '',
      })))
      setWinners(w.items || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [eventId])

  async function draw(speakerEventId: number) {
    setDrawing(speakerEventId)
    try {
      await api.raffle.draw(eventId, speakerEventId, onlyLive)
      const w = await api.raffle.winners(eventId)
      setWinners(w.items || [])
    } catch (e: any) {
      const msg = e.message || ''
      if (msg.includes('409')) alert('Нет подходящих билетов для розыгрыша. Снимите фильтр «только в эфире» или дождитесь активности.')
      else alert(msg || 'Ошибка')
    } finally {
      setDrawing(null)
    }
  }

  async function reset(winnerId: number) {
    if (!confirm('Сбросить выигрыш и переразыграть приз?')) return
    await api.raffle.deleteWinner(eventId, winnerId)
    const w = await api.raffle.winners(eventId)
    setWinners(w.items || [])
  }

  // Спикеры с непустым подарком розыгрыша — те кого можно разыгрывать
  const drawable = speakers.filter(s => s.gift_raffle_title.trim())
  const speakersWithoutPrize = speakers.length - drawable.length

  if (loading) return <div className="py-10 text-center text-gray-500"><Spinner /></div>

  if (speakers.length === 0) {
    return (
      <div className="p-10 text-center text-gray-500 text-sm bg-white rounded-2xl border border-gray-100">
        Сначала добавьте спикеров на вкладке «Спикеры» и заполните им поле «Подарок для розыгрыша».
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2 cursor-pointer text-sm">
          <input type="checkbox" checked={onlyLive} onChange={e => setOnlyLive(e.target.checked)} className="w-4 h-4" />
          <span>Только участники в эфире (за последние 120 минут)</span>
        </label>
      </div>

      {speakersWithoutPrize > 0 && (
        <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg p-3">
          У <strong>{speakersWithoutPrize}</strong> спикер{speakersWithoutPrize === 1 ? 'а' : 'ов'} не заполнен подарок для розыгрыша — они не показаны.
        </div>
      )}

      <div className="space-y-3">
        {drawable.map(s => {
          const winner = winners.find(w => w.speaker_event_id === s.id)
          return (
            <div key={s.id} className="bg-white rounded-2xl border border-gray-100 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-xs uppercase tracking-wider text-gray-500">Спикер</div>
                  <div className="font-semibold text-gray-900">{s.name}</div>
                  <div className="text-sm text-gray-700 mt-0.5">{s.gift_raffle_title}</div>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">Победитель</div>
                  {winner ? (
                    <div className="flex items-center gap-2">
                      <Trophy size={16} style={{ color: PEACH }} />
                      <Link href={`/dashboard/clients?focus=${winner.contact_id}`} className="text-[#25455D] hover:underline font-medium">
                        {winner.winner_name || '—'} {winner.winner_username && `(@${winner.winner_username.replace(/^@/, '')})`}
                      </Link>
                      <span className="text-xs text-gray-500 font-mono">{ticketNo(winner.ticket_id)}</span>
                    </div>
                  ) : (
                    <span className="text-sm text-gray-400">не выбран</span>
                  )}
                </div>

                {winner ? (
                  <button
                    onClick={() => reset(winner.winner_id)}
                    className="px-3 py-2 rounded-lg text-xs font-medium border border-gray-300 hover:bg-gray-50 inline-flex items-center gap-1.5"
                  >
                    <RotateCcw size={12} /> Сбросить
                  </button>
                ) : (
                  <button
                    onClick={() => draw(s.id)}
                    disabled={drawing === s.id}
                    className="px-4 py-2.5 rounded-lg text-sm font-bold disabled:opacity-50"
                    style={{ background: PEACH, color: BRAND }}
                  >
                    {drawing === s.id ? 'Крутим…' : 'Выбрать победителя'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
