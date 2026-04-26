'use client'
import { useState, useEffect, useMemo } from 'react'
import { Users, Search, ChevronDown, ChevronUp, X, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

interface Participant {
  id: number
  platform_user_id: string
  ref_code: string
  referrer_ref_code: string | null
  is_registered: boolean
  is_in_chat: boolean
  registered_at: string | null
  first_name: string | null
  last_name: string | null
  username: string | null
  salebot_id: string | null
  phone: string | null
  email: string | null
  referral_count: number
}

type RegisteredFilter = 'all' | 'yes' | 'no'

interface Counts {
  total: number
  registered: number
  not_registered: number
}

function ContactCard({
  p,
  onToggleRegistered,
}: {
  p: Participant
  onToggleRegistered: (next: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || 'Без имени'
  const initial = name[0]?.toUpperCase() || '?'

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      onToggleRegistered(!p.is_registered)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-t border-gray-50 first:border-t-0">
      <div
        className="flex items-center gap-4 px-5 py-3.5 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={() => setOpen(v => !v)}
      >
        <button
          type="button"
          onClick={toggle}
          disabled={busy}
          title={p.is_registered ? 'Снять статус «Зарегистрирован»' : 'Отметить как зарегистрирован'}
          className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
            p.is_registered
              ? 'bg-green-500 border-green-500 text-white'
              : 'bg-white border-gray-300 hover:border-gray-400'
          } ${busy ? 'opacity-50' : ''}`}
        >
          {p.is_registered && <Check size={13} strokeWidth={3} />}
        </button>

        <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center shrink-0 text-sm font-medium text-gray-500">
          {initial}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-gray-900 text-sm truncate">{name}</p>
          {p.username && (
            <p className="text-xs text-gray-400">@{p.username.replace(/^@+/, '')}</p>
          )}
        </div>
        <div className="text-right shrink-0 flex items-center gap-2">
          <div>
            {p.registered_at && (
              <p className="text-xs text-gray-400">
                {new Date(p.registered_at).toLocaleDateString('ru')}
              </p>
            )}
            {p.referral_count > 0 && (
              <p className="text-xs text-brand font-medium">{p.referral_count} реф.</p>
            )}
          </div>
          {open ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
        </div>
      </div>

      {open && (
        <div className="px-5 pb-4 bg-gray-50 border-t border-gray-100">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 pt-3 text-xs">
            <Field label="Свой реф-код (его ссылка)" value={p.ref_code || '—'} mono />
            <Field label="Реф-код, от кого пришёл" value={p.referrer_ref_code || '—'} mono highlight={!!p.referrer_ref_code} />
            <Field label="Telegram ID" value={p.platform_user_id || '—'} />
            <Field label="Salebot ID" value={p.salebot_id || '—'} />
            <Field label="Телефон" value={p.phone || '—'} />
            <Field label="Email" value={p.email || '—'} />
            <Field label="Зарегистрирован" value={p.is_registered ? 'Да' : 'Нет'} />
            <Field label="В чате" value={p.is_in_chat ? 'Да' : 'Нет'} />
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, value, mono, highlight }: { label: string; value: string; mono?: boolean; highlight?: boolean }) {
  return (
    <div>
      <p className="text-gray-400 mb-0.5">{label}</p>
      <p className={`${mono ? 'font-mono' : ''} ${highlight ? 'text-brand font-medium' : 'text-gray-700'} break-all`}>
        {value}
      </p>
    </div>
  )
}

function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
        active
          ? 'bg-gray-900 text-white'
          : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
      }`}
    >
      {label} <span className={active ? 'text-white/70' : 'text-gray-400'}>{count}</span>
    </button>
  )
}

export default function EventParticipants({ eventId }: { eventId: number }) {
  const [participants, setParticipants] = useState<Participant[]>([])
  const [counts, setCounts] = useState<Counts>({ total: 0, registered: 0, not_registered: 0 })
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<RegisteredFilter>('all')

  async function load(f: RegisteredFilter) {
    setLoading(true)
    try {
      const r = await api.events.participants(eventId, f)
      setParticipants(r.participants || [])
      setCounts(r.counts || { total: 0, registered: 0, not_registered: 0 })
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load(filter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, filter])

  async function toggleRegistered(participantId: number, next: boolean) {
    // Оптимистичное обновление + откат при ошибке
    const prev = participants
    const prevCounts = counts
    setParticipants(list =>
      list.map(p => (p.id === participantId ? { ...p, is_registered: next } : p))
    )
    setCounts(c => ({
      total: c.total,
      registered: c.registered + (next ? 1 : -1),
      not_registered: c.not_registered + (next ? -1 : 1),
    }))
    try {
      await api.events.setRegistered(eventId, participantId, next)
      // Если активный фильтр исключает новый статус — убрать строку
      if ((filter === 'yes' && !next) || (filter === 'no' && next)) {
        setParticipants(list => list.filter(p => p.id !== participantId))
      }
    } catch (e: any) {
      setParticipants(prev)
      setCounts(prevCounts)
      alert(e?.message || 'Не удалось обновить статус')
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return participants
    return participants.filter(p => {
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ').toLowerCase()
      const username = (p.username || '').toLowerCase().replace(/^@+/, '')
      const refCode = (p.ref_code || '').toLowerCase()
      const referrerCode = (p.referrer_ref_code || '').toLowerCase()
      return (
        name.includes(q) ||
        username.includes(q) ||
        refCode.includes(q) ||
        referrerCode.includes(q) ||
        (p.platform_user_id || '').includes(q) ||
        (p.salebot_id || '').includes(q)
      )
    })
  }, [participants, search])

  if (loading && participants.length === 0) {
    return <div className="flex justify-center py-12"><Spinner className="text-brand text-2xl" /></div>
  }

  if (counts.total === 0) {
    return (
      <div className="max-w-2xl">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
          <div className="w-16 h-16 rounded-full gradient-bg flex items-center justify-center mx-auto mb-5">
            <Users size={28} className="text-white" />
          </div>
          <h2 className="text-lg font-bold text-gray-900 mb-2">Участников пока нет</h2>
          <p className="text-gray-500 text-sm max-w-xs mx-auto">
            Здесь появятся пользователи Telegram, которые открыли бот по вашей реферальной ссылке на это событие.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl">
      {/* Фильтр-таблетки */}
      <div className="flex gap-2 mb-3 flex-wrap">
        <FilterPill label="Все" count={counts.total} active={filter === 'all'} onClick={() => setFilter('all')} />
        <FilterPill label="Зарегистрированы" count={counts.registered} active={filter === 'yes'} onClick={() => setFilter('yes')} />
        <FilterPill label="Не зарегистрированы" count={counts.not_registered} active={filter === 'no'} onClick={() => setFilter('no')} />
      </div>

      {/* Поиск */}
      <div className="relative mb-4">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Поиск по имени, @username, реф-коду, Telegram ID..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-8 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand bg-white"
        />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            <X size={14} />
          </button>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-10 text-center text-gray-400 text-sm">
            {participants.length === 0 ? 'В этой группе пусто' : 'Никого не найдено'}
          </div>
        ) : (
          filtered.map(p => (
            <ContactCard
              key={p.id}
              p={p}
              onToggleRegistered={(next) => toggleRegistered(p.id, next)}
            />
          ))
        )}
      </div>
    </div>
  )
}
