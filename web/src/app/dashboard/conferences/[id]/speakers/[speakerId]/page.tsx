'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter, useParams, usePathname } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, ExternalLink, Check, AlertTriangle, X, User as UserIcon, Maximize2, Download, Copy, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'
import { ImageThumb } from '@/components/ImagePreview'
import FileUploader from '@/components/FileUploader'
import RefLinkInline from '@/components/RefLinkInline'
import MediaAssetsField, { MediaAsset } from '@/components/MediaAssetsField'
import { validateSocialLinks } from '@/lib/validateSocialLinks'

// Поля профиля, которые обязательно нужны
const PROFILE_FIELDS: { key: string; label: string }[] = [
  { key: 'name', label: 'Имя и фамилия' },
  { key: 'title', label: 'Должность / специализация' },
  { key: 'achievements', label: 'Регалии' },
  { key: 'photo_url', label: 'Фото' },
  // poster_url стал библиотекой (миграция 121). Признак «заполнено» = есть
  // хоть одна афиша. _COLLAB_SELECT отдаёт posters_count.
  { key: 'posters_count', label: 'Афиша' },
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
      if (typeof v === 'number') return v <= 0
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
function TopicsEditor({ topics, onChange, boundIndex, slotLabel, slotHasTopic }: {
  topics: string[]; onChange: (topics: string[]) => void
  boundIndex?: number | null; slotLabel?: string | null; slotHasTopic?: boolean | null
}) {
  function updateTopic(i: number, val: string) {
    const next = [...topics]; next[i] = val; onChange(next)
  }
  function removeTopic(i: number) { onChange(topics.filter((_, idx) => idx !== i)) }
  function addTopic() { onChange([...topics, '']) }
  // Слот в программе есть, но темы в нём ещё нет — предупреждаем.
  const slotNoTopic = !!slotLabel && slotHasTopic === false
  return (
    <div className="space-y-2">
      {slotLabel && (
        <div className={`text-xs rounded-lg px-3 py-2 ${slotNoTopic ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}`}>
          {slotNoTopic
            ? <>⚠️ Слот <b>{slotLabel}</b> занят, но тема к нему ещё не привязана — сохраните тему, и она подставится в программу и рассылки.</>
            : <>✓ В программу и рассылки идёт тема, отмеченная зелёным (слот <b>{slotLabel}</b>). Остальные темы в программу не попадают.</>}
        </div>
      )}
      {topics.map((t, i) => {
        const isBound = boundIndex != null && boundIndex === i
        return (
          <div key={i} className="flex items-start gap-2">
            <div className="flex-1">
              <textarea value={t} onChange={e => updateTopic(i, e.target.value)} rows={2}
                placeholder={`Тема ${i + 1}`}
                className={`input w-full resize-none text-sm ${isBound ? 'border-emerald-400 ring-1 ring-emerald-200' : ''}`} />
              {isBound && (
                <div className="text-[11px] text-emerald-600 mt-1">✓ Тема в слоте программы{slotLabel ? ` (${slotLabel})` : ''}</div>
              )}
            </div>
            {topics.length > 1 && (
              <button type="button" onClick={() => removeTopic(i)}
                className="mt-1 p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0">
                <X size={14} />
              </button>
            )}
          </div>
        )
      })}
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

// Прямые ссылки на карточку конкретного спикера: веб-страница события и Mini App.
function SpeakerCardLink({ slug, ecId, botHandle }: { slug: string; ecId: number; botHandle: string }) {
  const webUrl = `https://pluson.ru/event/${slug}?spk=${ecId}`
  // Mini App-ссылка — только при своём боте клиента. Системный @pluson_bot
  // не подставляем (с 2026-07-08): нет бота → показываем только веб-ссылку.
  const tgUrl = botHandle
    ? `https://telegram.me/${botHandle}?startapp=ref_pg${slug}_spk${ecId}`
    : ''
  const [copied, setCopied] = useState<string | null>(null)
  const copy = async (url: string, key: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(key); setTimeout(() => setCopied(null), 2000) } catch {}
  }
  const Row = ({ label, url, k }: { label: string; url: string; k: string }) => (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-20 shrink-0">{label}</span>
      <input readOnly value={url} className="flex-1 text-xs bg-gray-50 px-2 py-1.5 rounded-lg border border-gray-200 font-mono truncate" />
      <button type="button" onClick={() => copy(url, k)}
        className="px-2.5 py-1.5 bg-brand text-white rounded-lg text-xs font-semibold hover:opacity-90 shrink-0">
        {copied === k ? '✓' : 'Копировать'}
      </button>
    </div>
  )
  return (
    <div className="space-y-2">
      <Row label="Веб" url={webUrl} k="web" />
      {tgUrl && <Row label="Mini App" url={tgUrl} k="tg" />}
    </div>
  )
}

export default function ConferenceSpeakerPage() {
  const router = useRouter()
  const pathname = usePathname()
  const { id, speakerId } = useParams()
  const confId = Number(id)
  const speakerEventId = Number(speakerId)
  // Премия/турнир открыта под /dashboard/tournaments — «назад» и ссылки на
  // настройки должны вести туда же, а не в Конференции.
  const basePath = pathname?.startsWith('/dashboard/tournaments') ? '/dashboard/tournaments' : '/dashboard/conferences'
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
    knowledge_base_title: '',
    knowledge_base_url: '',
    show_topic_field: true,
    show_gift_after_speech_field: true,
    show_knowledge_base_field: false,
    show_notes_field: false,
    show_partner_registration_link: true,
    notes: '',
    is_commercial: false,
    bot_in_channel: false,
    priority: 60,
    exclude_gift_from_broadcast: false,
    exclude_channel_from_subscription: false,
    poster_id: null as number | null,
    announcement_poster_ids: [] as number[],
  })
  const [posterLibrary, setPosterLibrary] = useState<Array<{ id: number; url: string; label: string | null }>>([])
  const [uploadingPoster, setUploadingPoster] = useState(false)
  const [posterUploadError, setPosterUploadError] = useState<string | null>(null)
  const posterFileRef = useRef<HTMLInputElement | null>(null)
  const [posterLightbox, setPosterLightbox] = useState<string | null>(null)
  const [posterCopiedId, setPosterCopiedId] = useState<number | null>(null)
  const [showAccessCode, setShowAccessCode] = useState(false)
  const [inviteMsg, setInviteMsg] = useState<string | null>(null)
  const [inviteCopied, setInviteCopied] = useState(false)

  const [clientWorkAccount, setClientWorkAccount] = useState<{ username: string; id: string } | null>(null)
  const [mainBotHandle, setMainBotHandle] = useState<string>('')
  const [subscriptionMode, setSubscriptionMode] = useState<'none' | 'organizer' | 'all_speakers'>('none')
  const [eventSlug, setEventSlug] = useState<string | null>(null)
  const [eventStatus, setEventStatus] = useState<'draft' | 'published' | 'ended' | null>(null)
  const [refCode, setRefCode] = useState<string | null>(null)
  // Подарок из ПЛЮСОНа (лид-магнит/пакет), если спикер выбрал его в своём
  // кабинете. Показываем отдельной read-only плашкой — иначе выглядит будто
  // подарка нет, хотя он есть.
  const [giftPluson, setGiftPluson] = useState<{ name: string; url: string | null } | null>(null)
  // ПЛЮСОН-подарки спикера (magnet/package, до 4) — read-only на вкладке ПЛЮСОН.
  const [giftMagnets, setGiftMagnets] = useState<Array<{ name: string; url: string | null; kind: string }>>([])
  // Ручные подарки (kind='manual', до 4) — редактируемый список на вкладке
  // «Ввести вручную»: каждый = название + ссылка (миграция 219).
  const [manualGifts, setManualGifts] = useState<Array<{ title: string; url: string }>>([])
  // Вкладка блока подарка: 'manual' (ручной ввод — 1-я) / 'pluson' (просмотр).
  // ⚠️ В вебе клиент НЕ трогает ПЛЮСОН-подарки: их выбирает спикер в своём
  // кабинете. Вкладка ПЛЮСОН — только просмотр факта привязки. Переключение
  // вкладок ничего не удаляет и уведомлений не шлёт.
  const [giftTab, setGiftTab] = useState<'pluson' | 'manual'>('manual')
  // Привязан ли ПЛЮСОН-аккаунт у спикера (collaborators.linked_client_id).
  // Показ вкладки ПЛЮСОН завязан на ЭТО, а не на факт выбранных подарков: спикер
  // мог удалить у себя все подарки, но привязка остаётся — она снимается только
  // если он сам отвяжет ПЛЮСОН в кабинете.
  const [speakerLinked, setSpeakerLinked] = useState<{ id: number; email: string | null } | null>(null)
  // Этапы турнира + в каких участвует этот спикер/жюри (event_collaborator_stages)
  const [stages, setStages] = useState<Array<{ id: number; title: string }>>([])
  const [stageIds, setStageIds] = useState<number[]>([])

  const [loading, setLoading] = useState(true)
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingEvent, setSavingEvent] = useState(false)
  const [profileSaved, setProfileSaved] = useState(false)
  const [eventSaved, setEventSaved] = useState(false)
  const [verifyingChannel, setVerifyingChannel] = useState(false)
  const [channelVerifyMsg, setChannelVerifyMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [error, setError] = useState('')
  const [showWarning, setShowWarning] = useState(false)
  const [subTab, setSubTab] = useState<'talk' | 'profile' | 'links'>('talk')

  useEffect(() => {
    api.auth.me().then((c: any) => {
      if (c.work_tg_id) setClientWorkAccount({ username: c.work_tg_username || '', id: String(c.work_tg_id) })
      if (c.main_bot_handle) setMainBotHandle(String(c.main_bot_handle))
    }).catch(() => {})
    api.conference.get(confId).then((r: any) => {
      const m = r?.conference?.subscription_mode
      if (m === 'organizer' || m === 'all_speakers') setSubscriptionMode(m)
      else setSubscriptionMode('none')
      setEventSlug(r?.conference?.event_slug || null)
      setEventStatus((r?.conference?.event_status as any) || null)
    }).catch(() => {})
    // этапы турнира — для мультиселекта «в каких этапах участвует»
    api.conference.stages.list(confId).then((r: any) => {
      setStages((r.stages || []).map((s: any) => ({ id: s.id, title: s.title })))
    }).catch(() => {})
  }, [confId])

  useEffect(() => {
    api.conference.speakers.list(confId)
      .then(r => {
        const speakers = r.speakers || []
        const sp = speakers.find((s: any) => s.id === speakerEventId)
        if (!sp) { router.push(`${basePath}/${confId}?tab=speakers`); return }
        setRefCode(sp.ref_code || null)
        setStageIds(Array.isArray(sp.stage_ids) ? sp.stage_ids : [])

        // Подарок из ПЛЮСОНа: спикер привязал свой кабинет и выбрал лид-магнит/пакет.
        // Бэк для рассылок подставляет имя магнита в gift_after_speech_title —
        // но здесь это НЕ ручной ввод, поэтому показываем отдельной плашкой и НЕ
        // кладём в редактируемое поле (иначе при сохранении перезапишет привязку).
        const allGifts = Array.isArray(sp.gift_magnets) ? sp.gift_magnets : []
        // ПЛЮСОН-подарки (magnet/package) — read-only; ручные (manual) — редактируемые.
        const plusonG = allGifts.filter((g: any) => g.kind !== 'manual')
        const manualG = allGifts.filter((g: any) => g.kind === 'manual')
          .map((g: any) => ({ title: g.name || '', url: g.url || '' }))
        setGiftMagnets(plusonG.map((g: any) => ({ name: g.name, url: g.url || null, kind: g.kind })))
        // Legacy: старый ручной подарок в gift_after_speech_* (одним куском, как у
        // спикеров без структурированного списка) — показываем как ОДИН ручной
        // подарок, если структурированных ручных ещё нет.
        if (manualG.length === 0 && (sp.gift_after_speech_title || sp.gift_after_speech_url)
            && !sp.gift_lead_magnet_id && !sp.gift_package_id) {
          manualG.push({ title: sp.gift_after_speech_title || '', url: sp.gift_after_speech_url || '' })
        }
        setManualGifts(manualG)
        const hasPluson = plusonG.length > 0 || !!sp.gift_lead_magnet_id || !!sp.gift_package_id
        setGiftPluson(null)
        // Привязка ПЛЮСОН (независимо от того, выбрал ли спикер подарки).
        setSpeakerLinked(sp.linked_client_id
          ? { id: sp.linked_client_id, email: sp.linked_client_email || null } : null)
        // Вкладка по умолчанию: ПЛЮСОН — если ПЛЮСОН привязан ИЛИ подарок оттуда;
        // иначе ручной ввод.
        setGiftTab((sp.linked_client_id || hasPluson) ? 'pluson' : 'manual')

        const rawTopics = sp.topics && sp.topics.length > 0
          ? sp.topics.map((t: any) => typeof t === 'string' ? t : t.topic)
          : (sp.speaker_topic ? [sp.speaker_topic] : [''])

        setEventForm({
          role: sp.role || 'speaker',
          topics: rawTopics.length > 0 ? rawTopics : [''],
          // Ручной подарок теперь в manualGifts (список), эти поля не используются.
          gift_after_speech_title: '',
          gift_after_speech_url: '',
          gift_raffle_title: sp.gift_raffle_title || '',
          gift_raffle_url: sp.gift_raffle_url || '',
          knowledge_base_title: sp.knowledge_base_title || '',
          knowledge_base_url: sp.knowledge_base_url || '',
          show_topic_field: sp.show_topic_field !== false,
          show_gift_after_speech_field: sp.show_gift_after_speech_field !== false,
          show_knowledge_base_field: !!sp.show_knowledge_base_field,
          show_notes_field: !!sp.show_notes_field,
          show_partner_registration_link: sp.show_partner_registration_link !== false,
          notes: sp.notes || '',
          is_commercial: sp.is_commercial || false,
          bot_in_channel: sp.bot_in_channel || false,
          priority: sp.priority ?? 60,
          exclude_gift_from_broadcast: sp.exclude_gift_from_broadcast || false,
          exclude_channel_from_subscription: sp.exclude_channel_from_subscription || false,
          // Какая афиша из библиотеки коллаба используется в этой конференции
          // (миграция 121). NULL = первая из библиотеки.
          poster_id: sp.poster_id ?? null,
          // Афиши «для анонсов» в этой конференции (миграция 122).
          announcement_poster_ids: Array.isArray(sp.announcement_poster_ids) ? sp.announcement_poster_ids : [],
          // Привязка темы к слоту программы (какая тема реально идёт в рассылку).
          bound_topic_index: sp.bound_topic_index ?? null,
          slot_label: sp.slot_label ?? null,
          slot_has_topic: sp.slot_has_topic ?? null,
        })

        return api.collaborators.get(sp.speaker_id)
      })
      .then(r => {
        if (!r) return
        setProfile(r.collaborator)
        const ach = r.collaborator.achievements
        setAchievementsText(Array.isArray(ach) ? ach.join('\n') : (ach || ''))
        // Загружаем библиотеку афиш этого коллаба
        api.collaborators.posters.list(r.collaborator.id)
          .then((pr: any) => setPosterLibrary(pr.posters || []))
          .catch(() => setPosterLibrary([]))
      })
      .catch(() => router.push(`${basePath}/${confId}?tab=speakers`))
      .finally(() => setLoading(false))
  }, [confId, speakerEventId])

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault()
    // Соцсети — только полной ссылкой (https://…), не ником.
    const socialErr = validateSocialLinks([
      ['Telegram-канал', profile.tg_channel_url],
      ['ВКонтакте', profile.vk_url],
      ['MAX', profile.max_url],
      ['Нельзяграм', profile.instagram_url],
      ['Сайт', profile.website_url],
    ])
    if (socialErr) { setError(socialErr); return }
    setSavingProfile(true); setError(''); setProfileSaved(false)
    try {
      const achievements = achievementsText.split('\n').map(s => s.trim()).filter(Boolean)
      await api.collaborators.update(profile.id, {
        name: profile.name,
        title: profile.title,
        achievements,
        photo_url: profile.photo_url,
        photo_folder_url: profile.photo_folder_url,
        video_folder_url: profile.video_folder_url,
        tg_channel_url: profile.tg_channel_url,
        vk_url: profile.vk_url,
        max_url: profile.max_url,
        instagram_url: profile.instagram_url,
        website_url: profile.website_url,
        tg_channel_id: profile.tg_channel_id,
        personal_tg_id: profile.personal_tg_id,
        personal_tg_username: profile.personal_tg_username,
        personal_vk_id: profile.personal_vk_id,
        personal_vk_username: profile.personal_vk_username,
        personal_max_id: profile.personal_max_id,
        personal_max_username: profile.personal_max_username,
        assistant_tg_username: profile.assistant_tg_username,
        media_assets: Array.isArray(profile.media_assets) ? profile.media_assets : [],
        ask_topics: profile.ask_topics ?? null,
        show_ask_topics_field: !!profile.show_ask_topics_field,
      })
      setProfileSaved(true)
      setTimeout(() => setProfileSaved(false), 3000)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSavingProfile(false)
    }
  }

  async function uploadPosterToLibrary(files: FileList | null) {
    if (!files || files.length === 0 || !profile) return
    setPosterUploadError(null)
    setUploadingPoster(true)
    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
      const token = (typeof window !== 'undefined' && localStorage.getItem('plusson_token')) || ''
      const newPosterIds: number[] = []
      for (const f of Array.from(files)) {
        if (f.size > 50 * 1024 * 1024) throw new Error(`«${f.name}» больше 50 МБ`)
        const fd = new FormData()
        fd.append('file', f)
        fd.append('kind', 'speaker_poster')
        fd.append('collaborator_id', String(profile.id))
        const r = await fetch(`${API_URL}/api/v1/uploads`, {
          method: 'POST',
          body: fd,
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!r.ok) {
          const err = await r.json().catch(() => ({ detail: `HTTP ${r.status}` }))
          throw new Error(err.detail || `HTTP ${r.status}`)
        }
        const body = await r.json().catch(() => ({}))
        if (typeof body.poster_id === 'number') newPosterIds.push(body.poster_id)
      }
      // Перезагружаем библиотеку чтобы увидеть новые афиши.
      const pr: any = await api.collaborators.posters.list(profile.id)
      setPosterLibrary(pr.posters || [])
      // По умолчанию: только что загруженная индивидуальная афиша становится
      // и афишей для рассылок (radio), и попадает в «Афиши для анонсов»
      // (галочки) в этой конференции. Клиент может переснять выбор вручную.
      if (newPosterIds.length > 0) {
        const broadcastId = newPosterIds[newPosterIds.length - 1]
        setEventForm(f => {
          const announcement = Array.from(new Set([...f.announcement_poster_ids, ...newPosterIds]))
          api.conference.speakers.update(confId, speakerEventId, {
            poster_id: broadcastId,
            announcement_poster_ids: announcement,
          } as any).catch(() => {})
          return { ...f, poster_id: broadcastId, announcement_poster_ids: announcement }
        })
      }
    } catch (e: any) {
      setPosterUploadError(e.message || 'Ошибка загрузки')
    } finally {
      setUploadingPoster(false)
      if (posterFileRef.current) posterFileRef.current.value = ''
    }
  }

  function calcPriority(role: string, is_commercial: boolean): number {
    if (role === 'organizer') return 10
    if (role === 'jury') return 15
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

  // Переключение вкладки подарка. Если у спикера НАСТРОЕН подарок в ПЛЮСОН —
  // на «Ввести вручную» переключиться НЕЛЬЗЯ (убрать его может только спикер в
  // своём кабинете). Ничего не удаляем. Обратно (на ПЛЮСОН) — свободно.
  function switchGiftTab(target: 'manual' | 'pluson') {
    const hasPlusonGift = giftMagnets.length > 0 || !!giftPluson
    if (target === 'manual' && hasPlusonGift) {
      alert('У спикера настроен подарок из ПЛЮСОН. Ввести подарок вручную нельзя, пока он выбран.\n\nУбрать подарок из ПЛЮСОН может только сам спикер в своём кабинете.')
      return
    }
    setGiftTab(target)
  }

  async function saveEvent(e: React.FormEvent) {
    e.preventDefault()
    setSavingEvent(true); setError(''); setEventSaved(false)
    try {
      const topics = eventForm.topics.filter(t => t.trim())
      // Приоритет берём ИЗ ПОЛЯ (то, что клиент ввёл вручную), а не пересчитываем
      // по роли — иначе ручное значение затиралось. Пусто → дефолт по роли.
      const priority = ((eventForm as any).priority ?? null) !== null
        ? Number((eventForm as any).priority)
        : calcPriority(eventForm.role, eventForm.is_commercial)
      // ⚠️ ПЛЮСОН-подарки спикера из ВЕБА не трогаем НИКОГДА (их настраивает
      // спикер в кабинете). Ручные подарки (список до 4) шлём как gift_lead_magnets
      // с kind='manual' — ТОЛЬКО когда активна вкладка «Ввести вручную» (иначе не
      // трогаем подарки вовсе). У каждого ручного обязательны И название, И ссылка.
      const cleanManual = manualGifts
        .map(g => ({ title: g.title.trim(), url: g.url.trim() }))
        .filter(g => g.title && g.url)
      if (giftTab === 'manual') {
        const partial = manualGifts.some(g => (g.title.trim() && !g.url.trim()) || (!g.title.trim() && g.url.trim()))
        if (partial) {
          setError('У каждого подарка нужны и название, и ссылка. Заполните оба поля или удалите пустой подарок.')
          setSavingEvent(false); return
        }
      }
      const payload: any = {
        role: eventForm.role,
        topics,
        stage_ids: stageIds,
        // Ручные подарки пишем только с вкладки «Вручную» (на вкладке ПЛЮСОН —
        // просмотр, туда не лезем).
        ...(giftTab === 'manual' ? {
          gift_lead_magnets: cleanManual.map(g => ({ kind: 'manual', title: g.title, url: g.url })),
        } : {}),
        gift_raffle_title: eventForm.gift_raffle_title,
        gift_raffle_url: eventForm.gift_raffle_url,
        knowledge_base_title: eventForm.knowledge_base_title,
        knowledge_base_url: eventForm.knowledge_base_url,
        show_topic_field: eventForm.show_topic_field,
        show_gift_after_speech_field: eventForm.show_gift_after_speech_field,
        show_knowledge_base_field: eventForm.show_knowledge_base_field,
        show_notes_field: eventForm.show_notes_field,
        show_partner_registration_link: eventForm.show_partner_registration_link,
        notes: eventForm.notes,
        is_commercial: eventForm.is_commercial,
        bot_in_channel: eventForm.bot_in_channel,
        priority,
        exclude_gift_from_broadcast: eventForm.exclude_gift_from_broadcast,
        exclude_channel_from_subscription: eventForm.exclude_channel_from_subscription,
        poster_id: eventForm.poster_id,
        announcement_poster_ids: eventForm.announcement_poster_ids,
      }
      try {
        await api.conference.speakers.update(confId, speakerEventId, payload)
      } catch (err: any) {
        // Снятие этапа с уже проставленными оценками — спрашиваем подтверждение.
        if (err?.detail?.code === 'stage_has_scores') {
          const n = err.detail.scores || 0
          if (confirm(`На снимаемом этапе уже есть оценки (${n}). Если убрать участие — ВСЕ эти оценки, назначения и обратная связь удалятся безвозвратно. Удалить?`)) {
            await api.conference.speakers.update(confId, speakerEventId, { ...payload, force_remove_stage_data: true })
          } else {
            setSavingEvent(false)
            return  // отменили — не сохраняем
          }
        } else {
          throw err
        }
      }
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
        <Link href={`${basePath}/${confId}?tab=speakers`}
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

      {/* Быстрый переход в карточку контакта в общей базе */}
      {profile.contact_id && (
        <div className="mb-4">
          <Link
            href={`/dashboard/clients?contact=${profile.contact_id}`}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-800 hover:bg-blue-100 transition-colors"
          >
            <UserIcon size={14} className="text-blue-600" />
            <span>Открыть карточку контакта</span>
            <ExternalLink size={12} />
          </Link>
        </div>
      )}

      {/* Подвкладки: Выступление / Профиль / Ссылки */}
      <div className="border-b border-gray-200 mb-6 flex gap-1">
        {([['talk', 'Выступление'], ['profile', 'Профиль'], ['links', 'Ссылки']] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setSubTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              subTab === k
                ? 'border-[#FFCFA4] text-[#25455D]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── ВКЛАДКА «ССЫЛКИ» ── */}
      {subTab === 'links' && (
      <div className="space-y-6 mb-8">
        {/* Партнёрская ссылка спикера на это событие */}
        <RefLinkInline slug={eventSlug} refCode={refCode} eventStatus={eventStatus} />

        {/* Прямая ссылка на карточку спикера (открывает вкладку «Спикеры» и скроллит к нему) */}
        {eventSlug && (
          <div className="bg-white border border-gray-200 rounded-2xl p-4">
            <div className="font-semibold text-gray-900 text-sm mb-1">Ссылка на карточку этого спикера</div>
            <div className="text-xs text-gray-600 mb-3">Откроет страницу события сразу на карточке спикера. Работает в вебе и в Mini App.</div>
            <SpeakerCardLink slug={eventSlug} ecId={speakerEventId} botHandle={mainBotHandle} />
          </div>
        )}

        {/* Код доступа для самообслуживания спикера + готовое сообщение */}
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <div className="font-semibold text-gray-900 text-sm">Код доступа для самозаполнения спикера</div>
              <div className="text-xs text-gray-600 mt-0.5">Спикер откроет страницу <code className="bg-white px-1 rounded">pluson.ru/speaker/{eventSlug || '…'}</code>, выберет фамилию и введёт код. Можно передать ассистенту.</div>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <input type={showAccessCode ? 'text' : 'password'}
              value={profile.access_code || ''}
              readOnly
              className="flex-1 font-mono tracking-wider text-sm bg-white px-3 py-2 rounded-lg border border-gray-200" />
            <button type="button" onClick={() => setShowAccessCode(v => !v)}
              className="px-3 py-2 bg-white border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-gray-50">
              {showAccessCode ? 'Скрыть' : 'Показать'}
            </button>
            <button type="button"
              onClick={async () => {
                try {
                  const r = await api.collaborators.inviteMessage(profile.id, confId)
                  setInviteMsg(r.message)
                  await navigator.clipboard.writeText(r.message)
                  setInviteCopied(true)
                  setTimeout(() => setInviteCopied(false), 3000)
                } catch (e: any) {
                  setError(e.message || 'Не удалось получить сообщение')
                }
              }}
              className="px-3 py-2 bg-brand text-white rounded-lg text-xs font-semibold hover:opacity-90">
              {inviteCopied ? '✓ Скопировано' : '📋 Скопировать сообщение спикеру'}
            </button>
          </div>
          {inviteMsg && (
            <details className="mt-3">
              <summary className="text-xs text-gray-600 cursor-pointer">Посмотреть что скопировалось</summary>
              <pre className="mt-2 p-3 bg-white rounded-lg text-xs text-gray-700 whitespace-pre-wrap border border-gray-100">{inviteMsg}</pre>
            </details>
          )}
        </div>
      </div>
      )}

      {/* ── ВКЛАДКА «ВЫСТУПЛЕНИЕ» ── */}
      {subTab === 'talk' && (
      <form onSubmit={saveEvent} className="space-y-4 mb-8">
        <h2 className="font-bold text-gray-900 text-lg">Выступление в этой конференции</h2>

        {/* Роль + коммерческое */}
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

        {/* В каких этапах участвует — только при наличии этапов (турнир) */}
        {stages.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-3">
            <h3 className="font-semibold text-gray-900 text-sm">В каких этапах участвует</h3>
            <p className="text-xs text-gray-500 -mt-1">
              Отметьте этапы. Влияет на распределение жюри, турнирную таблицу и кабинет спикера —
              человек виден только в выбранных этапах. Ничего не отмечено — не участвует ни в одном.
            </p>
            <div className="space-y-2">
              {stages.map(st => {
                const checked = stageIds.includes(st.id)
                return (
                  <label key={st.id} className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
                    <input type="checkbox" checked={checked}
                      onChange={e => setStageIds(prev => e.target.checked ? [...prev, st.id] : prev.filter(x => x !== st.id))}
                      className="w-4 h-4 rounded border-gray-300 text-brand" />
                    <span>{st.title}</span>
                  </label>
                )
              })}
            </div>
          </div>
        )}

        {/* Что спикер видит в своей форме — сразу после галочки «Коммерческое» */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-3">
          <h3 className="font-semibold text-gray-900 text-sm">Что спикер видит в своей форме</h3>
          <p className="text-xs text-gray-500 -mt-1">Тогглы управляют тем, какие поля показываются спикеру на странице <code className="bg-gray-50 px-1 rounded">pluson.ru/speaker/{eventSlug || '…'}</code>.</p>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
            <input type="checkbox" checked={eventForm.show_topic_field}
              onChange={e => setEventForm(f => ({ ...f, show_topic_field: e.target.checked }))}
              className="w-4 h-4 rounded border-gray-300 text-brand" />
            <span>Темы выступления — спикер может заполнить сам</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
            <input type="checkbox" checked={eventForm.show_gift_after_speech_field}
              onChange={e => setEventForm(f => ({ ...f, show_gift_after_speech_field: e.target.checked }))}
              className="w-4 h-4 rounded border-gray-300 text-brand" />
            <span>Подарок после эфира — спикер может заполнить сам</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
            <input type="checkbox" checked={eventForm.show_knowledge_base_field}
              onChange={e => setEventForm(f => ({ ...f, show_knowledge_base_field: e.target.checked }))}
              className="w-4 h-4 rounded border-gray-300 text-brand" />
            <span>Материал в базу знаний — спикер может заполнить сам</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
            <input type="checkbox" checked={eventForm.show_notes_field}
              onChange={e => setEventForm(f => ({ ...f, show_notes_field: e.target.checked }))}
              className="w-4 h-4 rounded border-gray-300 text-brand" />
            <span>Заметки — спикер может заполнить сам</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
            <input type="checkbox" checked={eventForm.show_partner_registration_link}
              onChange={e => setEventForm(f => ({ ...f, show_partner_registration_link: e.target.checked }))}
              className="w-4 h-4 rounded border-gray-300 text-brand" />
            <span>Ссылка на регистрацию партнёром — спикеру предлагается зарегистрироваться партнёром клиента</span>
          </label>
          <p className="text-xs text-gray-500 pt-1">Подарок для розыгрыша показывается автоматически, если для события включён модуль розыгрыша.</p>
        </div>

        {/* Темы выступления — перед подарками */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <FieldLabel label="Темы выступления" empty={!eventForm.topics.some(t => t.trim())} />
          <TopicsEditor topics={eventForm.topics} onChange={topics => setEventForm(f => ({ ...f, topics }))}
            boundIndex={(eventForm as any).bound_topic_index}
            slotLabel={(eventForm as any).slot_label}
            slotHasTopic={(eventForm as any).slot_has_topic} />
          <p className="text-xs text-gray-400 pt-2">
            Если у спикера несколько тем, в программу и рассылки идёт та, что привязана к его слоту (отмечена зелёным). Спикер выбирает слот сам в своём кабинете; тема слота обновляется автоматически.
          </p>
        </div>

        {/* Подарок после эфира — 2 вкладки.
            1-я «Ввести вручную» (веб): организатор задаёт подарок руками.
            2-я «Из ПЛЮСОН»: ТОЛЬКО ПРОСМОТР состава, что выбрал спикер у себя в
            кабинете. Организатор здесь ничего не меняет и не удаляет — переключение
            вкладок безопасно (ничего не трёт, уведомлений не шлёт).
            Вкладка ПЛЮСОН показывается, если у спикера привязан ПЛЮСОН-аккаунт
            (speakerLinked) — даже если он пока не выбрал ни одного подарка. */}
        {(() => {
          const pluslonItems = giftMagnets.length > 0
            ? giftMagnets
            : (giftPluson ? [{ name: giftPluson.name, url: giftPluson.url, kind: 'magnet' }] : [])
          return (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">Подарок после эфира</h3>

          <div className="flex gap-2">
            {([
              { v: 'manual', t: '✍️ Ввести вручную' },
              { v: 'pluson', t: '🎁 Из ПЛЮСОН' },
            ] as const).map(opt => {
              const active = giftTab === opt.v
              return (
                <button key={opt.v} type="button"
                  onClick={() => switchGiftTab(opt.v)}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border transition-colors ${
                    active ? 'border-[#25455D] border-2 bg-[#EAF2FB] text-[#25455D]'
                           : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'}`}>
                  {opt.t}
                </button>
              )
            })}
          </div>

          {giftTab === 'manual' ? (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">
                До 4 подарков. У каждого — название и ссылка (они уйдут в рассылку парой: название, под ним ссылка).
              </p>
              {manualGifts.map((g, i) => (
                <div key={i} className="rounded-xl border border-gray-200 p-3 space-y-2 relative">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-500">Подарок {i + 1}</span>
                    <button type="button" title="Удалить подарок"
                      onClick={() => setManualGifts(list => list.filter((_, k) => k !== i))}
                      className="text-gray-300 hover:text-red-500"><Trash2 size={14} /></button>
                  </div>
                  <input value={g.title}
                    onChange={e => setManualGifts(list => list.map((x, k) => k === i ? { ...x, title: e.target.value } : x))}
                    placeholder="Название — например: Чек-лист по нутрициологии"
                    className="input text-sm" />
                  <textarea value={g.url} rows={2}
                    onChange={e => setManualGifts(list => list.map((x, k) => k === i ? { ...x, url: e.target.value } : x))}
                    placeholder={"Ссылка — https://...\nможно с переносами: ссылка + инструкция как забрать"}
                    className="input text-sm resize-y" />
                </div>
              ))}
              {manualGifts.length < 4 && (
                <button type="button"
                  onClick={() => setManualGifts(list => [...list, { title: '', url: '' }])}
                  className="text-sm font-medium text-[#25455D] hover:opacity-80 flex items-center gap-1.5">
                  <Plus size={15} /> Добавить подарок
                </button>
              )}
              {manualGifts.length === 0 && (
                <p className="text-xs text-gray-400">Пока подарков нет. Нажмите «Добавить подарок».</p>
              )}
            </div>
          ) : (
            /* Вкладка ПЛЮСОН — ТОЛЬКО ПРОСМОТР. */
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm space-y-2">
              {speakerLinked && (
                <div className="text-xs text-emerald-700">
                  ✓ Подключён ПЛЮСОН{speakerLinked.email ? `: ${speakerLinked.email}` : ''}
                </div>
              )}
              {pluslonItems.length > 0 ? (
                <ol className="space-y-2 list-decimal list-inside">
                  {pluslonItems.map((g, i) => (
                    <li key={i} className="text-emerald-900">
                      <span className="font-medium">{g.kind === 'package' ? '📦 ' : ''}{g.name}</span>
                      {g.url && (
                        <div><a href={g.url} target="_blank" rel="noreferrer"
                          className="text-emerald-700 underline break-all text-xs">{g.url}</a></div>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="text-emerald-800 text-xs">
                  Спикер пока не выбрал ни одного подарка-лид-магнита.
                </div>
              )}
              <div className="text-emerald-700 text-xs pt-1 border-t border-emerald-200">
                Привязывать подарки из ПЛЮСОН спикер может только в своём кабинете спикера.
              </div>
            </div>
          )}
        </div>
          )
        })()}

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

        {/* Материал в базу знаний */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">Материал в базу знаний</h3>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Название материала</label>
            <textarea value={eventForm.knowledge_base_title} onChange={setEF('knowledge_base_title')}
              rows={2} placeholder="Например: Презентация выступления / Чек-лист"
              className="input resize-y text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Ссылка</label>
            <textarea value={eventForm.knowledge_base_url} onChange={setEF('knowledge_base_url')}
              rows={2} placeholder="https://..."
              className="input resize-y text-sm" />
          </div>
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
      )}

      {/* ── ВКЛАДКА «ПРОФИЛЬ» ── */}
      {subTab === 'profile' && (
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

        {/* С какими вопросами можно обращаться (глобально на коллабе) */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-3">
          <h3 className="font-semibold text-gray-900 text-sm">С какими вопросами можно обращаться?</h3>
          <p className="text-xs text-gray-500">
            Список тем/вопросов эксперта. Подставляется в рассылку «Экспертный день» (плейсхолдер {'{speaker_ask_topics}'}). Если пусто — блок в рассылке не показывается.
          </p>
          <textarea
            value={profile.ask_topics || ''}
            onChange={e => setProfile((p: any) => ({ ...p, ask_topics: e.target.value }))}
            rows={5}
            placeholder={'Как выступать бесплатно с лидерами рынка?\nКак запоминаться аудитории?\nКак регулярно выступать?'}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand resize-y" />
          <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
            <input type="checkbox" checked={!!profile.show_ask_topics_field}
              onChange={e => setProfile((p: any) => ({ ...p, show_ask_topics_field: e.target.checked }))}
              className="w-4 h-4 rounded border-gray-300 text-brand" />
            <span>Показывать в кабинете спикера — спикер может заполнить сам</span>
          </label>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">{t.fields.media}</h3>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Фото для сайта</label>
            <FileUploader
              mode="single"
              kind="speaker_photo"
              collaboratorId={profile.id}
              value={profile.photo_url || null}
              onChange={u => setProfile((p: any) => ({ ...p, photo_url: u || '' }))}
              accept="image/*"
              aspectClass="aspect-square"
              emptyText="Перетащите сюда фото"
              buttonLabel="Загрузить"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5 gap-3">
              <label className="block text-sm font-medium text-gray-700">Индивидуальные афиши</label>
              <button
                type="button"
                onClick={() => posterFileRef.current?.click()}
                disabled={uploadingPoster}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-xs font-medium text-gray-700 disabled:opacity-50"
              >
                {uploadingPoster ? '⏳ Загрузка…' : '+ Добавить афишу'}
              </button>
              <input
                ref={posterFileRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={e => uploadPosterToLibrary(e.target.files)}
              />
            </div>
            <p className="text-xs text-gray-400 mb-3">
              Все афиши коллаба. Под каждой — две настройки <b>для этой конференции</b>:
              <br />
              • <b>Для рассылок по чат-боту</b> (радио, одна) — пойдёт в рассылки бота.
              По умолчанию первая из библиотеки.
              <br />
              • <b>Для анонсов</b> (чек-боксы, любое число) — отмеченные увидит спикер в
              своём кабинете и скачает для своих каналов.
              <br />
              Загруженные здесь афиши попадают в общую библиотеку коллаба — её можно
              посмотреть и на{' '}
              <Link href={`/dashboard/collaborations/${profile.id}`} className="text-brand hover:underline">
                странице коллаба
              </Link>.
            </p>
            {posterUploadError && (
              <div className="text-xs text-red-600 mb-2">{posterUploadError}</div>
            )}
            {posterLibrary.length === 0 ? (
              <div className="text-center py-6 text-sm text-gray-400 rounded-xl border border-dashed border-gray-200">
                Афиш ещё нет. Нажмите «+ Добавить афишу», чтобы загрузить.
              </div>
            ) : (
              <div className="space-y-3">
                {posterLibrary.map((p, idx) => {
                  // Если poster_id явно не выбран — первая афиша подсвечена
                  // как «Для рассылок» (fallback совпадает с показанным выбором).
                  const isBroadcast = eventForm.poster_id === p.id
                    || (eventForm.poster_id == null && idx === 0)
                  const isAnnouncement = eventForm.announcement_poster_ids.includes(p.id)
                  return (
                    <div
                      key={p.id}
                      className="flex items-stretch gap-3 p-3 rounded-xl border border-gray-200 bg-white"
                    >
                      <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-lg overflow-hidden bg-gray-100 border border-gray-100 shrink-0">
                        <img
                          src={p.url}
                          alt={p.label || ''}
                          onClick={() => setPosterLightbox(p.url)}
                          className="w-full h-full object-cover cursor-zoom-in"
                        />
                      </div>
                      <div className="flex-1 flex flex-col justify-between min-w-0">
                        <div className="text-xs text-gray-600 truncate">
                          {p.label || <span className="text-gray-400 italic">без подписи</span>}
                        </div>
                        {/* Действия с афишей: раскрыть, скачать, скопировать ссылку */}
                        <div className="flex flex-wrap gap-1.5 my-1.5">
                          <button
                            type="button"
                            onClick={() => setPosterLightbox(p.url)}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-[11px] font-medium text-gray-700"
                            title="Раскрыть"
                          >
                            <Maximize2 size={11} /> Раскрыть
                          </button>
                          <a
                            href={p.url}
                            download
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1 px-2 py-1 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-[11px] font-medium text-gray-700"
                            title="Скачать"
                          >
                            <Download size={11} /> Скачать
                          </a>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(p.url)
                              setPosterCopiedId(p.id)
                              setTimeout(() => setPosterCopiedId(null), 2000)
                            }}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-[11px] font-medium text-gray-700"
                            title={p.url}
                          >
                            {posterCopiedId === p.id
                              ? <><Check size={11} className="text-green-600" /> Скопировано</>
                              : <><Copy size={11} /> Ссылка</>}
                          </button>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                            <input
                              type="radio"
                              name="broadcast_poster"
                              checked={isBroadcast}
                              // Автосейв: меняется радио — сразу PATCH cse.
                              // Кнопка «Сохранить выступление» внизу формы не
                              // обязательна для выбора афиш — клиент часто думал,
                              // что верхняя «Сохранить профиль» сохраняет всё.
                              onChange={() => {
                                setEventForm(f => ({ ...f, poster_id: p.id }))
                                api.conference.speakers.update(confId, speakerEventId, { poster_id: p.id } as any).catch(() => {})
                              }}
                              className="accent-brand"
                            />
                            Для рассылок по чат-боту
                          </label>
                          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={isAnnouncement}
                              onChange={e => {
                                const nextIds = e.target.checked
                                  ? [...eventForm.announcement_poster_ids, p.id]
                                  : eventForm.announcement_poster_ids.filter(x => x !== p.id)
                                setEventForm(f => ({ ...f, announcement_poster_ids: nextIds }))
                                api.conference.speakers.update(confId, speakerEventId, { announcement_poster_ids: nextIds } as any).catch(() => {})
                              }}
                              className="accent-brand"
                            />
                            Для анонсов
                          </label>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
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
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Ссылка на VK-сообщество</label>
            <input type="url" value={profile.vk_url || ''} onChange={setP('vk_url')}
              placeholder="https://vk.com/..."
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Ссылка на MAX-канал</label>
            <input type="url" value={profile.max_url || ''} onChange={setP('max_url')}
              placeholder="https://max.ru/..."
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">Медийные активы</h3>
          <MediaAssetsField
            value={Array.isArray(profile.media_assets) ? profile.media_assets as MediaAsset[] : []}
            onChange={next => setProfile((p: any) => ({ ...p, media_assets: next }))}
          />
        </div>

        {/* Личные аккаунты VK и MAX */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">Личный аккаунт VK / MAX</h3>
          <p className="text-xs text-gray-500 -mt-2">Используется для отправки ссылок и контакта со спикером. Не показывается участникам.</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">VK username</label>
              <input type="text" value={profile.personal_vk_username || ''} onChange={setP('personal_vk_username')}
                placeholder="id123456 или nickname"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">VK ID</label>
              <input type="text" value={profile.personal_vk_id || ''} onChange={setP('personal_vk_id')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">MAX username</label>
              <input type="text" value={profile.personal_max_username || ''} onChange={setP('personal_max_username')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">MAX ID</label>
              <input type="text" value={profile.personal_max_id || ''} onChange={setP('personal_max_id')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h3 className="font-semibold text-gray-900 text-sm">{t.fields.accounts}</h3>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.telegram}</label>
            <input type="url" value={profile.tg_channel_url || ''} onChange={setP('tg_channel_url')}
              placeholder="https://telegram.me/username"
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
                      ? <>В <a href={`${basePath}/${confId}?tab=settings`} className="underline">настройках конференции</a> выбран режим «Не требовать подписку».</>
                      : <>В <a href={`${basePath}/${confId}?tab=settings`} className="underline">настройках конференции</a> выбран режим «Только каналы организаторов», поэтому канал этого спикера не участвует в проверке.</>
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
      )}

      {/* Статистика кликов по карточке спикера в Mini App (миграция 109) */}
      <SpeakerClickStats confId={confId} speakerEventId={speakerEventId} />

      {/* Lightbox — раскрытие индивидуальной афиши на весь экран */}
      {posterLightbox && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/85"
          onClick={() => setPosterLightbox(null)}
        >
          <div className="relative max-w-5xl max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <img src={posterLightbox} alt="" className="max-w-full max-h-[90vh] rounded-xl shadow-2xl object-contain" />
            <div className="absolute top-2 right-2 flex gap-2">
              <a
                href={posterLightbox}
                download
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 bg-white/90 text-gray-800 rounded-lg px-3 py-1.5 text-sm font-medium hover:bg-white transition-colors"
              >
                <Download size={14} /> Скачать
              </a>
              <button
                onClick={() => setPosterLightbox(null)}
                className="bg-black/50 text-white rounded-full p-1.5 hover:bg-black/80 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


const CLICK_KIND_LABELS: Record<string, string> = {
  tg_channel:     'TG-канал',
  vk:             'ВКонтакте',
  max:            'MAX',
  instagram:      'Нельзяграм',
  website:        'Сайт',
  knowledge_base: 'Материал в базу знаний',
}

function SpeakerClickStats({ confId, speakerEventId }: { confId: number; speakerEventId: number }) {
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    setLoading(true)
    api.conference.speakers.clickStats(confId, speakerEventId)
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setLoading(false))
  }, [confId, speakerEventId])
  if (loading) return null
  if (!stats || (stats.total ?? 0) === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mt-8 text-sm text-gray-500">
        <h2 className="font-bold text-gray-900 text-lg mb-2">Статистика интереса</h2>
        Пока никто не нажимал на ссылки в карточке этого спикера в Mini App.
      </div>
    )
  }
  const items = Object.entries(stats.by_kind || {})
    .map(([k, v]) => ({ kind: k, label: CLICK_KIND_LABELS[k] || k, count: v as number }))
    .sort((a, b) => b.count - a.count)
  return (
    <div className="mt-8 space-y-4">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <h2 className="font-bold text-gray-900 text-lg mb-3">Статистика интереса</h2>
        <p className="text-xs text-gray-500 mb-4">Сколько участников нажали на ссылки в карточке этого спикера в Mini App.</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {items.map(it => (
            <div key={it.kind} className="bg-gray-50 rounded-xl p-3">
              <div className="text-xs text-gray-500 uppercase tracking-wide">{it.label}</div>
              <div className="text-2xl font-bold text-gray-900 mt-1">{it.count}</div>
            </div>
          ))}
        </div>
      </div>
      {stats.recent && stats.recent.length > 0 && (
        <details className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <summary className="font-semibold text-gray-900 text-sm cursor-pointer">
            Последние клики ({stats.recent.length}) — подробно
          </summary>
          <div className="mt-3 space-y-2">
            {stats.recent.map((r: any, i: number) => {
              // Идентификаторы платформ — actual (если контакт жив) ИЛИ snapshot (миграция 110).
              // Бэк уже отдаёт эффективные tg_id/vk_id/max_id/tg_nickname/name.
              const ids: string[] = []
              if (r.tg_id) ids.push(`TG ${r.tg_id}${r.tg_nickname ? ` (@${r.tg_nickname})` : ''}`)
              if (r.vk_id) ids.push(`VK ${r.vk_id}`)
              if (r.max_id) ids.push(`MAX ${r.max_id}`)
              return (
                <div key={i} className="flex justify-between gap-3 text-xs text-gray-700 border-b border-gray-100 pb-2 last:border-0">
                  <span className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {r.id && r.name ? (
                        <Link
                          href={`/dashboard/clients?contact=${r.id}`}
                          className="font-medium text-blue-700 hover:underline"
                        >
                          {r.name}
                        </Link>
                      ) : r.name ? (
                        <span className="font-medium" title="Контакт удалён — данные из снапшота клика">{r.name}</span>
                      ) : (
                        <span className="text-gray-400 italic">аноним</span>
                      )}
                      {r.email && <span className="text-gray-500"> · {r.email}</span>}
                    </div>
                    {(ids.length > 0 || r.phone) && (
                      <div className="text-[11px] text-gray-500 font-mono mt-0.5">
                        {ids.join(' · ')}
                        {r.phone && (ids.length > 0 ? ' · ' : '') + r.phone}
                      </div>
                    )}
                  </span>
                  <span className="text-gray-500 whitespace-nowrap">{CLICK_KIND_LABELS[r.click_kind] || r.click_kind}</span>
                  <span className="text-gray-400 whitespace-nowrap">{new Date(r.clicked_at).toLocaleString('ru-RU')}</span>
                </div>
              )
            })}
          </div>
        </details>
      )}
    </div>
  )
}
