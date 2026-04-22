'use client'
import { useState, useEffect, useCallback } from 'react'
import { Search, UserCircle, Phone, Mail, Link2, Tag, Calendar, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

interface Contact {
  id: number
  platform_user_id: string
  username: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  utm_source: string | null
  tags: string[] | null
  ref_code: string | null
  is_unsubscribed: boolean
  last_contact_at: string | null
  created_at: string | null
  salebot_id: string | null
  referrer_name: string | null
  is_participant: boolean
}

interface ContactDetail extends Contact {
  events: {
    title: string
    slug: string
    is_registered: boolean
    registered_at: string | null
    ref_code: string
  }[]
}

function formatDate(dt: string | null) {
  if (!dt) return '—'
  return new Date(dt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function Avatar({ contact }: { contact: Contact }) {
  const initials = [contact.first_name, contact.last_name]
    .filter(Boolean).map(s => s![0]).join('').toUpperCase() || '?'
  return (
    <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
      style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
      {initials}
    </div>
  )
}

export default function ContactsPage() {
  const [search, setSearch] = useState('')
  const [showUnsubscribed, setShowUnsubscribed] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal] = useState(0)
  const [totalAll, setTotalAll] = useState(0)
  const [subscribed, setSubscribed] = useState(0)
  const [unsubscribed, setUnsubscribed] = useState(0)
  const [selected, setSelected] = useState<ContactDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [offset, setOffset] = useState(0)
  const LIMIT = 50

  const fetchContacts = useCallback(async (q: string, off: number, unsub: boolean) => {
    setLoading(true)
    try {
      const data = await api.contacts.list(q, LIMIT, off, unsub)
      setContacts(data.items || [])
      setTotal(data.total || 0)
      setTotalAll(data.total_all || 0)
      setSubscribed(data.subscribed || 0)
      setUnsubscribed(data.unsubscribed || 0)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      setOffset(0)
      fetchContacts(search, 0, showUnsubscribed)
    }, 300)
    return () => clearTimeout(t)
  }, [search, showUnsubscribed, fetchContacts])

  useEffect(() => {
    fetchContacts(search, offset, showUnsubscribed)
  }, [offset])

  const selectContact = async (id: number) => {
    setLoadingDetail(true)
    try {
      setSelected(await api.contacts.get(id))
    } catch (e) {
      console.error(e)
    } finally {
      setLoadingDetail(false)
    }
  }

  return (
    <div className="flex h-[calc(100vh-80px)] gap-4">

      {/* Левая колонка — список */}
      <div className="w-80 shrink-0 flex flex-col bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {/* Поиск */}
        <div className="p-3 border-b border-gray-100">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              className="w-full pl-9 pr-3 py-2 text-sm bg-gray-50 rounded-lg border border-gray-200 focus:outline-none focus:border-[#25455D]"
              placeholder="Имя, никнейм, email..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="mt-2 px-1 flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <p className="text-xs text-gray-500 font-medium">
                {totalAll.toLocaleString('ru')} контактов
                {showUnsubscribed ? '' : <span className="text-gray-400"> (показано {total.toLocaleString('ru')})</span>}
              </p>
              <div className="flex gap-3 text-xs">
                <span className="text-green-600">✓ {subscribed.toLocaleString('ru')}</span>
                <span className="text-red-400">✗ {unsubscribed.toLocaleString('ru')}</span>
              </div>
            </div>
            <label className="flex items-center gap-1.5 cursor-pointer select-none shrink-0">
              <div className={`w-8 h-4 rounded-full transition-colors relative ${showUnsubscribed ? 'bg-red-400' : 'bg-gray-200'}`}
                onClick={() => { setShowUnsubscribed(v => !v); setOffset(0) }}>
                <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${showUnsubscribed ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </div>
              <span className="text-xs text-gray-500">Отписавшиеся</span>
            </label>
          </div>
        </div>

        {/* Список */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-8 text-center text-gray-400 text-sm">Загрузка...</div>
          ) : contacts.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">Ничего не найдено</div>
          ) : (
            contacts.map(c => (
              <button
                key={c.id}
                onClick={() => selectContact(c.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50 transition-colors border-b border-gray-50 ${selected?.id === c.id ? 'bg-blue-50 border-l-2 border-l-[#25455D]' : ''}`}
              >
                <Avatar contact={c} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-gray-900 truncate">
                      {[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}
                    </span>
                    {c.is_participant && (
                      <span className="shrink-0 text-[10px] bg-[#FFCFA4] text-[#25455D] font-semibold px-1.5 py-0.5 rounded-full">УЧ</span>
                    )}
                  </div>
                  <span className="text-xs text-gray-400 truncate block">
                    {c.username ? `@${c.username}` : c.email || c.phone || '—'}
                  </span>
                </div>
              </button>
            ))
          )}

          {/* Пагинация */}
          {!loading && total > LIMIT && (
            <div className="flex justify-between items-center p-3 border-t border-gray-100">
              <button
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - LIMIT))}
                className="text-xs text-[#25455D] disabled:text-gray-300"
              >← Назад</button>
              <span className="text-xs text-gray-400">{offset + 1}–{Math.min(offset + LIMIT, total)}</span>
              <button
                disabled={offset + LIMIT >= total}
                onClick={() => setOffset(offset + LIMIT)}
                className="text-xs text-[#25455D] disabled:text-gray-300"
              >Вперёд →</button>
            </div>
          )}
        </div>
      </div>

      {/* Правая колонка — карточка */}
      <div className="flex-1 bg-white rounded-2xl border border-gray-100 shadow-sm overflow-y-auto">
        {!selected && !loadingDetail && (
          <div className="h-full flex flex-col items-center justify-center text-gray-400">
            <UserCircle size={48} className="mb-3 opacity-30" />
            <p className="text-sm">Выберите контакт из списка</p>
          </div>
        )}

        {loadingDetail && (
          <div className="h-full flex items-center justify-center text-gray-400 text-sm">Загрузка...</div>
        )}

        {selected && !loadingDetail && (
          <div className="p-6">
            {/* Шапка */}
            <div className="flex items-center gap-4 mb-6 pb-6 border-b border-gray-100">
              <div className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold text-white"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                {[selected.first_name, selected.last_name].filter(Boolean).map(s => s![0]).join('').toUpperCase() || '?'}
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">
                  {[selected.first_name, selected.last_name].filter(Boolean).join(' ') || '—'}
                </h2>
                {selected.username && (
                  <a href={`https://t.me/${selected.username}`} target="_blank" rel="noreferrer"
                    className="text-sm text-[#25455D] flex items-center gap-1 mt-0.5 hover:underline">
                    @{selected.username} <ExternalLink size={12} />
                  </a>
                )}
              </div>
              {selected.is_unsubscribed && (
                <span className="ml-auto text-xs bg-red-100 text-red-600 px-2 py-1 rounded-full">Отписан</span>
              )}
            </div>

            {/* Поля */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              {selected.phone && (
                <div className="flex items-start gap-2">
                  <Phone size={15} className="text-gray-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs text-gray-400">Телефон</p>
                    <p className="text-sm text-gray-800">{selected.phone}</p>
                  </div>
                </div>
              )}
              {selected.email && (
                <div className="flex items-start gap-2">
                  <Mail size={15} className="text-gray-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs text-gray-400">Email</p>
                    <p className="text-sm text-gray-800 break-all">{selected.email}</p>
                  </div>
                </div>
              )}
              {selected.referrer_name && (
                <div className="flex items-start gap-2">
                  <Link2 size={15} className="text-gray-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs text-gray-400">Пришёл от</p>
                    <p className="text-sm text-gray-800">{selected.referrer_name}</p>
                  </div>
                </div>
              )}
              {selected.utm_source && (
                <div className="flex items-start gap-2">
                  <Link2 size={15} className="text-gray-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs text-gray-400">Источник</p>
                    <p className="text-sm text-gray-800">{selected.utm_source}</p>
                  </div>
                </div>
              )}
              <div className="flex items-start gap-2">
                <Calendar size={15} className="text-gray-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-gray-400">Первый контакт</p>
                  <p className="text-sm text-gray-800">{formatDate(selected.created_at)}</p>
                </div>
              </div>
              {selected.last_contact_at && (
                <div className="flex items-start gap-2">
                  <Calendar size={15} className="text-gray-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs text-gray-400">Последний контакт</p>
                    <p className="text-sm text-gray-800">{formatDate(selected.last_contact_at)}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Метки */}
            {selected.tags && selected.tags.length > 0 && (
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-2">
                  <Tag size={14} className="text-gray-400" />
                  <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">Метки</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {selected.tags.map((tag, i) => (
                    <span key={i} className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-full">{tag}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Участие в событиях */}
            {selected.events && selected.events.length > 0 && (
              <div>
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-2">Участие в событиях</p>
                <div className="space-y-2">
                  {selected.events.map((ev, i) => (
                    <div key={i} className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-gray-800">{ev.title}</p>
                        <p className="text-xs text-gray-400">{formatDate(ev.registered_at)}</p>
                      </div>
                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${ev.is_registered ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                        {ev.is_registered ? 'Зарегистрирован' : 'Посетитель'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
