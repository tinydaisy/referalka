'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  Settings, User, Clock, Send, Users, Key, Plus, Trash2,
  ChevronRight, CheckCircle, XCircle, Play, ExternalLink,
  Wand2, Edit2, Save, X, Eye, EyeOff, Copy
} from 'lucide-react'
import { api } from '@/lib/api'

type Tab = 'settings' | 'speakers' | 'program' | 'templates' | 'broadcasts' | 'promo' | 'codes' | 'raffle'

const TABS: { id: Tab; label: string; icon: any }[] = [
  { id: 'settings',   label: 'Настройки',   icon: Settings },
  { id: 'speakers',   label: 'Спикеры',     icon: User },
  { id: 'program',    label: 'Программа',   icon: Clock },
  { id: 'templates',  label: 'Шаблоны',     icon: Edit2 },
  { id: 'broadcasts', label: 'Рассылки',    icon: Send },
  { id: 'promo',      label: 'Промо',       icon: Users },
  { id: 'codes',      label: 'Кодовые слова', icon: Key },
  { id: 'raffle',     label: 'Розыгрыш',      icon: Users },
]

const ROLES: Record<string, string> = {
  organizer: 'Организатор', headliner: 'Хедлайнер',
  speaker: 'Спикер', partner: 'Партнёр',
  commercial: 'Коммерческий', general_partner: 'Генеральный партнёр',
}

const BROADCAST_TYPES: Record<string, string> = {
  pre_5min: 'За 5 минут', pre_30min: 'За 30 минут', pre_1day: 'За 1 день',
  post_thanks: 'После выступления', day_start: 'Начало дня',
  speaker_intro: 'Анонс спикера', manual: 'Вручную',
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  approved: 'bg-green-100 text-green-700',
  sending: 'bg-blue-100 text-blue-700',
  sent: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-600',
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Черновик', approved: 'Утверждена',
  sending: 'Отправляется', sent: 'Отправлена', cancelled: 'Отменена',
}

const LANDING_TEMPLATES = [
  { id: 'ivision', name: 'iViSiON', description: 'Премиальный лендинг конференции с программой, спикерами и регистрацией' },
]

