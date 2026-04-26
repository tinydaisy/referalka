'use client'
import { useState, useEffect, useCallback } from 'react'
import { Search, UserCircle, Phone, Mail, Link2, Tag, Calendar, ExternalLink, GitMerge, AlertCircle, Bell, BellOff } from 'lucide-react'
import { api } from '@/lib/api'

interface Identity {
  platform_slug: string
  platform_user_id: string
  username: string | null
  first_name: string | null
  last_name: string | null
}

interface Contact {
  id: number
  name: string | null
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
  identities: Identity[] | null
  // Backwards-compat поля (отдаются API для совместимости с рекомендованной идентичностью)
  platform_user_id: string | null
  username: string | null
  first_name: string | null
  last_name: string | null
}

interface Subscription {
  channel_id: number
  channel_name: string
  channel_handle: string | null
  is_unsubscribed: boolean
  subscribed_at: string | null
  unsubscribed_at: string | null
}

interface IdentityWithSubs extends Identity {
  id: number
  platform_display_name: string
  platform_icon_url: string | null
  platform_color_hex: string | null
  subscriptions: Subscription[]
}

interface ContactDetail extends Contact {
  identities: IdentityWithSubs[]
  events: {
    id: number
    title: string
    slug: string
    is_registered: boolean
    is_in_chat: boolean
    registered_at: string | null
    ref_code: string
    referrals_count: number
  }[]
  referrer: { id: number; name: string | null } | null
  merged_ref_codes: string[]
}

interface DuplicateContact {
  id: number
  name: string | null
  email: string | null
  phone: string | null
  ref_code: string | null
  match_reason: 'email' | 'phone' | 'name' | 'other'
}

