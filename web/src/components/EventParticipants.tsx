'use client'
import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { Users, Search, ChevronDown, ChevronUp, X, Check, Trash2, Plus, Mail, Phone, UserPlus, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useMe } from '@/hooks/useMe'

interface Participant {
  id: number
  contact_id: number
  platform_user_id: string
  ref_code: string
  referrer_ref_code: string | null
  referrer_contact_id: number | null
  referrer_name: string | null
  referrer_username: string | null
  is_registered: boolean
  is_in_chat: boolean
  is_subscribed?: boolean
  is_unsubscribed?: boolean
  registered_at: string | null
  link_clicked_at: string | null
  contact_name: string | null
  first_name: string | null
  last_name: string | null
  username: string | null
  salebot_id: string | null
  phone: string | null
  email: string | null
  referral_count: number
  // Платформенные идентичности (для иконок + клик на профиль)
  tg_id?: string | null
  tg_username?: string | null
  vk_id?: string | null
  vk_username?: string | null
  max_id?: string | null
  max_username?: string | null
}

// Иконки платформ — SVG inline (без зависимости от внешних библиотек)
function PlatformBadge({
  platform, userId, username,
}: {
  platform: 'telegram' | 'vk' | 'max'
  userId?: string | null
  username?: string | null
}) {
  if (!userId && !username) return null
  const label = username ? `@${username.replace(/^@+/, '')}` : `#${userId}`
  const href =
    platform === 'telegram'
      ? (username ? `https://t.me/${username.replace(/^@+/, '')}` : `tg://user?id=${userId}`)
      : platform === 'vk'
      ? (username ? `https://vk.com/${username.replace(/^@+/, '')}` : `https://vk.com/id${userId}`)
      : (username ? `https://max.ru/${username}` : '#')
  const color =
    platform === 'telegram' ? '#229ED9'
    : platform === 'vk'     ? '#0077FF'
    : '#FFCFA4'
  const letter = platform === 'telegram' ? 'TG' : platform === 'vk' ? 'VK' : 'MAX'
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs hover:underline"
      style={{ color }}
    >
      <span
        className="inline-flex items-center justify-center w-4 h-4 rounded-sm text-[9px] font-bold text-white"
        style={{ background: color }}
      >
        {letter}
      </span>
      <span className="truncate max-w-[160px]">{label}</span>
    </a>
  )
}

type RegisteredFilter = 'all' | 'yes' | 'no'

interface Counts {
  total: number
  registered: number
  not_registered: number
}

function referrerLabel(p: Participant): string {
  if (!p.referrer_ref_code) return '—'
  const username = p.referrer_username ? `@${p.referrer_username.replace(/^@+/, '')}` : ''
  if (p.referrer_name) {
    return username ? `${p.referrer_name} (${username})` : p.referrer_name
  }
  if (username) return username
  return `код ${p.referrer_ref_code}`
}

