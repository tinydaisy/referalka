'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Edit2, Eye, X, ChevronDown, ChevronUp, Send, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { getTimezone } from '@/lib/timezone'

type TypeDef = {
  type: string
  title: string
  hint: string
  variables: string[]
  hasSpeaker?: boolean
  showPhoto?: boolean
}

const TYPE_DEFS: TypeDef[] = [
  {
    type: 'speaker_intro',
    title: 'Знакомство со спикером',
    hint: 'Рассылается участникам для представления спикера. Фото — афиша спикера. Текст генерируется автоматически из данных спикера.',
    variables: ['{speaker_name}', '{speaker_role}', '{speaker_tg}', '{speaker_instagram}', '{speaker_topic}', '{speaker_achievements}', '{gift_after_speech_title}', '{gift_raffle_title}', '{registration_url}'],
    hasSpeaker: true,
    showPhoto: true,
  },
  {
    type: 'pre_start',
    title: 'Анонс спикера',
    hint: 'Отправляется за 5 минут до начала выступления. Фото — афиша спикера.',
    variables: ['{speaker_name}', '{speaker_topic}', '{stream_url}'],
    hasSpeaker: true,
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
    type: 'day_start_30min_unreg',
    title: 'День конференции — за 30 мин (не зарегистрирован)',
    hint: 'Для тех, кто ещё не зарегистрирован. Кнопка и ссылка — на лендинг регистрации. Фото — горизонтальная афиша.',
    variables: ['{conf_title}', '{day_number}', '{day_date}', '{day_program}', '{registration_url}'],
    showPhoto: true,
  },
  {
    type: 'day_start_30min_reg',
    title: 'День конференции — за 30 мин (зарегистрирован)',
    hint: 'Для уже зарегистрированных участников. Кнопка и ссылка — на вебинарную комнату дня. Фото — горизонтальная афиша.',
    variables: ['{conf_title}', '{day_number}', '{day_date}', '{day_program}', '{stream_url}'],
    showPhoto: true,
  },
  {
    type: 'day_live',
    title: 'День конференции — старт эфира',
    hint: 'Отправляется в момент начала дня конференции.',
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
]

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
  { name: '{registration_url}', desc: 'Ссылка на лендинг регистрации' },
  { name: '{conf_title}', desc: 'Название конференции' },
  { name: '{day_number}', desc: 'Номер дня (1, 2, 3…)' },
  { name: '{day_ordinal}', desc: 'Номер дня словом (первом, втором…)' },
  { name: '{day_date}', desc: 'Дата дня конференции' },
  { name: '{day_program}', desc: 'Программа дня (список спикеров и тем)' },
  { name: '{next_day_mention}', desc: 'Фраза про следующую встречу (авто: завтра/дата, пусто если последний день)' },
  { name: '{raffle_url}', desc: 'Ссылка на розыгрыш' },
  { name: '{day_speakers_gifts}', desc: 'Список подарков спикеров за день' },
]

const emptyForm = { name: '', type: 'pre_start', text: '', photo_url: '', button_text: '', button_url: '' }

