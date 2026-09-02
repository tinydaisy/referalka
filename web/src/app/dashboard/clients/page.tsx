'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Search, UserCircle, Phone, Mail, MailX, Link2, Tag, Calendar, ExternalLink, GitMerge, AlertCircle, Bell, BellOff, SlidersHorizontal, X, Download, Pencil, Check, Briefcase, Trash2, ChevronDown, ChevronLeft, ChevronUp, Send, Pin } from 'lucide-react'
import { api, ContactFilters } from '@/lib/api'
import { MultiSelectDropdown, MultiSelectOption } from '@/components/MultiSelectDropdown'
import { useMe } from '@/hooks/useMe'
import DialogChat from '@/components/DialogChat'
// ⚠️ Форма доп. поля — ОБЩАЯ с разделом «Анкеты»: поле заводится из двух мест,
// а форма одна (иначе разъедется список типов и вариантов).
import ContactFieldForm from '@/components/ContactFieldForm'
import { MoreHorizontal, Plus as PlusIcon, Upload } from 'lucide-react'

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
  pinned_at?: string | null
  ref_code: string | null
  external_ref_param: string | null
  linked_client_id?: number | null
  linked_client_email?: string | null
  is_staff?: boolean
  is_blacklisted?: boolean
  /** Почтовик вернул отказ по адресу — письма на него не уходят. */
  email_is_dead?: boolean
  is_unsubscribed: boolean
  last_contact_at: string | null
  created_at: string | null
  salebot_id: string | null
  referrer_name: string | null
  is_participant: boolean
  /** Непрочитанные сообщения ОТ человека в ботах (TG/VK/MAX). */
  unread_count?: number
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
  /** Причина отказа почтовика, уже переведённая бэкендом на русский. */
  email_dead_reason?: string | null
  email_dead_at?: string | null
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
  collaborator: {
    id: number
    name: string
    title: string | null
    photo_url: string | null
  } | null
  // Согласия 152-ФЗ (миграция 099)
  consent_pd_at: string | null
  consent_pd_ip: string | null
  consent_pd_policy_ver: number | null
  consent_marketing_at: string | null
  consent_marketing_ip: string | null
  consent_marketing_policy_ver: number | null
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

// Краткая мета-строка под именем: @tg_nick · vk:id · email/phone
function getMetaLine(c: Contact): string {
  const parts: string[] = []
  for (const ident of c.identities || []) {
    if (ident.platform_slug === 'telegram') {
      if (ident.username) parts.push(`@${ident.username}`)
      else if (ident.platform_user_id) parts.push(`tg:${ident.platform_user_id}`)
    } else if (ident.platform_slug === 'vk') {
      if (ident.username) parts.push(`vk:@${ident.username}`)
      else if (ident.platform_user_id) parts.push(`vk:${ident.platform_user_id}`)
    } else if (ident.platform_slug === 'max') {
      if (ident.username) parts.push(`mx:@${ident.username}`)
      else if (ident.platform_user_id) parts.push(`mx:${ident.platform_user_id}`)
    }
  }
  const contactInfo = c.email || c.phone
  if (contactInfo) parts.push(contactInfo)
  return parts.join(' · ') || '—'
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

const EMPTY_FILTERS: ContactFilters = {
  subscription: 'any',
  platforms: [],
  utmSources: [],
  tags: [],
  eventIds: [],
  leadMagnetIds: [],
  packageIds: [],
  leadMagnetStage: 'any',
  blacklisted: '',
  dateFrom: '',
  dateTo: '',
  createdFrom: '',
  createdTo: '',
}

function countActiveFilters(f: ContactFilters): number {
  let n = 0
  if (f.subscription && f.subscription !== 'any') n++
  if (f.platforms?.length) n++
  if (f.channelIds?.length || f.includeUnattached) n++
  if (f.utmSources?.length) n++
  if (f.tags?.length) n++
  if (f.eventIds?.length) n++
  if (f.leadMagnetIds?.length) n++
  if (f.packageIds?.length) n++
  if (f.blacklisted) n++
  if (f.dateFrom) n++
  if (f.dateTo) n++
  if (f.createdFrom) n++
  if (f.createdTo) n++
  return n
}

function parseFiltersFromUrl(): { filters: ContactFilters; search: string; showUnsubscribed: boolean } {
  if (typeof window === 'undefined') return { filters: EMPTY_FILTERS, search: '', showUnsubscribed: false }
  const sp = new URLSearchParams(window.location.search)
  const ints = (k: string) => (sp.get(k) || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n))
  const strs = (k: string) => (sp.get(k) || '').split(',').map(s => s.trim()).filter(Boolean)
  const f: ContactFilters = { ...EMPTY_FILTERS }
  const sub = sp.get('subscription')
  if (sub === 'subscribed' || sub === 'unsubscribed' || sub === 'any') f.subscription = sub
  if (sp.has('platforms'))    f.platforms = strs('platforms')
  if (sp.has('channel_ids'))  f.channelIds = ints('channel_ids')
  if (sp.get('include_unattached') === '1') f.includeUnattached = true
  if (sp.has('utm_sources'))  f.utmSources = strs('utm_sources')
  if (sp.has('tags'))         f.tags = strs('tags')
  if (sp.has('event_ids'))    f.eventIds = ints('event_ids')
  if (sp.has('lead_magnet_ids')) f.leadMagnetIds = ints('lead_magnet_ids')
  if (sp.has('package_ids'))  f.packageIds = ints('package_ids')
  const lms = sp.get('lead_magnet_stage')
  if (lms === 'delivered' || lms === 'not_delivered' || lms === 'any') f.leadMagnetStage = lms
  const bl = sp.get('blacklisted')
  if (bl === 'yes' || bl === 'no') f.blacklisted = bl
  f.dateFrom = sp.get('date_from') || ''
  f.dateTo = sp.get('date_to') || ''
  f.createdFrom = sp.get('created_from') || ''
  f.createdTo = sp.get('created_to') || ''
  return {
    filters: f,
    search: sp.get('q') || '',
    showUnsubscribed: sp.get('show_unsubscribed') === '1',
  }
}

function syncFiltersToUrl(filters: ContactFilters, search: string, showUnsubscribed: boolean) {
  if (typeof window === 'undefined') return
  const sp = new URLSearchParams(window.location.search)
  ;['q','subscription','platforms','channel_ids','include_unattached','utm_sources','tags',
    'event_ids','lead_magnet_ids','package_ids','lead_magnet_stage','blacklisted','date_from','date_to','created_from','created_to','show_unsubscribed']
    .forEach(k => sp.delete(k))
  if (search) sp.set('q', search)
  if (showUnsubscribed) sp.set('show_unsubscribed', '1')
  if (filters.subscription && filters.subscription !== 'any') sp.set('subscription', filters.subscription)
  if (filters.platforms?.length) sp.set('platforms', filters.platforms.join(','))
  if (filters.channelIds?.length) sp.set('channel_ids', filters.channelIds.join(','))
  if (filters.includeUnattached) sp.set('include_unattached', '1')
  if (filters.utmSources?.length) sp.set('utm_sources', filters.utmSources.join(','))
  if (filters.tags?.length) sp.set('tags', filters.tags.join(','))
  if (filters.eventIds?.length) sp.set('event_ids', filters.eventIds.join(','))
  if (filters.leadMagnetIds?.length) sp.set('lead_magnet_ids', filters.leadMagnetIds.join(','))
  if (filters.packageIds?.length) sp.set('package_ids', filters.packageIds.join(','))
  if (filters.leadMagnetStage && filters.leadMagnetStage !== 'any'
      && (filters.leadMagnetIds?.length || filters.packageIds?.length)) {
    sp.set('lead_magnet_stage', filters.leadMagnetStage)
  }
  if (filters.blacklisted) sp.set('blacklisted', filters.blacklisted)
  if (filters.dateFrom) sp.set('date_from', filters.dateFrom)
  if (filters.dateTo) sp.set('date_to', filters.dateTo)
  if (filters.createdFrom) sp.set('created_from', filters.createdFrom)
  if (filters.createdTo) sp.set('created_to', filters.createdTo)
  const qs = sp.toString()
  const next = window.location.pathname + (qs ? `?${qs}` : '')
  window.history.replaceState(null, '', next)
}

/* ─────────────────── Меню действий над базой контактов ──────────────────── */
/**
 * Одно место для действий со ВСЕЙ базой, а не россыпь кнопок над списком.
 * Сейчас внутри: выгрузка CSV и создание дополнительного поля контакта.
 * Сюда же лягут будущие массовые операции.
 *
 * ⚠️ «Добавить поле» открывает ТУ ЖЕ форму, что в разделе «Анкеты» — поле
 * создаётся один раз на кабинет и сразу существует у всех контактов. Люди
 * искали эту настройку в «Контактах» и не находили: она была только в
 * «Анкетах», куда за полем контакта никто не идёт.
 */