function ContactCard({
  p,
  onToggleRegistered,
  onDelete,
  clickLabel,
}: {
  p: Participant
  onToggleRegistered: (next: boolean) => void
  onDelete: () => void
  clickLabel: string
}) {
  const { isAssistant } = useMe()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const name = p.contact_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || 'Без имени'
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

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    if (deleting) return
    if (!confirm(`Удалить участника «${name}» из события?\n\nКонтакт и его участие в других событиях останутся.`)) return
    setDeleting(true)
    try {
      onDelete()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="border-t border-gray-50 first:border-t-0">
      <div
        className="flex items-center gap-3 px-5 py-3.5 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={() => setOpen(v => !v)}
      >
        {/* Имя — главная колонка */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center shrink-0 text-sm font-medium text-gray-500">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-gray-900 text-sm truncate">{name}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5">
              {p.tg_id || p.tg_username ? (
                <PlatformBadge platform="telegram" userId={p.tg_id} username={p.tg_username} />
              ) : null}
              {p.vk_id || p.vk_username ? (
                <PlatformBadge platform="vk" userId={p.vk_id} username={p.vk_username} />
              ) : null}
              {p.max_id || p.max_username ? (
                <PlatformBadge platform="max" userId={p.max_id} username={p.max_username} />
              ) : null}
            </div>
          </div>
        </div>

        {/* Колонка «Кто привёл» (имя реферера) */}
        <div className="hidden sm:flex flex-1 max-w-xs shrink-0 min-w-0 items-center">
          {p.referrer_ref_code ? (
            <span className="text-xs text-gray-700 truncate" title={referrerLabel(p)}>
              {p.referrer_name || (p.referrer_username ? `@${p.referrer_username.replace(/^@+/, '')}` : `код ${p.referrer_ref_code}`)}
              {p.referrer_username && p.referrer_name && (
                <span className="text-gray-400"> @{p.referrer_username.replace(/^@+/, '')}</span>
              )}
            </span>
          ) : (
            <span className="text-xs text-gray-300">— пришёл сам</span>
          )}
        </div>

        {/* Колонка «Дата регистрации» */}
        <div className="w-24 text-center shrink-0">
          {p.registered_at ? (
            <span className="text-xs text-gray-500">
              {new Date(p.registered_at).toLocaleDateString('ru')}
            </span>
          ) : (
            <span className="text-xs text-gray-300">—</span>
          )}
        </div>

        {/* Колонка «Зарегистрирован» — чекбокс */}
        <div className="w-24 flex justify-center shrink-0">
          <button
            type="button"
            onClick={toggle}
            disabled={busy}
            title={p.is_registered ? 'Снять статус «Зарегистрирован»' : 'Отметить как зарегистрирован'}
            className={`w-6 h-6 rounded-md border flex items-center justify-center transition-colors ${
              p.is_registered
                ? 'bg-green-500 border-green-500 text-white'
                : 'bg-white border-gray-300 hover:border-gray-400'
            } ${busy ? 'opacity-50' : ''}`}
          >
            {p.is_registered && <Check size={14} strokeWidth={3} />}
          </button>
        </div>

        {/* Колонка «Был в эфире» / «Проголосовал» — read-only по link_clicked_at */}
        <div className="w-24 flex justify-center shrink-0">
          <span
            title={p.link_clicked_at
              ? `${clickLabel} — ${new Date(p.link_clicked_at).toLocaleString('ru')}`
              : 'Не нажал главную ссылку события'}
            className={`w-6 h-6 rounded-md border flex items-center justify-center ${
              p.link_clicked_at
                ? 'bg-emerald-500 border-emerald-500 text-white'
                : 'bg-white border-gray-300'
            }`}
          >
            {p.link_clicked_at && <Check size={14} strokeWidth={3} />}
          </span>
        </div>

        {/* Колонка «Подписан / Отписан» — read-only */}
        <div className="w-24 flex justify-center shrink-0">
          {p.is_unsubscribed ? (
            <span
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold bg-red-50 text-red-600 border border-red-200"
              title="Отписался от всех TG-каналов клиента"
            >
              ✕ Отписан
            </span>
          ) : p.is_subscribed ? (
            <span
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold bg-green-50 text-green-700 border border-green-200"
              title="Подписан хотя бы на один TG-канал клиента"
            >
              ✓ Подписан
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium bg-gray-50 text-gray-400 border border-gray-200"
              title="Нет записи о подписке (либо контакт не из TG)"
            >
              —
            </span>
          )}
        </div>

        {/* Кнопка удаления */}
        <div className="w-8 flex justify-center shrink-0">
          {!isAssistant && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              title="Удалить из события"
              className={`w-7 h-7 rounded-md flex items-center justify-center text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors ${
                deleting ? 'opacity-50' : ''
              }`}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>

        <div className="w-4 shrink-0 text-gray-400">
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </div>

      {open && (
        <div className="px-5 pb-4 bg-gray-50 border-t border-gray-100">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 pt-3 text-xs">
            <Field label="Свой реф-код (его ссылка)" value={p.ref_code || '—'} mono />
            <Field
              label="От кого пришёл"
              value={referrerLabel(p)}
              highlight={!!p.referrer_ref_code}
            />
            <Field
              label="Реф-код реферера"
              value={p.referrer_ref_code || '—'}
              mono
              highlight={!!p.referrer_ref_code}
            />
            <Field label="Telegram ID" value={p.platform_user_id || '—'} />
            <Field label="Salebot ID" value={p.salebot_id || '—'} />
            <Field label="Телефон" value={p.phone || '—'} />
            <Field label="Email" value={p.email || '—'} />
            <Field label="Зарегистрирован" value={p.is_registered ? 'Да' : 'Нет'} />
            <Field label="В чате" value={p.is_in_chat ? 'Да' : 'Нет'} />
          </div>
          {p.contact_id ? (
            <div className="pt-3 mt-3 border-t border-gray-200">
              <a
                href={`/dashboard/clients?contact=${p.contact_id}`}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#25455D] hover:underline"
              >
                Открыть карточку контакта в общей базе →
              </a>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function ListHeader({ clickLabel }: { clickLabel: string }) {
  return (
    <div className="hidden sm:flex items-center gap-3 px-5 py-2.5 border-b border-gray-100 bg-gray-50/50 text-[11px] font-medium uppercase tracking-wider text-gray-400">
      <div className="flex-1 min-w-0">Имя</div>
      <div className="flex-1 max-w-xs">Кто привёл</div>
      <div className="w-24 text-center">Регистрация</div>
      <div className="w-24 text-center">Зарегистр.</div>
      <div className="w-24 text-center">{clickLabel}</div>
      <div className="w-24 text-center">Подписка</div>
      <div className="w-8" />
      <div className="w-4" />
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

function AddFromContactModal({
  eventId,
  existingContactIds,
  onClose,
  onAdded,
}: {
  eventId: number
  existingContactIds: Set<number>
  onClose: () => void
  onAdded: () => void
}) {
  const [query, setQuery] = useState('')
  const [contacts, setContacts] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState<number | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true)
      api.contacts.list(query, 50, 0, false)
        .then((r: any) => setContacts(r.contacts || r.items || []))
        .catch(() => setContacts([]))
        .finally(() => setLoading(false))
    }, query ? 250 : 0)
    return () => clearTimeout(t)
  }, [query])

  async function pickContact(c: any) {
    if (existingContactIds.has(c.id)) return
    setAdding(c.id); setError('')
    try {
      await api.events.addParticipantFromContact(eventId, c.id, false)
      onAdded()
      onClose()
    } catch (e: any) {
      setError(e?.message || 'Не удалось добавить участника')
    } finally {
      setAdding(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 shrink-0">
          <div>
            <h3 className="font-bold text-gray-900 text-lg">Добавить участника</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Выберите контакт — он попадёт в список без статуса «зарегистрирован».
              Поставить галочку можно потом кликом по строке.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 border-b border-gray-100 shrink-0">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              autoFocus
              type="text"
              placeholder="Имя, email или телефон..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <div className="w-6 h-6 border-2 border-brand rounded-full border-t-transparent animate-spin" />
            </div>
          ) : contacts.length === 0 ? (
            <div className="p-8 text-center">
              <Users size={28} className="mx-auto mb-3 text-gray-300" />
              <p className="text-sm text-gray-500 mb-2">
                {query ? 'Ничего не найдено' : 'Нет контактов'}
              </p>
              <p className="text-xs text-gray-400">
                Сначала добавьте человека в{' '}
                <Link href="/dashboard/clients" className="text-brand hover:underline">«Контакты»</Link>
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-50">
              {contacts.map(c => {
                const taken = existingContactIds.has(c.id)
                const isAdding = adding === c.id
                return (
                  <li key={c.id}>
                    <button
                      onClick={() => pickContact(c)}
                      disabled={taken || isAdding}
                      className={`w-full text-left px-3 py-3 rounded-xl flex items-center gap-3 transition-colors
                        ${taken ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}`}
                    >
                      <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
                        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                        {(c.name || '?').trim().charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-sm text-gray-900 truncate">{c.name || 'Без имени'}</div>
                        <div className="text-xs text-gray-500 truncate flex items-center gap-3">
                          {c.email && <span className="flex items-center gap-1"><Mail size={10} />{c.email}</span>}
                          {c.phone && <span className="flex items-center gap-1"><Phone size={10} />{c.phone}</span>}
                          {!c.email && !c.phone && <span className="text-gray-400">без email/телефона</span>}
                        </div>
                      </div>
                      {taken ? (
                        <span className="text-[11px] text-gray-400 shrink-0">уже участник</span>
                      ) : isAdding ? (
                        <Spinner />
                      ) : (
                        <UserPlus size={16} className="text-gray-400 shrink-0" />
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {error && (
          <div className="p-3 border-t border-red-200 bg-red-50 text-red-700 text-sm flex items-center gap-2">
            <AlertCircle size={15} /> {error}
          </div>
        )}

        <div className="p-4 border-t border-gray-100 text-xs text-gray-500 shrink-0">
          Не нашли человека?{' '}
          <Link href="/dashboard/clients" className="text-brand hover:underline">
            Добавьте контакт
          </Link>{' '}
          — и вернитесь сюда.
        </div>
      </div>
    </div>
  )
}

export default function EventParticipants({ eventId, moduleSlug }: { eventId: number; moduleSlug?: string }) {
  // Лейбл второй галочки — «Был в эфире» / «Проголосовал». У конкурсов
  // главная ссылка — голосование, у остальных типов — стрим/эфир.
  const clickLabel = moduleSlug === 'contest' ? 'Проголосовал' : 'Был в эфире'
  const [participants, setParticipants] = useState<Participant[]>([])
  const [counts, setCounts] = useState<Counts>({ total: 0, registered: 0, not_registered: 0 })
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<RegisteredFilter>('all')
  const [showAdd, setShowAdd] = useState(false)

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

  async function deleteParticipant(participantId: number) {
    const prev = participants
    const prevCounts = counts
    const target = participants.find(p => p.id === participantId)
    if (!target) return
    setParticipants(list => list.filter(p => p.id !== participantId))
    setCounts(c => ({
      total: c.total - 1,
      registered: c.registered - (target.is_registered ? 1 : 0),
      not_registered: c.not_registered - (target.is_registered ? 0 : 1),
    }))
    try {
      await api.events.deleteParticipant(eventId, participantId)
    } catch (e: any) {
      setParticipants(prev)
      setCounts(prevCounts)
      alert(e?.message || 'Не удалось удалить участника')
    }
  }

  const existingContactIds = useMemo(
    () => new Set(participants.map(p => p.contact_id).filter((x): x is number => typeof x === 'number')),
    [participants]
  )

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
          <p className="text-gray-500 text-sm max-w-xs mx-auto mb-6">
            Здесь появятся пользователи Telegram, которые открыли бот по вашей реферальной ссылке на это событие. Или добавьте их вручную из своих контактов.
          </p>
          <button onClick={() => setShowAdd(true)}
            className="btn-gold inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold">
            <Plus size={16} /> Добавить из контактов
          </button>
        </div>
        {showAdd && (
          <AddFromContactModal
            eventId={eventId}
            existingContactIds={existingContactIds}
            onClose={() => setShowAdd(false)}
            onAdded={() => load(filter)}
          />
        )}
      </div>
    )
  }

  return (
    <div>
      {/* Фильтр-таблетки + кнопка добавления */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <FilterPill label="Все" count={counts.total} active={filter === 'all'} onClick={() => setFilter('all')} />
        <FilterPill label="Зарегистрированы" count={counts.registered} active={filter === 'yes'} onClick={() => setFilter('yes')} />
        <FilterPill label="Не зарегистрированы" count={counts.not_registered} active={filter === 'no'} onClick={() => setFilter('no')} />
        <div className="ml-auto">
          <button onClick={() => setShowAdd(true)}
            className="btn-gold inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold">
            <Plus size={15} /> Добавить из контактов
          </button>
        </div>
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
          <>
            <ListHeader clickLabel={clickLabel} />
            {filtered.map(p => (
              <ContactCard
                key={p.id}
                p={p}
                onToggleRegistered={(next) => toggleRegistered(p.id, next)}
                onDelete={() => deleteParticipant(p.id)}
                clickLabel={clickLabel}
              />
            ))}
          </>
        )}
      </div>
      <p className="text-xs text-gray-400 mt-2">
        Галочка в колонке «Зарегистр.» — отметка вручную, что человек зарегистрировался на событие. Снять/поставить можно кликом.
      </p>
      {showAdd && (
        <AddFromContactModal
          eventId={eventId}
          existingContactIds={existingContactIds}
          onClose={() => setShowAdd(false)}
          onAdded={() => load(filter)}
        />
      )}
    </div>
  )
}