export default function TemplatesPage() {
  const { id } = useParams()
  const eventId = Number(id)

  const [templates, setTemplates] = useState<any[]>([])
  const [speakers, setSpeakers] = useState<any[]>([])
  const [editModal, setEditModal] = useState<any>(null)
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
  const [confSessions, setConfSessions] = useState<any[]>([])
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
    api.conference.sessions.list(eventId).then(r => setConfSessions(r.sessions || [])).catch(() => {})
  }, [eventId])

  async function save() {
    try {
      const res = await api.conference.templates.update(eventId, editModal.id, form)
      setTemplates(templates.map((x: any) => x.id === editModal.id ? res : x))
      setEditModal(null)
    } catch (e: any) {
      alert(e.message)
    }
  }

  function openEdit(t: any) {
    setEditModal(t)
    setForm({
      name: t.name,
      type: t.type,
      text: (t.text || '').replace(/\\n/g, '\n'),
      photo_url: t.photo_url || '',
      button_text: t.button_text || '',
      button_url: t.button_url || '',
    })
  }

  function openPreview(tpl: any, def: TypeDef) {
    // Перечитываем актуальные данные из БД при каждом открытии превью
    api.conference.days.list(eventId).then(r => {
      const days = r.days || []
      const dayNums = days.map((d: any) => d.day_number).sort((a: number, b: number) => a - b)
      if (dayNums.length > 0) setConfDays(dayNums)
      setConfDaysData(days)
    }).catch(() => {})
    api.conference.get(eventId).then(r => setConfData(r.conference)).catch(() => {})
    api.conference.sessions.list(eventId).then(r => setConfSessions(r.sessions || [])).catch(() => {})
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
      const DAY_TYPES = ['day_start_30min_unreg', 'day_start_30min_reg', 'day_live', 'day_end']
      const isDayType = DAY_TYPES.includes(testModal.def.type)
      if (isDayType) {
        // Для day-шаблонов: отправить только этот шаблон для каждого дня
        const allDetails: any[] = []
        for (const d of confDays) {
          const r = await api.conference.templates.test(eventId, testModal.tpl.id, d)
          if (r.details) allDetails.push(...r.details)
        }
        setTestResult({ ok: true, sent: allDetails.length, details: allDetails })
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
    return dayObj?.stream_url || '🔗 [ссылка на эфир]'
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
        const ROLE_MAP: Record<string, string> = { speaker: 'Спикер', headliner: 'Хедлайнер', partner: 'Партнёр', organizer: 'Организатор' }
        const roleLabel = ROLE_MAP[speaker.role] || 'Спикер'
        const tgChannel = (speaker.tg_channel_url || '').trim()
        const insta = (speaker.instagram_url || '').trim()
        const achList: string[] = (speaker.achievements || []).filter(Boolean)
        const topic = (speaker.topics?.[0]?.topic || speaker.topic || '').trim()
        const achText = achList.length > 0 ? achList.map(a => `• ${a}`).join('\n') : `• ${topic || 'уточняется'}`

        // Подставляем переменные в текст шаблона
        out = out
          .replace(/\{speaker_name\}/g, speaker.name || '')
          .replace(/\{speaker_role\}/g, roleLabel)
          .replace(/\{speaker_topic\}/g, topic || 'уточняется')
          .replace(/\{speaker_achievements\}/g, achText)
          .replace(/\{gift_after_speech_title\}/g, giftTitle)
          .replace(/\{gift_raffle_title\}/g, giftRaffle)
          .replace(/\{registration_url\}/g, confData?.registration_url || '')

        // Тг канал — строку целиком убираем если нет
        if (tgChannel) {
          out = out.replace(/\{speaker_tg\}/g, `<b>Тг канал:</b> ${tgChannel}`)
        } else {
          out = out.replace(/^.*\{speaker_tg\}.*$\n?/gm, '')
        }
        if (insta) {
          out = out.replace(/\{speaker_instagram\}/g, `<b>Нельзяграм:</b> ${insta}`)
        } else {
          out = out.replace(/^.*\{speaker_instagram\}.*$\n?/gm, '')
        }
        // Подарки — строки убираем если нет
        if (!giftTitle) out = out.replace(/^.*🎁.*\{gift_after_speech_title\}.*$\n?/gm, '')
        if (!giftRaffle) out = out.replace(/^.*🏆.*\{gift_raffle_title\}.*$\n?/gm, '')

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
          .replace(/\{speaker_topic\}/g, speaker.topics?.[0]?.topic || speaker.topic || 'уточняется')
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
          .replace(/\{speaker_topic\}/g, speaker.topics?.[0]?.topic || speaker.topic || 'уточняется')
          .replace(/\{stream_url\}/g, getStreamUrl(day))
      }
    }

    const d = day ?? testDay
    const dayObj = confDaysData.find((x: any) => x.day_number === d)
    const realStreamUrl = dayObj?.stream_url || ''
    const realRegUrl = confData?.registration_url || ''
    const realConfTitle = confData?.event_title || confData?.title || '[Название конференции]'
    const realDayDate = dayObj?.day_date
      ? new Date(dayObj.day_date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
      : `День ${d}`

    // Строим программу дня из сессий
    const daySessions = confSessions.filter((s: any) => s.day === d)
    const ROLE_LABELS: Record<string, string> = { headliner: 'Хедлайнер', partner: 'Партнёр', organizer: 'Организатор' }
    const dayProgram = daySessions.length > 0
      ? daySessions.map((s: any) => {
          const fmt = (dt: string) => { if (!dt) return ''; return new Date(dt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: getTimezone() }) }
          const timeStart = fmt(s.start_datetime)
          const timeEnd = fmt(s.end_datetime)
          const timePart = timeStart && timeEnd ? `${timeStart}-${timeEnd}` : timeStart
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

    // Подарки спикеров дня для превью
    const speakerGiftBlocks = daySessions
      .filter((s: any) => s.speaker_name)
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
    const curDaySessions = confSessions.filter((s: any) => s.day === d)
    const nextDaySessions = confSessions.filter((s: any) => s.day === d + 1)
    let nextDayMention = ''
    if (nextDaySessions.length > 0 && nextDaySessions[0].start_datetime) {
      const nextDt = new Date(nextDaySessions[0].start_datetime)
      const userTz = getTimezone()
      const nextTime = nextDt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: userTz })
      // Для сравнения дат берём дату в таймзоне пользователя
      const toLocalDate = (d: Date) => new Date(d.toLocaleDateString('en-CA', { timeZone: userTz }))
      let diffDays = 999
      if (curDaySessions.length > 0 && curDaySessions[0].start_datetime) {
        const curDt = new Date(curDaySessions[0].start_datetime)
        diffDays = Math.round((toLocalDate(nextDt).getTime() - toLocalDate(curDt).getTime()) / 86400000)
      }
      const nextLocalDate = toLocalDate(nextDt)
      const when = diffDays === 1 ? 'завтра' : `${nextLocalDate.getUTCDate()} ${MONTHS_RU[nextLocalDate.getUTCMonth()]}`
      nextDayMention = `Встречаемся ${when} в ${nextTime} на День ${d + 1}.`
    }

    out = out
      .replace(/\{conf_title\}/g, realConfTitle)
      .replace(/\{day_number\}/g, String(d))
      .replace(/\{day_ordinal\}/g, dayOrdinal)
      .replace(/\{day_date\}/g, realDayDate)
      .replace(/\{day_program\}/g, dayProgram)
      .replace(/\{next_day_mention\}/g, nextDayMention)
      .replace(/\{raffle_url\}/g, realRaffleUrl || '🔗 [ссылка на розыгрыш]')
      .replace(/\{day_speakers_gifts\}/g, daySpeakersGifts)
      .replace(/\{stream_url\}/g, realStreamUrl || '🔗 [ссылка на эфир]')
      .replace(/\{registration_url\}/g, realRegUrl || '🔗 [ссылка на регистрацию]')
      .replace(/\{gift_url\}/g, '🔗 [ссылка на подарок]')
      .replace(/\{gift_title\}/g, '[название подарка]')
      .replace(/\{gift_after_speech_title\}/g, '[подарок на эфире]')
      .replace(/\{gift_raffle_title\}/g, '[подарок для розыгрыша]')
      .replace(/\{speaker_name\}/g, '[Имя спикера]')
      .replace(/\{speaker_tg\}/g, '')
      .replace(/\{speaker_topic\}/g, '[тема]')
      .replace(/\{speaker_achievements\}/g, '')

    // Убираем незамененные переменные если пустые
    if (!nextDayMention) out = out.replace(/^.*\{next_day_mention\}.*$\n?/gm, '')
    if (!daySpeakersGifts) out = out.replace(/^.*\{day_speakers_gifts\}.*$\n?/gm, '')
    // Схлопываем 3+ пустых строки подряд
    out = out.replace(/\n{3,}/g, '\n\n')
    return out.trim()
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-4">
        Шаблоны создаются автоматически. Отредактируйте тексты — плейсхолдеры вида{' '}
        <code className="text-xs bg-gray-100 rounded px-1">{'{speaker_name}'}</code> подставятся при отправке.
        Потом перейдите в «Очередь рассылок» и нажмите «Создать из программы».
      </p>

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
        {TYPE_DEFS.map(def => {
          const tpl = templates.find(t => t.type === def.type)
          return (
            <div key={def.type} className="bg-white rounded-2xl border border-gray-100 p-5">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <h4 className="font-semibold text-gray-800">{def.title}</h4>
                  <p className="text-xs text-gray-400 mt-0.5">{def.hint}</p>
                </div>
                <div className="flex flex-wrap gap-2 shrink-0">
                  {tpl && (
                    <button onClick={() => openTest(tpl, def)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-emerald-700 font-medium border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 transition-colors">
                      <Send size={13} /> Протестировать
                    </button>
                  )}
                  {tpl && (
                    <button onClick={() => openPreview(tpl, def)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-gray-600 font-medium border border-gray-200 hover:bg-gray-50 transition-colors">
                      <Eye size={13} /> Просмотреть
                    </button>
                  )}
                  {tpl && (
                    <button onClick={() => openEdit(tpl)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm text-white font-medium"
                      style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                      <Edit2 size={13} /> Редактировать
                    </button>
                  )}
                </div>
              </div>

              {!tpl ? (
                <div className="py-8 text-center text-gray-400 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                  <Edit2 size={22} className="mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Шаблон ещё не создан — обновите страницу</p>
                </div>
              ) : (
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-xs text-gray-700 whitespace-pre-wrap font-mono mb-3">{(tpl.text || '').replace(/\\n/g, '\n')}</p>
                  <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                    {tpl.photo_url ? (
                      <span>📷 Своё фото</span>
                    ) : def.showPhoto ? (
                      <span className="text-blue-500">📸 Афиша подставится автоматически</span>
                    ) : null}
                    {tpl.button_text && <span>🔘 Кнопка: «{tpl.button_text}»</span>}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

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
                <label className="text-xs text-gray-500 mb-1 block">Текст сообщения</label>
                <textarea value={form.text} onChange={e => setForm({ ...form, text: e.target.value })}
                  rows={10} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none resize-y font-mono" />
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
                  Фото (URL) — если пусто, подставится афиша автоматически
                </label>
                <input value={form.photo_url} onChange={e => setForm({ ...form, photo_url: e.target.value })}
                  placeholder="https://..."
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
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

      {/* Модалка предпросмотра */}
      {previewModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800 text-sm">Предпросмотр: {previewModal.def.title}</h3>
              <button onClick={() => setPreviewModal(null)}><X size={18} /></button>
            </div>

            {/* Выбор дня — для всех шаблонов где есть дни */}
            {confDays.length > 1 && (
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
              {/* Фото */}
              {previewModal.def.showPhoto && (() => {
                const isDayTpl = previewModal.def.type.startsWith('day_')
                const photoSrc = previewModal.tpl.photo_url
                  || (isDayTpl
                    ? confData?.poster_horizontal?.[0]
                    : previewSpeaker?.poster_url)
                const placeholder = isDayTpl ? '📸 Горизонтальная афиша конференции' : '📸 Афиша спикера'
                return photoSrc ? (
                  <img src={photoSrc} alt=""
                    className="w-full rounded-xl mb-2"
                    style={{ maxHeight: '400px', objectFit: 'contain', background: '#f0f0f0' }}
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
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

            {['gift', 'speaker_intro', 'pre_start', 'day_start_30min_unreg', 'day_start_30min_reg', 'day_live', 'day_end'].includes(testModal.def.type) ? (
              <>
                <p className="text-sm text-gray-600 mb-4">
                  {testModal.def.type === 'gift' && 'Отправит сообщения о подарке для каждого спикера выбранного дня (по порядку программы) на тестовые Telegram ID из настроек.'}
                  {testModal.def.type === 'speaker_intro' && 'Отправит «Знакомство со спикером» для каждого спикера выбранного дня (с фото афиши) на тестовые Telegram ID из настроек.'}
                  {testModal.def.type === 'pre_start' && 'Отправит «Анонс спикера» для каждого спикера выбранного дня (с реальной ссылкой на эфир и фото) на тестовые Telegram ID из настроек.'}
                  {testModal.def.type === 'day_start_30min_unreg' && `Отправит сообщение для незарегистрированных для каждого дня конференции. Итого ${confDays.length} сообщений на каждый тестовый аккаунт.`}
                  {testModal.def.type === 'day_start_30min_reg' && `Отправит сообщение для зарегистрированных для каждого дня конференции. Итого ${confDays.length} сообщений на каждый тестовый аккаунт.`}
                  {testModal.def.type === 'day_live' && `Отправит сообщение о старте эфира для каждого дня конференции. Итого ${confDays.length} сообщений на каждый тестовый аккаунт.`}
                  {testModal.def.type === 'day_end' && `Отправит итоги дня для каждого дня конференции. Итого ${confDays.length} сообщений на каждый тестовый аккаунт.`}
                </p>
                {!testResult && (
                  <>
                    <p className="text-xs text-gray-400 mb-4">Будет отправлено для каждого из {confDays.length} дней</p>
                    <button
                      onClick={runTest}
                      disabled={testSending}
                      className="w-full py-2.5 rounded-xl text-sm font-medium text-white flex items-center justify-center gap-2"
                      style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)', opacity: testSending ? 0.7 : 1 }}
                    >
                      {testSending
                        ? <><Loader2 size={15} className="animate-spin" /> Отправляем...</>
                        : <><Send size={15} /> Отправить тест — все дни ({confDays.length} сообщений)</>
                      }
                    </button>
                  </>
                )}
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
