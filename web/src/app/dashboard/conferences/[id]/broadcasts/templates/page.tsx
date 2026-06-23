'use client'
import { useState, useEffect, useRef } from 'react'
import { useParams } from 'next/navigation'
import { Edit2, Eye, X, ChevronDown, ChevronUp, Send, CheckCircle, XCircle, Loader2, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import BroadcastChannelPicker from '@/components/BroadcastChannelPicker'
import BroadcastMediaPicker from '@/components/BroadcastMediaPicker'

type TypeDef = {
  type: string
  title: string
  hint: string
  variables: string[]
  hasSpeaker?: boolean
  showPhoto?: boolean
}

// {vip_url} — ссылка на оплату VIP-тарифа — доступна во ВСЕХ шаблонах,
// поэтому добавляется в variables каждого типа автоматически (см. ниже).
const TYPE_DEFS_RAW: TypeDef[] = [
  {
    type: 'pre_conf',
    title: 'Анонс знакомства со спикерами',
    hint: 'Отправляется за день до старта. Рассказывает о конференции и призывает зарегистрироваться. Фото — горизонтальная афиша.',
    variables: ['{conf_title}', '{conf_date}', '{conf_description}', '{landing_url}'],
    showPhoto: true,
  },
  {
    type: 'speaker_intro',
    title: 'Знакомство со спикером',
    hint: 'Рассылается участникам для представления спикера. Фото — афиша спикера. Текст генерируется автоматически из данных спикера.',
    variables: ['{speaker_name}', '{speaker_role}', '{speaker_tg}', '{speaker_instagram}', '{speaker_topic}', '{speaker_achievements}', '{gift_after_speech_title}', '{gift_raffle_title}', '{landing_url}'],
    hasSpeaker: true,
    showPhoto: true,
  },
  {
    type: '5min_before',
    title: 'За 5 минут до выступления спикера',
    hint: 'Только для конференции. Отправляется за 5 минут до начала выступления каждого спикера (per-session). Фото — афиша спикера.',
    variables: ['{speaker_name}', '{speaker_topic}', '{stream_url}'],
    hasSpeaker: true,
    showPhoto: true,
  },
  {
    type: 'event_live',
    title: 'За 5 минут до старта мероприятия',
    hint: 'Только для мероприятия. Отправляется за 5 минут до старта эфира мероприятия. Фото — афиша события.',
    variables: ['{conf_title}', '{stream_url}'],
    showPhoto: true,
  },
  {
    type: '30min_before',
    title: 'За 30 минут до старта',
    hint: 'Общий шаблон: за 30 минут до старта дня конференции или до старта мероприятия. Кнопка → ссылка на эфир.',
    variables: ['{conf_title}', '{stream_url}', '{day_date}'],
    showPhoto: true,
  },
  {
    type: 'gift',
    title: 'Подарок спикера',
    hint: 'Отправляется за 10 минут до конца выступления. Без фото.',
    variables: ['{speaker_name}', '{gift_title}', '{gift_url}'],
    hasSpeaker: true,
    showPhoto: false,
  },
  {
    type: '2h_before_unreg',
    title: 'За 2 часа (не зарегистрирован)',
    hint: 'Для тех, кто ещё не зарегистрирован. Кнопка и ссылка — на лендинг регистрации. Фото — горизонтальная афиша.',
    variables: ['{conf_title}', '{day_number}', '{day_date}', '{day_program}', '{landing_url}'],
    showPhoto: true,
  },
  {
    type: '2h_before_reg',
    title: 'За 2 часа (зарегистрирован)',
    hint: 'Для уже зарегистрированных. Эфира ещё нет — лучше предложить позвать друзей через свой партнёрский кабинет ({game_link}).',
    variables: ['{conf_title}', '{day_number}', '{day_date}', '{day_program}', '{game_link}', '{stream_url}'],
    showPhoto: true,
  },
  {
    type: 'day_before_09_12_unreg',
    title: 'За сутки в 09:12 МСК (не зарегистрирован)',
    hint: 'Только для мероприятий. За сутки до events.start_at в 09:12 МСК. Кнопка → ссылка на лендинг регистрации.',
    variables: ['{conf_title}', '{landing_url}'],
    showPhoto: true,
  },
  {
    type: 'day_before_09_12_reg',
    title: 'За сутки в 09:12 МСК (зарегистрирован)',
    hint: 'Только для мероприятий. За сутки до events.start_at в 09:12 МСК. Кнопка → партнёрский кабинет ({game_link}).',
    variables: ['{conf_title}', '{game_link}'],
    showPhoto: true,
  },
  {
    type: 'day_live',
    title: 'День конференции — старт эфира',
    hint: 'Отправляется за 5 минут до старта дня конференции.',
    variables: ['{conf_title}', '{day_number}', '{stream_url}'],
    showPhoto: true,
  },
  {
    type: 'day_end',
    title: 'День конференции — итоги дня',
    hint: 'Отправляется по окончании дня. Автоматически вставляет список подарков всех спикеров этого дня.',
    variables: ['{conf_title}', '{day_ordinal}', '{next_day_mention}', '{raffle_url}', '{day_speakers_gifts}'],
    showPhoto: true,
  },
  {
    type: 'vip_offer',
    title: 'Продажа VIP-тарифа',
    hint: 'Произвольная рассылка (например, продажа VIP-тарифа после итогов дня). Время отправки задаётся вручную в очереди. По умолчанию уходит по всей базе клиента.',
    variables: ['{first_name}'],
    showPhoto: true,
  },
]

// {vip_url} доступен во всех типах — добавляем его в variables каждого шаблона,
// если ещё нет (чтобы кнопка-вставка плейсхолдера была в любом редакторе).
const TYPE_DEFS: TypeDef[] = TYPE_DEFS_RAW.map(d => ({
  ...d,
  variables: d.variables.includes('{vip_url}') ? d.variables : [...d.variables, '{vip_url}'],
}))

const ALL_VARIABLES: { name: string; desc: string }[] = [
  { name: '{speaker_name}', desc: 'Имя спикера' },
  { name: '{speaker_tg}', desc: 'Telegram-канал спикера' },
  { name: '{speaker_topic}', desc: 'Тема выступления' },
  { name: '{speaker_achievements}', desc: 'Регалии спикера (строки через · )' },
  { name: '{gift_after_speech_title}', desc: 'Подарок на эфире' },
  { name: '{gift_raffle_title}', desc: 'Подарок для розыгрыша' },
  { name: '{gift_title}', desc: 'Название подарка (из поля «Подарок» сессии)' },
  { name: '{gift_url}', desc: 'Ссылка на подарок' },
  { name: '{stream_url}', desc: 'Ссылка на эфир (вебинарная комната дня)' },
  { name: '{landing_url}', desc: 'Ссылка на лендинг регистрации' },
  { name: '{conf_title}', desc: 'Название конференции' },
  { name: '{day_number}', desc: 'Номер дня (1, 2, 3…)' },
  { name: '{day_ordinal}', desc: 'Номер дня словом (первом, втором…)' },
  { name: '{day_date}', desc: 'Дата дня конференции' },
  { name: '{day_program}', desc: 'Программа дня (список спикеров и тем)' },
  { name: '{next_day_mention}', desc: 'Фраза про следующую встречу (авто: завтра/дата, пусто если последний день)' },
  { name: '{raffle_url}', desc: 'Ссылка на розыгрыш' },
  { name: '{day_speakers_gifts}', desc: 'Список подарков спикеров за день' },
  { name: '{first_name}', desc: 'Имя получателя (персонализация)' },
  { name: '{game_link}', desc: 'Личная ссылка получателя на вкладку «Игра» события (партнёрский кабинет)' },
  { name: '{vip_url}', desc: 'Ссылка на оплату VIP-тарифа (та же, что у VIP-кнопки в Mini App)' },
]

const INCLUDE_LABELS: Record<string, string> = {
  all_event: 'Все участники конфы',
  registered_event: 'Зарегистрированные участники',
  all_client: 'Вся база клиента',
}

const EXCLUDE_LABELS: Record<string, string> = {
  none: 'никого не исключать',
  registered_event: 'зарег. участников',
  unregistered_event: 'незарег. участников',
  all_event: 'всех участников конфы',
}

function audienceLabel(inc: string, exc: string): string {
  const incLabel = INCLUDE_LABELS[inc] || inc
  if (!exc || exc === 'none') return incLabel
  return `${incLabel} − ${EXCLUDE_LABELS[exc] || exc}`
}

const emptyForm = {
  name: '', type: '5min_before', subject: '', text: '', photo_url: '',
  video_url: '', media_type: null as 'photo' | 'video' | null,
  button_text: '', button_url: '', audience_include: 'all_event', audience_exclude: 'none',
  intro_start_time: '11:00', intro_interval_min: 15, intro_days_before: 1,
  custom_day_ref: '', custom_time: '12:00',
  // target_channel_ids: null = «по всем каналам клиента» (default),
  // [] = никуда не слать, [N,M] = только эти channel_id.
  target_channel_ids: null as number[] | null,
}

// Превью с гарантированным плейсхолдером при битом URL.
// Без этого `<img onError>` просто скрывается и пользователь видит пустоту.
function PreviewImage({ src, placeholder }: { src: string; placeholder: string }) {
  const [errored, setErrored] = useState(false)
  if (errored) {
    return (
      <div className="w-full h-20 rounded-xl mb-2 flex items-center justify-center text-xs text-gray-400"
        style={{ background: '#e8e8e8' }}>
        {placeholder} (не загрузилась)
      </div>
    )
  }
  return (
    <img src={src} alt=""
      className="w-full rounded-xl mb-2"
      style={{ maxHeight: '400px', objectFit: 'contain', background: '#f0f0f0' }}
      onError={() => setErrored(true)}
    />
  )
}

const CUSTOM_PLACEHOLDERS = [
  '{conf_title}', '{conf_date}', '{conf_description}',
  '{day_number}', '{day_date}', '{day_program}',
  '{stream_url}', '{landing_url}', '{raffle_url}',
  '{first_name}', '{vip_url}',
]

function customDayRefLabel(ref: string, confDays: number[]): string {
  if (!ref) return ''
  if (ref.startsWith('before_')) return `За ${ref.split('_')[1]} дня до конференции`
  if (ref.startsWith('day_')) return `День ${ref.split('_')[1]}`
  if (ref.startsWith('after_')) return `Через ${ref.split('_')[1]} дня после конференции`
  return ref
}

export default function TemplatesPage() {
  const { id } = useParams()
  const eventId = Number(id)

  const [templates, setTemplates] = useState<any[]>([])
  const [speakers, setSpeakers] = useState<any[]>([])
  const [editModal, setEditModal] = useState<any>(null)
  const [createModal, setCreateModal] = useState(false)
  const [form, setForm] = useState({ ...emptyForm })
  const [previewModal, setPreviewModal] = useState<{ tpl: any; def: TypeDef } | null>(null)
  const [previewSpeakerId, setPreviewSpeakerId] = useState<number | null>(null)
  const [varsOpen, setVarsOpen] = useState(false)
  const [testModal, setTestModal] = useState<{ def: TypeDef; tpl: any } | null>(null)
  const [testSending, setTestSending] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)
  const [testDay, setTestDay] = useState(1)
  const [confDays, setConfDays] = useState<number[]>([1])
  const [confDaysData, setConfDaysData] = useState<any[]>([])
  const [confData, setConfData] = useState<any>(null)
  const [eventData, setEventData] = useState<any>(null)
  const [confSessions, setConfSessions] = useState<any[]>([])
  const [confPosters, setConfPosters] = useState<{ horizontal: string[]; vertical: string[]; square: string[] }>({
    horizontal: [], vertical: [], square: [],
  })
  const [previewRegistered, setPreviewRegistered] = useState(false)

  useEffect(() => {
    api.conference.templates.list(eventId).then(r => setTemplates(r.templates || [])).catch(() => {})
    api.conference.speakers.list(eventId).then(r => setSpeakers(r.speakers || [])).catch(() => {})
    api.conference.days.list(eventId).then(r => {
      const days = r.days || []
      const dayNums = days.map((d: any) => d.day_number).sort((a: number, b: number) => a - b)
      if (dayNums.length > 0) setConfDays(dayNums)
      setConfDaysData(days)
    }).catch(() => {})
    api.conference.get(eventId).then(r => setConfData(r.conference)).catch(() => {})
    api.events.get(eventId).then(r => setEventData(r.event || r)).catch(() => {})
    api.conference.sessions.list(eventId).then(r => setConfSessions(r.sessions || [])).catch(() => {})
    // Афиши лежат в event_posters (общая таблица для всех событий) — забираем все ориентации
    api.referralProgram.posters.list(eventId).then(r => {
      const items = r.items || []
      setConfPosters({
        horizontal: items.filter((p: any) => p.orientation === 'horizontal').map((p: any) => p.url),
        vertical:   items.filter((p: any) => p.orientation === 'vertical').map((p: any) => p.url),
        square:     items.filter((p: any) => p.orientation === 'square').map((p: any) => p.url),
      })
    }).catch(() => {})
  }, [eventId])

  async function save() {
    try {
      const mt = (form as any).media_type as 'photo' | 'video' | null
      const payload: any = {
        ...form,
        text: form.text || '',
        // Не отправляем фото и видео одновременно — оставляем выбранный тип.
        photo_url: mt === 'photo' ? ((form as any).photo_url || null) : null,
        video_url: mt === 'video' ? ((form as any).video_url || null) : null,
        media_type: mt,
        audience_include: (form as any).audience_include || 'all_event',
        audience_exclude: (form as any).audience_exclude || 'none',
        intro_start_time: (form as any).intro_start_time || '11:00',
        intro_interval_min: (form as any).intro_interval_min || 15,
        intro_days_before: (form as any).intro_days_before || 1,
      }
      // target_channel_ids: null = «не трогаем текущее значение в БД»,
      // массив = заменяем целиком. Picker всегда приводит null → массив после
      // первичной отрисовки, поэтому здесь обычно уже массив.
      if ((form as any).target_channel_ids !== null && (form as any).target_channel_ids !== undefined) {
        payload.target_channel_ids = (form as any).target_channel_ids
      }
      const res = await api.conference.templates.update(eventId, editModal.id, payload)
      setTemplates(templates.map((x: any) => x.id === editModal.id ? res : x))
      setEditModal(null)
    } catch (e: any) {
      alert(e.message)
    }
  }

  function openCreate() {
    setForm({
      ...emptyForm,
      type: 'custom',
      audience_include: 'all_event',
      audience_exclude: 'none',
      custom_day_ref: confDays[0] ? `day_${confDays[0]}` : 'before_1',
      custom_time: '12:00',
    } as any)
    setCreateModal(true)
  }

  async function createCustom() {
    try {
      const f = form as any
      if (!f.name || !f.name.trim()) {
        alert('Введите название шаблона')
        return
      }
      if (!f.custom_day_ref) {
        alert('Выберите день отправки')
        return
      }
      if (!f.custom_time || !/^\d{1,2}:\d{2}$/.test(f.custom_time)) {
        alert('Укажите время в формате HH:MM')
        return
      }
      const payload: any = {
        name: f.name,
        type: 'custom',
        subject: f.subject || null,
        text: f.text || '',
        photo_url: f.media_type === 'photo' ? (f.photo_url || null) : null,
        video_url: f.media_type === 'video' ? (f.video_url || null) : null,
        media_type: f.media_type,
        button_text: f.button_text || null,
        button_url: f.button_url || null,
        audience_include: f.audience_include || 'all_event',
        audience_exclude: f.audience_exclude || 'none',
        custom_day_ref: f.custom_day_ref,
        custom_time: f.custom_time,
      }
      if (f.target_channel_ids !== null && f.target_channel_ids !== undefined) {
        payload.target_channel_ids = f.target_channel_ids
      }
      const res = await api.conference.templates.create(eventId, payload)
      setTemplates([...templates, res])
      setCreateModal(false)
    } catch (e: any) {
      alert(e.message)
    }
  }

  async function removeTemplate(tplId: number) {
    if (!confirm('Удалить шаблон?')) return
    try {
      await api.conference.templates.delete(eventId, tplId)
      setTemplates(templates.filter((x: any) => x.id !== tplId))
    } catch (e: any) {
      alert(e.message)
    }
  }

  function openEdit(t: any) {
    setEditModal(t)
    setForm({
      name: t.name,
      type: t.type,
      subject: t.subject || '',
      text: (t.text || '').replace(/\\n/g, '\n'),
      photo_url: t.photo_url || '',
      video_url: t.video_url || '',
      media_type: (t.media_type || (t.photo_url ? 'photo' : null)) as 'photo' | 'video' | null,
      button_text: t.button_text || '',
      button_url: t.button_url || '',
      audience_include: t.audience_include || 'all_event',
      audience_exclude: t.audience_exclude || 'none',
      intro_start_time: t.intro_start_time || '11:00',
      intro_interval_min: t.intro_interval_min || 15,
      intro_days_before: t.intro_days_before || 1,
      custom_day_ref: t.custom_day_ref || '',
      custom_time: t.custom_time || '12:00',
      target_channel_ids: Array.isArray(t.target_channel_ids) ? t.target_channel_ids : null,
    } as any)
  }

  async function openPreview(tpl: any, def: TypeDef) {
    // Ждём актуальных данных из БД перед открытием превью
    const [daysR, confR, sessionsR] = await Promise.all([
      api.conference.days.list(eventId).catch(() => ({ days: [] })),
      api.conference.get(eventId).catch(() => ({ conference: null })),
      api.conference.sessions.list(eventId).catch(() => ({ sessions: [] })),
    ])
    const days = daysR.days || []
    const dayNums = days.map((d: any) => d.day_number).sort((a: number, b: number) => a - b)
    if (dayNums.length > 0) setConfDays(dayNums)
    setConfDaysData(days)
    if (confR.conference) setConfData(confR.conference)
    setConfSessions(sessionsR.sessions || [])
    setPreviewModal({ tpl, def })
    setPreviewSpeakerId(speakers[0]?.id ?? null)
  }

  function openTest(tpl: any, def: TypeDef) {
    setTestModal({ tpl, def })
    setTestResult(null)
    setTestDay(confDays[0] ?? 1)
  }

  async function runTest() {
    if (!testModal) return
    setTestSending(true)
    setTestResult(null)
    try {
      const ALL_DAYS_TYPES = ['2h_before_unreg', '2h_before_reg', 'day_live', 'day_end']
      const SINGLE_DAY_TYPES: string[] = []
      const isDayAllType = ALL_DAYS_TYPES.includes(testModal.def.type)
      const isDaySingleType = SINGLE_DAY_TYPES.includes(testModal.def.type)
      if (isDayAllType) {
        // Шлём для всех дней
        const allDetails: any[] = []
        for (const d of confDays) {
          const r = await api.conference.templates.test(eventId, testModal.tpl.id, d)
          if (r.details) allDetails.push(...r.details)
        }
        setTestResult({ ok: true, sent: allDetails.length, details: allDetails })
      } else if (isDaySingleType) {
        // Шлём только для выбранного дня
        const r = await api.conference.templates.test(eventId, testModal.tpl.id, testDay)
        setTestResult(r)
      } else {
        const res = await api.conference.templates.test(eventId, testModal.tpl.id, testDay)
        setTestResult(res)
      }
    } catch (e: any) {
      setTestResult({ ok: false, error: e.message })
    } finally {
      setTestSending(false)
    }
  }

  const currentType = TYPE_DEFS.find(d => d.type === form.type)
  const previewSpeaker = previewSpeakerId ? speakers.find(s => s.id === previewSpeakerId) : null

  function getStreamUrl(day?: number): string {
    const d = day ?? 1
    const dayObj = confDaysData.find((x: any) => x.day_number === d)
    // Без префикса 🔗 — он уже есть в самом тексте шаблона перед {stream_url},
    // иначе в превью получаем «🔗 🔗 [ссылка на эфир]».
    return dayObj?.stream_url || eventData?.stream_url || '[ссылка на эфир]'
  }

  function getGameLink(): string {
    // Превью {game_link}: уходит к уже зарегистрированным — pid не нужен, их реферер
    // уже учтён при регистрации. Просто открываем их вкладку «Игра».
    const slug = eventData?.slug || '{slug}'
    return `https://t.me/pluson_bot/pluson?startapp=ref_pg${slug}_tabgame`
  }

  function renderPreviewText(text: string, speaker: any | null, tplType?: string, day?: number): string {
    if (!text) return ''
    // Нормализуем литеральные \n на случай старых данных из БД
    let out = text.replace(/\\n/g, '\n')

    if (speaker) {
      const giftTitle = (speaker.gift_after_speech_title || '').trim()
      const giftUrl = (speaker.gift_after_speech_url || '').trim()
      const rawTg = (speaker.personal_tg_username || '').trim()
      const tgUrl = rawTg ? '@' + rawTg.replace(/^@+/, '') : ''
      const giftRaffle = (speaker.gift_raffle_title || '').trim()

      if (tplType === 'speaker_intro') {
        const ROLE_MAP: Record<string, string> = { speaker: 'Спикер', headliner: 'Хедлайнер', partner: 'Партнёр', organizer: 'Организатор', jury: 'Жюри' }
        const roleLabel = ROLE_MAP[speaker.role] || 'Спикер'
        const tgChannel = (speaker.tg_channel_url || '').trim()
        const insta = (speaker.instagram_url || '').trim()
        const achList: string[] = (speaker.achievements || []).filter((a: string) => a && a.trim())
        // Все темы спикера через перенос строки (раньше брали только первую,
        // и у спикеров с темами на каждый день вторая «терялась»).
        const topicsArr: string[] = (Array.isArray(speaker.topics) && speaker.topics.length > 0)
          ? speaker.topics.map((t: any) => (t?.topic || '').trim()).filter(Boolean)
          : ((speaker.topic || '').trim() ? [(speaker.topic || '').trim()] : [])
        const topic = topicsArr.join('\n')
        const achText = achList.map((a: string) => `• ${a}`).join('\n')

        // Сначала убираем строки с пустыми плейсхолдерами (пока они ещё в тексте)
        if (!topic) out = out.replace(/^[^\n]*\{speaker_topic\}[^\n]*\n?/gm, '')
        if (!achText) {
          out = out.replace(/^[^\n]*О спикере[^\n]*\n?/gm, '')
          out = out.replace(/^[^\n]*\{speaker_achievements\}[^\n]*\n?/gm, '')
        }
        if (!giftTitle) out = out.replace(/^[^\n]*\{gift_after_speech_title\}[^\n]*\n?/gm, '')
        if (!giftRaffle) out = out.replace(/^[^\n]*\{gift_raffle_title\}[^\n]*\n?/gm, '')
        if (!tgChannel) out = out.replace(/^[^\n]*\{speaker_tg\}[^\n]*\n?/gm, '')
        if (!insta) out = out.replace(/^[^\n]*\{speaker_instagram\}[^\n]*\n?/gm, '')

        // Потом подставляем значения
        out = out
          .replace(/\{speaker_name\}/g, speaker.name || '')
          .replace(/\{speaker_role\}/g, roleLabel)
          .replace(/\{speaker_topic\}/g, topic)
          .replace(/\{speaker_achievements\}/g, achText)
          .replace(/\{gift_after_speech_title\}/g, giftTitle)
          .replace(/\{gift_raffle_title\}/g, giftRaffle)
          .replace(/\{landing_url\}/g, confData?.event_landing_url || '')
        if (tgChannel) out = out.replace(/\{speaker_tg\}/g, `<b>Тг канал:</b> ${tgChannel}`)
        if (insta) out = out.replace(/\{speaker_instagram\}/g, `<b>Нельзяграм:</b> ${insta}`)

        out = out.replace(/\n{3,}/g, '\n\n').trim()
      } else if (tplType === 'gift') {
        // Убираем строки с переменными подарка — заменим всё блоком по правилам
        out = out.replace(/^.*\{gift_title\}.*$\n?/gm, '')
        out = out.replace(/^.*\{gift_url\}.*$\n?/gm, '')

        let giftBlock = ''
        if (!giftTitle) {
          giftBlock = tgUrl
            ? `🎁 Чтобы забрать материалы — пишите в личку ${tgUrl}`
            : `🎁 Чтобы забрать материалы — напишите спикеру в личку`
        } else if (!giftUrl) {
          giftBlock = tgUrl ? `${giftTitle}\nПишите в личку ${tgUrl}` : giftTitle
        } else {
          giftBlock = `${giftTitle}\n${giftUrl}`
        }
        out = out.trimEnd() + '\n\n' + giftBlock
        out = out
          .replace(/\{speaker_name\}/g, speaker.name || '')
          .replace(/\{speaker_topic\}/g, ((Array.isArray(speaker.topics) && speaker.topics.length > 0) ? speaker.topics.map((t: any) => t?.topic || '').filter(Boolean).join('\n') : speaker.topic) || 'уточняется')
          .replace(/\{stream_url\}/g, getStreamUrl(day))
      } else {
        // pre_start и другие спикерские шаблоны
        if (giftUrl) {
          out = out.replace(/\{gift_url\}/g, giftUrl)
        } else {
          out = out.replace(/^.*\{gift_url\}.*$\n?/gm, '')
        }
        if (giftTitle) {
          out = out.replace(/\{gift_title\}/g, giftTitle)
          out = out.replace(/\{gift_after_speech_title\}/g, giftTitle)
        } else {
          out = out.replace(/^.*\{gift_title\}.*$\n?/gm, '')
          out = out.replace(/^.*\{gift_after_speech_title\}.*$\n?/gm, '')
        }
        if (giftRaffle) {
          out = out.replace(/\{gift_raffle_title\}/g, giftRaffle)
        } else {
          out = out.replace(/^.*\{gift_raffle_title\}.*$\n?/gm, '')
        }
        out = out
          .replace(/\{speaker_name\}/g, speaker.name || '')
          .replace(/\{speaker_topic\}/g, ((Array.isArray(speaker.topics) && speaker.topics.length > 0) ? speaker.topics.map((t: any) => t?.topic || '').filter(Boolean).join('\n') : speaker.topic) || 'уточняется')
          .replace(/\{stream_url\}/g, getStreamUrl(day))
      }
    }

    const d = day ?? testDay
    const dayObj = confDaysData.find((x: any) => x.day_number === d)
    // Для конференции — данные из conf_days/conf_conferences. Для мероприятия —
    // прямые поля events.title / events.stream_url / events.landing_url.
    const realStreamUrl = dayObj?.stream_url || eventData?.stream_url || ''
    const realRegUrl = confData?.event_landing_url || eventData?.landing_url || ''
    const realConfTitle = confData?.event_title || confData?.title || eventData?.title || '[Название события]'
    const realDayDate = dayObj?.day_date
      ? new Date(dayObj.day_date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
      : `День ${d}`

    // Строим программу дня из сессий
    const daySessions = confSessions.filter((s: any) => s.day === d)
    const ROLE_LABELS: Record<string, string> = { headliner: 'Хедлайнер', partner: 'Партнёр', organizer: 'Организатор', jury: 'Жюри' }
    const dayProgram = daySessions.length > 0
      ? daySessions.map((s: any) => {
          const fmt = (v: string) => v ? String(v).slice(0, 5) : ''
          const timeStart = fmt(s.start_time)
          const timeEnd = fmt(s.end_time)
          let timePart = ''
          if (timeStart && timeEnd) timePart = `${timeStart}-${timeEnd} МСК`
          else if (timeStart) timePart = `${timeStart} МСК`
          const topic = s.title || ''
          const name = s.speaker_name || ''
          const role = s.speaker_role
          const roleLabel = ROLE_LABELS[role] ? ` — ${ROLE_LABELS[role]}` : ''
          const speakerPart = name ? ` (<b>${name}${roleLabel}</b>)` : ''
          const boldTime = timePart ? `<b>${timePart}</b>` : ''
          return `${boldTime}: ${topic}${speakerPart}`.trim()
        }).join('\n')
      : '[программа дня]'

    const ORDINALS: Record<number, string> = { 1: 'первом', 2: 'втором', 3: 'третьем', 4: 'четвёртом', 5: 'пятом' }
    const dayOrdinal = ORDINALS[d] || `${d}-м`
    const realRaffleUrl = confData?.raffle_url || ''

    // Подарки спикеров дня для превью.
    // Должно совпадать с backend/app/services/collaborator_sort.py — то же группирование.
    // Внутри группы здесь сортируем по priority — данных о реальных «приведённых» в
    // превью нет (это статичный мок), поэтому отдельный ключ referrals не учитывается.
    const roleOrder = (s: any) => {
      const r = s.speaker_role, c = s.is_commercial
      if (r === 'organizer')                       return 1
      if (c && r === 'jury')                       return 2
      if (c && r === 'headliner')                  return 3
      if (c && r === 'speaker')                    return 4
      if (c && r === 'general_partner')            return 5
      if (c && r === 'partner')                    return 6
      if (r === 'jury')                            return 7
      if (r === 'headliner')                       return 8
      if (r === 'speaker')                         return 9
      if (r === 'general_partner')                 return 10
      if (r === 'partner')                         return 11
      return 12
    }
    const speakerGiftBlocks = [...daySessions]
      .filter((s: any) => s.speaker_name && !s.exclude_gift_from_broadcast)
      .sort((a: any, b: any) => {
        const g = roleOrder(a) - roleOrder(b)
        if (g !== 0) return g
        return (a.priority ?? 60) - (b.priority ?? 60)
      })
      .map((s: any) => {
        const title = (s.gift_after_speech_title || '').trim()
        const url = (s.gift_after_speech_url || '').trim()
        const tg = (s.personal_tg_username || '').trim()
        const tgMention = tg ? '@' + tg.replace(/^@+/, '') : ''
        if (!title) return `🎁 <b>${s.speaker_name}:</b> ${tgMention ? 'пишите в личку ' + tgMention : 'уточните у спикера'}`
        if (!url) return `🎁 <b>${s.speaker_name}:</b> ${title}${tgMention ? '\nПишите в личку ' + tgMention : ''}`
        return `🎁 <b>${s.speaker_name}:</b> ${title}\n${url}`
      })
    const daySpeakersGifts = speakerGiftBlocks.length > 0
      ? `А сейчас ловите подарки от спикеров Дня ${d}:\n\n` + speakerGiftBlocks.join('\n\n')
      : ''

    // Умная фраза про следующий день
    const MONTHS_RU = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']
    const nextDaySessions = confSessions.filter((s: any) => s.day === d + 1)
    let nextDayMention = ''
    const nextDayObj = confDaysData.find((x: any) => x.day_number === d + 1)
    if (nextDaySessions.length > 0 && nextDaySessions[0].start_time && nextDayObj?.day_date) {
      const nextTime = String(nextDaySessions[0].start_time).slice(0, 5)
      const curDayObj = confDaysData.find((x: any) => x.day_number === d)
      let diffDays = 999
      if (curDayObj?.day_date) {
        const [ny, nm, nd] = String(nextDayObj.day_date).slice(0, 10).split('-').map(Number)
        const [cy, cm, cd] = String(curDayObj.day_date).slice(0, 10).split('-').map(Number)
        diffDays = Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(cy, cm - 1, cd)) / 86400000)
      }
      const [ny, nm, nd] = String(nextDayObj.day_date).slice(0, 10).split('-').map(Number)
      const when = diffDays === 1 ? 'завтра' : `${nd} ${MONTHS_RU[nm - 1]}`
      nextDayMention = `Встречаемся ${when} в ${nextTime} МСК на День ${d + 1}.`
    }

    const confDay1 = confDaysData.find((x: any) => x.day_number === 1)
    const confDay1Date = confDay1?.day_date
      ? new Date(confDay1.day_date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
      : ''
    const realConfDesc = eventData?.description || ''

    out = out
      .replace(/\{conf_title\}/g, realConfTitle)
      .replace(/\{conf_date\}/g, confDay1Date || '[дата конференции]')
      .replace(/\{conf_description\}/g, realConfDesc || '[описание конференции]')
      .replace(/\{day_number\}/g, String(d))
      .replace(/\{day_ordinal\}/g, dayOrdinal)
      .replace(/\{day_date\}/g, realDayDate)
      .replace(/\{day_program\}/g, dayProgram)
      .replace(/\{next_day_mention\}/g, nextDayMention)
      .replace(/\{raffle_url\}/g, realRaffleUrl || '🔗 [ссылка на розыгрыш]')
      .replace(/\{day_speakers_gifts\}/g, daySpeakersGifts)
      .replace(/\{stream_url\}/g, realStreamUrl || '[ссылка на эфир]')
      .replace(/\{landing_url\}/g, realRegUrl || '[ссылка на регистрацию]')
      .replace(/\{vip_url\}/g, eventData?.vip_url || '[ссылка на оплату VIP]')
      .replace(/\{game_link\}/g, getGameLink())
      .replace(/\{gift_url\}/g, '🔗 [ссылка на подарок]')
      .replace(/\{gift_title\}/g, '[название подарка]')
      .replace(/\{gift_after_speech_title\}/g, '[подарок на эфире]')
      .replace(/\{gift_raffle_title\}/g, '[подарок для розыгрыша]')
      .replace(/\{speaker_name\}/g, '[Имя спикера]')
      .replace(/\{speaker_tg\}/g, '')
      .replace(/\{speaker_topic\}/g, '[тема]')
      .replace(/\{speaker_achievements\}/g, '')
      .replace(/\{first_name\}/g, '[Имя]')

    // Убираем незамененные переменные если пустые
    if (!nextDayMention) out = out.replace(/^.*\{next_day_mention\}.*$\n?/gm, '')
    if (!daySpeakersGifts) out = out.replace(/^.*\{day_speakers_gifts\}.*$\n?/gm, '')
    // Схлопываем 3+ пустых строки подряд
    out = out.replace(/\n{3,}/g, '\n\n')
    return out.trim()
  }

  const customTemplates = templates.filter(t => t.type === 'custom')

  // Варианты «за N дней», «День N», «через N дней» для выпадающего списка.
  // confDays приходит из БД как массив номеров дней ([1, 2, 3] для трёхдневной конфы).
  const dayRefOptions: { value: string; label: string }[] = [
    { value: 'before_3', label: 'За 3 дня до конференции' },
    { value: 'before_2', label: 'За 2 дня до конференции' },
    { value: 'before_1', label: 'За 1 день до конференции' },
    ...confDays.map(n => ({ value: `day_${n}`, label: `День ${n}` })),
    { value: 'after_1', label: 'Через 1 день после конференции' },
    { value: 'after_2', label: 'Через 2 дня после конференции' },
    { value: 'after_3', label: 'Через 3 дня после конференции' },
  ]

  function customDayToTestDay(ref: string): number {
    if (!ref) return confDays[0] ?? 1
    if (ref.startsWith('day_')) return Number(ref.split('_')[1])
    if (ref.startsWith('after_')) return confDays[confDays.length - 1] ?? 1
    return confDays[0] ?? 1
  }

  const CUSTOM_DEF: TypeDef = {
    type: 'custom',
    title: 'Кастомный шаблон',
    hint: '',
    variables: CUSTOM_PLACEHOLDERS,
    showPhoto: true,
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">
        Шаблоны создаются автоматически. Отредактируйте тексты — плейсхолдеры вида{' '}
        <code className="text-xs bg-gray-100 rounded px-1">{'{speaker_name}'}</code> подставятся при отправке.
        Потом перейдите в «Очередь рассылок» и нажмите «Создать из программы».
      </p>

      <div className="mb-4 flex justify-end">
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm text-white font-medium shadow-sm"
          style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}
        >
          <Plus size={15} /> Добавить шаблон
        </button>
      </div>

      {/* Памятка переменных */}
      <div className="mb-6 border border-gray-200 rounded-2xl overflow-hidden">
        <button
          onClick={() => setVarsOpen(v => !v)}
          className="w-full flex items-center justify-between px-5 py-3.5 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
        >
          <span className="text-sm font-medium text-gray-700">📋 Памятка по переменным</span>
          {varsOpen ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
        </button>
        {varsOpen && (
          <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            {ALL_VARIABLES.map(v => (
              <div key={v.name} className="flex items-baseline gap-2">
                <code className="text-xs bg-blue-50 text-blue-700 border border-blue-100 rounded px-1.5 py-0.5 font-mono shrink-0">{v.name}</code>
                <span className="text-xs text-gray-500">{v.desc}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-4">
        {templates
          .filter(t => t.type !== 'custom')
          .slice()
          .sort((a, b) => {
            const ai = TYPE_DEFS.findIndex(d => d.type === a.type)
            const bi = TYPE_DEFS.findIndex(d => d.type === b.type)
            const av = ai === -1 ? 999 : ai
            const bv = bi === -1 ? 999 : bi
            return av - bv
          })
          .map(tpl => {
            const def: TypeDef = TYPE_DEFS.find(d => d.type === tpl.type)
              || { type: tpl.type, title: tpl.name, hint: '', variables: [], showPhoto: false }
            return (
              <div key={tpl.id} className="bg-white rounded-2xl border border-gray-100 p-5">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <h4 className="font-semibold text-gray-800">{def.title}</h4>
                    {def.hint && <p className="text-xs text-gray-400 mt-0.5">{def.hint}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    <button onClick={() => openTest(tpl, def)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-emerald-700 font-medium border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 transition-colors">
                      <Send size={13} /> Протестировать
                    </button>
                    <button onClick={() => openPreview(tpl, def)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-gray-600 font-medium border border-gray-200 hover:bg-gray-50 transition-colors">
                      <Eye size={13} /> Просмотреть
                    </button>
                    <button onClick={() => openEdit(tpl)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-white font-medium"
                      style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                      <Edit2 size={13} /> Редактировать
                    </button>
                  </div>
                </div>

                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-xs text-gray-700 whitespace-pre-wrap font-mono mb-3">{(tpl.text || '').replace(/\\n/g, '\n')}</p>
                  <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                    {tpl.photo_url ? (
                      <span>📷 Своё фото</span>
                    ) : def.showPhoto ? (
                      <span className="text-blue-500">📸 Афиша подставится автоматически</span>
                    ) : null}
                    {tpl.button_text && (
                      <span>
                        🔘 Кнопка: «{tpl.button_text}»
                        {tpl.button_url && (
                          <span className="ml-1 text-gray-400 text-xs font-normal">({tpl.button_url})</span>
                        )}
                      </span>
                    )}
                    <span className="text-indigo-500 font-medium">
                      👥 {audienceLabel(tpl.audience_include || 'all_event', tpl.audience_exclude || 'none')}
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
      </div>

      {customTemplates.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-gray-500 mb-3 uppercase tracking-wide">Ваши шаблоны</h3>
          <div className="space-y-4">
            {customTemplates.map(tpl => (
              <div key={tpl.id} className="bg-white rounded-2xl border border-gray-100 p-5">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <h4 className="font-semibold text-gray-800">{tpl.name}</h4>
                    <p className="text-xs text-gray-400 mt-0.5">
                      ⏰ {customDayRefLabel(tpl.custom_day_ref || '', confDays)} в {tpl.custom_time || '—'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    <button
                      onClick={() => {
                        setTestDay(customDayToTestDay(tpl.custom_day_ref || ''))
                        setPreviewModal({ tpl, def: { ...CUSTOM_DEF, title: tpl.name } })
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-gray-600 font-medium border border-gray-200 hover:bg-gray-50 transition-colors">
                      <Eye size={13} /> Просмотреть
                    </button>
                    <button onClick={() => openEdit(tpl)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-white font-medium"
                      style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                      <Edit2 size={13} /> Редактировать
                    </button>
                    <button onClick={() => removeTemplate(tpl.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-red-600 font-medium border border-red-200 hover:bg-red-50 transition-colors">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                <div className="bg-gray-50 rounded-xl p-4">
                  {tpl.media_type === 'video' && tpl.video_url ? (
                    <video src={tpl.video_url} controls className="w-full max-h-40 rounded-lg mb-3 bg-black" />
                  ) : tpl.photo_url ? (
                    <img src={tpl.photo_url} alt="" className="w-full max-h-40 object-contain rounded-lg mb-3"
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  ) : null}
                  <p className="text-xs text-gray-700 whitespace-pre-wrap font-mono mb-3">{(tpl.text || '').replace(/\\n/g, '\n')}</p>
                  <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                    {tpl.media_type === 'video' && tpl.video_url && <span>🎬 Своё видео</span>}
                    {tpl.media_type !== 'video' && tpl.photo_url && <span>📷 Своё фото</span>}
                    {tpl.button_text && (
                      <span>
                        🔘 Кнопка: «{tpl.button_text}»
                        {tpl.button_url && (
                          <span className="ml-1 text-gray-400 text-xs font-normal">({tpl.button_url})</span>
                        )}
                      </span>
                    )}
                    <span className="text-indigo-500 font-medium">
                      👥 {audienceLabel(tpl.audience_include || 'all_event', tpl.audience_exclude || 'none')}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Модалка редактирования */}
      {editModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">Редактировать шаблон</h3>
              <button onClick={() => setEditModal(null)}><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Название</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400" />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">
                  Заголовок (опционально)
                </label>
                <input
                  value={(form as any).subject || ''}
                  onChange={e => setForm({ ...form, subject: e.target.value } as any)}
                  placeholder="Тема для email + жирная первая строка для TG/VK/MAX"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400"
                />
                <p className="text-[11px] text-gray-500 mt-1 leading-snug">
                  В email становится темой письма. В Telegram/VK/MAX — первая жирная строка перед основным текстом.
                </p>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Текст сообщения</label>
                <textarea
                  value={form.text || ''}
                  onChange={(e) => setForm({ ...form, text: e.target.value })}
                  placeholder="Используйте плейсхолдеры {conf_title}, {day_number}, {first_name} и т.п. Можно HTML-теги <b>, <i>, <a href>."
                  rows={12}
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-gray-400 font-mono leading-relaxed resize-y"
                />
                <p className="text-[11px] text-gray-500 mt-1 leading-snug">
                  Жирный, курсив, подчёркивание и ссылки. Telegram и MAX покажут как есть. В&nbsp;ВКонтакте
                  форматирование не работает — останется только чистый текст и&nbsp;ссылки.
                </p>
                {currentType && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className="text-xs text-gray-400 mr-1">Вставить:</span>
                    {currentType.variables.map(v => (
                      <button key={v} type="button"
                        onClick={() => setForm({ ...form, text: form.text + v })}
                        className="text-xs bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded-lg px-2 py-0.5 font-mono text-gray-600">
                        {v}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">
                  Медиа (опционально) — фото или видео. Если пусто, для дневных шаблонов подставится афиша.
                </label>
                <BroadcastMediaPicker
                  value={{
                    photo_url: form.media_type === 'photo' ? (form.photo_url || null) : null,
                    video_url: form.media_type === 'video' ? (form.video_url || null) : null,
                    media_type: form.media_type,
                  }}
                  onChange={(v) => setForm({ ...form, photo_url: v.photo_url || '', video_url: v.video_url || '', media_type: v.media_type } as any)}
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Видео в Telegram проигрывается прямо в сообщении; в VK/MAX/email — ссылкой.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Текст кнопки</label>
                  <input value={form.button_text} onChange={e => setForm({ ...form, button_text: e.target.value })}
                    placeholder="Войти в эфир"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Ссылка кнопки</label>
                  <input value={form.button_url} onChange={e => setForm({ ...form, button_url: e.target.value })}
                    placeholder="{stream_url} или https://..."
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none font-mono" />
                </div>
              </div>
              {/* Настройки кастомного шаблона — день и время */}
              {editModal?.type === 'custom' && (
                <div className="border border-amber-100 rounded-xl p-3 bg-amber-50 space-y-3">
                  <p className="text-xs font-medium text-amber-800">📅 Когда отправлять</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">День отправки</label>
                      <select
                        value={(form as any).custom_day_ref || ''}
                        onChange={e => setForm({ ...form, custom_day_ref: e.target.value } as any)}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                        {dayRefOptions.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Время</label>
                      <input
                        type="time"
                        value={(form as any).custom_time || '12:00'}
                        onChange={e => setForm({ ...form, custom_time: e.target.value } as any)}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white" />
                    </div>
                  </div>
                </div>
              )}

              {/* Настройки расписания для Знакомства со спикером */}
              {editModal?.type === 'speaker_intro' && (
                <div className="border border-blue-100 rounded-xl p-3 bg-blue-50 space-y-3">
                  <p className="text-xs font-medium text-blue-700">⏰ Расписание знакомств со спикерами</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Время старта (МСК)</label>
                      <input
                        type="time"
                        value={(form as any).intro_start_time || '11:00'}
                        onChange={e => setForm({ ...form, intro_start_time: e.target.value } as any)}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Интервал (мин)</label>
                      <input
                        type="number"
                        min={5} max={120}
                        value={(form as any).intro_interval_min || 15}
                        onChange={e => setForm({ ...form, intro_interval_min: Number(e.target.value) } as any)}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Отправить за</label>
                    <select
                      value={(form as any).intro_days_before || 1}
                      onChange={e => setForm({ ...form, intro_days_before: Number(e.target.value) } as any)}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white"
                    >
                      <option value={1}>за 1 день до конференции</option>
                      <option value={2}>за 2 дня до конференции</option>
                      <option value={3}>за 3 дня до конференции</option>
                      <option value={4}>за 4 дня до конференции</option>
                      <option value={5}>за 5 дней до конференции</option>
                      <option value={6}>за 6 дней до конференции</option>
                      <option value={7}>за 7 дней до конференции</option>
                    </select>
                  </div>
                </div>
              )}

              <div className="border border-gray-100 rounded-xl p-3 bg-gray-50 space-y-2">
                <p className="text-xs font-medium text-gray-600">👥 Аудитория рассылки</p>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Включить</label>
                  <select
                    value={(form as any).audience_include || 'all_event'}
                    onChange={e => setForm({ ...form, audience_include: e.target.value } as any)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="all_event">Все участники конфы</option>
                    <option value="registered_event">Зарегистрированные участники</option>
                    <option value="all_client">Вся база клиента (все события)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Исключить</label>
                  <select
                    value={(form as any).audience_exclude || 'none'}
                    onChange={e => setForm({ ...form, audience_exclude: e.target.value } as any)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="none">Никого не исключать</option>
                    <option value="registered_event">Зарегистрированных участников</option>
                    <option value="unregistered_event">Незарегистрированных участников</option>
                    <option value="all_event">Всех участников конфы</option>
                  </select>
                </div>
                <p className="text-xs text-indigo-600 font-medium pt-1">
                  Итого: {audienceLabel((form as any).audience_include || 'all_event', (form as any).audience_exclude || 'none')}
                </p>
              </div>

              <BroadcastChannelPicker
                value={(form as any).target_channel_ids ?? null}
                onChange={(next) => setForm({ ...form, target_channel_ids: next } as any)}
              />
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={save}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                Сохранить
              </button>
              <button onClick={() => setEditModal(null)}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модалка создания кастомного шаблона */}
      {createModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">Новый шаблон</h3>
              <button onClick={() => setCreateModal(false)}><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Название</label>
                <input value={(form as any).name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="Например: «Напоминание за день»"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400" />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">День отправки</label>
                  <select
                    value={(form as any).custom_day_ref || ''}
                    onChange={e => setForm({ ...form, custom_day_ref: e.target.value } as any)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    {dayRefOptions.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Время (МСК / таймзона клиента)</label>
                  <input
                    type="time"
                    value={(form as any).custom_time || '12:00'}
                    onChange={e => setForm({ ...form, custom_time: e.target.value } as any)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white" />
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-500 mb-1 block">
                  Заголовок (опционально)
                </label>
                <input
                  value={(form as any).subject || ''}
                  onChange={e => setForm({ ...form, subject: e.target.value } as any)}
                  placeholder="Тема для email + жирная первая строка для TG/VK/MAX"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400"
                />
                <p className="text-[11px] text-gray-500 mt-1 leading-snug">
                  В email становится темой письма. В Telegram/VK/MAX — первая жирная строка перед основным текстом.
                </p>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Текст сообщения</label>
                <textarea
                  value={(form as any).text || ''}
                  onChange={(e) => setForm({ ...form, text: e.target.value } as any)}
                  placeholder="Используйте плейсхолдеры {conf_title}, {day_number}, {first_name} и т.п. Можно HTML-теги <b>, <i>, <a href>."
                  rows={10}
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-gray-400 font-mono leading-relaxed resize-y"
                />
                <p className="text-[11px] text-gray-500 mt-1 leading-snug">
                  Жирный, курсив, подчёркивание и ссылки. Telegram и MAX покажут как есть. В&nbsp;ВКонтакте
                  форматирование не работает — останется только чистый текст и&nbsp;ссылки.
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="text-xs text-gray-400 mr-1">Вставить:</span>
                  {CUSTOM_PLACEHOLDERS.map(v => (
                    <button key={v} type="button"
                      onClick={() => setForm({ ...form, text: ((form as any).text || '') + v } as any)}
                      className="text-xs bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded-lg px-2 py-0.5 font-mono text-gray-600">
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-500 mb-1 block">Медиа (опционально) — фото или видео</label>
                <BroadcastMediaPicker
                  value={{
                    photo_url: (form as any).media_type === 'photo' ? ((form as any).photo_url || null) : null,
                    video_url: (form as any).media_type === 'video' ? ((form as any).video_url || null) : null,
                    media_type: (form as any).media_type,
                  }}
                  onChange={(v) => setForm({ ...form, photo_url: v.photo_url || '', video_url: v.video_url || '', media_type: v.media_type } as any)}
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Видео в Telegram проигрывается прямо в сообщении; в VK/MAX/email — ссылкой.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Текст кнопки</label>
                  <input value={(form as any).button_text}
                    onChange={e => setForm({ ...form, button_text: e.target.value })}
                    placeholder="Например: «Зарегистрироваться»"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Ссылка кнопки</label>
                  <input value={(form as any).button_url}
                    onChange={e => setForm({ ...form, button_url: e.target.value })}
                    placeholder="{landing_url} или https://..."
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none font-mono" />
                </div>
              </div>

              <div className="border border-gray-100 rounded-xl p-3 bg-gray-50 space-y-2">
                <p className="text-xs font-medium text-gray-600">👥 По какой базе отправлять</p>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Включить</label>
                  <select
                    value={(form as any).audience_include || 'all_event'}
                    onChange={e => setForm({ ...form, audience_include: e.target.value } as any)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="all_event">Все участники конфы</option>
                    <option value="registered_event">Зарегистрированные участники</option>
                    <option value="all_client">Вся база клиента (все события)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Исключить</label>
                  <select
                    value={(form as any).audience_exclude || 'none'}
                    onChange={e => setForm({ ...form, audience_exclude: e.target.value } as any)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
                    <option value="none">Никого не исключать</option>
                    <option value="registered_event">Зарегистрированных участников</option>
                    <option value="unregistered_event">Незарегистрированных участников</option>
                    <option value="all_event">Всех участников конфы</option>
                  </select>
                </div>
                <p className="text-xs text-indigo-600 font-medium pt-1">
                  Итого: {audienceLabel((form as any).audience_include || 'all_event', (form as any).audience_exclude || 'none')}
                </p>
              </div>

              <BroadcastChannelPicker
                value={(form as any).target_channel_ids ?? null}
                onChange={(next) => setForm({ ...form, target_channel_ids: next } as any)}
              />
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={createCustom}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                Создать
              </button>
              <button onClick={() => setCreateModal(false)}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модалка предпросмотра */}
      {previewModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800 text-sm">Предпросмотр: {previewModal.def.title}</h3>
              <button onClick={() => setPreviewModal(null)}><X size={18} /></button>
            </div>

            {/* Выбор дня — только для дневных шаблонов */}
            {confDays.length > 1 && !['pre_conf', 'speaker_intro', '5min_before', 'gift'].includes(previewModal.def.type) && (
              <div className="mb-3">
                <label className="text-xs text-gray-500 mb-1.5 block">День конференции</label>
                <div className="flex gap-2">
                  {confDays.map(d => (
                    <button key={d} onClick={() => setTestDay(d)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${testDay === d ? 'text-white border-transparent' : 'text-gray-600 border-gray-200 bg-white hover:bg-gray-50'}`}
                      style={testDay === d ? { background: 'linear-gradient(45deg,#25455D,#0a1520)' } : {}}>
                      День {d}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Выбор спикера — для шаблонов со спикером */}
            {previewModal.def.hasSpeaker && speakers.length > 0 && (
              <div className="mb-4">
                <label className="text-xs text-gray-500 mb-1 block">Посмотреть как у спикера:</label>
                <select
                  value={previewSpeakerId ?? ''}
                  onChange={e => setPreviewSpeakerId(Number(e.target.value) || null)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white"
                >
                  <option value="">— без замены переменных —</option>
                  {speakers.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Имитация Telegram-сообщения */}
            <div className="bg-[#effdde] rounded-2xl rounded-tr-sm p-3 shadow-sm">
              {/* Видео шаблона (если выбрано) — приоритет над афишей */}
              {previewModal.tpl.media_type === 'video' && previewModal.tpl.video_url && (
                <video src={previewModal.tpl.video_url} controls
                  className="w-full max-h-48 rounded-xl mb-2 bg-black" />
              )}
              {/* Фото */}
              {previewModal.def.showPhoto && previewModal.tpl.media_type !== 'video' && (() => {
                // Конференционные/событийные шаблоны: афиша события (не спикера).
                // Спикерская афиша подставляется только для шаблонов со спикером.
                const isEventLevelTpl = previewModal.def.type.startsWith('day_')
                  || previewModal.def.type === 'pre_conf'
                  || previewModal.def.type === '2h_before_unreg'
                  || previewModal.def.type === '2h_before_reg'
                  || previewModal.def.type === '30min_before'
                  || previewModal.def.type === 'event_live'
                // Афиша события: тот же приоритет, что и в backend get_default_event_photo —
                // square > horizontal > vertical.
                const eventPoster = confPosters.square[0] || confPosters.horizontal[0] || confPosters.vertical[0]
                const speakerPoster = previewSpeaker?.cse_poster_url || previewSpeaker?.speaker_poster_url || previewSpeaker?.poster_url
                // Для спикерских шаблонов: спикерская афиша; если спикера нет (мероприятие) или
                // у него нет афиши — fallback на афишу события, а не пустой плейсхолдер.
                const photoSrc = previewModal.tpl.photo_url
                  || (isEventLevelTpl
                    ? eventPoster
                    : (speakerPoster || eventPoster))
                const placeholder = isEventLevelTpl
                  ? '📸 Афиша события'
                  : (speakers.length > 0 ? '📸 Афиша спикера' : '📸 Афиша события')
                return photoSrc ? (
                  <PreviewImage key={photoSrc} src={photoSrc} placeholder={placeholder} />
                ) : (
                  <div className="w-full h-20 rounded-xl mb-2 flex items-center justify-center text-xs text-gray-400"
                    style={{ background: '#e8e8e8' }}>
                    {placeholder}
                  </div>
                )
              })()}
              <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed"
                dangerouslySetInnerHTML={{ __html: renderPreviewText(
                  previewModal.tpl.text,
                  previewModal.def.hasSpeaker ? previewSpeaker : null,
                  previewModal.def.type,
                  testDay
                )}} />
              {previewModal.tpl.button_text && (
                <div className="mt-3">
                  <div className="w-full py-2 px-3 rounded-xl text-center text-sm font-medium text-blue-600 bg-white border border-gray-200">
                    {previewModal.tpl.button_text}
                  </div>
                  {previewModal.tpl.button_url && (
                    <p className="text-xs text-gray-400 mt-1 text-center break-all">
                      {renderPreviewText(
                        previewModal.tpl.button_url,
                        previewModal.def.hasSpeaker ? previewSpeaker : null,
                        previewModal.def.type,
                        testDay
                      )}
                    </p>
                  )}
                </div>
              )}
            </div>

            <button onClick={() => setPreviewModal(null)}
              className="w-full mt-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
              Закрыть
            </button>
          </div>
        </div>
      )}

      {/* Модалка тестирования */}
      {testModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">Тест: {testModal.def.title}</h3>
              <button onClick={() => setTestModal(null)}><X size={18} /></button>
            </div>

            {['pre_conf', 'gift', 'speaker_intro', '5min_before', '2h_before_unreg', '2h_before_reg', 'day_live', 'day_end', '30min_before', 'event_live'].includes(testModal.def.type) ? (
              <>
                <p className="text-sm text-gray-600 mb-4">
                  {testModal.def.type === 'pre_conf' && 'Отправит анонс знакомства со спикерами с горизонтальной афишей, описанием конференции и ссылкой на регистрацию на тестовые Telegram ID из настроек.'}
                  {testModal.def.type === 'gift' && 'Отправит сообщения о подарке для каждого спикера выбранного дня (по порядку программы) на тестовые Telegram ID из настроек.'}
                  {testModal.def.type === 'speaker_intro' && 'Отправит «Знакомство со спикером» для каждого спикера выбранного дня (с фото афиши) на тестовые Telegram ID из настроек.'}
                  {testModal.def.type === '5min_before' && 'Отправит «Анонс спикера» для каждого спикера выбранного дня (с реальной ссылкой на эфир и фото) на тестовые Telegram ID из настроек.'}
                  {testModal.def.type === '2h_before_unreg' && `Отправит сообщение для незарегистрированных для каждого дня конференции. Итого ${confDays.length} сообщений на каждый тестовый аккаунт.`}
                  {testModal.def.type === '2h_before_reg' && `Отправит сообщение для зарегистрированных для каждого дня конференции. Итого ${confDays.length} сообщений на каждый тестовый аккаунт.`}
                  {testModal.def.type === 'day_live' && `Отправит сообщение о старте эфира для каждого дня конференции. Итого ${confDays.length} сообщений на каждый тестовый аккаунт.`}
                  {testModal.def.type === 'day_end' && `Отправит итоги дня для каждого дня конференции. Итого ${confDays.length} сообщений на каждый тестовый аккаунт.`}
                  {testModal.def.type === '30min_before' && 'Отправит сообщение «за 30 минут до старта» на тестовые Telegram ID из настроек.'}
                  {testModal.def.type === 'event_live' && 'Отправит сообщение «за 5 минут до старта эфира» на тестовые Telegram ID из настроек.'}
                </p>

                {!testResult && (() => {
                  // «Все дни» — только для типов, которые шлются по каждому дню конференции.
                  // 30min_before / event_live / спикерские — единичная тестовая отправка.
                  const MULTI_DAY = ['2h_before_unreg', '2h_before_reg', 'day_live', 'day_end']
                  const isMultiDay = MULTI_DAY.includes(testModal.def.type) && confDays.length > 0
                  return (
                  <>
                    {isMultiDay && (
                      <p className="text-xs text-gray-400 mb-4">Будет отправлено для каждого из {confDays.length} дней</p>
                    )}
                    <button
                      onClick={runTest}
                      disabled={testSending}
                      className="w-full py-2.5 rounded-xl text-sm font-medium text-white flex items-center justify-center gap-2"
                      style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)', opacity: testSending ? 0.7 : 1 }}
                    >
                      {testSending
                        ? <><Loader2 size={15} className="animate-spin" /> Отправляем...</>
                        : <><Send size={15} /> {isMultiDay ? `Отправить тест — все дни (${confDays.length} сообщений)` : 'Отправить тест'}</>
                      }
                    </button>
                  </>
                  )
                })()}
                {testResult && testResult.ok && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-emerald-700 mb-3 flex items-center gap-2">
                      <CheckCircle size={16} /> День {testDay} — отправлено {testResult.sent} спикеров
                    </p>
                    {testResult.details?.map((d: any, i: number) => (
                      <div key={i} className="bg-gray-50 rounded-xl px-3 py-2">
                        <p className="text-xs font-medium text-gray-700 mb-1">{d.speaker}</p>
                        <div className="flex flex-wrap gap-2">
                          {d.results?.map((r: any, j: number) => (
                            <span key={j} className={`text-xs flex items-center gap-1 ${r.ok ? 'text-emerald-600' : 'text-red-500'}`}>
                              {r.ok ? <CheckCircle size={11} /> : <XCircle size={11} />}
                              {r.chat_id}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                    <button onClick={() => { setTestResult(null) }}
                      className="w-full mt-2 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
                      Отправить ещё раз
                    </button>
                  </div>
                )}
                {testResult && !testResult.ok && (
                  <div className="bg-red-50 rounded-xl p-3 flex items-start gap-2 text-sm text-red-700">
                    <XCircle size={16} className="shrink-0 mt-0.5" />
                    {testResult.message || testResult.error || 'Ошибка отправки'}
                  </div>
                )}
              </>
            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
                Тестовая отправка для этого шаблона пока не реализована.
              </div>
            )}

            <button onClick={() => setTestModal(null)}
              className="w-full mt-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
              Закрыть
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