function formatDate(dt: string | null) {
  if (!dt) return '—'
  return new Date(dt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function PlatformIcon({ slug, color }: { slug: string; color?: string | null }) {
  // Простой текстовый бейдж — пока без SVG-иконок (они в /public после деплоя)
  const labels: Record<string, string> = { telegram: 'TG', vk: 'VK', max: 'MX' }
  return (
    <span
      className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-bold text-white shrink-0"
      style={{ background: color || '#25455D' }}
    >
      {labels[slug] || slug.slice(0, 2).toUpperCase()}
    </span>
  )
}

function getName(c: Contact): string {
  return c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '—'
}

function getInitials(c: Contact): string {
  const name = getName(c)
  if (name === '—') return '?'
  return name.split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?'
}

function Avatar({ contact }: { contact: Contact }) {
  return (
    <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
      style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
      {getInitials(contact)}
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
  const [duplicates, setDuplicates] = useState<DuplicateContact[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [offset, setOffset] = useState(0)
  const [merging, setMerging] = useState(false)
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
      const [detail, dups] = await Promise.all([
        api.contacts.get(id),
        api.contacts.duplicates(id).catch(() => ({ items: [] })),
      ])
      setSelected(detail)
      setDuplicates(dups.items || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoadingDetail(false)
    }
  }

  const mergeWith = async (targetId: number) => {
    if (!selected) return
    if (!confirm('Объединить контакты? Идентичности и события второго перенесутся к этому контакту.')) return
    setMerging(true)
    try {
      await api.contacts.merge(selected.id, targetId)
      await selectContact(selected.id)
      await fetchContacts(search, offset, showUnsubscribed)
    } catch (e) {
      console.error(e)
      alert('Ошибка объединения: ' + (e as Error).message)
    } finally {
      setMerging(false)
    }
  }

  return (
    <div className="flex h-[calc(100vh-80px)] gap-4">
      {/* Левая колонка — список */}
      <div className="w-80 shrink-0 flex flex-col bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
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
                      {getName(c)}
                    </span>
                    {c.identities && c.identities.length > 0 && (
                      <div className="flex gap-0.5 shrink-0">
                        {c.identities.slice(0, 3).map(ident => (
                          <PlatformIcon key={ident.platform_slug} slug={ident.platform_slug} />
                        ))}
                      </div>
                    )}
                    {c.is_participant && (
                      <span className="shrink-0 text-[10px] bg-[#FFCFA4] text-[#25455D] font-semibold px-1.5 py-0.5 rounded-full">УЧ</span>
                    )}
                  </div>
                  <span className="text-xs text-gray-400 truncate block">
                    {c.email || c.phone || '—'}
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
              <div className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold text-white shrink-0"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                {getInitials(selected)}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-xl font-bold text-gray-900 truncate">
                  {getName(selected)}
                </h2>
                <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
                  {selected.email && <span className="truncate">{selected.email}</span>}
                  {selected.phone && <span className="shrink-0">{selected.phone}</span>}
                </div>
              </div>
              {selected.is_unsubscribed && (
                <span className="ml-auto text-xs bg-red-100 text-red-600 px-2 py-1 rounded-full shrink-0">Отписан</span>
              )}
            </div>

            {/* Каналы — группы по платформам */}
            {selected.identities && selected.identities.length > 0 && (
              <div className="mb-6">
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-3">Каналы</p>
                <div className="space-y-3">
                  {selected.identities.map(ident => (
                    <div key={ident.id} className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
                      <div className="flex items-center gap-2 mb-2">
                        <PlatformIcon slug={ident.platform_slug} color={ident.platform_color_hex} />
                        <span className="text-sm font-semibold text-gray-700">
                          {ident.platform_display_name}
                        </span>
                        {ident.username ? (
                          <a
                            href={ident.platform_slug === 'telegram' ? `https://t.me/${ident.username}` : '#'}
                            target="_blank" rel="noreferrer"
                            className="text-sm text-[#25455D] hover:underline flex items-center gap-1"
                          >
                            @{ident.username}<ExternalLink size={11} />
                          </a>
                        ) : (
                          <span className="text-xs text-gray-400 font-mono">{ident.platform_user_id}</span>
                        )}
                      </div>
                      {ident.subscriptions.length > 0 ? (
                        <ul className="space-y-1">
                          {ident.subscriptions.map(sub => (
                            <li key={sub.channel_id} className="flex items-center gap-2 text-xs">
                              {sub.is_unsubscribed ? (
                                <BellOff size={12} className="text-red-400 shrink-0" />
                              ) : (
                                <Bell size={12} className="text-green-500 shrink-0" />
                              )}
                              <span className={sub.is_unsubscribed ? 'text-gray-400 line-through' : 'text-gray-700'}>
                                {sub.channel_name}
                              </span>
                              {sub.is_unsubscribed && sub.unsubscribed_at && (
                                <span className="text-gray-400 ml-auto">отписался {formatDate(sub.unsubscribed_at)}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-gray-400 italic">Нет подписок на каналы</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Реф-код и реферер */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 mb-6">
              {selected.ref_code && (
                <div className="flex items-start gap-2">
                  <Link2 size={15} className="text-gray-400 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-gray-400">Реф-код</p>
                    <p className="text-sm text-gray-800 font-mono break-all">{selected.ref_code}</p>
                  </div>
                </div>
              )}
              {selected.referrer && (
                <div className="flex items-start gap-2">
                  <Link2 size={15} className="text-gray-400 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-gray-400">Пришёл от</p>
                    <p className="text-sm text-gray-800">{selected.referrer.name || '—'}</p>
                  </div>
                </div>
              )}
              {selected.utm_source && (
                <div className="flex items-start gap-2">
                  <Link2 size={15} className="text-gray-400 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-gray-400">Источник (UTM)</p>
                    <p className="text-sm text-gray-800">{selected.utm_source}</p>
                  </div>
                </div>
              )}
              {selected.salebot_id && (
                <div className="flex items-start gap-2">
                  <UserCircle size={15} className="text-gray-400 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-gray-400">Salebot ID</p>
                    <p className="text-sm text-gray-800 font-mono">{selected.salebot_id}</p>
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

            {/* События */}
            {selected.events && selected.events.length > 0 && (
              <div className="mb-6">
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-2">Участие в событиях</p>
                <div className="space-y-2">
                  {selected.events.map((ev, i) => (
                    <div key={i} className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-gray-800">{ev.title}</p>
                        <p className="text-xs text-gray-400">
                          {formatDate(ev.registered_at)}
                          {ev.referrals_count > 0 && <span className="ml-2 text-[#25455D]">· привёл {ev.referrals_count}</span>}
                        </p>
                      </div>
                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${ev.is_registered ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                        {ev.is_registered ? 'Зарегистрирован' : 'Посетитель'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Возможные дубли */}
            {duplicates.length > 0 && (
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-2">
                  <AlertCircle size={14} className="text-amber-500" />
                  <p className="text-xs text-amber-700 font-medium uppercase tracking-wide">Возможные дубли</p>
                </div>
                <div className="space-y-2">
                  {duplicates.map(d => (
                    <div key={d.id} className="flex items-center justify-between bg-amber-50 border border-amber-100 rounded-xl px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{d.name || '—'}</p>
                        <p className="text-xs text-gray-500 truncate">
                          {d.email || d.phone}
                          <span className="ml-2 text-amber-700">совпадение по {d.match_reason === 'email' ? 'email' : d.match_reason === 'phone' ? 'телефону' : 'имени'}</span>
                        </p>
                      </div>
                      <button
                        onClick={() => mergeWith(d.id)}
                        disabled={merging}
                        className="shrink-0 ml-3 text-xs flex items-center gap-1 px-3 py-1.5 bg-[#25455D] text-white rounded-full hover:opacity-90 disabled:opacity-50"
                      >
                        <GitMerge size={12} />Объединить
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Слитые реф-коды (исторические) */}
            {selected.merged_ref_codes && selected.merged_ref_codes.length > 0 && (
              <div className="mb-2">
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-2">Слитые реф-коды</p>
                <div className="flex flex-wrap gap-1.5">
                  {selected.merged_ref_codes.map((code, i) => (
                    <span key={i} className="text-xs bg-gray-100 text-gray-500 px-2 py-1 rounded-full font-mono">{code}</span>
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
