'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, ExternalLink, Check, AlertTriangle, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'
import { ImageThumb } from '@/components/ImagePreview'

// Поля профиля, которые обязательно нужны
const PROFILE_FIELDS: { key: string; label: string }[] = [
  { key: 'name', label: 'Имя и фамилия' },
  { key: 'title', label: 'Должность / специализация' },
  { key: 'achievements', label: 'Регалии' },
  { key: 'photo_url', label: 'Фото' },
  { key: 'poster_url', label: 'Афиша' },
  { key: 'tg_channel_url', label: 'Ссылка на Telegram-канал' },
  { key: 'tg_channel_id', label: 'ID канала' },
  { key: 'personal_tg_id', label: 'ID личного аккаунта' },
  { key: 'personal_tg_username', label: 'Ник личного аккаунта' },
]

function getMissingProfileFields(form: any): string[] {
  return PROFILE_FIELDS
    .filter(f => {
      const v = form[f.key]
      if (Array.isArray(v)) return v.length === 0
      return !v || String(v).trim() === ''
    })
    .map(f => f.label)
}

function getMissingEventFields(form: any): string[] {
  const missing: string[] = []

  const hasTopics = form.topics?.length > 0 && form.topics.some((t: string) => t.trim())
  if (!hasTopics) missing.push('Тема выступления')

  if (!form.gift_after_speech_title?.trim()) missing.push('Название подарка после эфира')
  if (!form.gift_after_speech_url?.trim()) missing.push('Ссылка на подарок после эфира')
  if (!form.gift_raffle_title?.trim()) missing.push('Название подарка розыгрыша')
  if (!form.gift_raffle_url?.trim()) missing.push('Ссылка на подарок розыгрыша')

  return missing
}