function ContactsActionsMenu({
  onExport, exporting, total, onAddField, canAddField,
}: {
  onExport: () => void
  exporting: boolean
  total: number
  onAddField: () => void
  canAddField: boolean
}) {
  const [open, setOpen] = useState(false)

  // Клик мимо закрывает меню. Это НЕ форма — вводимых данных тут нет,
  // поэтому закрытие по фону уместно (в отличие от модалок-форм).
  useEffect(() => {
    if (!open) return
    const onDoc = () => setOpen(false)
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [open])

  return (
    <div className="relative shrink-0" onClick={e => e.stopPropagation()}>
      <button
        onClick={() => setOpen(v => !v)}
        title="Действия с базой"
        className="px-2.5 py-[7px] rounded-lg border border-gray-200 bg-gray-50 text-sm text-gray-600 hover:bg-gray-100"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-64 rounded-xl border border-gray-200 bg-white py-1 shadow-lg">
          <Link
            href="/dashboard/clients/import"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
          >
            <Upload size={14} />
            Загрузить базу (CSV)
          </Link>
          <button
            onClick={() => { setOpen(false); onExport() }}
            disabled={exporting || total === 0}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            <Download size={14} />
            {exporting ? 'Готовим файл…' : 'Скачать базу (CSV)'}
          </button>
          {canAddField && (
            <button
              onClick={() => { setOpen(false); onAddField() }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
            >
              <PlusIcon size={14} />
              Добавить поле контактам
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function ContactsPage() {
  const { me, isAssistant } = useMe()
  // Создание доп. поля контакта прямо из «Контактов» (форма общая с «Анкетами»).
  const [addingField, setAddingField] = useState(false)
  // Инициализируем из URL — для deep-link с лид-магнитов и для возврата к фильтру.
  const initial = typeof window !== 'undefined' ? parseFiltersFromUrl() : { filters: EMPTY_FILTERS, search: '', showUnsubscribed: false }
  const [search, setSearch] = useState(initial.search)
  const [showUnsubscribed, setShowUnsubscribed] = useState(initial.showUnsubscribed)
  const [filters, setFilters] = useState<ContactFilters>(initial.filters)
  const [filterPanelOpen, setFilterPanelOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal] = useState(0)
  const [totalAll, setTotalAll] = useState(0)
  const [subscribed, setSubscribed] = useState(0)
  const [unsubscribed, setUnsubscribed] = useState(0)
  const [selected, setSelected] = useState<ContactDetail | null>(null)
  const [duplicates, setDuplicates] = useState<DuplicateContact[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  // Ошибка deep-link (?contact=ID указывает на чужой контакт → 404).
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [merging, setMerging] = useState(false)
  // Свёрнутость секций «События» и «Лид-магниты» в карточке (по умолчанию свёрнуты для компактности)
  const [eventsOpen, setEventsOpen] = useState(false)
  const [magnetsOpen, setMagnetsOpen] = useState(false)
  const LIMIT = 50
  const activeFilterCount = countActiveFilters(filters)

  const fetchContacts = useCallback(async (q: string, off: number, unsub: boolean, f: ContactFilters) => {
    setLoading(true)
    try {
      const data = await api.contacts.list(q, LIMIT, off, unsub, f)
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
    syncFiltersToUrl(filters, search, showUnsubscribed)
    const t = setTimeout(() => {
      setOffset(0)
      fetchContacts(search, 0, showUnsubscribed, filters)
    }, 300)
    return () => clearTimeout(t)
  }, [search, showUnsubscribed, filters, fetchContacts])

  async function handleExport() {
    setExporting(true)
    try {
      const blob = await api.contacts.exportCsv(search, showUnsubscribed, filters)
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const stamp = new Date().toISOString().slice(0, 10)
      a.download = `contacts-${stamp}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    } catch (e) {
      alert('Ошибка экспорта: ' + (e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  useEffect(() => {
    fetchContacts(search, offset, showUnsubscribed, filters)
  }, [offset])

  // Deep-link: ?contact=ID — автоматически открыть карточку этого контакта.
  // Используется со страницы коллаборатора («Открыть карточку»).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const cid = sp.get('contact')
    if (cid && /^\d+$/.test(cid)) {
      selectContact(Number(cid))
    }
  }, [])

  const selectContact = async (id: number) => {
    setLoadingDetail(true)
    setDeepLinkError(null)
    try {
      const [detail, dups] = await Promise.all([
        api.contacts.get(id),
        api.contacts.duplicates(id).catch(() => ({ items: [] })),
      ])
      setSelected(detail)
      setDuplicates(dups.items || [])
      // Открыли карточку → DialogChat грузит переписку и на бэке помечает
      // входящие прочитанными. Гасим бейдж сразу, чтобы цифра не висела.
      const hadUnread = contacts.some((c: any) => c.id === id && c.unread_count)
      setContacts((cs: any[]) => cs.map(c =>
        c.id === id && c.unread_count ? { ...c, unread_count: 0 } : c
      ))
      // ⚠️ И перечитываем список: прочитанный диалог должен УЕХАТЬ ВНИЗ, к
      // остальным прочитанным, как в мессенджере. Раньше строка оставалась
      // стоять среди непрочитанных, и было не видно, что уже просмотрено, а
      // что нет. Перечитываем только если непрочитанные реально были — иначе
      // каждый клик по контакту дёргал бы список впустую.
      // Порядок задаёт бэкенд: сначала непрочитанные по дате, ниже
      // прочитанные по дате последнего сообщения.
      if (hadUnread) {
        fetchContacts(search, offset, showUnsubscribed, filters).catch(() => {})
      }
    } catch (e: any) {
      console.error(e)
      // Контакт из ЧУЖОЙ базы (напр. уведомление пришло через @pluson_bot —
      // сервисного клиента, а вы залогинены в своём кабинете) → API 404.
      // Показываем это понятно, а не пустой экран.
      const msg = (e?.message || '')
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        setDeepLinkError('Этот контакт не в вашей базе. Возможно, сообщение пришло через другого бота (не ваш кабинет).')
      }
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
      await fetchContacts(search, offset, showUnsubscribed, filters)
    } catch (e) {
      console.error(e)
      alert('Ошибка объединения: ' + (e as Error).message)
    } finally {
      setMerging(false)
    }
  }

  return (
    <div className="flex h-[calc(100vh-80px)] gap-4">
      {/* Левая колонка — список.
          ⚠️ Мобильный: три колонки на узкий экран не помещаются — показываем ЧТО-ТО ОДНО.
          Выбран контакт → список СКРЫВАЕМ (видна карточка+чат с кнопкой «Назад»). Не выбран
          → список во всю ширину. На десктопе (md:) список виден всегда рядом с чатом. */}
      <div className={`${(selected || deepLinkError) ? 'hidden md:flex' : 'flex'} w-full md:w-80 shrink-0 flex-col bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden`}>
        <div className="p-3 border-b border-gray-100">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                className="w-full pl-9 pr-3 py-2 text-sm bg-gray-50 rounded-lg border border-gray-200 focus:outline-none focus:border-[#25455D]"
                placeholder="Имя, @ник, email, телефон, реф-код, gcpc=..., TG ID"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <button
              onClick={() => setFilterPanelOpen(true)}
              className={`relative px-2.5 rounded-lg border text-sm flex items-center gap-1 shrink-0 ${
                activeFilterCount > 0
                  ? 'border-[#25455D] bg-[#25455D] text-white'
                  : 'border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100'
              }`}
              title="Настройки фильтра"
            >
              <SlidersHorizontal size={14} />
              {activeFilterCount > 0 && (
                <span className="text-[10px] font-bold bg-white text-[#25455D] rounded-full px-1.5 leading-4">
                  {activeFilterCount}
                </span>
              )}
            </button>
            {/* Меню действий над базой. Сюда же лягут будущие массовые
                операции — чтобы они не расползались отдельными кнопками. */}
            <ContactsActionsMenu
              onExport={handleExport}
              exporting={exporting}
              total={total}
              onAddField={() => setAddingField(true)}
              canAddField={!isAssistant && (me?.features || []).includes('surveys')}
            />
          </div>

          {/* Создание доп. поля прямо отсюда — форма общая с «Анкетами».
              Новое поле появляется у всех контактов сразу (пустым). */}
          {addingField && (
            <div className="mt-3">
              {/* Список контактов не перечитываем: новое поле у всех пустое,
                  на выдачу списка оно не влияет. */}
              <ContactFieldForm
                onClose={() => setAddingField(false)}
                onSaved={() => setAddingField(false)}
              />
            </div>
          )}
          <div className="mt-2 px-1 flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              {/* ⚠️ При включённых фильтрах показываем НАЙДЕНО, а не общее число.
                  Раньше здесь всегда висело total_all (вся база) — и когда фильтр
                  отсекал всех, список пустел, а счётчик по-прежнему показывал
                  7466: выглядело как «фильтр не работает», хотя он работал. */}
              <p className="text-xs text-gray-500 font-medium">
                {activeFilterCount > 0 || search.trim()
                  ? <>Найдено: <span className="text-gray-800">{total.toLocaleString('ru')}</span>
                      <span className="text-gray-400"> из {totalAll.toLocaleString('ru')}</span></>
                  : <>{totalAll.toLocaleString('ru')} контактов</>}
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
          {activeFilterCount > 0 && (
            <button
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="mt-2 w-full text-xs text-gray-500 hover:text-red-500 flex items-center justify-center gap-1 py-1"
            >
              <X size={12} /> Сбросить фильтры ({activeFilterCount})
            </button>
          )}
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
                    {/* ⚠️ Гвоздик у закреплённых: они подняты наверх списка,
                        и без значка непонятно, почему человек стоит первым
                        (замечание владельца). */}
                    {c.pinned_at && (
                      <Pin size={12} className="shrink-0 text-[#25455D]"
                           style={{ fill: 'currentColor' }} />
                    )}
                    {/* Есть непрочитанные — имя жирнее, как в мессенджерах:
                        за один бейдж справа взгляд не цепляется. */}
                    <span className={`text-sm truncate ${
                      c.unread_count ? 'font-bold text-[#25455D]' : 'font-medium text-gray-900'
                    }`}>
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
                    {c.is_blacklisted && (
                      <span
                        title="В чёрном списке"
                        className="shrink-0 w-2 h-2 rounded-full bg-red-600"
                      />
                    )}
                    {c.email_is_dead && (
                      <span
                        title="Адрес не работает — письма на него не отправляются"
                        className="shrink-0 text-red-500"
                      >
                        <MailX size={13} />
                      </span>
                    )}
                    {/* Непрочитанные сообщения от человека — как в мессенджере.
                        Бейдж прижат к правому краю (ml-auto), чтобы читался
                        столбиком по всему списку, а не прыгал за именем. */}
                    {!!c.unread_count && (
                      <span
                        title={`Новых сообщений: ${c.unread_count}`}
                        className="ml-auto shrink-0 min-w-[20px] text-center text-[11px] font-bold px-1.5 py-0.5 rounded-full"
                        style={{ background: '#FFCFA4', color: '#25455D' }}
                      >
                        {c.unread_count}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-gray-400 truncate block">
                    {getMetaLine(c)}
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

      {/* Центральная колонка — чат с контактом */}
      <div className="hidden md:flex flex-1 bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden flex-col">
        {selected && !loadingDetail ? (
          <DialogChat
            key={selected.id}
            contactId={selected.id}
            contactName={getName(selected)}
            availablePlatforms={(selected.identities || [])
              .map((i: any) => i.platform_slug)
              .filter((p: string) => ['telegram', 'vk', 'max'].includes(p))}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-gray-300">
            <Send size={40} className="mb-3 opacity-30" />
            <p className="text-sm">Чат с контактом появится здесь</p>
          </div>
        )}
      </div>

      {/* Правая колонка — параметры контакта (на десктопе уже, в одну колонку).
          Мобильный: если контакт не выбран — колонку прячем (виден список во всю ширину). */}
      <div className={`${(selected || deepLinkError) ? 'flex flex-col w-full' : 'hidden md:block'} md:flex-none md:w-[380px] bg-white rounded-2xl border border-gray-100 shadow-sm overflow-y-auto`}>
        {/* Мобильная кнопка «Назад к списку» — только когда контакт открыт. */}
        {selected && (
          <button
            onClick={() => setSelected(null)}
            className="md:hidden flex items-center gap-1 text-sm text-gray-600 px-4 py-3 border-b border-gray-100 sticky top-0 bg-white z-10">
            <ChevronLeft size={18} /> Назад к списку
          </button>
        )}
        {!selected && !loadingDetail && deepLinkError && (
          <div className="h-full flex flex-col items-center justify-center text-center px-6 text-gray-500">
            <AlertCircle size={40} className="mb-3 text-amber-400" />
            <p className="text-sm">{deepLinkError}</p>
          </div>
        )}
        {!selected && !loadingDetail && !deepLinkError && (
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
            {/* items-start, а не items-center: имя переносится на 2 строки,
                и при центрировании аватар с кнопками уезжали вниз. */}
            <div className="flex items-start gap-4 mb-6 pb-6 border-b border-gray-100">
              <div className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold text-white shrink-0"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                {getInitials(selected)}
              </div>
              <div className="min-w-0 flex-1">
                <ContactNameEditor
                  contactId={selected.id}
                  initialName={getName(selected)}
                  onSaved={(newName) => {
                    setSelected((s: any) => s ? { ...s, name: newName } : s)
                    setContacts((cs: any[]) => cs.map(c => c.id === selected.id ? { ...c, name: newName } : c))
                  }}
                />
                <button
                  type="button"
                  onClick={() => { navigator.clipboard.writeText(String(selected.id)) }}
                  title="Скопировать contact_id (нужен для интеграции с GetCourse/Salebot)"
                  className="mt-1 text-xs text-gray-400 hover:text-gray-700 font-mono"
                >
                  contact_id: #{selected.id} ⧉
                </button>
              </div>
              {selected.is_unsubscribed && (
                <span className="ml-auto text-xs bg-red-100 text-red-600 px-2 py-1 rounded-full shrink-0">Отписан</span>
              )}
              {selected.is_blacklisted && (
                <span className={`${selected.is_unsubscribed ? 'ml-1' : 'ml-auto'} text-xs bg-red-600 text-white font-semibold px-2 py-1 rounded-full shrink-0`}>
                  В ЧС
                </span>
              )}
              {(selected as any).was_in_webinar && (
                <span className={`${(selected.is_unsubscribed || selected.is_blacklisted) ? 'ml-1' : 'ml-auto'} text-xs bg-green-600 text-white font-semibold px-2 py-1 rounded-full shrink-0`}>
                  📺 Был в эфире
                </span>
              )}
              {!isAssistant && (
              <button
                onClick={async () => {
                  if (selected.collaborator) {
                    alert('Контакт связан с коллаборатором (спикер/соорганизатор). Сначала удалите коллаборацию в разделе «Коллаборации», потом контакт.')
                    return
                  }
                  const confirmMsg = `Удалить контакт «${getName(selected)}» полностью?\n\nЭто действие нельзя отменить. Будут удалены:\n• сам контакт и все его идентичности (TG/VK/MAX)\n• все участия в событиях\n• все прохождения воронок лид-магнитов\n\nЕсли хотите просто отписать — используйте мерж или фильтр «Отписаны».`
                  if (!confirm(confirmMsg)) return
                  try {
                    await api.contacts.delete(selected.id)
                    setSelected(null)
                    await fetchContacts(search, offset, showUnsubscribed, filters)
                  } catch (e: any) {
                    alert('Ошибка удаления: ' + (e?.message || 'неизвестная'))
                  }
                }}
                className="ml-2 p-2 text-red-500 hover:bg-red-50 rounded-lg shrink-0"
                title="Удалить контакт полностью"
              >
                <Trash2 size={16} />
              </button>
              )}
            </div>

            {/* Если контакт — также коллаборатор, показываем ссылку */}
            {selected.collaborator && (
              <Link
                href={`/dashboard/collaborations/${selected.collaborator.id}`}
                className="mb-6 flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-2xl p-3 hover:bg-amber-100 transition-colors group"
              >
                <div className="w-10 h-10 rounded-full overflow-hidden shrink-0 bg-white border border-amber-200 flex items-center justify-center">
                  {selected.collaborator.photo_url
                    ? <img src={selected.collaborator.photo_url} alt={selected.collaborator.name} className="w-full h-full object-cover" />
                    : <Briefcase size={16} className="text-amber-600" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-semibold text-amber-900 uppercase tracking-wide">Этот контакт имеет карточку спикера</div>
                  <div className="text-sm text-gray-800 truncate">
                    {selected.collaborator.name}
                    {selected.collaborator.title && <span className="text-gray-500"> — {selected.collaborator.title}</span>}
                  </div>
                </div>
                <ExternalLink size={14} className="text-amber-700 shrink-0 group-hover:translate-x-0.5 transition-transform" />
              </Link>
            )}

            {/* Каналы — группы по платформам */}
            {selected.identities && selected.identities.length > 0 && (
              <div className="mb-6">
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-3">Каналы</p>
                <div className="space-y-3">
                  {selected.identities.map(ident => (
                    <div key={ident.id} className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <PlatformIcon slug={ident.platform_slug} color={ident.platform_color_hex} />
                        <span className="text-sm font-semibold text-gray-700">
                          {ident.platform_display_name}
                        </span>
                        {ident.username && (
                          <a
                            href={ident.platform_slug === 'telegram' ? `https://telegram.me/${ident.username}` : '#'}
                            target="_blank" rel="noreferrer"
                            className="text-sm text-[#25455D] hover:underline flex items-center gap-1"
                          >
                            @{ident.username}<ExternalLink size={11} />
                          </a>
                        )}
                        <span className="text-xs text-gray-400 font-mono">id {ident.platform_user_id}</span>
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

            {/* ⚠️ Всё, что ниже, на ТЕЛЕФОНЕ спрятано под «Информация о контакте».
                Раньше параметры шли простынёй, и до переписки приходилось
                листать полэкрана — а заходят в карточку чаще всего именно
                ради диалога. На компьютере блок открыт всегда: там переписка
                в соседней колонке, и прятать нечего. */}
            <ContactInfoCollapse>

            {/* Контактные поля и метаданные — в одну колонку (друг под другом) */}
            <div className="grid grid-cols-1 gap-y-4 mb-6">
              {/* Строка 1: Email | Телефон */}
              <ContactFieldEditor
                contactId={selected.id}
                field="email"
                label="Email"
                icon={<Mail size={15} className="text-gray-400 mt-0.5 shrink-0" />}
                value={selected.email}
                inputType="email"
                onSaved={(v) => {
                  setSelected((s: any) => s ? { ...s, email: v } : s)
                  setContacts((cs: any[]) => cs.map(c => c.id === selected.id ? { ...c, email: v } : c))
                }}
              />
              {/* Почтовик вернул отказ по этому адресу — письма на него не уходят.
                  Показываем причину и дату, чтобы клиент понял, что делать. */}
              {selected.email_is_dead && (
                <div className="-mt-2 ml-6 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                  <p className="text-xs font-semibold text-red-700">
                    Адрес не работает — письма на него не отправляются
                  </p>
                  {selected.email_dead_reason && (
                    <p className="text-xs text-red-600 mt-0.5">{selected.email_dead_reason}</p>
                  )}
                  {selected.email_dead_at && (
                    <p className="text-[11px] text-red-500 mt-0.5">
                      Проверено {new Date(selected.email_dead_at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })}
                    </p>
                  )}
                </div>
              )}
              <ContactFieldEditor
                contactId={selected.id}
                field="phone"
                label="Телефон"
                icon={<Phone size={15} className="text-gray-400 mt-0.5 shrink-0" />}
                value={selected.phone}
                inputType="tel"
                placeholder="+7 999 123-45-67"
                onSaved={(v) => {
                  setSelected((s: any) => s ? { ...s, phone: v } : s)
                  setContacts((cs: any[]) => cs.map(c => c.id === selected.id ? { ...c, phone: v } : c))
                }}
              />

              {/* Строка 2: Реф-код | Партнёрский параметр (внешняя платформа) */}
              <div className="flex items-start gap-2">
                <Link2 size={15} className="text-gray-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs text-gray-400">Реф-код</p>
                  <p className="text-sm text-gray-800 font-mono break-all">{selected.ref_code || '—'}</p>
                </div>
              </div>

              {/* Привязка к ПЛЮСОН-аккаунту (только отображение) */}
              {selected.linked_client_email && (
                <div className="flex items-start gap-2">
                  <Link2 size={15} className="text-gray-400 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-gray-400">ПЛЮСОН-аккаунт</p>
                    <p className="text-sm text-gray-800 break-all">
                      <span className="inline-block px-1.5 py-0.5 bg-green-50 text-green-700 rounded text-xs mr-1">связан</span>
                      {selected.linked_client_email}
                    </p>
                  </div>
                </div>
              )}
              <ContactFieldEditor
                contactId={selected.id}
                field="external_ref_param"
                label="Партнёрский параметр"
                icon={<Link2 size={15} className="text-gray-400 mt-0.5 shrink-0" />}
                value={selected.external_ref_param}
                inputType="text"
                placeholder="например, gcpc=08cea"
                hint="key=value из вашей внешней платформы (GetCourse, Bizon360 и т.п.). Будет приписан к URL стороннего лендинга, чтобы клиент видел этого партнёра у себя."
                onSaved={(v) => {
                  setSelected((s: any) => s ? { ...s, external_ref_param: v } : s)
                }}
              />

              {/* Закрепить наверху списка.
                  ⚠️ Закрепление ОБЩЕЕ на кабинет: помощник ведёт базу
                  владельца, и оба должны видеть один порядок. */}
              <div className="flex items-start gap-2">
                <Pin size={15} className="text-gray-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={!!selected.pinned_at}
                      onChange={async (e) => {
                        const v = e.target.checked
                        const was = selected.pinned_at
                        setSelected((s: any) => s ? { ...s, pinned_at: v ? new Date().toISOString() : null } : s)
                        try { await api.contacts.update(selected.id, { pinned: v }); fetchContacts(search, offset, showUnsubscribed, filters) }
                        catch { setSelected((s: any) => s ? { ...s, pinned_at: was } : s) }
                      }}
                      className="w-4 h-4 accent-[#25455D]"
                    />
                    <span className="text-sm text-gray-800">Закрепить наверху</span>
                  </label>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Контакт останется в начале списка — удобно, пока ведёте с человеком разговор.
                  </p>
                </div>
              </div>

              {/* Метки */}
              <ContactTags
                contactId={selected.id}
                tags={selected.tags || []}
                onSaved={(t) => setSelected((s: any) => s ? { ...s, tags: t } : s)}
              />

              {/* Сотрудник / лидген */}
              <div className="flex items-start gap-2">
                <Briefcase size={15} className="text-gray-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={!!selected.is_staff}
                      onChange={async (e) => {
                        const v = e.target.checked
                        setSelected((s: any) => s ? { ...s, is_staff: v } : s)
                        try { await api.contacts.update(selected.id, { is_staff: v }) }
                        catch { setSelected((s: any) => s ? { ...s, is_staff: !v } : s) }
                      }}
                      className="w-4 h-4 accent-[#25455D]"
                    />
                    <span className="text-sm text-gray-800">Сотрудник / лидген</span>
                  </label>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Исключается из турнирной таблицы. В отчёте рефоводов его приведённые
                    суммируются в группу «Организатор».
                  </p>
                </div>
              </div>

              {/* Чёрный список */}
              {!isAssistant && (
                <div className="flex items-start gap-2">
                  <AlertCircle size={15} className={`mt-0.5 shrink-0 ${selected.is_blacklisted ? 'text-red-600' : 'text-gray-400'}`} />
                  <div className="min-w-0">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={!!selected.is_blacklisted}
                        onChange={async (e) => {
                          const v = e.target.checked
                          setSelected((s: any) => s ? { ...s, is_blacklisted: v } : s)
                          setContacts((cs: any[]) => cs.map(c => c.id === selected.id ? { ...c, is_blacklisted: v } : c))
                          try {
                            if (v) await api.contacts.addToBlacklist(selected.id)
                            else await api.contacts.removeFromBlacklist(selected.id)
                          } catch {
                            setSelected((s: any) => s ? { ...s, is_blacklisted: !v } : s)
                            setContacts((cs: any[]) => cs.map(c => c.id === selected.id ? { ...c, is_blacklisted: !v } : c))
                          }
                        }}
                        className="w-4 h-4 accent-red-600"
                      />
                      <span className={`text-sm ${selected.is_blacklisted ? 'text-red-600 font-medium' : 'text-gray-800'}`}>
                        В чёрном списке
                      </span>
                    </label>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Не получает рассылки и контент из ваших ботов.
                    </p>
                  </div>
                </div>
              )}

              {/* Строка 3: Первый контакт | Последний контакт */}
              <div className="flex items-start gap-2">
                <Calendar size={15} className="text-gray-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-gray-400">Первый контакт</p>
                  <p className="text-sm text-gray-800">{formatDate(selected.created_at)}</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Calendar size={15} className="text-gray-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-gray-400">Последний контакт</p>
                  <p className="text-sm text-gray-800">{selected.last_contact_at ? formatDate(selected.last_contact_at) : '—'}</p>
                </div>
              </div>

              {/* Доп. строки — реферер и UTM, если заполнены */}
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
            </div>

            {/* Согласия на обработку данных и маркетинг (152-ФЗ) */}
            <div className="mb-6">
              <p className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-2">Согласия и данные (152-ФЗ)</p>
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  {selected.consent_pd_at ? (
                    <span className="text-green-600">✓</span>
                  ) : (
                    <span className="text-gray-300">○</span>
                  )}
                  <span className="text-gray-700">Согласие на обработку перс. данных</span>
                  {selected.consent_pd_at && (
                    <span className="text-xs text-gray-400 ml-auto">
                      {formatDate(selected.consent_pd_at)}
                      {selected.consent_pd_policy_ver ? ` · v${selected.consent_pd_policy_ver}` : ''}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {selected.consent_marketing_at ? (
                    <span className="text-green-600">✓</span>
                  ) : (
                    <span className="text-gray-300">○</span>
                  )}
                  <span className="text-gray-700">Согласие на маркетинговые рассылки</span>
                  {selected.consent_marketing_at && (
                    <span className="text-xs text-gray-400 ml-auto">
                      {formatDate(selected.consent_marketing_at)}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-3 flex gap-2 flex-wrap">
                <button
                  onClick={async () => {
                    const token = localStorage.getItem('plusson_token') || ''
                    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
                    const r = await fetch(`${apiUrl}/api/v1/contacts/${selected.id}/export`, {
                      headers: { Authorization: `Bearer ${token}` },
                    })
                    if (!r.ok) { alert('Не удалось экспортировать'); return }
                    const data = await r.json()
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = `contact_${selected.id}_export.json`
                    a.click()
                    URL.revokeObjectURL(url)
                  }}
                  className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50">
                  📥 Скачать данные (JSON)
                </button>
                <button
                  onClick={async () => {
                    if (!confirm(`Удалить персональные данные «${getName(selected)}»?\n\nПо требованию 152-ФЗ оператор обязан удалить ПД субъекта по запросу. Будут стёрты: имя, email, телефон, идентичности TG/VK/MAX и все подписки. Контакт станет неактивным.\n\nЭто действие нельзя отменить.`)) return
                    const token = localStorage.getItem('plusson_token') || ''
                    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
                    const r = await fetch(`${apiUrl}/api/v1/contacts/${selected.id}/personal-data`, {
                      method: 'DELETE',
                      headers: { Authorization: `Bearer ${token}` },
                    })
                    if (!r.ok) { alert('Не удалось удалить'); return }
                    alert('Персональные данные стёрты')
                    setSelected(null)
                    await fetchContacts(search, offset, showUnsubscribed, filters)
                  }}
                  className="text-xs px-3 py-1.5 border border-red-200 text-red-600 rounded-lg hover:bg-red-50">
                  🗑 Стереть ПД
                </button>
              </div>
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
              <details className="mb-3 group rounded-xl border border-[#FFCFA4] bg-[#FFF6EE] overflow-hidden">
                <summary className="flex items-center justify-between cursor-pointer list-none select-none px-4 py-3 hover:bg-[#FFEFE0]">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#25455D]">
                    Участие в событиях
                    <span className="ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-[#FFCFA4] text-[#25455D] text-[11px] font-bold">{selected.events.length}</span>
                  </p>
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-[#FFCFA4] text-[#25455D] transition-transform group-open:rotate-180">
                    <ChevronDown size={15} strokeWidth={2.5} />
                  </span>
                </summary>
                <div className="px-4 pb-3 pt-1">
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
              </details>
            )}

            {(selected as any).lead_magnet_runs && (selected as any).lead_magnet_runs.length > 0 && (
              <details className="mb-3 group rounded-xl border border-[#FFCFA4] bg-[#FFF6EE] overflow-hidden">
                <summary className="flex items-center justify-between cursor-pointer list-none select-none px-4 py-3 hover:bg-[#FFEFE0]">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#25455D]">
                    Лид-магниты
                    <span className="ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-[#FFCFA4] text-[#25455D] text-[11px] font-bold">{(selected as any).lead_magnet_runs.length}</span>
                  </p>
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-[#FFCFA4] text-[#25455D] transition-transform group-open:rotate-180">
                    <ChevronDown size={15} strokeWidth={2.5} />
                  </span>
                </summary>
                <div className="px-4 pb-3 pt-1">
                <div className="space-y-2">
                  {(selected as any).lead_magnet_runs.map((r: any) => {
                    const stages: Record<string, { label: string; color: string }> = {
                      landed: { label: 'Перешёл', color: 'bg-gray-100 text-gray-700' },
                      started: { label: 'Запустил', color: 'bg-blue-50 text-blue-700' },
                      subscribed: { label: 'Подписался', color: 'bg-amber-50 text-amber-700' },
                      delivered: { label: 'Получил', color: 'bg-green-50 text-green-700' },
                    }
                    const st = stages[r.stage] || stages.landed
                    return (
                      <div key={r.id} className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-800 truncate">
                            {r.source_kind === 'package' ? '📦 ' : '🎁 '}{r.source_name || '—'}
                          </p>
                          <p className="text-xs text-gray-400">
                            {formatDate(r.landed_at)}
                            {r.utm?.utm_source && <span className="ml-2">· utm: {r.utm.utm_source}</span>}
                          </p>
                        </div>
                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${st.color}`}>{st.label}</span>
                      </div>
                    )
                  })}
                </div>
                </div>
              </details>
            )}

            {/* Дополнительные поля контакта (миграция 280). Показываем ВСЕ
                поля кабинета, в том числе пустые — иначе не видно, что поле
                вообще есть, и его нечем заполнить вручную. */}
            {(selected as any).custom_fields?.length > 0 && (
              <div className="mb-3 rounded-xl border border-gray-200 bg-white p-4">
                <h4 className="mb-3 text-sm font-semibold text-gray-800">Дополнительные поля</h4>
                <div className="space-y-2">
                  {(selected as any).custom_fields.map((f: any) => (
                    <ContactFieldRow key={f.id} field={f} contactId={(selected as any).id} />
                  ))}
                </div>
              </div>
            )}

            {/* ⚠️ Только СПИСОК анкет со ссылками, без самих ответов: в
                карточке контакта и так плотно, а развёрнутые ответы
                превращают её в помойку (замечание владельца). Ответы
                смотрим на своей странице. */}
            {(selected as any).survey_history?.length > 0 && (
              <div className="mb-3 rounded-xl border border-gray-200 bg-white p-4">
                <h4 className="mb-3 text-sm font-semibold text-gray-800">
                  Анкеты
                  <span className="ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-[#FFCFA4] text-[#25455D] text-[11px] font-bold">
                    {(selected as any).survey_history.length}
                  </span>
                </h4>
                <div className="space-y-2">
                  {(selected as any).survey_history.map((r: any) => (
                    <Link key={r.id}
                          href={`/dashboard/surveys/${r.survey_id}/responses/${r.id}`}
                          className="block rounded-lg border border-gray-100 p-2.5 hover:bg-gray-50">
                      <div className="text-sm font-medium text-[#25455D]">
                        {r.survey_title}
                      </div>
                      <div className="text-xs text-gray-500">
                        {new Date(r.created_at).toLocaleString('ru-RU', {
                          timeZone: 'Europe/Moscow',
                          day: '2-digit', month: '2-digit', year: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })} МСК
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Вебинары — где контакт реально был в эфире (webinar_presence) */}
            {(selected as any).webinar_history && (selected as any).webinar_history.length > 0 && (
              <details className="mb-3 group rounded-xl border border-[#FFCFA4] bg-[#FFF6EE] overflow-hidden">
                <summary className="flex items-center justify-between cursor-pointer list-none select-none px-4 py-3 hover:bg-[#FFEFE0]">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#25455D]">
                    Был в эфире
                    <span className="ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-[#FFCFA4] text-[#25455D] text-[11px] font-bold">{(selected as any).webinar_history.length}</span>
                  </p>
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-[#FFCFA4] text-[#25455D] transition-transform group-open:rotate-180">
                    <ChevronDown size={15} strokeWidth={2.5} />
                  </span>
                </summary>
                <div className="px-4 pb-3 pt-1">
                <div className="space-y-2">
                  {(selected as any).webinar_history.map((w: any) => (
                    <div key={w.room_id} className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">
                          📺 {w.event_title || '—'} · День {w.day_number}
                        </p>
                        <p className="text-xs text-gray-400">
                          {w.day_date ? formatDate(w.day_date) : formatDate(w.last_seen_at)}
                          <span className="ml-2">· ~{w.minutes} мин в эфире</span>
                          {!w.registered && <span className="ml-2 text-amber-600">· без регистрации</span>}
                        </p>
                      </div>
                      <span className="text-xs px-2 py-1 rounded-full font-medium bg-green-50 text-green-700 whitespace-nowrap">Был в эфире</span>
                    </div>
                  ))}
                </div>
                </div>
              </details>
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

            {/* Партнёрская ссылка (миграция 105) */}
            <PartnerLinksBlock contact={selected} />

            </ContactInfoCollapse>

            {/* Мобильный чат — под параметрами (на десктопе чат в средней колонке) */}
            <div className="md:hidden mt-6 pt-4 border-t border-gray-100 -mx-6">
              <div className="px-6 pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Переписка</div>
              <div className="h-[60vh]">
                <DialogChat
                  key={`m-${selected.id}`}
                  contactId={selected.id}
                  contactName={getName(selected)}
                  availablePlatforms={(selected.identities || [])
                    .map((i: any) => i.platform_slug)
                    .filter((p: string) => ['telegram', 'vk', 'max'].includes(p))}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {filterPanelOpen && (
        <FilterPanel
          initial={filters}
          onApply={f => { setFilters(f); setFilterPanelOpen(false) }}
          onClose={() => setFilterPanelOpen(false)}
        />
      )}
    </div>
  )
}

/* ─────── Окошко фильтра контактов ─────── */
interface FilterOptions {
  platforms: { slug: string; display_name: string; color_hex: string | null }[]
  channels:  { id: number; platform_slug: string; display_name: string; handle: string | null; is_active: boolean }[]
  utm_sources: string[]
  tags: string[]
  events: { id: number; title: string; slug: string }[]
  lead_magnets: { id: number; name: string }[]
  packages: { id: number; name: string }[]
}

function FilterPanel({ initial, onApply, onClose }: {
  initial: ContactFilters
  onApply: (f: ContactFilters) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<ContactFilters>(initial)
  const [opts, setOpts] = useState<FilterOptions | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.contacts.filterOptions()
      .then((loaded: FilterOptions) => setOpts(loaded))
      .catch(() => setOpts({
        platforms: [], channels: [], utm_sources: [], tags: [],
        events: [], lead_magnets: [], packages: [],
      }))
      .finally(() => setLoading(false))
  }, [])

  function toggleArrayItem<T>(arr: T[] | undefined, item: T): T[] {
    const cur = arr || []
    return cur.includes(item) ? cur.filter(x => x !== item) : [...cur, item]
  }

  const channelOptions: MultiSelectOption<number>[] = (opts?.channels || []).map(c => ({
    value: c.id,
    label: c.display_name,
    hint: c.is_active ? undefined : '(рассылка)',
  }))
  const utmOptions: MultiSelectOption<string>[] = (opts?.utm_sources || []).map(u => ({ value: u, label: u }))
  const tagOptions: MultiSelectOption<string>[] = (opts?.tags || []).map(t => ({ value: t, label: t }))
  const eventOptions: MultiSelectOption<number>[] = (opts?.events || []).map(e => ({ value: e.id, label: e.title }))
  const lmOptions: MultiSelectOption<number>[] = (opts?.lead_magnets || []).map(m => ({ value: m.id, label: m.name }))
  const pkgOptions: MultiSelectOption<number>[] = (opts?.packages || []).map(p => ({ value: p.id, label: p.name }))

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 sticky top-0 bg-white">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <SlidersHorizontal size={18} /> Фильтр контактов
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {loading && (
            <div className="text-center text-gray-400 text-sm py-4">Загрузка опций…</div>
          )}

          {!loading && opts && (
            <>
              {/* Платформа — оставлены пилюлями, их обычно мало (2-3) */}
              {opts.platforms.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Платформа</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {opts.platforms.map(p => {
                      const active = (draft.platforms || []).includes(p.slug)
                      return (
                        <button
                          key={p.slug}
                          onClick={() => setDraft(d => ({ ...d, platforms: toggleArrayItem(d.platforms, p.slug) }))}
                          className={`text-xs px-2.5 py-1 rounded-full border ${
                            active
                              ? 'bg-[#25455D] text-white border-[#25455D]'
                              : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                          }`}
                        >{p.display_name}</button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Каналы — выпадающий мульти-селект, «Без привязки» как пункт списка */}
              {opts.channels.length > 0 && (
                <MultiSelectDropdown
                  label="Каналы подписки"
                  options={channelOptions}
                  values={draft.channelIds || []}
                  onChange={(next) => setDraft(d => ({ ...d, channelIds: next }))}
                  placeholder="Любой канал"
                  searchPlaceholder="Поиск канала…"
                  extraToggle={{
                    label: 'Без привязки к каналу',
                    checked: !!draft.includeUnattached,
                    onToggle: (next) => setDraft(d => ({ ...d, includeUnattached: next })),
                  }}
                />
              )}

              {/* События */}
              {opts.events.length > 0 && (
                <MultiSelectDropdown
                  label="События"
                  options={eventOptions}
                  values={draft.eventIds || []}
                  onChange={(next) => setDraft(d => ({ ...d, eventIds: next }))}
                  placeholder="Любое событие"
                  searchPlaceholder="Поиск по названию события…"
                />
              )}

              {/* Лид-магниты */}
              {opts.lead_magnets.length > 0 && (
                <MultiSelectDropdown
                  label="Лид-магниты"
                  options={lmOptions}
                  values={draft.leadMagnetIds || []}
                  onChange={(next) => setDraft(d => ({ ...d, leadMagnetIds: next }))}
                  placeholder="Любой лид-магнит"
                  searchPlaceholder="Поиск лид-магнита…"
                />
              )}

              {/* Пакеты лид-магнитов */}
              {opts.packages.length > 0 && (
                <MultiSelectDropdown
                  label="Пакеты лид-магнитов"
                  options={pkgOptions}
                  values={draft.packageIds || []}
                  onChange={(next) => setDraft(d => ({ ...d, packageIds: next }))}
                  placeholder="Любой пакет"
                  searchPlaceholder="Поиск пакета…"
                />
              )}

              {/* Забрали материалы или нет — только когда выбран конкретный лид-магнит/пакет */}
              {((draft.leadMagnetIds?.length || 0) > 0 || (draft.packageIds?.length || 0) > 0) && (
                <div>
                  <label className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    Материалы
                  </label>
                  <div className="flex gap-1 p-1 bg-gray-100 rounded-xl">
                    {([
                      { id: 'any',           label: 'Все' },
                      { id: 'not_delivered', label: 'Не забрали' },
                      { id: 'delivered',     label: 'Забрали' },
                    ] as const).map(o => {
                      const active = (draft.leadMagnetStage || 'any') === o.id
                      return (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => setDraft(d => ({ ...d, leadMagnetStage: o.id }))}
                          className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                            active ? 'bg-white text-[#25455D] shadow-sm' : 'text-gray-500 hover:text-gray-700'
                          }`}
                        >
                          {o.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* UTM-источник */}
              {opts.utm_sources.length > 0 && (
                <MultiSelectDropdown
                  label="UTM-источник"
                  options={utmOptions}
                  values={draft.utmSources || []}
                  onChange={(next) => setDraft(d => ({ ...d, utmSources: next }))}
                  placeholder="Любой источник"
                  searchPlaceholder="Поиск источника…"
                />
              )}

              {/* Теги */}
              {opts.tags.length > 0 && (
                <MultiSelectDropdown
                  label="Теги"
                  options={tagOptions}
                  values={draft.tags || []}
                  onChange={(next) => setDraft(d => ({ ...d, tags: next }))}
                  placeholder="Любой тег"
                  searchPlaceholder="Поиск тега…"
                />
              )}

              {/* Состояние подписки */}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Подписка</h3>
                <div className="flex gap-1.5">
                  {([
                    { v: 'any',          label: 'Любая' },
                    { v: 'subscribed',   label: 'Подписан' },
                    { v: 'unsubscribed', label: 'Отписан' },
                  ] as const).map(opt => (
                    <button
                      key={opt.v}
                      onClick={() => setDraft(d => ({ ...d, subscription: opt.v }))}
                      className={`flex-1 text-xs px-2 py-1.5 rounded-lg border ${
                        (draft.subscription || 'any') === opt.v
                          ? 'bg-[#25455D] text-white border-[#25455D]'
                          : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                      }`}
                    >{opt.label}</button>
                  ))}
                </div>
              </div>

              {/* Чёрный список */}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Чёрный список</h3>
                <div className="flex gap-1.5">
                  {([
                    { v: '',    label: 'Все' },
                    { v: 'yes', label: 'В ЧС' },
                    { v: 'no',  label: 'Не в ЧС' },
                  ] as const).map(opt => {
                    const active = (draft.blacklisted || '') === opt.v
                    return (
                      <button
                        key={opt.v || 'all'}
                        onClick={() => setDraft(d => ({ ...d, blacklisted: opt.v }))}
                        className={`flex-1 text-xs px-2 py-1.5 rounded-lg border ${
                          active
                            ? (opt.v === 'yes'
                                ? 'bg-red-600 text-white border-red-600'
                                : 'bg-[#25455D] text-white border-[#25455D]')
                            : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                        }`}
                      >{opt.label}</button>
                    )
                  })}
                </div>
              </div>

              {/* Дата попадания в базу — отвечает на «кто новый».
                  ⚠️ Держим ВЫШЕ «последнего контакта»: спрашивают чаще, а по
                  названию эти два фильтра легко перепутать. */}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Попал в базу</h3>
                <p className="text-[10px] text-gray-400 mb-2 -mt-1">Когда контакт появился у вас впервые</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">от</label>
                    <input
                      type="date"
                      value={draft.createdFrom || ''}
                      onChange={e => setDraft(d => ({ ...d, createdFrom: e.target.value }))}
                      className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">до</label>
                    <input
                      type="date"
                      value={draft.createdTo || ''}
                      onChange={e => setDraft(d => ({ ...d, createdTo: e.target.value }))}
                      className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                    />
                  </div>
                </div>
              </div>

              {/* Дата последнего контакта */}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Последний контакт</h3>
                <p className="text-[10px] text-gray-400 mb-2 -mt-1">Когда человек в последний раз о себе напомнил</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">от</label>
                    <input
                      type="date"
                      value={draft.dateFrom || ''}
                      onChange={e => setDraft(d => ({ ...d, dateFrom: e.target.value }))}
                      className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-400 mb-1">до</label>
                    <input
                      type="date"
                      value={draft.dateTo || ''}
                      onChange={e => setDraft(d => ({ ...d, dateTo: e.target.value }))}
                      className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:border-[#25455D]"
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-between gap-2 p-5 border-t border-gray-100 sticky bottom-0 bg-white">
          <button
            onClick={() => setDraft(EMPTY_FILTERS)}
            className="px-4 py-2 text-sm text-gray-500 hover:text-red-500"
          >
            Сбросить
          </button>
          <button
            onClick={() => onApply(draft)}
            className="px-5 py-2 text-sm rounded-lg text-white font-medium"
            style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
          >
            Применить
          </button>
        </div>
      </div>
    </div>
  )
}


// ─── Inline-редактор имени контакта ──────────────────────────────────────────
function ContactNameEditor({
  contactId,
  initialName,
  onSaved,
}: {
  contactId: number
  initialName: string
  onSaved: (newName: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(initialName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Если поменялся выбранный контакт — обновляем локальный value
  useEffect(() => { setValue(initialName); setEditing(false); setError('') }, [contactId, initialName])

  async function save() {
    const v = value.trim()
    if (!v) { setError('Имя не может быть пустым'); return }
    if (v === initialName) { setEditing(false); return }
    setSaving(true); setError('')
    try {
      const r: any = await api.contacts.update(contactId, { name: v })
      onSaved(r.contact?.name || v)
      setEditing(false)
    } catch (e: any) {
      setError(e?.message || 'Ошибка')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <input
            autoFocus
            type="text"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') { setEditing(false); setValue(initialName); setError('') }
            }}
            className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-base focus:outline-none focus:ring-1 focus:ring-brand/30 font-bold"
            disabled={saving}
            maxLength={200}
          />
          <button
            onClick={save}
            disabled={saving}
            className="p-2 rounded-lg text-white"
            style={{ background: '#25455D' }}
            title="Сохранить"
          >
            <Check size={16} />
          </button>
          <button
            onClick={() => { setEditing(false); setValue(initialName); setError('') }}
            disabled={saving}
            className="p-2 rounded-lg border border-gray-200 text-gray-500"
            title="Отмена"
          >
            <X size={16} />
          </button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    )
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="group flex items-start gap-2 max-w-full text-left"
      title="Кликните чтобы изменить имя"
    >
      {/* ⚠️ НЕ truncate: на телефоне имя обрезалось многоточием («Марго Форб…»)
          и человека нельзя было опознать. Переносим на несколько строк —
          места по вертикали хватает, а имя должно читаться целиком. */}
      <h2 className="text-xl font-bold text-gray-900 break-words min-w-0 group-hover:text-[#25455D]">{initialName}</h2>
      <Pencil size={14} className="mt-1.5 text-gray-300 group-hover:text-gray-600 shrink-0 transition-colors" />
    </button>
  )
}

/**
 * Сворачиваемая «Информация о контакте» — ТОЛЬКО на телефоне.
 *
 * ⚠️ Компьютер и телефон ведут себя по-разному намеренно. На компьютере
 * карточка контакта и переписка стоят в РАЗНЫХ колонках, прятать параметры
 * незачем — блок просто отрисован как был. На телефоне колонок нет, всё идёт
 * одной лентой: параметров набирается на два экрана, и переписка оказывалась
 * далеко внизу. Поэтому на узком экране параметры свёрнуты, а диалог виден
 * сразу.
 *
 * ⚠️ Содержимое не размонтируется, а скрывается классом `hidden`: иначе при
 * каждом сворачивании терялось бы состояние вложенных редакторов (набранный,
 * но не сохранённый email) и заново дёргались бы их запросы.
 */
function ContactInfoCollapse({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {/* Кнопка только на телефоне */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="md:hidden w-full mb-4 flex items-center justify-between gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left hover:bg-amber-100 transition-colors"
      >
        <span className="text-sm font-bold text-amber-900">Информация о контакте</span>
        <span className="flex items-center gap-1.5 text-amber-800 shrink-0">
          <span className="text-xs font-bold">{open ? 'Свернуть' : 'Развернуть'}</span>
          {open
            ? <ChevronUp size={18} strokeWidth={2.5} />
            : <ChevronDown size={18} strokeWidth={2.5} />}
        </span>
      </button>
      {/* На компьютере (md+) блок открыт всегда, флаг `open` его не касается */}
      <div className={open ? '' : 'hidden md:block'}>{children}</div>
    </>
  )
}

// ─── Inline-редактор поля контакта (email / phone) ───────────────────────────
function ContactFieldEditor({
  contactId,
  field,
  label,
  icon,
  value,
  inputType,
  placeholder,
  hint,
  onSaved,
}: {
  contactId: number
  field: 'email' | 'phone' | 'external_ref_param'
  label: string
  icon: React.ReactNode
  value: string | null
  inputType: 'email' | 'tel' | 'text'
  placeholder?: string
  hint?: string
  onSaved: (newValue: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { setDraft(value || ''); setEditing(false); setError('') }, [contactId, value])

  async function save() {
    const v = draft.trim() || null
    if ((v || null) === (value || null)) { setEditing(false); return }
    setSaving(true); setError('')
    try {
      const r: any = await api.contacts.update(contactId, { [field]: v ?? '' })
      onSaved(r.contact?.[field] ?? v)
      setEditing(false)
    } catch (e: any) {
      setError(e?.message || 'Ошибка')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-start gap-2">
      {icon}
      <div className="min-w-0 flex-1">
        <p className="text-xs text-gray-400">{label}</p>
        {editing ? (
          <div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <input
                autoFocus
                type={inputType}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') save()
                  if (e.key === 'Escape') { setEditing(false); setDraft(value || ''); setError('') }
                }}
                placeholder={placeholder}
                className="flex-1 min-w-0 px-2 py-1 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand/30"
                disabled={saving}
              />
              <button
                onClick={save}
                disabled={saving}
                className="p-1.5 rounded-lg text-white shrink-0"
                style={{ background: '#25455D' }}
                title="Сохранить"
              >
                <Check size={13} />
              </button>
              <button
                onClick={() => { setEditing(false); setDraft(value || ''); setError('') }}
                disabled={saving}
                className="p-1.5 rounded-lg border border-gray-200 text-gray-500 shrink-0"
                title="Отмена"
              >
                <X size={13} />
              </button>
            </div>
            {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
          </div>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="group flex items-center gap-1.5 max-w-full text-left"
            title={value ? `Изменить ${label.toLowerCase()}` : `Добавить ${label.toLowerCase()}`}
          >
            {value ? (
              <p className="text-sm text-gray-800 break-all group-hover:text-[#25455D]">{value}</p>
            ) : (
              <p className="text-sm text-gray-400 italic group-hover:text-[#25455D]">— добавить</p>
            )}
            <Pencil size={11} className="text-gray-300 group-hover:text-gray-600 shrink-0 transition-colors" />
          </button>
        )}
        {hint && !editing && <p className="text-[11px] text-gray-400 mt-0.5 leading-tight">{hint}</p>}
      </div>
    </div>
  )
}


/* ─────── Партнёрская ссылка контакта (миграция 105) ─────── */
// Партнёрка живёт ТОЛЬКО в TG/VK/MAX. Email сюда не входит (нет интерактивности).
const PARTNER_PLATFORMS = ['telegram', 'vk', 'max']

function PartnerLinksBlock({ contact }: { contact: ContactDetail }) {
  const { me } = useMe()
  const [copied, setCopied] = useState<string | null>(null)
  const landingConfigured = !!(me?.partner_landing_url || '').trim()
  const contactId = contact.id
  const botHandles: { telegram?: string | null; vk?: string | null; max?: string | null } | null = me?.bot_handles || null
  const vkAppId: number | null = (me as any)?.vk_app_id ? Number((me as any).vk_app_id) : null

  // Регистрация партнёров — единый функционал с разделом «Интеграция» в Настройках.
  // Гейтинг по фиче partner_registration (vip + admin).
  const hasPartnerRegistration = (me?.features || []).includes('partner_registration')
  if (!hasPartnerRegistration) return null

  // Только TG/VK/MAX, из подключённых клиентом (свой канал). Системные не используем.
  const available: string[] = me?.available_platforms || []
  const platforms = PARTNER_PLATFORMS.filter(p => available.includes(p))

  function copy(label: string, text: string) {
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  const platformLabel: Record<string, string> = {
    telegram: 'Telegram',
    vk: 'VK',
    max: 'MAX',
  }

  // Прямая личная ссылка: t.me/{bot}?start=prtp_{contact_id} (бот резолвит client_id + external_ref_param из contacts).
  function personalUrlFor(p: string): string | null {
    if (p === 'telegram') {
      // Только свой TG-бот клиента — системный @pluson_bot больше не fallback.
      const handle = (botHandles?.telegram || '').replace(/^@/, '')
      if (!handle) return null
      return `https://telegram.me/${handle}?start=prtp_${contactId}`
    }
    if (p === 'vk') {
      // Партнёрская ссылка через VK Mini App клиента
      // (vk.com/app{aid}#prtp_<contact_id>). Без своего VK Mini App не работает —
      // нужен токен сообщества для отправки в личку.
      if (!vkAppId) return null
      return `https://vk.com/app${vkAppId}#prtp_${contactId}`
    }
    if (p === 'max') {
      const handle = (botHandles?.max || '').replace(/^@/, '')
      if (!handle) return null
      return `https://max.ru/${handle}?start=prtp_${contactId}`
    }
    return null
  }

  return (
    <div className="mb-2 mt-4 pt-4 border-t border-gray-100">
      <p className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-2">
        Партнёрская ссылка
      </p>
      {!landingConfigured ? (
        <div className="rounded-xl border border-dashed border-gray-200 px-4 py-3 bg-gray-50">
          <p className="text-sm text-gray-600 mb-2">
            Сторонняя партнёрская ссылка не настроена.
          </p>
          <p className="text-xs text-gray-500">
            Настройте URL в{' '}
            <Link href="/dashboard/settings?tab=tech" className="text-[#25455D] underline">
              Настройках → Технические
            </Link>{' '}
            — после этого здесь появятся персональные ссылки этого контакта.
          </p>
          <div className="mt-3 space-y-1.5 select-none" style={{ filter: 'blur(3px)', pointerEvents: 'none' }}>
            {platforms.map(p => {
              const url = personalUrlFor(p) || '—'
              return (
                <div key={p} className="flex items-center gap-2">
                  <span className="w-16 text-[11px] font-semibold text-gray-500">{platformLabel[p] || p}</span>
                  <span className="text-xs font-mono text-gray-600 truncate">{url}</span>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          {platforms.map(p => {
            const url = personalUrlFor(p)
            const disabled = !url
            return (
              <div key={p} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[11px] font-semibold text-gray-500">{platformLabel[p] || p}</span>
                <input
                  type="text"
                  value={url || ''}
                  readOnly
                  placeholder={!url ? '— у клиента не подключён канал этой платформы' : ''}
                  className={`flex-1 min-w-0 px-3 py-1.5 text-xs font-mono border border-gray-200 rounded-lg ${
                    disabled ? 'bg-gray-100 text-gray-400' : 'bg-gray-50 text-gray-700'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => url && copy(p, url)}
                  disabled={disabled}
                  className="px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Скопировать"
                >
                  {copied === p ? (
                    <Check size={13} className="text-green-600" />
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}


/**
 * Строка дополнительного поля в карточке контакта (миграция 280).
 *
 * ⚠️ Показывается и когда значение пустое: иначе клиент не увидит, что поле
 * вообще существует, и не сможет вписать его вручную. Основной способ
 * заполнения — анкета, здесь правка одного человека.
 */
function ContactFieldRow({ field, contactId }: { field: any; contactId: number }) {
  const [value, setValue] = useState<string>(field.value || '')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  const opts: string[] = Array.isArray(field.options) ? field.options : []
  const isChoice = field.kind === 'select' || field.kind === 'bool'
  const choices = field.kind === 'bool' ? ['Да', 'Нет'] : opts

  const save = async (v: string) => {
    setSaving(true)
    try {
      await api.contacts.setField(contactId, { field_id: field.id, value: v })
      setValue(v)
      setEditing(false)
    } finally { setSaving(false) }
  }

  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-sm text-gray-500">{field.title}</span>
      {editing ? (
        <div className="flex min-w-0 flex-1 justify-end gap-2">
          {isChoice ? (
            <select autoFocus disabled={saving} value={value}
                    onChange={e => save(e.target.value)}
                    className="min-w-0 rounded-lg border border-gray-300 px-2 py-1 text-sm bg-white">
              <option value="">— не указано —</option>
              {choices.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input autoFocus disabled={saving} defaultValue={value}
                   type={field.kind === 'number' || field.kind === 'scale' ? 'number'
                         : field.kind === 'date' ? 'date' : 'text'}
                   onBlur={e => save(e.target.value)}
                   onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                   className="min-w-0 rounded-lg border border-gray-300 px-2 py-1 text-sm" />
          )}
        </div>
      ) : (
        <button onClick={() => setEditing(true)}
                className="min-w-0 text-right text-sm text-gray-900 hover:underline">
          {value || <span className="text-gray-400">не указано</span>}
        </button>
      )}
    </div>
  )
}


/** Метки контакта: свои пометки вроде «интересуется спикерством».
 *
 * ⚠️ Метки приходят и сами — из импорта базы, из воронок, из Salebot. Здесь
 * человек ставит их руками, поэтому существующие подсказываем: иначе рядом
 * заведутся «ivision» и «iVision», и фильтр базы перестанет их находить.
 */
function ContactTags({ contactId, tags, onSaved }: {
  contactId: number; tags: string[]; onSaved: (t: string[]) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)

  async function save(next: string[]) {
    setSaving(true)
    try {
      await api.contacts.update(contactId, { tags: next })
      onSaved(next)
    } finally { setSaving(false) }
  }

  function add() {
    const t = value.trim()
    if (!t) return
    if (!tags.includes(t)) save([...tags, t])
    setValue(''); setEditing(false)
  }

  return (
    <div className="flex items-start gap-2">
      <Tag size={15} className="text-gray-400 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-gray-800 mb-1">Метки</div>
        <div className="flex flex-wrap gap-1.5">
          {tags.map(t => (
            <span key={t} className="inline-flex items-center gap-1 text-xs bg-[#FFF1E3]
                                     text-[#8a5a25] rounded-full px-2 py-0.5">
              {t}
              <button
                onClick={() => save(tags.filter(x => x !== t))}
                disabled={saving}
                className="text-[#b98a5c] hover:text-[#8a5a25]"
                title="Убрать метку"
              >×</button>
            </span>
          ))}
          {editing ? (
            <input
              autoFocus
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') add()
                if (e.key === 'Escape') { setValue(''); setEditing(false) }
              }}
              onBlur={add}
              placeholder="например: интересуется спикерством"
              className="text-xs border border-gray-300 rounded-full px-2 py-0.5 w-56
                         focus:outline-none focus:border-[#25455D]"
            />
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="text-xs text-gray-500 border border-dashed border-gray-300
                         rounded-full px-2 py-0.5 hover:border-[#25455D] hover:text-[#25455D]"
            >+ метка</button>
          )}
        </div>
        <p className="text-xs text-gray-400 mt-1">
          По меткам можно отобрать людей в списке и в выгрузке.
        </p>
      </div>
    </div>
  )
}