export default function ConferencePage() {
  const { id } = useParams()
  const eventId = Number(id)
  const [activeTab, setActiveTab] = useState<Tab>('settings')
  const [event, setEvent] = useState<any>(null)
  const [conf, setConf] = useState<any>(null)
  const [speakers, setSpeakers] = useState<any[]>([])
  const [sessions, setSessions] = useState<any[]>([])
  const [days, setDays] = useState<any[]>([])
  const [broadcasts, setBroadcasts] = useState<any[]>([])
  const [promoPartners, setPromoPartners] = useState<any[]>([])
  const [codes, setCodes] = useState<any[]>([])
  const [activeProgramDay, setActiveProgramDay] = useState(1)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  // Формы
  const [confForm, setConfForm] = useState<any>({})
  // speakerModal: null | 'new' | 'from_base' | {speaker event object}
  const [speakerModal, setSpeakerModal] = useState<any>(null)
  const [speakerForm, setSpeakerForm] = useState<any>({})
  const [baseSearch, setBaseSearch] = useState('')
  const [baseResults, setBaseResults] = useState<any[]>([])
  const [baseLoading, setBaseLoading] = useState(false)
  const [selectedBase, setSelectedBase] = useState<any>(null) // выбранный спикер из базы
  const [editGlobalModal, setEditGlobalModal] = useState<any>(null) // редактировать профиль в базе
  const [genModal, setGenModal] = useState(false)
  const [genForm, setGenForm] = useState({ day: 1, start_time: '11:00', slot_duration: 30, break_duration: 10, speaker_ids: [] as number[] })
  const [sessionModal, setSessionModal] = useState<any>(null)
  const [sessionForm, setSessionForm] = useState<any>({})
  const [broadcastEdit, setBroadcastEdit] = useState<number | null>(null)
  const [broadcastText, setBroadcastText] = useState('')
  // Шаблоны и новые рассылки
  const [templates, setTemplates] = useState<any[]>([])
  const [schedules, setSchedules] = useState<any[]>([])
  const [templateForm, setTemplateForm] = useState<any>({ name: '', type: 'pre_start', text: '', photo_url: '', button_text: '', button_url: '' })
  const [templateModal, setTemplateModal] = useState<any>(null) // null | 'new' | {template}
  const [schedulesLoading, setSchedulesLoading] = useState(false)
  const [addPromo, setAddPromo] = useState(false)
  const [promoForm, setPromoForm] = useState({ name: '', telegram_url: '', partner_code: '' })
  const [addCode, setAddCode] = useState(false)
  const [codeForm, setCodeForm] = useState({ speaker_id: '', code_word: '', tickets_reward: 1 })
  const [raffleTickets, setRaffleTickets] = useState<any[]>([])
  const [raffleWinner, setRaffleWinner] = useState<any>(null)

  useEffect(() => {
    loadAll()
  }, [eventId])

  async function loadAll() {
    const [ev, sp, ss, br, pp, cd, tmpl, sched, rt] = await Promise.all([
      api.events.get(eventId),
      api.conference.speakers.list(eventId),
      api.conference.sessions.list(eventId),
      api.conference.broadcasts.list(eventId),
      api.conference.promoPartners.list(eventId),
      api.conference.codes.list(eventId),
      api.conference.templates.list(eventId).catch(() => ({ templates: [] })),
      api.conference.schedules.list(eventId).catch(() => ({ schedules: [] })),
      api.conference.raffleTickets.list(eventId).catch(() => ({ tickets: [] })),
    ])
    setEvent(ev.event)
    setSpeakers(sp.speakers || [])
    setSessions(ss.sessions || [])
    setBroadcasts(br.broadcasts || [])
    setPromoPartners(pp.partners || [])
    setCodes(cd.codes || [])
    setTemplates(tmpl.templates || [])
    setSchedules(sched.schedules || [])
    setRaffleTickets(rt.tickets || [])

    // Загружаем конференцию
    const c = await api.conference.get(eventId)
    if (c.conference) {
      setConf(c.conference)
      setConfForm(c.conference)
    } else {
      // Инициализируем
      const init = await api.conference.init(eventId)
      setConf(init.conference)
      setConfForm(init.conference)
    }

    // Дни
    const d = await api.conference.days.list(eventId)
    setDays(d.days || [])
  }

  function flash(text: string) {
    setMsg(text)
    setTimeout(() => setMsg(''), 3000)
  }

  // ── Настройки ────────────────────────────────────────────────────────────────
  async function saveSettings() {
    setSaving(true)
    const res = await api.conference.update(eventId, {
      subtitle: confForm.subtitle,
      offer: confForm.offer,
      description: confForm.description,
      start_date: confForm.start_date,
      end_date: confForm.end_date,
      registration_url: confForm.registration_url,
      chat_url: confForm.chat_url,
      landing_template: confForm.landing_template || 'ivision',
      landing_url: confForm.landing_url,
      vip_upsell_url: confForm.vip_upsell_url,
    })
    setConf(res.conference)
    setSaving(false)
    flash('Настройки сохранены и лендинг обновлён ✓')
  }

  // ── Спикеры ──────────────────────────────────────────────────────────────────
  async function searchBase(q: string) {
    setBaseSearch(q)
    if (q.length < 2) { setBaseResults([]); return }
    setBaseLoading(true)
    const res = await api.collaborators.list(q)
    setBaseResults(res.collaborators || [])
    setBaseLoading(false)
  }

  async function saveSpeaker() {
    setSaving(true)
    try {
      if (speakerModal === 'new') {
        // Создаём нового спикера в базе + добавляем в событие
        const res = await api.conference.speakers.create(eventId, speakerForm)
        setSpeakers(s => [...s, res.speaker])
        flash('Спикер создан и добавлен')
      } else if (speakerModal === 'from_base') {
        // Добавляем из базы в событие
        if (!selectedBase) { flash('Выберите спикера из базы'); setSaving(false); return }
        const res = await api.conference.speakers.addFromBase(eventId, {
          speaker_id: selectedBase.id,
          ...speakerForm,
          sort_order: speakerForm.sort_order ?? speakers.length,
        })
        setSpeakers(s => [...s, res.speaker])
        flash('Спикер добавлен из базы')
      } else {
        // Обновляем данные участия (тема, подарок, роль)
        const res = await api.conference.speakers.update(eventId, speakerModal.id, speakerForm)
        setSpeakers(s => s.map(x => x.id === speakerModal.id ? res.speaker : x))
        flash('Данные обновлены')
      }
    } catch (e: any) { flash(e.message) }
    setSaving(false)
    setSpeakerModal(null)
    setSelectedBase(null)
    setBaseSearch('')
    setBaseResults([])
  }

  async function saveGlobalProfile() {
    if (!editGlobalModal) return
    setSaving(true)
    try {
      await api.collaborators.update(editGlobalModal.speaker_id, editGlobalModal.form)
      // Перезагружаем список спикеров события
      const updated = await api.conference.speakers.list(eventId)
      setSpeakers(updated.speakers || [])
      flash('Профиль спикера обновлён')
    } catch (e: any) { flash(e.message) }
    setSaving(false)
    setEditGlobalModal(null)
  }

  async function removeSpeakerFromEvent(speakerEventId: number) {
    if (!confirm('Убрать спикера из этого события? Он останется в базе.')) return
    await api.conference.speakers.delete(eventId, speakerEventId)
    setSpeakers(s => s.filter(x => x.id !== speakerEventId))
    flash('Спикер убран из события')
  }

  function openSpeakerEdit(s: any) {
    setSpeakerModal(s)
    setSpeakerForm({
      role: s.role,
      speaker_topic: s.speaker_topic,
      gift_title: s.gift_title,
      gift_url: s.gift_url,
      poster_url: s.poster_url,
      partner_url: s.partner_url,
      extra_info: s.extra_info,
      is_visible: s.is_visible,
      sort_order: s.sort_order,
    })
  }

  function openGlobalEdit(s: any) {
    setEditGlobalModal({
      speaker_id: s.speaker_id,
      name: s.name,
      form: {
        name: s.name,
        title: s.title,
        company: s.company,
        bio: s.bio,
        photo_url: s.photo_url,
        photo_folder_url: s.photo_folder_url,
        video_folder_url: s.video_folder_url,
        telegram_url: s.telegram_url,
        instagram_url: s.instagram_url,
        website_url: s.website_url,
      }
    })
  }

  // ── Программа ─────────────────────────────────────────────────────────────────
  const daysCount = conf
    ? (() => {
        if (conf.start_date && conf.end_date) {
          const d1 = new Date(conf.start_date), d2 = new Date(conf.end_date)
          return Math.max(1, Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1)
        }
        return 2
      })()
    : 2

  async function saveDay(dayNum: number, data: any) {
    const res = await api.conference.days.upsert(eventId, dayNum, data)
    setDays(d => {
      const existing = d.find(x => x.day_number === dayNum)
      return existing ? d.map(x => x.day_number === dayNum ? res.day : x) : [...d, res.day]
    })
    flash('День сохранён')
  }

  async function addSession() {
    const res = await api.conference.sessions.create(eventId, sessionForm)
    setSessions(s => [...s, res.session])
    setSessionModal(null)
    flash('Сессия добавлена')
  }

  async function deleteSession(sessionId: number) {
    if (!confirm('Удалить сессию?')) return
    await api.conference.sessions.delete(eventId, sessionId)
    setSessions(s => s.filter(x => x.id !== sessionId))
  }

  async function generateSchedule() {
    const res = await api.conference.sessions.generate(eventId, genForm)
    const updated = await api.conference.sessions.list(eventId)
    setSessions(updated.sessions || [])
    setGenModal(false)
    flash(`Расписание создано: ${res.sessions.length} сессий`)
  }

  // ── Рассылки ─────────────────────────────────────────────────────────────────
  async function approveBroadcast(bId: number) {
    const res = await api.conference.broadcasts.approve(eventId, bId)
    setBroadcasts(b => b.map(x => x.id === bId ? res.broadcast : x))
    flash('Рассылка утверждена ✓')
  }

  async function cancelBroadcast(bId: number) {
    const res = await api.conference.broadcasts.cancel(eventId, bId)
    setBroadcasts(b => b.map(x => x.id === bId ? res.broadcast : x))
  }

  async function saveBroadcastText(bId: number) {
    const res = await api.conference.broadcasts.update(eventId, bId, { text: broadcastText })
    setBroadcasts(b => b.map(x => x.id === bId ? res.broadcast : x))
    setBroadcastEdit(null)
    flash('Текст сохранён')
  }

  async function testBroadcast(bId: number) {
    const res = await api.conference.broadcasts.test(eventId, bId)
    flash(res.message)
  }

  async function generateBroadcasts() {
    const res = await api.conference.broadcasts.generateFromSchedule(eventId)
    const updated = await api.conference.broadcasts.list(eventId)
    setBroadcasts(updated.broadcasts || [])
    flash(res.message)
  }

  const outerTabs = [
    { label: 'Обзор', href: `/dashboard/events/${id}` },
    { label: 'Аналитика', href: `/dashboard/events/${id}/analytics` },
    { label: 'Материалы', href: `/dashboard/events/${id}/materials` },
    { label: 'Конференция', href: `/dashboard/events/${id}/conference`, active: true },
  ]

  const daysSessions = sessions.filter(s => s.day === activeProgramDay)

  return (
    <div>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-6">
        <Link href="/dashboard" className="hover:text-gray-700">События</Link>
        <span>/</span>
        <Link href={`/dashboard/events/${id}`} className="hover:text-gray-700">{event?.title}</Link>
        <span>/</span>
        <span className="text-gray-700">Конференция</span>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-6">{event?.title}</h1>

      {/* Flash */}
      {msg && (
        <div className="mb-4 px-4 py-3 bg-green-50 border border-green-200 text-green-700 rounded-xl text-sm">
          {msg}
        </div>
      )}

      {/* Outer tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {outerTabs.map(tab => (
          <Link key={tab.href} href={tab.href}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab.active ? 'border-[#25455D] text-[#25455D]' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {tab.label}
          </Link>
        ))}
      </div>

      {/* Inner tabs */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {TABS.map(({ id: tid, label, icon: Icon }) => (
          <button key={tid} onClick={() => setActiveTab(tid)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              activeTab === tid
                ? 'text-white shadow-sm'
                : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
            style={activeTab === tid ? { background: 'linear-gradient(45deg,#25455D,#0a1520)' } : {}}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {/* ═══ НАСТРОЙКИ ═══════════════════════════════════════════════════════════ */}
      {activeTab === 'settings' && (
        <div className="space-y-6">

          {/* Основное */}
          <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
            <h3 className="font-semibold text-gray-900 mb-4">Основная информация</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-xs text-gray-500 mb-1">Главный оффер / подзаголовок *</label>
                <input type="text" value={confForm.offer || ''} placeholder="Например: БИЗНЕСЫ ВЛИЯНИЯ ВНЕ СТАНДАРТОВ"
                  onChange={e => setConfForm((f: any) => ({ ...f, offer: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#25455D]/20" />
                <p className="text-xs text-gray-400 mt-1">Идёт как подзаголовок на лендинг</p>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Дата начала</label>
                <input type="date" value={confForm.start_date || ''}
                  onChange={e => setConfForm((f: any) => ({ ...f, start_date: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Дата окончания</label>
                <input type="date" value={confForm.end_date || ''}
                  onChange={e => setConfForm((f: any) => ({ ...f, end_date: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none" />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-gray-500 mb-1">Описание (для лендинга)</label>
                <textarea value={confForm.description || ''} rows={3}
                  onChange={e => setConfForm((f: any) => ({ ...f, description: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none resize-none" />
              </div>
            </div>
          </div>

          {/* Ссылки */}
          <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
            <h3 className="font-semibold text-gray-900 mb-4">Ссылки</h3>
            <div className="space-y-3">
              {[
                { key: 'registration_url', label: 'Ссылка на регистрацию (GetCourse и т.п.)', placeholder: 'https://...' },
                { key: 'chat_url', label: 'Ссылка на общий чат участников', placeholder: 'https://t.me/...' },
                { key: 'landing_url', label: 'Внешний лендинг (если есть)', placeholder: 'https://...' },
                { key: 'vip_upsell_url', label: 'VIP предложение (upsell)', placeholder: 'https://...' },
              ].map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="block text-xs text-gray-500 mb-1">{label}</label>
                  <input type="url" value={confForm[key] || ''} placeholder={placeholder}
                    onChange={e => setConfForm((f: any) => ({ ...f, [key]: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                </div>
              ))}
            </div>
          </div>

          {/* Шаблон лендинга */}
          <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
            <h3 className="font-semibold text-gray-900 mb-1">Шаблон лендинга</h3>
            <p className="text-xs text-gray-400 mb-4">При сохранении настроек JSON лендинга обновляется автоматически</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {LANDING_TEMPLATES.map(tpl => (
                <div key={tpl.id}
                  onClick={() => setConfForm((f: any) => ({ ...f, landing_template: tpl.id }))}
                  className={`border-2 rounded-2xl p-4 cursor-pointer transition-all ${
                    (confForm.landing_template || 'ivision') === tpl.id
                      ? 'border-[#25455D] bg-[#25455D]/5'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}>
                  <div className="flex items-center gap-2 mb-1">
                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                      (confForm.landing_template || 'ivision') === tpl.id ? 'border-[#25455D]' : 'border-gray-300'
                    }`}>
                      {(confForm.landing_template || 'ivision') === tpl.id && (
                        <div className="w-2 h-2 rounded-full bg-[#25455D]" />
                      )}
                    </div>
                    <span className="font-semibold text-sm text-gray-900">{tpl.name}</span>
                  </div>
                  <p className="text-xs text-gray-500 ml-6">{tpl.description}</p>
                  {confForm.landing_url && (
                    <a href={confForm.landing_url} target="_blank" rel="noopener noreferrer"
                      className="mt-2 ml-6 flex items-center gap-1 text-xs text-[#25455D] hover:underline"
                      onClick={e => e.stopPropagation()}>
                      <ExternalLink size={11} /> Открыть лендинг
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>

          <button onClick={saveSettings} disabled={saving}
            className="px-6 py-3 rounded-xl text-sm font-medium text-white shadow-sm disabled:opacity-50"
            style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
            {saving ? 'Сохраняем...' : 'Сохранить настройки'}
          </button>
        </div>
      )}

      {/* ═══ СПИКЕРЫ ═════════════════════════════════════════════════════════════ */}
      {activeTab === 'speakers' && (
        <div>
          <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
            <h3 className="font-semibold text-gray-800">Спикеры и партнёры ({speakers.length})</h3>
            <div className="flex gap-2">
              <button
                onClick={() => { setSpeakerModal('from_base'); setSpeakerForm({ role: 'speaker', is_visible: true }); setSelectedBase(null); setBaseSearch(''); setBaseResults([]) }}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50">
                <Users size={14} /> Из базы
              </button>
              <button
                onClick={() => { setSpeakerModal('new'); setSpeakerForm({ role: 'speaker', is_visible: true, sort_order: speakers.length }) }}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-[#1a2a3a]"
                style={{ background: 'linear-gradient(45deg,#FFCFA4,#e8a87c)' }}>
                <Plus size={14} /> Новый спикер
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {speakers.map(s => (
              <div key={s.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex gap-3 mb-3">
                  <div className="w-12 h-12 rounded-full flex-shrink-0 overflow-hidden"
                    style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                    {s.photo_url
                      ? <img src={s.photo_url} alt={s.name} className="w-full h-full object-cover" />
                      : <div className="w-full h-full flex items-center justify-center text-white font-bold text-sm">{s.name?.[0]}</div>
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-gray-900 text-sm truncate">{s.name}</p>
                    <p className="text-xs text-gray-400">{ROLES[s.role] || s.role}</p>
                    {s.title && <p className="text-xs text-gray-500 truncate">{s.title}</p>}
                  </div>
                </div>
                {s.speaker_topic && (
                  <p className="text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2 mb-2 line-clamp-2">
                    📌 {s.speaker_topic}
                  </p>
                )}
                {s.gift_title && (
                  <p className="text-xs text-emerald-600 bg-emerald-50 rounded-lg px-3 py-2 mb-2 line-clamp-2">
                    🎁 {s.gift_title}
                  </p>
                )}
                {/* Кнопки */}
                <div className="flex gap-2 mt-3">
                  <button onClick={() => openSpeakerEdit(s)}
                    className="flex-1 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-gray-50 flex items-center justify-center gap-1">
                    <Edit2 size={11} /> Выступление
                  </button>
                  <button onClick={() => openGlobalEdit(s)}
                    className="flex-1 py-1.5 border border-[#25455D]/20 rounded-lg text-xs text-[#25455D] hover:bg-[#25455D]/5 flex items-center justify-center gap-1">
                    <User size={11} /> Профиль
                  </button>
                  <button onClick={() => removeSpeakerFromEvent(s.id)}
                    className="p-1.5 border border-red-100 rounded-lg text-red-400 hover:bg-red-50">
                    <Trash2 size={12} />
                  </button>
                </div>
                {s.ref_code && (
                  <button onClick={() => { navigator.clipboard.writeText(`https://t.me/pluson_bot?start=${s.ref_code}`); flash('Ссылка скопирована') }}
                    className="mt-2 w-full text-xs text-[#25455D] hover:underline flex items-center justify-center gap-1">
                    <Copy size={10} /> Реферальная ссылка
                  </button>
                )}
              </div>
            ))}
            {speakers.length === 0 && (
              <div className="col-span-3 py-12 text-center text-gray-400 bg-white rounded-2xl border border-gray-100">
                <User size={32} className="mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium mb-1">Спикеров пока нет</p>
                <p className="text-xs">Добавьте из базы или создайте нового</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ ПРОГРАММА ═══════════════════════════════════════════════════════════ */}
      {activeTab === 'program' && (
        <div>
          {/* День-переключатель */}
          <div className="flex items-center gap-3 mb-6">
            <div className="flex gap-2">
              {Array.from({ length: daysCount }, (_, i) => i + 1).map(d => (
                <button key={d} onClick={() => setActiveProgramDay(d)}
                  className={`px-5 py-2 rounded-xl text-sm font-medium transition-all ${
                    activeProgramDay === d ? 'text-white shadow-sm' : 'bg-white border border-gray-200 text-gray-600'
                  }`}
                  style={activeProgramDay === d ? { background: 'linear-gradient(45deg,#25455D,#0a1520)' } : {}}>
                  День {d}
                </button>
              ))}
            </div>
            <div className="ml-auto flex gap-2">
              <button onClick={() => setGenModal(true)}
                className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-600 hover:bg-gray-50">
                <Wand2 size={14} /> Генератор
              </button>
              <button onClick={() => { setSessionModal('new'); setSessionForm({ day: activeProgramDay, sort_order: daysSessions.length }) }}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-[#1a2a3a]"
                style={{ background: 'linear-gradient(45deg,#FFCFA4,#e8a87c)' }}>
                <Plus size={14} /> Добавить сессию
              </button>
            </div>
          </div>

          {/* Настройки дня */}
          <DaySettings
            day={activeProgramDay}
            data={days.find(d => d.day_number === activeProgramDay)}
            onSave={(data) => saveDay(activeProgramDay, data)}
          />

          {/* Сессии дня */}
          <div className="space-y-3 mt-4">
            {daysSessions.map(s => (
              <div key={s.id} className="bg-white rounded-xl border border-gray-100 p-4 flex gap-4 items-start">
                <div className="text-sm font-mono text-gray-400 w-20 shrink-0 pt-0.5">
                  {s.start_datetime
                    ? new Date(s.start_datetime).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
                    : '—:—'}
                  {s.end_datetime && (
                    <div className="text-xs">
                      {new Date(s.end_datetime).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 text-sm">{s.title}</p>
                  {s.speaker_name && (
                    <p className="text-xs text-gray-400 mt-0.5">👤 {s.speaker_name}</p>
                  )}
                  {s.gift_description && (
                    <p className="text-xs text-emerald-600 mt-1">🎁 {s.gift_description}</p>
                  )}
                </div>
                <button onClick={() => deleteSession(s.id)}
                  className="p-1 text-gray-300 hover:text-red-400 shrink-0">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {daysSessions.length === 0 && (
              <div className="py-10 text-center text-gray-400 bg-white rounded-2xl border border-gray-100">
                <Clock size={28} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">Программа пустая — добавьте сессии или используйте генератор</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ ШАБЛОНЫ ════════════════════════════════════════════════════════════ */}
      {activeTab === 'templates' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <div>
              <h3 className="font-semibold text-gray-800">Шаблоны рассылок</h3>
              <p className="text-xs text-gray-400 mt-0.5">Создайте шаблоны — потом запустите рассылки во вкладке «Рассылки»</p>
            </div>
            <button onClick={() => { setTemplateModal('new'); setTemplateForm({ name: '', type: 'pre_start', text: '', photo_url: '', button_text: '', button_url: '' }) }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm text-white font-medium"
              style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
              <Plus size={14} /> Новый шаблон
            </button>
          </div>

          {templates.length === 0 ? (
            <div className="py-12 text-center text-gray-400 bg-white rounded-2xl border border-gray-100">
              <Edit2 size={28} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">Шаблонов нет</p>
              <p className="text-xs mt-1">Создайте шаблон для рассылки «За 5 мин до старта» и «Подарок спикера»</p>
            </div>
          ) : (
            <div className="space-y-3">
              {templates.map(t => (
                <div key={t.id} className="bg-white rounded-xl border border-gray-100 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${t.type === 'pre_start' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                          {t.type === 'pre_start' ? 'За 5 мин до старта' : 'Подарок спикера'}
                        </span>
                        <span className="text-sm font-medium text-gray-800">{t.name}</span>
                      </div>
                      {t.text && (
                        <p className="text-sm text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-lg p-3 mb-2">{t.text}</p>
                      )}
                      <div className="flex flex-wrap gap-3 text-xs text-gray-400">
                        {t.photo_url && <span className="flex items-center gap-1"><Eye size={11} /> Есть фото</span>}
                        {t.button_text && <span className="flex items-center gap-1"><ExternalLink size={11} /> Кнопка: {t.button_text}</span>}
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button onClick={() => { setTemplateModal(t); setTemplateForm({ name: t.name, type: t.type, text: t.text || '', photo_url: t.photo_url || '', button_text: t.button_text || '', button_url: t.button_url || '' }) }}
                        className="p-1.5 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-700">
                        <Edit2 size={13} />
                      </button>
                      <button onClick={async () => {
                        await api.conference.templates.delete(eventId, t.id)
                        setTemplates(templates.filter(x => x.id !== t.id))
                      }} className="p-1.5 border border-red-100 rounded-lg text-red-400 hover:text-red-600">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Модалка создания/редактирования шаблона */}
          {templateModal && (
            <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
              <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-semibold text-gray-800">{templateModal === 'new' ? 'Новый шаблон' : 'Редактировать шаблон'}</h3>
                  <button onClick={() => setTemplateModal(null)}><X size={18} /></button>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Название шаблона</label>
                    <input value={templateForm.name} onChange={e => setTemplateForm({...templateForm, name: e.target.value})}
                      placeholder="Например: Анонс спикера"
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Тип</label>
                    <select value={templateForm.type} onChange={e => setTemplateForm({...templateForm, type: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none">
                      <option value="pre_start">За 5 минут до старта</option>
                      <option value="gift">Подарок спикера (за 10 мин до конца)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Текст сообщения</label>
                    <p className="text-xs text-gray-400 mb-1">Переменные: {'{speaker_name}'} {'{speaker_topic}'} {'{stream_url}'} {'{gift_title}'} {'{gift_url}'} {'{start_time}'} {'{end_time}'}</p>
                    <textarea value={templateForm.text} onChange={e => setTemplateForm({...templateForm, text: e.target.value})}
                      rows={6} placeholder="Текст сообщения..."
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none resize-none" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Фото (URL) — если нет, берётся афиша спикера</label>
                    <input value={templateForm.photo_url} onChange={e => setTemplateForm({...templateForm, photo_url: e.target.value})}
                      placeholder="https://..."
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Текст кнопки</label>
                      <input value={templateForm.button_text} onChange={e => setTemplateForm({...templateForm, button_text: e.target.value})}
                        placeholder="СМОТРЕТЬ ЭФИР"
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Ссылка кнопки</label>
                      <input value={templateForm.button_url} onChange={e => setTemplateForm({...templateForm, button_url: e.target.value})}
                        placeholder="https://..."
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 mt-5">
                  <button onClick={async () => {
                    if (templateModal === 'new') {
                      const res = await api.conference.templates.create(eventId, templateForm)
                      setTemplates([...templates, res])
                    } else {
                      const res = await api.conference.templates.update(eventId, templateModal.id, templateForm)
                      setTemplates(templates.map(x => x.id === templateModal.id ? res : x))
                    }
                    setTemplateModal(null)
                  }} className="flex-1 py-2 rounded-xl text-sm font-medium text-white"
                    style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                    Сохранить
                  </button>
                  <button onClick={() => setTemplateModal(null)}
                    className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
                    Отмена
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ РАССЫЛКИ ════════════════════════════════════════════════════════════ */}
      {activeTab === 'broadcasts' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <div>
              <h3 className="font-semibold text-gray-800">Очередь рассылок</h3>
              <p className="text-xs text-gray-400 mt-0.5">Создайте расписание из программы — рассылки уйдут автоматически по времени</p>
            </div>
            <div className="flex gap-2">
              {schedules.some(s => s.status === 'pending') && (
                <button onClick={async () => {
                  if (!confirm('Отменить все ожидающие рассылки?')) return
                  await api.conference.schedules.cancelAll(eventId)
                  const res = await api.conference.schedules.list(eventId)
                  setSchedules(res.schedules || [])
                }} className="flex items-center gap-2 px-3 py-2 border border-red-200 rounded-xl text-sm text-red-500 hover:bg-red-50">
                  <XCircle size={14} /> Остановить всё
                </button>
              )}
              <button onClick={async () => {
                if (templates.length === 0) { alert('Сначала создайте шаблоны во вкладке «Шаблоны»'); return }
                setSchedulesLoading(true)
                const res = await api.conference.schedules.generate(eventId)
                const updated = await api.conference.schedules.list(eventId)
                setSchedules(updated.schedules || [])
                setSchedulesLoading(false)
                setMsg(`Создано ${res.created} рассылок, пропущено ${res.skipped}`)
                setTimeout(() => setMsg(''), 4000)
              }} disabled={schedulesLoading}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm text-white font-medium disabled:opacity-50"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                <Wand2 size={14} /> {schedulesLoading ? 'Создаю...' : 'Создать из программы'}
              </button>
            </div>
          </div>

          {schedules.length === 0 ? (
            <div className="py-12 text-center text-gray-400 bg-white rounded-2xl border border-gray-100">
              <Send size={28} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">Рассылок нет</p>
              <p className="text-xs mt-1">Создайте шаблоны, потом нажмите «Создать из программы»</p>
            </div>
          ) : (
            <div className="space-y-2">
              {schedules.map(s => {
                const fireAt = s.fire_at ? new Date(s.fire_at) : null
                const secondsLeft = s.seconds_until
                const timeLeft = secondsLeft != null
                  ? secondsLeft > 3600
                    ? `${Math.floor(secondsLeft / 3600)}ч ${Math.floor((secondsLeft % 3600) / 60)}мин`
                    : secondsLeft > 60
                      ? `${Math.floor(secondsLeft / 60)} мин`
                      : `${secondsLeft} сек`
                  : null

                const statusColor: Record<string, string> = {
                  pending: 'bg-amber-50 border-amber-200',
                  running: 'bg-blue-50 border-blue-200',
                  done: 'bg-green-50 border-green-200',
                  cancelled: 'bg-gray-50 border-gray-200',
                }
                const statusLabel: Record<string, string> = {
                  pending: '⏳ Ожидает',
                  running: '📤 Отправляется',
                  done: '✅ Отправлено',
                  cancelled: '❌ Отменена',
                }

                return (
                  <div key={s.id} className={`rounded-xl border p-4 ${statusColor[s.status] || 'bg-white border-gray-100'}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="text-xs font-medium text-gray-700">{statusLabel[s.status] || s.status}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${s.type === 'pre_start' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                            {s.type === 'pre_start' ? 'Анонс' : 'Подарок'}
                          </span>
                          {s.speaker_name && <span className="text-xs text-gray-600 font-medium">{s.speaker_name}</span>}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-gray-500">
                          {fireAt && (
                            <span>{fireAt.toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                          )}
                          {timeLeft && s.status === 'pending' && (
                            <span className="text-amber-600 font-medium">через {timeLeft}</span>
                          )}
                          {s.status === 'done' && (
                            <span className="text-green-600">отправлено {s.recipients_sent} чел.</span>
                          )}
                        </div>
                      </div>
                      {s.status === 'pending' && (
                        <button onClick={async () => {
                          await api.conference.schedules.cancel(eventId, s.id)
                          setSchedules(schedules.map(x => x.id === s.id ? { ...x, status: 'cancelled' } : x))
                        }} className="p-1.5 border border-red-200 rounded-lg text-red-400 hover:text-red-600 shrink-0">
                          <XCircle size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══ ПРОМО-ПАРТНЁРЫ ══════════════════════════════════════════════════════ */}
      {activeTab === 'promo' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold text-gray-800">Промо-партнёры события</h3>
            <button onClick={() => setAddPromo(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-[#1a2a3a]"
              style={{ background: 'linear-gradient(45deg,#FFCFA4,#e8a87c)' }}>
              <Plus size={14} /> Добавить
            </button>
          </div>
          {addPromo && (
            <div className="bg-white rounded-2xl border border-gray-200 p-5 mb-4">
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div><label className="block text-xs text-gray-500 mb-1">Название</label>
                  <input value={promoForm.name} onChange={e => setPromoForm(f => ({ ...f, name: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" /></div>
                <div><label className="block text-xs text-gray-500 mb-1">Telegram</label>
                  <input value={promoForm.telegram_url} onChange={e => setPromoForm(f => ({ ...f, telegram_url: e.target.value }))}
                    placeholder="https://t.me/..." className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" /></div>
                <div><label className="block text-xs text-gray-500 mb-1">UTM-код</label>
                  <input value={promoForm.partner_code} onChange={e => setPromoForm(f => ({ ...f, partner_code: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" /></div>
              </div>
              <div className="flex gap-2">
                <button onClick={async () => {
                  const res = await api.conference.promoPartners.create(eventId, promoForm)
                  setPromoPartners(p => [...p, res.partner])
                  setAddPromo(false)
                  setPromoForm({ name: '', telegram_url: '', partner_code: '' })
                }} className="px-4 py-2 rounded-lg text-sm text-white" style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                  Сохранить
                </button>
                <button onClick={() => setAddPromo(false)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-500">Отмена</button>
              </div>
            </div>
          )}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50"><tr>
                {['Партнёр', 'Telegram', 'UTM-код', 'Ссылка'].map(h => (
                  <th key={h} className="px-5 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
                ))}
              </tr></thead>
              <tbody className="divide-y divide-gray-50">
                {promoPartners.length === 0 && (
                  <tr><td colSpan={4} className="px-5 py-8 text-center text-sm text-gray-400">Промо-партнёров пока нет</td></tr>
                )}
                {promoPartners.map(p => (
                  <tr key={p.id}>
                    <td className="px-5 py-3 text-sm font-medium text-gray-900">{p.name}</td>
                    <td className="px-5 py-3 text-sm text-gray-500">{p.telegram_url || '—'}</td>
                    <td className="px-5 py-3 text-sm font-mono text-gray-600">{p.partner_code}</td>
                    <td className="px-5 py-3">
                      <button onClick={() => { navigator.clipboard.writeText(`https://pluson.margoforbs.ru/l/${event?.slug}?app=tg&new_partner_id=${p.partner_code}`); flash('Скопировано') }}
                        className="flex items-center gap-1 text-xs text-[#25455D] hover:underline">
                        <Copy size={11} /> Скопировать
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ═══ КОДОВЫЕ СЛОВА ═══════════════════════════════════════════════════════ */}
      {activeTab === 'codes' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <div>
              <h3 className="font-semibold text-gray-800">Кодовые слова</h3>
              <p className="text-xs text-gray-400 mt-0.5">Спикер называет слово на выступлении — участники вводят и получают билеты на розыгрыш</p>
            </div>
            <button onClick={() => setAddCode(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-[#1a2a3a]"
              style={{ background: 'linear-gradient(45deg,#FFCFA4,#e8a87c)' }}>
              <Plus size={14} /> Добавить
            </button>
          </div>
          {addCode && (
            <div className="bg-white rounded-2xl border border-gray-200 p-5 mb-4">
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div><label className="block text-xs text-gray-500 mb-1">Спикер</label>
                  <select value={codeForm.speaker_id} onChange={e => setCodeForm(f => ({ ...f, speaker_id: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm">
                    <option value="">— выбрать —</option>
                    {speakers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select></div>
                <div><label className="block text-xs text-gray-500 mb-1">Кодовое слово</label>
                  <input value={codeForm.code_word} onChange={e => setCodeForm(f => ({ ...f, code_word: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" /></div>
                <div><label className="block text-xs text-gray-500 mb-1">Билетов</label>
                  <input type="number" min={1} value={codeForm.tickets_reward}
                    onChange={e => setCodeForm(f => ({ ...f, tickets_reward: Number(e.target.value) }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" /></div>
              </div>
              <div className="flex gap-2">
                <button onClick={async () => {
                  const res = await api.conference.codes.create(eventId, {
                    speaker_id: codeForm.speaker_id ? Number(codeForm.speaker_id) : undefined,
                    code_word: codeForm.code_word,
                    tickets_reward: codeForm.tickets_reward,
                  })
                  setCodes(c => [...c, res.code])
                  setAddCode(false)
                  setCodeForm({ speaker_id: '', code_word: '', tickets_reward: 1 })
                }} className="px-4 py-2 rounded-lg text-sm text-white" style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                  Сохранить
                </button>
                <button onClick={() => setAddCode(false)} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-500">Отмена</button>
              </div>
            </div>
          )}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50"><tr>
                {['Спикер', 'Кодовое слово', 'Билетов'].map(h => (
                  <th key={h} className="px-5 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
                ))}
              </tr></thead>
              <tbody className="divide-y divide-gray-50">
                {codes.length === 0 && <tr><td colSpan={3} className="px-5 py-8 text-center text-sm text-gray-400">Нет кодовых слов</td></tr>}
                {codes.map(c => (
                  <tr key={c.id}>
                    <td className="px-5 py-3 text-sm text-gray-700">{c.speaker_name || '—'}</td>
                    <td className="px-5 py-3 text-sm font-mono font-bold text-[#25455D]">{c.code_word}</td>
                    <td className="px-5 py-3 text-sm text-gray-600">{c.tickets_reward} 🎟</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'raffle' && (
        <div>
          <div className="mb-6">
            <h3 className="font-semibold text-gray-800">Розыгрыш</h3>
            <p className="text-xs text-gray-400 mt-0.5">Все билеты, зарегистрированные через API. Нажмите кнопку, чтобы выбрать случайного победителя.</p>
          </div>

          {/* Генератор победителя */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-6">
            <div className="flex flex-col sm:flex-row items-center gap-4">
              <button
                disabled={raffleTickets.length === 0}
                onClick={() => {
                  const idx = Math.floor(Math.random() * raffleTickets.length)
                  setRaffleWinner(raffleTickets[idx])
                }}
                className="flex items-center gap-2 px-6 py-3 rounded-xl text-base font-bold text-[#1a2a3a] disabled:opacity-40 disabled:cursor-not-allowed transition-all hover:scale-105 active:scale-100"
                style={{ background: 'linear-gradient(45deg,#FFCFA4,#e8a87c)' }}
              >
                🎲 Выбрать победителя
              </button>
              <span className="text-sm text-gray-400">Всего билетов: <b className="text-gray-700">{raffleTickets.length}</b></span>
            </div>

            {raffleWinner && (
              <div className="mt-5 p-5 rounded-2xl border-2 border-[#FFCFA4] bg-amber-50">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-3xl font-black text-[#25455D]">#{raffleWinner.ticket_number}</span>
                  <div>
                    <p className="font-bold text-gray-800 text-lg">{raffleWinner.tg_name || '—'}</p>
                    <p className="text-sm text-gray-500">
                      {raffleWinner.tg_username ? `@${raffleWinner.tg_username}` : `TG ID: ${raffleWinner.tg_id || '—'}`}
                    </p>
                  </div>
                  <button onClick={() => setRaffleWinner(null)} className="ml-auto text-gray-400 hover:text-gray-600">✕</button>
                </div>
              </div>
            )}
          </div>

          {/* Таблица билетов */}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px]">
                <thead className="bg-gray-50">
                  <tr>
                    {['№ билета', 'Имя в Telegram', 'Ник', 'Telegram ID', 'Salebot ID', 'Кодовое слово', 'Дата'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {raffleTickets.length === 0 && (
                    <tr><td colSpan={7} className="px-5 py-10 text-center text-sm text-gray-400">
                      Билеты ещё не добавлены.<br />
                      <span className="text-xs text-gray-300 mt-1 block">Используйте публичный API: POST /api/v1/events/{'{event_id}'}/conference/raffle-tickets/public</span>
                    </td></tr>
                  )}
                  {raffleTickets.map(t => (
                    <tr key={t.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-3 text-sm font-bold text-[#25455D]">#{t.ticket_number}</td>
                      <td className="px-4 py-3 text-sm text-gray-800">{t.tg_name || '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{t.tg_username ? `@${t.tg_username}` : '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-500 font-mono">{t.tg_id || '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-500">{t.salebot_client_id || '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-500">{t.code_word || '—'}</td>
                      <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
                        {t.created_at ? new Date(t.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ═══ МОДАЛ: Спикер ═══════════════════════════════════════════════════════ */}
      {speakerModal !== null && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)', paddingTop: '2rem' }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl mb-8">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <h3 className="font-bold text-gray-900">
                {speakerModal === 'new' && 'Новый спикер'}
                {speakerModal === 'from_base' && 'Добавить из базы'}
                {speakerModal !== 'new' && speakerModal !== 'from_base' && 'Выступление спикера'}
              </h3>
              <button onClick={() => setSpeakerModal(null)} className="text-gray-400 hover:text-gray-700"><X size={20} /></button>
            </div>

            <div className="p-6 space-y-4">

              {/* ── Режим: ИЗ БАЗЫ ── */}
              {speakerModal === 'from_base' && (
                <div>
                  {!selectedBase ? (
                    <div>
                      <label className="block text-xs text-gray-500 mb-2">Поиск по имени</label>
                      <input
                        value={baseSearch}
                        onChange={e => searchBase(e.target.value)}
                        placeholder="Начните вводить имя..."
                        className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none mb-3"
                        autoFocus
                      />
                      {baseLoading && <p className="text-sm text-gray-400 text-center py-4">Ищем...</p>}
                      {!baseLoading && baseSearch.length >= 2 && baseResults.length === 0 && (
                        <p className="text-sm text-gray-400 text-center py-4">Не найдено. Создайте нового спикера.</p>
                      )}
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {baseResults.map(sp => (
                          <button key={sp.id} onClick={() => setSelectedBase(sp)}
                            className="w-full flex items-center gap-3 p-3 border border-gray-200 rounded-xl hover:border-[#25455D] hover:bg-[#25455D]/5 text-left transition-all">
                            <div className="w-10 h-10 rounded-full flex-shrink-0 overflow-hidden"
                              style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                              {sp.photo_url
                                ? <img src={sp.photo_url} alt={sp.name} className="w-full h-full object-cover" />
                                : <div className="w-full h-full flex items-center justify-center text-white font-bold text-sm">{sp.name[0]}</div>
                              }
                            </div>
                            <div>
                              <p className="font-medium text-gray-900 text-sm">{sp.name}</p>
                              {sp.title && <p className="text-xs text-gray-400">{sp.title}</p>}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div>
                      {/* Выбранный спикер */}
                      <div className="flex items-center gap-3 p-3 bg-[#25455D]/5 rounded-xl border border-[#25455D]/20 mb-4">
                        <div className="w-10 h-10 rounded-full flex-shrink-0 overflow-hidden"
                          style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                          {selectedBase.photo_url
                            ? <img src={selectedBase.photo_url} alt={selectedBase.name} className="w-full h-full object-cover" />
                            : <div className="w-full h-full flex items-center justify-center text-white font-bold text-sm">{selectedBase.name[0]}</div>
                          }
                        </div>
                        <div className="flex-1">
                          <p className="font-medium text-gray-900 text-sm">{selectedBase.name}</p>
                          {selectedBase.title && <p className="text-xs text-gray-400">{selectedBase.title}</p>}
                        </div>
                        <button onClick={() => setSelectedBase(null)} className="text-gray-400 hover:text-gray-700 text-xs underline">
                          Изменить
                        </button>
                      </div>
                      {/* Данные выступления */}
                      <SpeakerEventFields form={speakerForm} setForm={setSpeakerForm} />
                    </div>
                  )}
                </div>
              )}

              {/* ── Режим: НОВЫЙ СПИКЕР ── */}
              {speakerModal === 'new' && (
                <div className="space-y-4">
                  <div className="p-3 bg-blue-50 rounded-xl text-xs text-blue-700">
                    Спикер будет создан в глобальной базе и сразу добавлен в это событие
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className="block text-xs text-gray-500 mb-1">Имя Фамилия / Название компании *</label>
                      <input value={speakerForm.name || ''} onChange={e => setSpeakerForm((f: any) => ({ ...f, name: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none" autoFocus />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Должность / специализация</label>
                      <input value={speakerForm.title || ''} onChange={e => setSpeakerForm((f: any) => ({ ...f, title: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Компания</label>
                      <input value={speakerForm.company || ''} onChange={e => setSpeakerForm((f: any) => ({ ...f, company: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Фото (URL)</label>
                      <input value={speakerForm.photo_url || ''} onChange={e => setSpeakerForm((f: any) => ({ ...f, photo_url: e.target.value }))}
                        placeholder="https://..." className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Telegram-канал</label>
                      <input value={speakerForm.telegram_url || ''} onChange={e => setSpeakerForm((f: any) => ({ ...f, telegram_url: e.target.value }))}
                        placeholder="https://t.me/..." className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs text-gray-500 mb-1">Регалии / Bio</label>
                      <textarea value={speakerForm.bio || ''} rows={2} onChange={e => setSpeakerForm((f: any) => ({ ...f, bio: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none resize-none" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Папка с фото</label>
                      <input value={speakerForm.photo_folder_url || ''} onChange={e => setSpeakerForm((f: any) => ({ ...f, photo_folder_url: e.target.value }))}
                        placeholder="https://disk.yandex.ru/..." className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Папка с видео</label>
                      <input value={speakerForm.video_folder_url || ''} onChange={e => setSpeakerForm((f: any) => ({ ...f, video_folder_url: e.target.value }))}
                        placeholder="https://disk.yandex.ru/..." className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                    </div>
                  </div>
                  <div className="border-t border-gray-100 pt-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Данные для этого события</p>
                    <SpeakerEventFields form={speakerForm} setForm={setSpeakerForm} />
                  </div>
                </div>
              )}

              {/* ── Режим: РЕДАКТИРОВАТЬ ВЫСТУПЛЕНИЕ ── */}
              {speakerModal !== 'new' && speakerModal !== 'from_base' && (
                <div>
                  <div className="p-3 bg-gray-50 rounded-xl text-xs text-gray-500 mb-4">
                    Здесь — данные выступления в этой конференции. Чтобы изменить фото, регалии или Telegram — нажмите кнопку «Профиль» на карточке.
                  </div>
                  <SpeakerEventFields form={speakerForm} setForm={setSpeakerForm} />
                  <div className="mt-3">
                    <label className="block text-xs text-gray-500 mb-1">Доп. информация</label>
                    <textarea value={speakerForm.extra_info || ''} rows={2}
                      onChange={e => setSpeakerForm((f: any) => ({ ...f, extra_info: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none resize-none" />
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <input type="checkbox" id="is_visible" checked={speakerForm.is_visible !== false}
                      onChange={e => setSpeakerForm((f: any) => ({ ...f, is_visible: e.target.checked }))} />
                    <label htmlFor="is_visible" className="text-sm text-gray-700">Показывать на лендинге</label>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3 p-6 border-t border-gray-100">
              <button onClick={saveSpeaker} disabled={saving || (speakerModal === 'from_base' && !selectedBase)}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white disabled:opacity-40"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                {saving ? 'Сохраняем...' : 'Сохранить'}
              </button>
              <button onClick={() => { setSpeakerModal(null); setSelectedBase(null) }}
                className="px-5 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ МОДАЛ: Редактировать профиль спикера в базе ══════════════════════ */}
      {editGlobalModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)', paddingTop: '2rem' }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mb-8">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <div>
                <h3 className="font-bold text-gray-900">Профиль спикера</h3>
                <p className="text-xs text-gray-400 mt-0.5">Меняется во всех событиях</p>
              </div>
              <button onClick={() => setEditGlobalModal(null)} className="text-gray-400 hover:text-gray-700"><X size={20} /></button>
            </div>
            <div className="p-6 space-y-3">
              {[
                { key: 'name', label: 'Имя Фамилия *', type: 'input' },
                { key: 'title', label: 'Должность / специализация', type: 'input' },
                { key: 'company', label: 'Компания', type: 'input' },
                { key: 'bio', label: 'Регалии / Bio', type: 'textarea' },
                { key: 'photo_url', label: 'Фото (URL)', type: 'input', placeholder: 'https://...' },
                { key: 'photo_folder_url', label: 'Папка с фото', type: 'input', placeholder: 'https://disk.yandex.ru/...' },
                { key: 'video_folder_url', label: 'Папка с видео', type: 'input', placeholder: 'https://disk.yandex.ru/...' },
                { key: 'telegram_url', label: 'Telegram-канал', type: 'input', placeholder: 'https://t.me/...' },
                { key: 'instagram_url', label: 'Instagram', type: 'input', placeholder: 'https://instagram.com/...' },
                { key: 'website_url', label: 'Сайт', type: 'input', placeholder: 'https://...' },
              ].map(({ key, label, type, placeholder }: any) => (
                <div key={key}>
                  <label className="block text-xs text-gray-500 mb-1">{label}</label>
                  {type === 'textarea'
                    ? <textarea value={editGlobalModal.form[key] || ''} rows={2}
                        onChange={e => setEditGlobalModal((m: any) => ({ ...m, form: { ...m.form, [key]: e.target.value } }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none resize-none" />
                    : <input value={editGlobalModal.form[key] || ''} placeholder={placeholder}
                        onChange={e => setEditGlobalModal((m: any) => ({ ...m, form: { ...m.form, [key]: e.target.value } }))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none" />
                  }
                </div>
              ))}
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-100">
              <button onClick={saveGlobalProfile} disabled={saving}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                {saving ? 'Сохраняем...' : 'Сохранить профиль'}
              </button>
              <button onClick={() => setEditGlobalModal(null)}
                className="px-5 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ МОДАЛ: Генератор расписания ════════════════════════════════════════ */}
      {genModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <h3 className="font-bold text-gray-900">Генератор расписания</h3>
              <button onClick={() => setGenModal(false)} className="text-gray-400 hover:text-gray-700"><X size={20} /></button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">День</label>
                  <select value={genForm.day} onChange={e => setGenForm(f => ({ ...f, day: Number(e.target.value) }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm">
                    {Array.from({ length: daysCount }, (_, i) => i + 1).map(d =>
                      <option key={d} value={d}>День {d}</option>
                    )}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Время начала</label>
                  <input type="time" value={genForm.start_time}
                    onChange={e => setGenForm(f => ({ ...f, start_time: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Длительность выступления (мин)</label>
                  <input type="number" value={genForm.slot_duration} min={10} max={120}
                    onChange={e => setGenForm(f => ({ ...f, slot_duration: Number(e.target.value) }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Перерыв между (мин)</label>
                  <input type="number" value={genForm.break_duration} min={0} max={60}
                    onChange={e => setGenForm(f => ({ ...f, break_duration: Number(e.target.value) }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-2">Спикеры (в порядке выступления)</label>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {speakers.filter(s => ['speaker', 'headliner', 'organizer'].includes(s.role)).map(s => (
                    <label key={s.id} className="flex items-center gap-2 p-2 border border-gray-100 rounded-lg cursor-pointer hover:bg-gray-50">
                      <input type="checkbox"
                        checked={genForm.speaker_ids.includes(s.id)}
                        onChange={e => setGenForm(f => ({
                          ...f,
                          speaker_ids: e.target.checked
                            ? [...f.speaker_ids, s.id]
                            : f.speaker_ids.filter(x => x !== s.id)
                        }))} />
                      <span className="text-sm text-gray-700">{s.name}</span>
                      <span className="text-xs text-gray-400 ml-auto">{ROLES[s.role]}</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-1">Выбрано: {genForm.speaker_ids.length} спикеров</p>
              </div>
              <p className="text-xs text-gray-400 bg-amber-50 border border-amber-100 rounded-lg p-3">
                ⚠️ Генерация заменит существующее расписание выбранного дня
              </p>
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-100">
              <button onClick={generateSchedule} disabled={genForm.speaker_ids.length === 0}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white disabled:opacity-40"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                Сгенерировать расписание
              </button>
              <button onClick={() => setGenModal(false)}
                className="px-5 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-600">Отмена</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ МОДАЛ: Добавить сессию ═══════════════════════════════════════════════ */}
      {sessionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h3 className="font-bold text-gray-900">Добавить сессию</h3>
              <button onClick={() => setSessionModal(null)} className="text-gray-400 hover:text-gray-700"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Название *</label>
                <input value={sessionForm.title || ''} onChange={e => setSessionForm((f: any) => ({ ...f, title: e.target.value }))}
                  placeholder="Открытие / Выступление / Перерыв"
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Спикер</label>
                <select value={sessionForm.speaker_id || ''} onChange={e => setSessionForm((f: any) => ({ ...f, speaker_id: e.target.value || null }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm">
                  <option value="">— без спикера —</option>
                  {speakers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Начало</label>
                  <input type="datetime-local" value={sessionForm.start_datetime || ''}
                    onChange={e => setSessionForm((f: any) => ({ ...f, start_datetime: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Конец</label>
                  <input type="datetime-local" value={sessionForm.end_datetime || ''}
                    onChange={e => setSessionForm((f: any) => ({ ...f, end_datetime: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Подарок от спикера (описание)</label>
                <input value={sessionForm.gift_description || ''} onChange={e => setSessionForm((f: any) => ({ ...f, gift_description: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm" />
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-gray-100">
              <button onClick={addSession}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                Добавить
              </button>
              <button onClick={() => setSessionModal(null)}
                className="px-5 py-2 border border-gray-200 rounded-xl text-sm text-gray-600">Отмена</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Компонент: поля выступления спикера в событии (роль, тема, подарок) ──────
const SPEAKER_ROLES: Record<string, string> = {
  organizer: 'Организатор', headliner: 'Хедлайнер',
  speaker: 'Спикер', partner: 'Партнёр',
  commercial: 'Коммерческий', general_partner: 'Генеральный партнёр',
}
function SpeakerEventFields({ form, setForm }: { form: any; setForm: (fn: any) => void }) {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-500 mb-1">Роль</label>
        <select value={form.role || 'speaker'} onChange={e => setForm((f: any) => ({ ...f, role: e.target.value }))}
          className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none">
          {Object.entries(SPEAKER_ROLES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Тема выступления</label>
        <input value={form.speaker_topic || ''} onChange={e => setForm((f: any) => ({ ...f, speaker_topic: e.target.value }))}
          placeholder="О чём будет доклад в этой конференции"
          className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none" />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Подарок — название</label>
        <textarea value={form.gift_title || ''} rows={2}
          onChange={e => setForm((f: any) => ({ ...f, gift_title: e.target.value }))}
          placeholder="Например: Чек-лист «10 способов удвоить продажи»"
          className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none resize-none" />
      </div>
      <div>
        <label className="block text-xs text-gray-500 mb-1">Подарок — ссылка для получения</label>
        <input value={form.gift_url || ''} onChange={e => setForm((f: any) => ({ ...f, gift_url: e.target.value }))}
          placeholder="https://..." className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none" />
      </div>
      <div className="flex items-center gap-2">
        <input type="checkbox" id="is_visible_ev" checked={form.is_visible !== false}
          onChange={e => setForm((f: any) => ({ ...f, is_visible: e.target.checked }))} />
        <label htmlFor="is_visible_ev" className="text-sm text-gray-700">Показывать на лендинге</label>
      </div>
    </div>
  )
}

// ── Компонент: настройки дня ──────────────────────────────────────────────────
function DaySettings({ day, data, onSave }: { day: number; data: any; onSave: (d: any) => void }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    day_date: data?.day_date || '',
    open_time: data?.open_time || '11:00',
    close_time: data?.close_time || '18:00',
    stream_url: data?.stream_url || '',
  })

  useEffect(() => {
    setForm({
      day_date: data?.day_date || '',
      open_time: data?.open_time?.slice(0, 5) || '11:00',
      close_time: data?.close_time?.slice(0, 5) || '18:00',
      stream_url: data?.stream_url || '',
    })
  }, [data])

  return (
    <div className="bg-gray-50 rounded-xl border border-gray-200 mb-4">
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700">
        <span>⚙️ Настройки дня {day}</span>
        <ChevronRight size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Дата</label>
            <input type="date" value={form.day_date} onChange={e => setForm(f => ({ ...f, day_date: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Открытие</label>
            <input type="time" value={form.open_time} onChange={e => setForm(f => ({ ...f, open_time: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Закрытие</label>
            <input type="time" value={form.close_time} onChange={e => setForm(f => ({ ...f, close_time: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          </div>
          <div className="md:col-span-4">
            <label className="block text-xs text-gray-500 mb-1">Ссылка на трансляцию</label>
            <input type="url" value={form.stream_url} onChange={e => setForm(f => ({ ...f, stream_url: e.target.value }))}
              placeholder="https://youtube.com/..."
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
          </div>
          <div className="md:col-span-4">
            <button onClick={() => onSave(form)}
              className="px-4 py-2 rounded-lg text-sm text-white" style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
              Сохранить день {day}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