function WarningPopup({ missing, onClose }: { missing: string[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])
  return (
    <div ref={ref} className="absolute right-0 top-full mt-2 z-50 bg-white border border-amber-200 rounded-2xl shadow-lg p-4 w-72">
      <div className="flex items-center justify-between mb-3">
        <span className="font-semibold text-sm text-gray-900">Не заполнены важные поля</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-0.5 rounded"><X size={14} /></button>
      </div>
      <ul className="space-y-1.5">
        {missing.map(label => (
          <li key={label} className="flex items-center gap-2 text-sm text-gray-700">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
            {label}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Редактор списка тем */
function TopicsEditor({ topics, onChange }: { topics: string[]; onChange: (topics: string[]) => void }) {
  function updateTopic(i: number, val: string) {
    const next = [...topics]; next[i] = val; onChange(next)
  }
  function removeTopic(i: number) { onChange(topics.filter((_, idx) => idx !== i)) }
  function addTopic() { onChange([...topics, '']) }
  return (
    <div className="space-y-2">
      {topics.map((t, i) => (
        <div key={i} className="flex items-start gap-2">
          <textarea value={t} onChange={e => updateTopic(i, e.target.value)} rows={2}
            placeholder={`Тема ${i + 1}`} className="input flex-1 resize-none text-sm" />
          {topics.length > 1 && (
            <button type="button" onClick={() => removeTopic(i)}
              className="mt-1 p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0">
              <X size={14} />
            </button>
          )}
        </div>
      ))}
      <button type="button" onClick={addTopic}
        className="flex items-center gap-1.5 text-xs text-brand hover:text-brand/80 transition-colors py-1">
        + Добавить тему
      </button>
    </div>
  )
}

/** Поле с иконкой предупреждения рядом с лейблом */
function FieldLabel({ label, empty }: { label: string; empty: boolean }) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5">
      <span className="block text-sm font-medium text-gray-700">{label}</span>
      {empty && <AlertTriangle size={13} className="text-amber-400 shrink-0" />}
    </div>
  )
}

export default function ConferenceSpeakerPage() {
  const router = useRouter()
  const { id, speakerId } = useParams()
  const confId = Number(id)
  const speakerEventId = Number(speakerId)
  const { t } = useLang()

  const [profile, setProfile] = useState<any>(null)
  const [achievementsText, setAchievementsText] = useState('')

  const [eventForm, setEventForm] = useState({
    role: 'speaker',
    topics: [''],
    gift_after_speech_title: '',
    gift_after_speech_url: '',
    gift_raffle_title: '',
    gift_raffle_url: '',
    notes: '',
    is_commercial: false,
    bot_in_channel: false,
    priority: 60,
    exclude_gift_from_broadcast: false,
    exclude_channel_from_subscription: false,
  })

  const [clientWorkAccount, setClientWorkAccount] = useState<{ username: string; id: string } | null>(null)
  const [mainBotHandle, setMainBotHandle] = useState<string>('')
  const [subscriptionMode, setSubscriptionMode] = useState<'none' | 'organizer' | 'all_speakers'>('none')

  const [loading, setLoading] = useState(true)
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingEvent, setSavingEvent] = useState(false)
  const [profileSaved, setProfileSaved] = useState(false)
  const [eventSaved, setEventSaved] = useState(false)
  const [verifyingChannel, setVerifyingChannel] = useState(false)
  const [channelVerifyMsg, setChannelVerifyMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [error, setError] = useState('')
  const [showWarning, setShowWarning] = useState(false)

  useEffect(() => {
    api.auth.me().then((c: any) => {
      if (c.work_tg_id) setClientWorkAccount({ username: c.work_tg_username || '', id: String(c.work_tg_id) })
      if (c.main_bot_handle) setMainBotHandle(String(c.main_bot_handle))
    }).catch(() => {})
    api.conference.get(confId).then((r: any) => {
      const m = r?.conference?.subscription_mode
      if (m === 'organizer' || m === 'all_speakers') setSubscriptionMode(m)
      else setSubscriptionMode('none')
    }).catch(() => {})
  }, [confId])

  useEffect(() => {
    api.conference.speakers.list(confId)
      .then(r => {
        const speakers = r.speakers || []
        const sp = speakers.find((s: any) => s.id === speakerEventId)
        if (!sp) { router.push(`/dashboard/conferences/${confId}?tab=speakers`); return }

        const rawTopics = sp.topics && sp.topics.length > 0
          ? sp.topics.map((t: any) => typeof t === 'string' ? t : t.topic)
          : (sp.speaker_topic ? [sp.speaker_topic] : [''])

        setEventForm({
          role: sp.role || 'speaker',
          topics: rawTopics.length > 0 ? rawTopics : [''],
          gift_after_speech_title: sp.gift_after_speech_title || '',
          gift_after_speech_url: sp.gift_after_speech_url || '',
          gift_raffle_title: sp.gift_raffle_title || '',
          gift_raffle_url: sp.gift_raffle_url || '',
          notes: sp.notes || '',
          is_commercial: sp.is_commercial || false,
          bot_in_channel: sp.bot_in_channel || false,
          priority: sp.priority ?? 60,
          exclude_gift_from_broadcast: sp.exclude_gift_from_broadcast || false,
          exclude_channel_from_subscription: sp.exclude_channel_from_subscription || false,
        })

        return api.collaborators.get(sp.speaker_id)
      })
      .then(r => {
        if (!r) return
        setProfile(r.collaborator)
        const ach = r.collaborator.achievements
        setAchievementsText(Array.isArray(ach) ? ach.join('\n') : (ach || ''))
      })
      .catch(() => router.push(`/dashboard/conferences/${confId}?tab=speakers`))
      .finally(() => setLoading(false))
  }, [confId, speakerEventId])

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault()
    setSavingProfile(true); setError(''); setProfileSaved(false)
    try {
      const achievements = achievementsText.split('\n').map(s => s.trim()).filter(Boolean)
      await api.collaborators.update(profile.id, {
        name: profile.name,
        title: profile.title,
        achievements,
        photo_url: profile.photo_url,
        poster_url: profile.poster_url,
        photo_folder_url: profile.photo_folder_url,
        video_folder_url: profile.video_folder_url,
        tg_channel_url: profile.tg_channel_url,
        instagram_url: profile.instagram_url,
        website_url: profile.website_url,
        tg_channel_id: profile.tg_channel_id,
        personal_tg_id: profile.personal_tg_id,
        personal_tg_username: profile.personal_tg_username,
        assistant_tg_username: profile.assistant_tg_username,
      })
      setProfileSaved(true)
      setTimeout(() => setProfileSaved(false), 3000)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSavingProfile(false)
    }
  }

  function calcPriority(role: string, is_commercial: boolean): number {
    if (role === 'organizer') return 10
    if (is_commercial && role === 'headliner') return 20
    if (is_commercial && role === 'speaker') return 30
    if (is_commercial && role === 'partner') return 40
    if (!is_commercial && role === 'headliner') return 50
    if (!is_commercial && role === 'speaker') return 60
    if (!is_commercial && role === 'partner') return 70
    return 60
  }

  async function handleBotInChannelChange(checked: boolean) {
    if (!checked) {
      setEventForm(f => ({ ...f, bot_in_channel: false }))
      setChannelVerifyMsg(null)
      return
    }
    const missing: string[] = []
    if (!profile?.tg_channel_id?.toString().trim()) missing.push('«ID канала»')
    if (!profile?.personal_tg_id?.toString().trim()) missing.push('«ID личного аккаунта»')
    if (missing.length > 0) {
      setChannelVerifyMsg({
        ok: false,
        text: `Сначала заполните и сохраните ${missing.join(' и ')} в профиле спикера — без них автопроверка не запустится.`,
      })
      return
    }
    setVerifyingChannel(true)
    setChannelVerifyMsg(null)
    try {
      const res = await api.conference.speakers.verifyChannel(confId, speakerEventId)
      setEventForm(f => ({ ...f, bot_in_channel: true }))
      setChannelVerifyMsg({ ok: true, text: res.message || 'Подписка подтверждена' })
    } catch (err: any) {
      setChannelVerifyMsg({ ok: false, text: err.message || 'Ошибка проверки' })
    } finally {
      setVerifyingChannel(false)
    }
  }

  async function saveEvent(e: React.FormEvent) {
    e.preventDefault()
    setSavingEvent(true); setError(''); setEventSaved(false)
    try {
      const topics = eventForm.topics.filter(t => t.trim())
      const priority = calcPriority(eventForm.role, eventForm.is_commercial)
      await api.conference.speakers.update(confId, speakerEventId, {
        role: eventForm.role,
        topics,
        gift_after_speech_title: eventForm.gift_after_speech_title,
        gift_after_speech_url: eventForm.gift_after_speech_url,
        gift_raffle_title: eventForm.gift_raffle_title,
        gift_raffle_url: eventForm.gift_raffle_url,
        notes: eventForm.notes,
        is_commercial: eventForm.is_commercial,
        bot_in_channel: eventForm.bot_in_channel,
        priority,
        exclude_gift_from_broadcast: eventForm.exclude_gift_from_broadcast,
        exclude_channel_from_subscription: eventForm.exclude_channel_from_subscription,
      } as any)
      setEventSaved(true)
      setTimeout(() => setEventSaved(false), 3000)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSavingEvent(false)
    }
  }

  const setP = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setProfile((f: any) => ({ ...f, [k]: e.target.value }))
  const setEF = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setEventForm(f => ({ ...f, [k]: e.target.value }))

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="text-brand text-3xl" />
      </div>
    )
  }
  if (!profile) return null

  const missingProfile = getMissingProfileFields(profile)
  const missingEvent = getMissingEventFields(eventForm)
  const allMissing = [...missingProfile, ...missingEvent]

  return (
    <div className="max-w-2xl">
      {/* Шапка */}
      <div className="flex items-center gap-3 mb-8">
        <Link href={`/dashboard/conferences/${confId}?tab=speakers`}
          className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex items-center gap-3 flex-1">
          {profile.photo_url && <ImageThumb url={profile.photo_url} alt={profile.name} />}
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{profile.name}</h1>
            {profile.title && <p className="text-gray-500 text-sm">{profile.title}</p>}
          </div>
        </div>
        {allMissing.length > 0 && (
          <div className="relative">
            <button type="button" onClick={() => setShowWarning(v => !v)}
              className="p-2 rounded-xl hover:bg-amber-50 transition-colors"
              title="Не заполнены важные поля">
              <AlertTriangle size={20} className="text-amber-400" />
            </button>
            {showWarning && (
              <WarningPopup missing={allMissing} onClose={() => setShowWarning(false)} />
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl mb-4">{error}</div>
      )}

      {/* ── БЛОК 1: Данные выступления ── */}
      <form onSubmit={saveEvent} className="space-y-4 mb-8">
        <h2 className="font-bold text-gray-900 text-lg">Выступление в этой конференции</h2>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="label">Роль</label>
              <select value={eventForm.role}
                onChange={e => {
                  const role = e.target.value
                  const priority = calcPriority(role, (eventForm as any).is_commercial)
                  setEventForm(f => ({ ...f, role, priority } as any))
                }}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand bg-white">
                {Object.entries(t.conferences.speakers.roles).map(([k, v]) => (
                  <option key={k} value={k}>{v as string}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Приоритет</label>
              <input type="number" min={1} max={999}
                value={(eventForm as any).priority ?? 60}
                onChange={e => setEventForm(f => ({ ...f, priority: Number(e.target.value) } as any))}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand text-center" />
            </div>
          </div>

          <div>
            <FieldLabel label="Темы выступления" empty={!eventForm.topics.some(t => t.trim())} />
            <TopicsEditor topics={eventForm.topics} onChange={topics => setEventForm(f => ({ ...f, topics }))} />
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={eventForm.is_commercial}
              onChange={e => {
                const is_commercial = e.target.checked
                const priority = calcPriority(eventForm.role, is_commercial)
                setEventForm(f => ({ ...f, is_commercial, priority } as any))
              }}
              className="w-4 h-4 rounded border-gray-300 text-brand" />
            <span className="text-sm text-gray-700">Коммерческое выступление</span>
          </label>

        </div>

        {/* Заметки */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-3">
          <h3 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
            <span>Заметки</span>
            <span className="text-xs text-gray-400 font-normal">— только для вас, не показывается участникам</span>
          </h3>
          <textarea
            value={eventForm.notes}
            onChange={e => setEventForm(f => ({ ...f, notes: e.target.value }))}
            rows={6}
            placeholder="Например: текст частушки для ведущего, шпаргалка по гонорару, контакты ассистента"
            className="input resize-y text-sm w-full"
          />
        </div>

        {/* Чёрный список */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-3">
          <h3 className="font-semibold text-gray-900 text-sm flex items-center gap-2">
            <span>Чёрный список</span>
            <span className="text-xs text-gray-400 font-normal">— исключения для этого спикера</span>
          </h3>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={eventForm.exclude_gift_from_broadcast}
              onChange={e => setEventForm(f => ({ ...f, exclude_gift_from_broadcast: e.target.checked }))}
              className="w-4 h-4 rounded border-gray-300 text-brand" />
            <span className="text-sm text-gray-700">
              Исключать подарок из общей рассылки
            </span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={eventForm.exclude_channel_from_subscription}
              onChange={e => setEventForm(f => ({ ...f, exclude_channel_from_subscription: e.target.checked }))}
              className="w-4 h-4 rounded border-gray-300 text-brand" />
            <span className="text-sm text-gray-700">
              Исключать канал из подписки
            </span>
          </label>
        </div>

        {/* Подарок после эфира */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">Подарок после эфира</h3>
          <div>
            <FieldLabel label="Название" empty={!eventForm.gift_after_speech_title.trim()} />
            <textarea value={eventForm.gift_after_speech_title} onChange={setEF('gift_after_speech_title')}
              rows={3} placeholder="Например: Чек-лист по нутрициологии"
              className="input resize-y text-sm" />
          </div>
          <div>
            <FieldLabel label="Ссылка / текст со ссылками" empty={!eventForm.gift_after_speech_url.trim()} />
            <textarea value={eventForm.gift_after_speech_url} onChange={setEF('gift_after_speech_url')}
              rows={3} placeholder={"https://...\nили несколько ссылок / инструкция как получить"}
              className="input resize-y text-sm" />
          </div>
        </div>

        {/* Подарок для розыгрыша */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">Подарок для розыгрыша</h3>
          <div>
            <FieldLabel label="Название" empty={!eventForm.gift_raffle_title.trim()} />
            <textarea value={eventForm.gift_raffle_title} onChange={setEF('gift_raffle_title')}
              rows={3} placeholder="Например: Консультация 1:1"
              className="input resize-y text-sm" />
          </div>
          <div>
            <FieldLabel label="Ссылка / текст со ссылками" empty={!eventForm.gift_raffle_url.trim()} />
            <textarea value={eventForm.gift_raffle_url} onChange={setEF('gift_raffle_url')}
              rows={3} placeholder={"https://...\nили несколько ссылок / инструкция как получить"}
              className="input resize-y text-sm" />
          </div>
        </div>

        <div className="flex gap-3 items-center">
          <button type="submit" disabled={savingEvent}
            className={`btn-gold flex-1 py-3 rounded-xl font-semibold flex items-center justify-center gap-2 ${savingEvent ? 'btn-loading' : ''}`}>
            {savingEvent ? <><Spinner /> Сохраняю...</> : <><Save size={16} /> Сохранить выступление</>}
          </button>
          {eventSaved && (
            <span className="flex items-center gap-1.5 text-sm text-green-600">
              <Check size={15} /> Сохранено
            </span>
          )}
        </div>
      </form>

      {/* ── БЛОК 2: Глобальный профиль спикера ── */}
      <form onSubmit={saveProfile} className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-gray-900 text-lg">Профиль спикера</h2>
          <span className="text-xs text-gray-400">Изменения применятся ко всем конференциям</span>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">{t.fields.basicInfo}</h3>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.nameRequired}</label>
            <input type="text" value={profile.name || ''} onChange={setP('name')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.position}</label>
            <input type="text" value={profile.title || ''} onChange={setP('title')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.achievements}</label>
            <textarea value={achievementsText} onChange={e => setAchievementsText(e.target.value)} rows={5}
              placeholder={'Регалия 1\nРегалия 2\nРегалия 3'}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand resize-y" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">{t.fields.media}</h3>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.photo}</label>
            <div className="flex gap-2">
              <input type="url" value={profile.photo_url || ''} onChange={setP('photo_url')} placeholder="https://..."
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
              <ImageThumb url={profile.photo_url} alt={profile.name} />
              {profile.photo_url && (
                <a href={profile.photo_url} target="_blank" rel="noopener"
                  className="px-3 py-2.5 rounded-xl border border-gray-200 text-gray-500 hover:text-brand transition-colors">
                  <ExternalLink size={15} />
                </a>
              )}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.posterUrl}</label>
            <div className="flex gap-2">
              <input type="url" value={profile.poster_url || ''} onChange={setP('poster_url')} placeholder="https://..."
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
              <ImageThumb url={profile.poster_url} alt={`Афиша ${profile.name}`} />
              {profile.poster_url && (
                <a href={profile.poster_url} target="_blank" rel="noopener"
                  className="px-3 py-2.5 rounded-xl border border-gray-200 text-gray-500 hover:text-brand transition-colors">
                  <ExternalLink size={15} />
                </a>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.photoFolder}</label>
              <input type="url" value={profile.photo_folder_url || ''} onChange={setP('photo_folder_url')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.videoFolder}</label>
              <input type="url" value={profile.video_folder_url || ''} onChange={setP('video_folder_url')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">{t.fields.contacts}</h3>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.instagram}</label>
            <input type="url" value={profile.instagram_url || ''} onChange={setP('instagram_url')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.website}</label>
            <input type="url" value={profile.website_url || ''} onChange={setP('website_url')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">{t.fields.accounts}</h3>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.telegram}</label>
            <input type="url" value={profile.tg_channel_url || ''} onChange={setP('tg_channel_url')}
              placeholder="https://t.me/username"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.channelId}</label>
              <input type="text" value={profile.tg_channel_id || ''} onChange={setP('tg_channel_id')}
                placeholder="-100123456789"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.personalAccountId}</label>
              <input type="text" value={profile.personal_tg_id || ''} onChange={setP('personal_tg_id')}
                placeholder="123456789"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.personalAccountUsername}</label>
              <input type="text" value={profile.personal_tg_username || ''} onChange={setP('personal_tg_username')}
                placeholder="@username"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.assistantAccount}</label>
              <input type="text" value={profile.assistant_tg_username || ''} onChange={setP('assistant_tg_username')}
                placeholder="@assistant"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>

          {/* Подписка бота на канал — показываем только когда конференция требует
              подписку и канал ЭТОГО спикера учитывается в проверке. */}
          {(() => {
            const channelMatters =
              subscriptionMode === 'all_speakers' ||
              (subscriptionMode === 'organizer' && eventForm.role === 'organizer')
            if (!channelMatters) {
              return (
                <div className="pt-2 border-t border-gray-100">
                  <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-xl p-3">
                    Подключение канала к проверке подписки отключено.{' '}
                    {subscriptionMode === 'none'
                      ? <>В <a href={`/dashboard/conferences/${confId}?tab=settings`} className="underline">настройках конференции</a> выбран режим «Не требовать подписку».</>
                      : <>В <a href={`/dashboard/conferences/${confId}?tab=settings`} className="underline">настройках конференции</a> выбран режим «Только канал организатора», поэтому канал этого спикера не участвует в проверке.</>
                    }
                  </div>
                </div>
              )
            }
            return (
              <div className="pt-2 border-t border-gray-100 space-y-3">
                <div className="text-xs text-gray-600 leading-relaxed bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
                  <div className="font-semibold text-gray-800">Как подключить канал спикера к проверке подписки:</div>
                  <ol className="list-decimal pl-4 space-y-1.5">
                    <li>
                      <span className="font-semibold">Заполните выше «ID канала» и «ID личного аккаунта» спикера и сохраните профиль</span> — без них автопроверка не запустится.
                    </li>
                    <li>
                      Откройте канал спикера в Telegram → «Управление каналом» → «Администраторы» → «Добавить администратора».
                    </li>
                    <li>
                      Найдите бота{' '}
                      <span className="font-mono font-semibold text-gray-800">
                        @{mainBotHandle || 'ваш_главный_бот'}
                      </span>
                      {!mainBotHandle && (
                        <span className="text-amber-700"> (подключите главный бот в разделе <a href="/dashboard/channels" className="underline">«Каналы»</a>)</span>
                      )}
                      {' '}и добавьте его.
                    </li>
                    <li>
                      <span className="font-semibold">Снимите ВСЕ галки прав</span> — бот не должен ничего публиковать в канале, он нужен только чтобы видеть подписчиков. Сохраните.
                    </li>
                    <li>
                      Поставьте галку ниже — бот сам проверит, видит ли он подписку самого спикера на свой канал. Если видит — канал добавляется в проверку. Если нет — покажет, что не так.
                    </li>
                  </ol>
                </div>
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    id="bot_in_channel_check"
                    checked={eventForm.bot_in_channel}
                    disabled={verifyingChannel}
                    onChange={e => handleBotInChannelChange(e.target.checked)}
                    className="w-4 h-4 mt-0.5 rounded border-gray-300 text-brand cursor-pointer"
                  />
                  <label htmlFor="bot_in_channel_check" className="text-sm text-gray-700 cursor-pointer select-none">
                    {verifyingChannel
                      ? 'Проверяю подписку...'
                      : 'Бот добавлен в администраторы канала'
                    }
                  </label>
                </div>
                {channelVerifyMsg && (
                  <p className={`text-xs px-3 py-2 rounded-lg ${channelVerifyMsg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
                    {channelVerifyMsg.text}
                  </p>
                )}
              </div>
            )
          })()}
        </div>

        <div className="flex gap-3 items-center">
          <button type="submit" disabled={savingProfile}
            className={`btn-gold flex-1 py-3 rounded-xl font-semibold flex items-center justify-center gap-2 ${savingProfile ? 'btn-loading' : ''}`}>
            {savingProfile ? <><Spinner /> Сохраняю...</> : <><Save size={16} /> Сохранить профиль</>}
          </button>
          {profileSaved && (
            <span className="flex items-center gap-1.5 text-sm text-green-600">
              <Check size={15} /> Сохранено
            </span>
          )}
        </div>
      </form>
    </div>
  )
}
