'use client'
/**
 * Мини-кабинет спикера: pluson.ru/speaker/<event_slug>.
 * Не Mini App — обычная веб-страница.
 *
 * Шаги:
 *  1) Грузим список фамилий спикеров события (GET /public/speaker-cabinet/{slug}/speakers).
 *  2) Спикер выбирает свою фамилию, вводит access_code (8 симв из дашборда клиента).
 *  3) POST /auth → JWT в localStorage.
 *  4) GET /me → форма правки. PATCH /me → сохраняем.
 *
 * Авторизация stateless, спикер может передать код ассистенту — тот заполнит за него.
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
import QrLinkButton from '@/components/QrLinkButton'

const API = process.env.NEXT_PUBLIC_API_URL || 'https://pluson.ru'
const PEACH = '#FFCFA4'
const DARK = '#25455D'

type SpeakerListItem = {
  speaker_event_id: number
  collaborator_id: number
  first_name: string
  last_name: string
  full_name: string
}

type SpeakerMe = {
  speaker_event_id: number
  collaborator_id: number
  event_id: number
  event_title: string
  event_slug: string
  role: string
  name: string | null
  title: string | null
  achievements: string[] | null
  photo_url: string | null
  // poster_url убран миграцией 121: афиши теперь библиотека на стороне клиента,
  // спикер их только просматривает в разделе «Материалы».
  photo_folder_url: string | null
  video_folder_url: string | null
  tg_channel_url: string | null
  vk_url: string | null
  max_url: string | null
  instagram_url: string | null
  website_url: string | null
  tg_channel_id: string | null
  assistant_tg_username: string | null
  email: string | null
  phone: string | null
  personal_tg_id: string | null
  personal_tg_username: string | null
  personal_vk_id: string | null
  personal_vk_username: string | null
  personal_max_id: string | null
  personal_max_username: string | null
  tg_locked: boolean
  vk_locked: boolean
  max_locked: boolean
  needs_channel_check: boolean
  bot_in_channel: boolean | null
  ref_code: string | null
  ref_links: { telegram?: string; vk?: string; max?: string }
  topics: string[]
  gift_after_speech_title: string | null
  gift_after_speech_url: string | null
  gift_lead_magnet_id: number | null
  gift_package_id: number | null
  gift_lead_magnet: { kind: string; id: number; name: string } | null
  gift_lead_magnets: { kind: string; id: number; name: string }[]
  linked_client_id: number | null
  linked_client_email: string | null
  gift_raffle_title: string | null
  gift_raffle_url: string | null
  knowledge_base_title: string | null
  knowledge_base_url: string | null
  notes: string | null
  ask_topics: string | null
  show_topic_field: boolean
  show_gift_after_speech_field: boolean
  show_knowledge_base_field: boolean
  show_notes_field: boolean
  show_ask_topics_field: boolean
  raffle_enabled: boolean | null
  // subscribers — число в тысячах (float, например 19.9 = 19.9к)
  media_assets: { platform: string; subscribers: number }[] | null
}

const MEDIA_PLATFORMS: { slug: string; label: string }[] = [
  { slug: 'tg',        label: 'Telegram' },
  { slug: 'youtube',   label: 'YouTube' },
  { slug: 'vk',        label: 'VK' },
  { slug: 'tiktok',    label: 'TikTok' },
  { slug: 'instagram', label: 'Instagram' },
  { slug: 'max',       label: 'MAX' },
  { slug: 'rutube',    label: 'RuTube' },
  { slug: 'chatbots',  label: 'Чат-боты' },
  { slug: 'database',  label: 'База' },
  { slug: 'total',     label: 'Суммарно' },
]

const TOKEN_KEY = (slug: string) => `speaker_cabinet_token_${slug}`

type SpeakerMaterials = {
  event_id: number
  event_slug: string
  event_title: string
  posters: { id: number; url: string; orientation: 'horizontal' | 'vertical' | 'square'; sort: number }[]
  // Афиши дней события (миграция 215): своя афиша под каждый день программы.
  day_posters?: {
    id: number; url: string; orientation: 'horizontal' | 'vertical' | 'square'
    sort: number; day: number; day_title: string; day_date: string | null
  }[]
  // Фото профиля коллаба (collaborators.photo_url) — «Фото для сайта»
  photo_url: string | null
  // Афиша помеченная клиентом «Для рассылок по чат-боту» в этой конференции.
  // NULL → fallback на первую из библиотеки.
  broadcast_poster_url: string | null
  // Афиши помеченные «Для анонсов» — массив (миграция 122).
  announcement_posters: { id: number; url: string; label: string | null; sort_order: number }[]
  // Алиас для обратной совместимости (тот же URL что broadcast_poster_url).
  speaker_poster_url: string | null
  event_video_url: string | null
  speaker_video_url: string | null
  announcement_texts: { id: number; content: string; sort: number }[]
  ref_links: { telegram?: string; vk?: string; max?: string }
  partner_link: { telegram?: string; vk?: string; max?: string }
  partner_landing_configured: boolean
  // Партнёрский код самого спикера во внешней системе (миграция 118).
  // Если есть — кабинет показывает «Вы партнёр, ваш код X» вместо ссылок на регистрацию.
  speaker_external_ref_param: string | null
  // URL аффилиат-кабинета во внешней системе клиента (миграция 118).
  // Кликабельная ссылка для уже зарегистрированных партнёров.
  partner_dashboard_url: string | null
  placeholders: { link: string; event: string; date: string; brand: string }
}

type CabinetTab = 'profile' | 'materials' | 'judging' | 'myresults' | 'invited' | 'slot' | 'broadcasts'

export default function SpeakerCabinetPage() {
  const params = useParams<{ event_slug: string }>()
  const slug = params.event_slug
  const [token, setToken] = useState<string | null>(null)
  const [list, setList] = useState<SpeakerListItem[] | null>(null)
  const [eventTitle, setEventTitle] = useState<string>('')
  const [chosenId, setChosenId] = useState<number | null>(null)
  const [code, setCode] = useState('')
  const [me, setMe] = useState<SpeakerMe | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [achText, setAchText] = useState<string>('')
  const [uploading, setUploading] = useState<'speaker_photo' | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; text: string; bot_handle?: string } | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [refCopied, setRefCopied] = useState<string>('')
  const [activeTab, setActiveTab] = useState<CabinetTab>('profile')
  const [materials, setMaterials] = useState<SpeakerMaterials | null>(null)
  const [photoLinkCopied, setPhotoLinkCopied] = useState(false)
  // Привязка ПЛЮСОН-аккаунта спикера (миграция 167)
  const [plusonModal, setPlusonModal] = useState<null | 'login' | 'register'>(null)
  const [plEmail, setPlEmail] = useState('')
  const [plPassword, setPlPassword] = useState('')
  const [plBusy, setPlBusy] = useState(false)
  const [plError, setPlError] = useState<string | null>(null)
  const [myMagnets, setMyMagnets] = useState<{ magnets: { id: number; name: string; known?: number; delivered?: number }[]; packages: { id: number; name: string; known?: number; delivered?: number }[] } | null>(null)
  // Источник подарка после эфира: 'pluson' (лид-магнит из ПЛЮСОН) ИЛИ 'manual'
  // (ручной ввод). Взаимоисключающие — показываем только выбранный.
  const [giftSource, setGiftSource] = useState<'pluson' | 'manual'>('pluson')

  // Восстановить токен из localStorage
  useEffect(() => {
    if (typeof window === 'undefined' || !slug) return
    const t = localStorage.getItem(TOKEN_KEY(slug))
    if (t) setToken(t)
  }, [slug])

  // Загрузить список фамилий
  useEffect(() => {
    if (!slug || token) return
    fetch(`${API}/api/v1/public/speaker-cabinet/${slug}/speakers`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).detail || 'Ошибка')
        return r.json()
      })
      .then((d) => {
        setList(d.speakers || [])
        setEventTitle(d.event_title || '')
      })
      .catch((e) => setError(String(e.message || e)))
  }, [slug, token])

  // Если токен есть — загрузить /me
  const loadMe = useCallback(async () => {
    if (!token) return
    try {
      const r = await fetch(`${API}/api/v1/public/speaker-cabinet/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      // 401 — токен истёк/сломан; 404 — cse удалён/изменился. В обоих случаях
      // тихо сбрасываем токен и показываем форму логина, без ошибочного баннера.
      if (r.status === 401 || r.status === 404) {
        localStorage.removeItem(TOKEN_KEY(slug))
        setToken(null)
        setMe(null)
        return
      }
      if (!r.ok) throw new Error((await r.json()).detail || 'Ошибка')
      const data = await r.json()
      setMe(data)
      setAchText((data.achievements || []).join('\n'))
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }, [token, slug])

  useEffect(() => {
    loadMe()
  }, [loadMe])

  // Materials — отдельный эндпоинт. Грузим сразу как только есть me, чтобы
  // партнёрский блок (перенесён в Профиль 2026-05-30) отображался на обеих
  // вкладках, и тексты не догружались с задержкой при переключении.
  useEffect(() => {
    if (!token || !me) return
    let cancelled = false
    fetch(`${API}/api/v1/public/speaker-cabinet/me/materials`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).detail || 'Ошибка')
        return r.json()
      })
      .then((d) => { if (!cancelled) setMaterials(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token, me, activeTab])

  // ПЛЮСОН-привязка: подгружаем лид-магниты клиента когда спикер привязал кабинет.
  // ⚠️ Этот useEffect ОБЯЗАН быть выше early-return (if !token||!me) — иначе при
  // появлении me меняется число хуков → React error #310 (белый экран).
  useEffect(() => {
    if (!token || !me?.linked_client_id) { setMyMagnets(null); return }
    let cancelled = false
    fetch(`${API}/api/v1/public/speaker-cabinet/me/my-lead-magnets`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(j => { if (!cancelled) setMyMagnets(j.linked ? { magnets: j.magnets || [], packages: j.packages || [] } : null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token, me?.linked_client_id])

  // Источник подарка: при загрузке выставляем по тому, что уже заполнено.
  // Инициализация источника подарка ПРИ ПЕРВОЙ загрузке профиля: выбран
  // лид-магнит/пакет ПЛЮСОН → 'pluson'; заполнен только ручной ввод → 'manual';
  // иначе 'pluson'. ⚠️ НЕ завязываем на linked_client_id — привязка ПЛЮСОНа НЕ
  // должна сбрасывать выбор обратно на ручной (источник там ставится явно).
  // ⚠️ Хук выше early-return.
  const giftInitDone = useRef(false)
  useEffect(() => {
    if (!me || giftInitDone.current) return
    giftInitDone.current = true
    const hasPluson = !!(me.gift_lead_magnet_id || me.gift_package_id || (me.gift_lead_magnets || []).length)
    const hasManual = !!(me.gift_after_speech_title || me.gift_after_speech_url)
    setGiftSource(hasManual && !hasPluson ? 'manual' : 'pluson')
  }, [me])

  const onAuth = async () => {
    if (!chosenId) { setError('Выберите свою фамилию'); return }
    if (!code.trim()) { setError('Введите код доступа'); return }
    setError(null)
    try {
      const r = await fetch(`${API}/api/v1/public/speaker-cabinet/${slug}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speaker_event_id: chosenId, access_code: code.trim() }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.detail || 'Ошибка'); return }
      localStorage.setItem(TOKEN_KEY(slug), d.token)
      setToken(d.token)
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  const onLogout = () => {
    localStorage.removeItem(TOKEN_KEY(slug))
    setToken(null)
    setMe(null)
    setChosenId(null)
    setCode('')
  }

  const onSave = async () => {
    if (!me || !token) return
    // Соцсети — ТОЛЬКО ссылкой, не никнеймом. Ник (@name / name) не открывается
    // из карточки спикера и ломает проверку подписки. Предупреждаем и не сохраняем.
    const socialFields: [string, string | null | undefined][] = [
      ['Telegram-канал', me.tg_channel_url],
      ['ВКонтакте', me.vk_url],
      ['MAX', me.max_url],
      ['Нельзяграм', me.instagram_url],
      ['Сайт', me.website_url],
    ]
    const badSocials = socialFields
      .filter(([, v]) => {
        const s = (v || '').trim()
        if (!s) return false
        return !/^https?:\/\//i.test(s)
      })
      .map(([label]) => label)
    if (badSocials.length) {
      setError(
        `Соцсети нужно указывать полной ссылкой, а не никнеймом. ` +
        `Исправьте: ${badSocials.join(', ')}. ` +
        `Например: https://t.me/username, https://vk.com/username, https://instagram.com/username`
      )
      return
    }
    setSaving(true); setError(null)
    try {
      // Регалии: парсим текстарею в массив. Сносим маркеры списков (•, *, –, и т.п.)
      const achievements = achText.split('\n')
        .map(line => line.replace(/^\s*[•●∙·*\-—–▶►▸✓✔]+\s*/, '').trim())
        .filter(Boolean)
      const payload: any = {
        name: me.name, title: me.title, achievements,
        photo_url: me.photo_url,
        photo_folder_url: me.photo_folder_url, video_folder_url: me.video_folder_url,
        tg_channel_url: me.tg_channel_url, tg_channel_id: me.tg_channel_id,
        assistant_tg_username: me.assistant_tg_username,
        vk_url: me.vk_url, max_url: me.max_url,
        instagram_url: me.instagram_url, website_url: me.website_url,
        email: me.email, phone: me.phone,
        personal_tg_id: me.personal_tg_id, personal_tg_username: me.personal_tg_username,
        personal_vk_id: me.personal_vk_id, personal_vk_username: me.personal_vk_username,
        personal_max_id: me.personal_max_id, personal_max_username: me.personal_max_username,
        topics: me.topics,
        media_assets: Array.isArray(me.media_assets) ? me.media_assets : [],
      }
      if (me.show_gift_after_speech_field) {
        // Подарок взаимоисключающий: ручной ИЛИ из ПЛЮСОНа. При сохранении
        // ручного — обнуляем ПЛЮСОН-подарок (иначе в БД остаются оба и шаблон
        // подставляет не то). Источник запоминаем по giftSource.
        if (giftSource === 'manual') {
          payload.gift_after_speech_title = me.gift_after_speech_title
          payload.gift_after_speech_url = me.gift_after_speech_url
          payload.gift_lead_magnet_id = null
          payload.gift_package_id = null
          payload.gift_lead_magnets = []  // снять список ПЛЮСОН-подарков
        } else {
          // источник ПЛЮСОН — ручной текст не сохраняем (список сохранён через saveGiftMagnets)
          payload.gift_after_speech_title = null
          payload.gift_after_speech_url = null
        }
      }
      if (me.raffle_enabled) {
        payload.gift_raffle_title = me.gift_raffle_title
        payload.gift_raffle_url = me.gift_raffle_url
      }
      if (me.show_knowledge_base_field) {
        payload.knowledge_base_title = me.knowledge_base_title
        payload.knowledge_base_url = me.knowledge_base_url
      }
      if (me.show_notes_field) {
        payload.notes = me.notes
      }
      if (me.show_ask_topics_field) {
        payload.ask_topics = me.ask_topics
      }
      const r = await fetch(`${API}/api/v1/public/speaker-cabinet/me`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.detail || 'Ошибка'); return }
      setMe(d)
      setAchText((d.achievements || []).join('\n'))
      setSavedAt(new Date())
    } catch (e: any) {
      setError(String(e.message || e))
    } finally {
      setSaving(false)
    }
  }

  const onVerifyChannel = async () => {
    if (!token) return
    setVerifying(true); setVerifyResult(null); setError(null)
    try {
      const r = await fetch(`${API}/api/v1/public/speaker-cabinet/me/verify-channel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const d = await r.json()
      if (r.ok && d.ok) {
        setVerifyResult({ ok: true, text: 'Бот видит вас в канале. Проверка подписки на ваш канал будет работать.', bot_handle: d.bot_handle })
        update({ bot_in_channel: true })
        if (d.channel_id) update({ tg_channel_id: d.channel_id })
      } else if (r.ok && !d.ok) {
        setVerifyResult({ ok: false, text: d.detail || 'Не получилось проверить', bot_handle: d.bot_handle })
      } else {
        setVerifyResult({ ok: false, text: d.detail || 'Ошибка проверки' })
      }
    } catch (e: any) {
      setVerifyResult({ ok: false, text: String(e.message || e) })
    } finally {
      setVerifying(false)
    }
  }

  const onDeletePhoto = async () => {
    if (!token) return
    if (!confirm('Удалить фото профиля?')) return
    setError(null)
    try {
      // Мгновенно сохраняем пустое фото через PATCH /me — как и загрузка,
      // удаление применяется сразу, без необходимости жать «Сохранить».
      const r = await fetch(`${API}/api/v1/public/speaker-cabinet/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ photo_url: null }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.detail || 'Не удалось удалить'); return }
      update({ photo_url: null })
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }

  const onUpload = async (kind: 'speaker_photo', file: File) => {
    if (!token) return
    setUploading(kind); setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('kind', kind)
      const r = await fetch(`${API}/api/v1/public/speaker-cabinet/me/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      })
      const d = await r.json()
      if (!r.ok) { setError(d.detail || 'Ошибка загрузки'); return }
      update({ photo_url: d.url })
    } catch (e: any) {
      setError(String(e.message || e))
    } finally {
      setUploading(null)
    }
  }

  // ─── UI: экран авторизации ─────────────────────────────────────────────
  if (!token || !me) {
    return (
      <div style={{ minHeight: '100vh', background: `linear-gradient(45deg, ${DARK}, #0a1520)`, padding: 20, fontFamily: 'Roboto, sans-serif' }}>
        <div style={{ maxWidth: 480, margin: '40px auto', background: '#fff', borderRadius: 16, padding: 28, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, marginBottom: 8 }}>Кабинет спикера</h1>
          {eventTitle && <div style={{ fontSize: 15, color: '#5c7589', marginBottom: 20 }}>«{eventTitle}»</div>}

          {/* Настоящая <form> с полями username+password — чтобы браузер
              предлагал сохранить логин как пароль и потом автозаполнял его.
              Фамилия выбирается кастомным пикером, но для менеджера паролей
              нужен реальный <input autoComplete="username">: держим скрытый,
              синхронизированный с выбранной фамилией. При автозаполнении из
              менеджера паролей он получает значение → резолвим в chosenId. */}
          <form onSubmit={(e) => { e.preventDefault(); onAuth() }}>
            <label style={{ display: 'block', fontSize: 13, color: '#5c7589', marginBottom: 6 }}>Найдите свою фамилию</label>
            <SpeakerPicker
              list={list || []}
              chosenId={chosenId}
              setChosenId={setChosenId}
              onUsernameAutofill={(name) => {
                const found = (list || []).find(
                  sp => sp.full_name.toLowerCase().replace(/ё/g, 'е').trim()
                        === name.toLowerCase().replace(/ё/g, 'е').trim()
                )
                if (found) setChosenId(found.speaker_event_id)
              }}
            />

            <label style={{ display: 'block', fontSize: 13, color: '#5c7589', marginBottom: 6 }}>Код доступа (из сообщения от организатора)</label>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="abcd1234"
              style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: '1px solid #d4dee5', fontSize: 15, marginBottom: 16, fontFamily: 'monospace', letterSpacing: 2, boxSizing: 'border-box' }}
            />

            {error && <div style={{ background: '#ffe9e0', color: '#a83e1c', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

            <button
              type="submit"
              style={{ width: '100%', padding: '14px', background: PEACH, color: DARK, fontWeight: 700, fontSize: 15, border: 'none', borderRadius: 10, cursor: 'pointer' }}
            >
              Войти
            </button>
          </form>

          <p style={{ marginTop: 16, fontSize: 12, color: '#7a8c9c', lineHeight: 1.5 }}>
            Сессия живёт 24 часа. Браузер предложит сохранить фамилию и код — тогда в следующий раз подставит их сам. Можно передать ссылку и код ассистенту — он заполнит за вас.
          </p>
        </div>
      </div>
    )
  }

  // ─── UI: форма правки ──────────────────────────────────────────────────
  const inputCss: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d4dee5', fontSize: 14, background: '#fff'
  }
  const labelCss: React.CSSProperties = { display: 'block', fontSize: 12, color: '#5c7589', marginBottom: 4, marginTop: 14 }
  const btnCss: React.CSSProperties = {
    padding: '8px 14px', borderRadius: 8, border: '1px solid #cfd9e2', background: '#fff',
    color: DARK, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  }
  const buttonSmall: React.CSSProperties = {
    padding: '6px 12px',
    background: '#fff',
    border: '1px solid #d4dee5',
    borderRadius: 8,
    fontSize: 12,
    color: DARK,
    cursor: 'pointer',
    fontWeight: 500,
  }

  const update = (patch: Partial<SpeakerMe>) => setMe((m) => m ? ({ ...m, ...patch }) : m)

  // ── Привязка ПЛЮСОН-аккаунта (миграция 167). Загрузка магнитов — в useEffect
  // выше early-return (см. комментарий там). Здесь только обработчики действий. ──

  const doPlusonAuth = async () => {
    if (!token || !plusonModal) return
    setPlBusy(true); setPlError(null)
    try {
      const path = plusonModal === 'register' ? 'register-pluson' : 'link-pluson'
      const r = await fetch(`${API}/api/v1/public/speaker-cabinet/me/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: plEmail.trim(), password: plPassword }),
      })
      const j = await r.json()
      if (!r.ok) { setPlError(j.detail || 'Не удалось подключить ПЛЮСОН'); setPlBusy(false); return }
      update({ linked_client_id: j.linked_client_id, linked_client_email: j.linked_client_email })
      // После привязки ПЛЮСОНа остаёмся на подвкладке «лид-магнит из ПЛЮСОНа»,
      // не перекидываем на ручной ввод.
      setGiftSource('pluson')
      setPlusonModal(null); setPlEmail(''); setPlPassword('')
    } catch {
      setPlError('Ошибка сети')
    }
    setPlBusy(false)
  }

  const unlinkPluson = async () => {
    if (!token) return
    if (!confirm('Отвязать ПЛЮСОН-аккаунт? Выбранный подарок-лид-магнит тоже снимется.')) return
    await fetch(`${API}/api/v1/public/speaker-cabinet/me/unlink-pluson`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    })
    update({ linked_client_id: null, linked_client_email: null, gift_lead_magnet_id: null, gift_package_id: null, gift_lead_magnet: null, gift_lead_magnets: [] })
    setMyMagnets(null)
  }

  // Выбор магнита/пакета из списка → сохраняем сразу.
  // Список до 4 подарков-лид-магнитов (миграция 200). Всегда шлём полный массив
  // в нужном порядке. Выбор ПЛЮСОН-подарков обнуляет ручной текст (взаимоисключение).
  const saveGiftMagnets = async (list: { kind: string; id: number; name: string }[]) => {
    if (!token) return
    const body: any = { gift_lead_magnets: list.map((x) => ({ kind: x.kind, id: x.id })) }
    if (list.length) { body.gift_after_speech_title = null; body.gift_after_speech_url = null }
    const r = await fetch(`${API}/api/v1/public/speaker-cabinet/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    if (r.ok) {
      update({
        gift_lead_magnets: list,
        gift_lead_magnet: list[0] || null,
        gift_lead_magnet_id: list[0]?.kind === 'magnet' ? list[0].id : null,
        gift_package_id: list[0]?.kind === 'package' ? list[0].id : null,
        ...(list.length ? { gift_after_speech_title: '', gift_after_speech_url: '' } : {}),
      })
    } else {
      const j = await r.json().catch(() => ({}))
      alert(j.detail || 'Не удалось сохранить выбор')
    }
  }
  const addGiftMagnet = (val: string) => {
    const cur = me?.gift_lead_magnets || []
    if (cur.length >= 4 || !val) return
    let item: { kind: string; id: number; name: string } | null = null
    if (val.startsWith('m:')) {
      const id = parseInt(val.slice(2), 10)
      const m = myMagnets?.magnets.find((x) => x.id === id)
      if (m) item = { kind: 'magnet', id, name: m.name }
    } else if (val.startsWith('p:')) {
      const id = parseInt(val.slice(2), 10)
      const p = myMagnets?.packages.find((x) => x.id === id)
      if (p) item = { kind: 'package', id, name: p.name }
    }
    if (!item) return
    if (cur.some((x) => x.kind === item!.kind && x.id === item!.id)) return  // без дублей
    saveGiftMagnets([...cur, item])
  }
  const removeGiftMagnet = (idx: number) => {
    const cur = me?.gift_lead_magnets || []
    saveGiftMagnets(cur.filter((_, i) => i !== idx))
  }
  const moveGiftMagnet = (idx: number, dir: -1 | 1) => {
    const cur = [...(me?.gift_lead_magnets || [])]
    const j = idx + dir
    if (j < 0 || j >= cur.length) return
    ;[cur[idx], cur[j]] = [cur[j], cur[idx]]
    saveGiftMagnets(cur)
  }

  const updTopics = (i: number, v: string) => {
    const arr = [...(me?.topics || [])]
    arr[i] = v
    update({ topics: arr })
  }
  const addTopic = () => update({ topics: [...(me?.topics || []), ''] })
  const removeTopic = (i: number) => update({ topics: (me?.topics || []).filter((_, idx) => idx !== i) })

  // Медийные активы — подписчики на платформе (миграция 111)
  const mediaAssets = (me?.media_assets || []) as { platform: string; subscribers: number }[]
  const usedPlatforms = new Set(mediaAssets.map(a => a.platform))
  const availablePlatforms = MEDIA_PLATFORMS.filter(p => !usedPlatforms.has(p.slug))
  const updMedia = (i: number, patch: Partial<{ platform: string; subscribers: number }>) => {
    update({ media_assets: mediaAssets.map((a, k) => (k === i ? { ...a, ...patch } : a)) })
  }
  const addMedia = () => {
    if (availablePlatforms.length === 0) return
    update({ media_assets: [...mediaAssets, { platform: availablePlatforms[0].slug, subscribers: 0 }] })
  }
  const removeMedia = (i: number) => {
    update({ media_assets: mediaAssets.filter((_, k) => k !== i) })
  }

  // Карточка для фото/афиши: превью + кнопки «Раскрыть», «Скачать», «Загрузить новое»
  function ImageCard({ url, kind, label }: { url: string | null, kind: 'speaker_photo', label: string }) {
    const fileInputId = `up-${kind}`
    return (
      <div>
        <label style={labelCss}>{label}</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          {url ? (
            <img
              src={url}
              alt={label}
              onClick={() => setLightbox(url)}
              style={{
                width: 90,
                height: 90,
                objectFit: 'cover',
                borderRadius: 12,
                border: '1px solid #d4dee5',
                cursor: 'zoom-in',
              }}
            />
          ) : (
            <div style={{
              width: 90,
              height: 90,
              borderRadius: 12,
              border: '1px dashed #c4d1dc',
              background: '#f5f7fa',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#9ab', fontSize: 11,
            }}>
              нет файла
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input
              id={fileInputId}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onUpload(kind, f)
                e.target.value = ''
              }}
            />
            <label htmlFor={fileInputId} style={{
              ...buttonSmall,
              cursor: uploading === kind ? 'wait' : 'pointer',
              opacity: uploading === kind ? 0.6 : 1,
            }}>
              {uploading === kind ? 'Загружаем…' : (url ? '📤 Заменить' : '📤 Загрузить')}
            </label>
            {url && (
              <>
                <button type="button" onClick={() => setLightbox(url)} style={buttonSmall}>
                  🔍 Раскрыть
                </button>
                <a
                  href={url}
                  download
                  target="_blank"
                  rel="noreferrer"
                  style={{ ...buttonSmall, textAlign: 'center', textDecoration: 'none' }}
                >
                  ⬇ Скачать
                </a>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(url)
                    setPhotoLinkCopied(true)
                    setTimeout(() => setPhotoLinkCopied(false), 1800)
                  }}
                  style={buttonSmall}
                >
                  {photoLinkCopied ? '✓ Скопировано' : '🔗 Ссылка'}
                </button>
                <button
                  type="button"
                  onClick={onDeletePhoto}
                  style={{ ...buttonSmall, color: '#c0392b', borderColor: '#f0c0b8' }}
                >
                  🗑 Удалить
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f5f7fa', padding: 16, fontFamily: 'Roboto, sans-serif' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ background: `linear-gradient(45deg, ${DARK}, #0a1520)`, color: '#fff', padding: 20, borderRadius: 14, marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div>
              <div style={{ fontSize: 13, opacity: 0.7 }}>«{me.event_title}»</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>
                {me.name || 'Спикер'}
                {me.role && <span style={{ fontWeight: 400, opacity: 0.85 }}> — {({ jury: 'жюри', organizer: 'организатор', headliner: 'хедлайнер', speaker: 'спикер', general_partner: 'генеральный партнёр', partner: 'партнёр' } as Record<string, string>)[me.role] || me.role}</span>}
              </div>
            </div>
            <button onClick={onLogout} style={{ background: 'transparent', border: '1px solid #fff', color: '#fff', padding: '8px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Выйти</button>
          </div>
        </div>

        {/* Вкладки кабинета — горизонтальный скролл, все в одну строку */}
        <div style={{
          display: 'flex', gap: 4, marginBottom: 14,
          borderBottom: '1px solid #d4dee5',
          overflowX: 'auto', flexWrap: 'nowrap',
          WebkitOverflowScrolling: 'touch',
        }}>
          {([
            { key: 'profile'   as CabinetTab, label: 'Профиль' },
            { key: 'materials' as CabinetTab, label: 'Материалы' },
            { key: 'broadcasts' as CabinetTab, label: 'Рекламные интеграции' },
            ...((me.role !== 'jury' && me.role !== 'organizer') ? [{ key: 'slot' as CabinetTab, label: 'Мой слот' }] : []),
            { key: 'invited'   as CabinetTab, label: 'Приглашённые' },
            ...((me.role === 'jury' || me.role === 'organizer') ? [{ key: 'judging' as CabinetTab, label: 'Оценка участников' }] : []),
            ...((me.role !== 'jury' && me.role !== 'organizer') ? [{ key: 'myresults' as CabinetTab, label: 'Мои результаты' }] : []),
          ]).map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              style={{
                padding: '10px 16px',
                background: 'transparent',
                border: 'none',
                borderBottom: activeTab === t.key ? `3px solid ${PEACH}` : '3px solid transparent',
                color: activeTab === t.key ? DARK : '#7a8c9c',
                fontWeight: activeTab === t.key ? 700 : 500,
                fontSize: 14,
                cursor: 'pointer',
                marginBottom: -1,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === 'materials' && (
          <MaterialsTab
            materials={materials}
            refCopied={refCopied}
            setRefCopied={setRefCopied}
            setLightbox={setLightbox}
          />
        )}

        {activeTab === 'judging' && token && <JudgingTab token={token} />}
        {activeTab === 'myresults' && token && <MyResultsTab token={token} />}
        {activeTab === 'invited' && token && <InvitedTab token={token} />}
        {activeTab === 'slot' && token && <SlotTab token={token} myName={me.name || ''} />}
        {activeTab === 'broadcasts' && token && <MyBroadcastsTab token={token} />}

        {activeTab === 'profile' && <>
        <Section title="Профиль">
          <label style={labelCss}>Имя и фамилия</label>
          <input style={inputCss} value={me.name || ''} onChange={(e) => update({ name: e.target.value })} />

          <label style={labelCss}>Telegram-ник ассистента</label>
          <input
            style={inputCss}
            value={me.assistant_tg_username || ''}
            onChange={(e) => update({ assistant_tg_username: e.target.value })}
            placeholder="username без @"
          />
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: -6, marginBottom: 4 }}>
            Если хотите, чтобы профиль за вас вёл ассистент — впишите его Telegram-ник.
            Он сможет войти в этот кабинет по ссылке от организатора и получит ваш код доступа.
          </div>

          <label style={labelCss}>Кто вы? Ваше позиционирование (кратко как роль/должность)</label>
          <input style={inputCss} value={me.title || ''} onChange={(e) => update({ title: e.target.value })} placeholder="Кто вы и чем занимаетесь" />

          <label style={labelCss}>Email</label>
          <input style={inputCss} type="email" value={me.email || ''} onChange={(e) => update({ email: e.target.value })} />

          <label style={labelCss}>Телефон</label>
          <input style={inputCss} type="tel" value={me.phone || ''} onChange={(e) => update({ phone: e.target.value })} />

          <div style={{ marginTop: 14 }}>
            <ImageCard url={me.photo_url} kind="speaker_photo" label="Фото профиля" />
          </div>

          <label style={labelCss}>Ссылка на папку с фото (Я.Диск / Google Drive)</label>
          <input style={inputCss} value={me.photo_folder_url || ''} onChange={(e) => update({ photo_folder_url: e.target.value })} placeholder="https://…" />
          <div style={{ fontSize: 11, color: '#7a8c9c', marginTop: 4, lineHeight: 1.5 }}>
            Заполняйте, если хотите предоставить несколько вариантов фото на выбор.
          </div>

          <label style={labelCss}>Ссылка на папку с видео (Я.Диск / Google Drive / YouTube)</label>
          <input style={inputCss} value={me.video_folder_url || ''} onChange={(e) => update({ video_folder_url: e.target.value })} placeholder="https://…" />

          <label style={labelCss}>Регалии — каждая на отдельной строке</label>
          <textarea
            style={{ ...inputCss, minHeight: 130, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
            value={achText}
            onChange={(e) => setAchText(e.target.value)}
            placeholder={'Спикер ТЕД\nЧемпион мира по дебатам\nАвтор 3 книг…'}
          />
          <div style={{ fontSize: 11, color: '#9ab', marginTop: 4 }}>
            Маркеры (•, *, —) можно не ставить — мы их сами уберём при сохранении.
          </div>
        </Section>

        {me.show_notes_field && (
          <Section title="Заметки">
            <div style={{ fontSize: 12, color: '#7a8c9c', marginBottom: 8, lineHeight: 1.5 }}>
              Здесь можно оставить заметки для организатора — их видит только он в вашей карточке.
            </div>
            <textarea
              style={{ ...inputCss, minHeight: 90, resize: 'vertical', fontFamily: 'inherit' }}
              value={me.notes || ''}
              onChange={(e) => update({ notes: e.target.value })}
              placeholder="Например: удобное время созвона, пожелания по гонорару, реквизиты…"
            />
          </Section>
        )}

        {me.show_ask_topics_field && (
          <Section title="С какими вопросами можно обращаться?">
            <div style={{ fontSize: 12, color: '#7a8c9c', marginBottom: 8, lineHeight: 1.5 }}>
              Список тем и вопросов, с которыми к вам можно обратиться. Показывается участникам в рассылке «Экспертный день».
            </div>
            <textarea
              style={{ ...inputCss, minHeight: 90, resize: 'vertical', fontFamily: 'inherit' }}
              value={me.ask_topics || ''}
              onChange={(e) => update({ ask_topics: e.target.value })}
              placeholder={'Как выступать бесплатно с лидерами рынка?\nКак запоминаться аудитории?\nКак регулярно выступать?'}
            />
          </Section>
        )}

        <Section title="Соцсети и каналы">
          <div style={{ fontSize: 12, color: '#7a8c9c', marginTop: -2, marginBottom: 6, lineHeight: 1.5 }}>
            Эти ссылки отображаются в Mini App события в вашей карточке — участники увидят их и смогут перейти прямо на ваш канал / сообщество / сайт.
          </div>
          <div style={{ fontSize: 12, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 10px', marginBottom: 10, lineHeight: 1.5 }}>
            Указывайте <b>полную ссылку</b> (начинается с https://), а не никнейм. По нику переход не работает.
          </div>
          <label style={labelCss}>Telegram-канал (ссылка)</label>
          <input style={inputCss} value={me.tg_channel_url || ''} onChange={(e) => update({ tg_channel_url: e.target.value })} placeholder="https://t.me/…" />
          <label style={labelCss}>VK-сообщество (ссылка)</label>
          <input style={inputCss} value={me.vk_url || ''} onChange={(e) => update({ vk_url: e.target.value })} placeholder="https://vk.com/…" />
          <label style={labelCss}>MAX-канал (ссылка)</label>
          <input style={inputCss} value={me.max_url || ''} onChange={(e) => update({ max_url: e.target.value })} placeholder="https://max.ru/…" />
          <label style={labelCss}>Instagram (Нельзяграм)</label>
          <input style={inputCss} value={me.instagram_url || ''} onChange={(e) => update({ instagram_url: e.target.value })} placeholder="https://instagram.com/…" />
          <label style={labelCss}>Сайт</label>
          <input style={inputCss} value={me.website_url || ''} onChange={(e) => update({ website_url: e.target.value })} placeholder="https://…" />
        </Section>

        <Section title="Личные аккаунты на платформах">
          <div style={{ fontSize: 12, color: '#7a8c9c', marginBottom: 8 }}>
            Не показываются другим участникам — используются только для связи. Платформы, через которые вы зашли через бота, заблокированы — менять их нельзя.
          </div>

          <PlatformAccountField
            label="Telegram"
            username={me.personal_tg_username}
            locked={!!me.tg_locked}
            onChange={(v) => update({ personal_tg_username: v })}
            placeholder="username (без @)"
            inputCss={inputCss} labelCss={labelCss}
          />
          <PlatformAccountField
            label="VK"
            username={me.personal_vk_username}
            locked={!!me.vk_locked}
            onChange={(v) => update({ personal_vk_username: v })}
            placeholder="id123456 или nickname"
            inputCss={inputCss} labelCss={labelCss}
          />
          <PlatformAccountField
            label="MAX"
            username={me.personal_max_username}
            locked={!!me.max_locked}
            onChange={(v) => update({ personal_max_username: v })}
            placeholder="username MAX"
            inputCss={inputCss} labelCss={labelCss}
          />
        </Section>

        {me.needs_channel_check && (
          <Section title="Подписка на ваш Telegram-канал">
            <div style={{ fontSize: 12, color: '#7a8c9c', marginBottom: 10 }}>
              Участники события должны быть подписаны на ваш Telegram-канал, чтобы попасть в чат / получить подарки.
              Чтобы автопроверка работала, добавьте нашего бота администратором в ваш канал и нажмите кнопку ниже.
            </div>
            <label style={labelCss}>Ссылка на ваш Telegram-канал</label>
            <input
              style={inputCss}
              value={me.tg_channel_url || ''}
              onChange={(e) => update({ tg_channel_url: e.target.value })}
              placeholder="https://t.me/your_channel"
            />
            {me.tg_channel_id && (
              <div style={{ fontSize: 11, color: '#7a8c9c', marginTop: 4 }}>ID канала: <code>{me.tg_channel_id}</code> (определяется автоматически)</div>
            )}
            <button
              type="button"
              onClick={onVerifyChannel}
              disabled={verifying}
              style={{
                marginTop: 12, padding: '10px 16px',
                background: me.bot_in_channel ? '#e6f4ea' : DARK,
                color: me.bot_in_channel ? '#2e6e3f' : '#fff',
                fontWeight: 700, border: 'none', borderRadius: 10,
                cursor: verifying ? 'wait' : 'pointer', fontSize: 13,
              }}
            >
              {verifying
                ? 'Проверяем…'
                : (me.bot_in_channel ? '✓ Бот в канале — проверить ещё раз' : 'Проверить, что бот в канале')}
            </button>
            {verifyResult && (
              <div style={{
                marginTop: 10, padding: '10px 12px', borderRadius: 8,
                background: verifyResult.ok ? '#e6f4ea' : '#ffe9e0',
                color: verifyResult.ok ? '#2e6e3f' : '#a83e1c',
                fontSize: 12, lineHeight: 1.5,
              }}>
                {verifyResult.ok ? '✓ ' : '⚠️ '}{verifyResult.text}
              </div>
            )}
            {!me.bot_in_channel && (
              <details style={{ marginTop: 10, fontSize: 12, color: '#5c7589' }}>
                <summary style={{ cursor: 'pointer' }}>Как добавить бота</summary>
                <ol style={{ marginTop: 8, paddingLeft: 18, lineHeight: 1.6 }}>
                  <li>Откройте ваш Telegram-канал.</li>
                  <li>Управление → Администраторы → Добавить администратора.</li>
                  <li>Найдите бота {verifyResult?.bot_handle ? <b>@{verifyResult.bot_handle}</b> : 'клиента (имя бота вам сообщит организатор)'} и добавьте без особых прав — достаточно стандартных.</li>
                  <li>Вернитесь сюда и нажмите «Проверить».</li>
                </ol>
              </details>
            )}
          </Section>
        )}

        {me.show_topic_field && (
          <Section title="Темы выступления">
            {(me.topics || []).map((t, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input style={inputCss} value={t} onChange={(e) => updTopics(i, e.target.value)} placeholder={`Тема ${i + 1}`} />
                <button onClick={() => removeTopic(i)} style={{ padding: '0 12px', background: '#fff', border: '1px solid #d4dee5', borderRadius: 8, cursor: 'pointer' }}>×</button>
              </div>
            ))}
            <button onClick={addTopic} style={{ padding: '8px 14px', background: '#fff', border: `1px dashed ${PEACH}`, color: DARK, borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>+ добавить тему</button>
          </Section>
        )}

        <Section title="Медийные активы">
          {mediaAssets.length === 0 && (
            <div style={{ fontSize: 12, color: '#5c7589', marginBottom: 8 }}>
              Подписчики на ваших площадках. Вводите цифру в <b>тысячах</b>: «19.9» = 19.9к.
              Лендинг события покажет ваш совокупный охват.
            </div>
          )}
          {mediaAssets.map((a, i) => {
            const usedByOthers = new Set(mediaAssets.filter((_, k) => k !== i).map(x => x.platform))
            const options = MEDIA_PLATFORMS.filter(p => !usedByOthers.has(p.slug))
            return (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <select
                  value={a.platform}
                  onChange={(e) => updMedia(i, { platform: e.target.value })}
                  style={{ ...inputCss, width: 130, flex: 'none' }}
                >
                  {options.map(p => <option key={p.slug} value={p.slug}>{p.label}</option>)}
                </select>
                <div style={{ position: 'relative', flex: 1 }}>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    min={0}
                    value={a.subscribers === 0 ? '' : a.subscribers}
                    placeholder="19.9"
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '') return updMedia(i, { subscribers: 0 })
                      const n = parseFloat(v)
                      updMedia(i, { subscribers: isNaN(n) || n < 0 ? 0 : n })
                    }}
                    style={{ ...inputCss, paddingRight: 28 }}
                  />
                  <span style={{
                    position: 'absolute', right: 12, top: '50%',
                    transform: 'translateY(-50%)', color: '#7a8c9c',
                    fontSize: 13, fontWeight: 500, pointerEvents: 'none',
                  }}>к</span>
                </div>
                <button onClick={() => removeMedia(i)} style={{ padding: '0 12px', background: '#fff', border: '1px solid #d4dee5', borderRadius: 8, cursor: 'pointer' }}>×</button>
              </div>
            )
          })}
          <button
            onClick={addMedia}
            disabled={availablePlatforms.length === 0}
            style={{
              padding: '8px 14px',
              background: '#fff',
              border: `1px dashed ${PEACH}`,
              color: availablePlatforms.length === 0 ? '#9aaab8' : DARK,
              borderRadius: 8,
              cursor: availablePlatforms.length === 0 ? 'not-allowed' : 'pointer',
              fontSize: 13,
            }}
          >
            {availablePlatforms.length === 0 ? 'Все платформы добавлены' : '+ добавить актив'}
          </button>
        </Section>

        {me.show_gift_after_speech_field && (
          <Section title="Подарок после эфира">
            {/* Выбор источника подарка — ЛИБО лид-магнит из ПЛЮСОН, ЛИБО ручной ввод. */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              {([
                { v: 'pluson', t: '🎁 Лид-магнит из ПЛЮСОН' },
                { v: 'manual', t: '✍️ Ввести вручную' },
              ] as const).map((opt) => {
                const active = giftSource === opt.v
                return (
                  <button key={opt.v} type="button" onClick={() => setGiftSource(opt.v)}
                    style={{
                      flex: '1 1 0', minWidth: 160, textAlign: 'center', cursor: 'pointer',
                      padding: '9px 12px', borderRadius: 9, fontSize: 12.5, fontWeight: 700,
                      border: active ? '2px solid #25455D' : '1px solid #d6dee6',
                      background: active ? '#EAF2FB' : '#fff',
                      color: active ? DARK : '#5b7286',
                    }}>
                    {opt.t}
                  </button>
                )
              })}
            </div>

            {/* ── Вариант 1: лид-магнит из ПЛЮСОН (для подсчёта баллов в турнире) ── */}
            {giftSource === 'pluson' && (
              <div style={{ background: '#F0F7FF', border: '1px solid #cfe2f5', borderRadius: 10, padding: 12 }}>
                {!me.linked_client_id ? (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700, color: DARK, marginBottom: 4 }}>🎁 Подарок-лид-магнит из ПЛЮСОН</div>
                    <div style={{ fontSize: 12, color: '#5b7286', lineHeight: 1.5, marginBottom: 10 }}>
                      Подключите свой кабинет ПЛЮСОН — и выберите свой лид-магнит как подарок.
                      Тогда система автоматически посчитает, сколько людей зашло по нему, и начислит вам баллы в турнире.
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button onClick={() => { setPlusonModal('login'); setPlError(null) }}
                        style={{ ...btnCss, background: DARK, color: '#fff' }}>Войти в ПЛЮСОН</button>
                      <button onClick={() => { setPlusonModal('register'); setPlError(null) }}
                        style={{ ...btnCss }}>Создать кабинет</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <div style={{ fontSize: 12.5, color: '#1d6b3a', fontWeight: 600 }}>✓ Подключён ПЛЮСОН: {me.linked_client_email}</div>
                      <button onClick={unlinkPluson} style={{ background: 'none', border: 'none', color: '#b04a4a', fontSize: 11.5, cursor: 'pointer', textDecoration: 'underline' }}>отвязать</button>
                    </div>
                    <label style={labelCss}>Подарки-лид-магниты (до 4, в порядке показа)</label>
                    {/* Список выбранных с управлением порядком/удалением */}
                    {(me.gift_lead_magnets || []).length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                        {(me.gift_lead_magnets || []).map((g, i) => {
                          const stat = g.kind === 'package'
                            ? (myMagnets?.packages || []).find((x) => x.id === g.id)
                            : (myMagnets?.magnets || []).find((x) => x.id === g.id)
                          return (
                          <div key={`${g.kind}${g.id}`} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #d7e4f0', borderRadius: 8, padding: '6px 8px' }}>
                            <span style={{ fontSize: 12, color: '#5b7286', minWidth: 16 }}>{i + 1}.</span>
                            <span style={{ flex: 1, fontSize: 13, color: DARK }}>{g.kind === 'package' ? '📦 ' : '🎁 '}{g.name}</span>
                            {stat && (
                              <span title={`${stat.known ?? 0} перешли, ${stat.delivered ?? 0} получили материалы`}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: '#FFCFA4', color: '#25455D', fontSize: 11.5, fontWeight: 600, borderRadius: 6, padding: '2px 7px', whiteSpace: 'nowrap' }}>
                                👤 {stat.known ?? 0}/{stat.delivered ?? 0}
                              </span>
                            )}
                            <button onClick={() => moveGiftMagnet(i, -1)} disabled={i === 0} title="Выше"
                              style={{ background: 'none', border: 'none', cursor: i === 0 ? 'default' : 'pointer', color: i === 0 ? '#cbd5db' : '#5b7286', fontSize: 14, padding: '0 3px' }}>↑</button>
                            <button onClick={() => moveGiftMagnet(i, 1)} disabled={i === (me.gift_lead_magnets || []).length - 1} title="Ниже"
                              style={{ background: 'none', border: 'none', cursor: i === (me.gift_lead_magnets || []).length - 1 ? 'default' : 'pointer', color: i === (me.gift_lead_magnets || []).length - 1 ? '#cbd5db' : '#5b7286', fontSize: 14, padding: '0 3px' }}>↓</button>
                            <button onClick={() => removeGiftMagnet(i)} title="Убрать"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#b04a4a', fontSize: 15, padding: '0 3px' }}>×</button>
                          </div>
                          )
                        })}
                      </div>
                    )}
                    {(me.gift_lead_magnets || []).length < 4 ? (
                      <select style={inputCss} value=""
                        onChange={(e) => { addGiftMagnet(e.target.value); e.currentTarget.value = '' }}>
                        <option value="">+ Добавить лид-магнит / пакет…</option>
                        {(myMagnets?.magnets || [])
                          .filter((m) => !(me.gift_lead_magnets || []).some((g) => g.kind === 'magnet' && g.id === m.id))
                          .map((m) => (<option key={`m${m.id}`} value={`m:${m.id}`}>🎁 {m.name} ({m.known ?? 0}/{m.delivered ?? 0})</option>))}
                        {(myMagnets?.packages || [])
                          .filter((p) => !(me.gift_lead_magnets || []).some((g) => g.kind === 'package' && g.id === p.id))
                          .map((p) => (<option key={`p${p.id}`} value={`p:${p.id}`}>📦 Пакет: {p.name} ({p.known ?? 0}/{p.delivered ?? 0})</option>))}
                      </select>
                    ) : (
                      <div style={{ fontSize: 11.5, color: '#a06a2a', marginTop: 4 }}>Максимум 4 лид-магнита.</div>
                    )}
                    {myMagnets && myMagnets.magnets.length === 0 && myMagnets.packages.length === 0 && (
                      <div style={{ fontSize: 11.5, color: '#a06a2a', marginTop: 6 }}>
                        В вашем ПЛЮСОН пока нет лид-магнитов. Создайте их в кабинете → раздел «Лид-магниты».
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── Вариант 2: ручной ввод ── */}
            {giftSource === 'manual' && (
              <>
                <label style={labelCss}>Название</label>
                <input style={inputCss} value={me.gift_after_speech_title || ''} onChange={(e) => update({ gift_after_speech_title: e.target.value })} placeholder="Например: Чек-лист по нутрициологии" />
                <label style={labelCss}>Ссылка</label>
                <input style={inputCss} value={me.gift_after_speech_url || ''} onChange={(e) => update({ gift_after_speech_url: e.target.value })} placeholder="https://…" />
                <div style={{ fontSize: 11, color: '#94a3b0', marginTop: 4 }}>
                  Ручную ссылку используем для рассылок и карточки. Баллы за лид-магнит в турнире считаются только при выборе из ПЛЮСОН.
                </div>
              </>
            )}
          </Section>
        )}

        {me.raffle_enabled && (
          <Section title="Подарок для розыгрыша">
            <label style={labelCss}>Название</label>
            <input style={inputCss} value={me.gift_raffle_title || ''} onChange={(e) => update({ gift_raffle_title: e.target.value })} placeholder="Например: Консультация 1:1" />
            <label style={labelCss}>Ссылка</label>
            <input style={inputCss} value={me.gift_raffle_url || ''} onChange={(e) => update({ gift_raffle_url: e.target.value })} placeholder="https://…" />
          </Section>
        )}

        {me.show_knowledge_base_field && (
          <Section title="Материал в базу знаний">
            <div style={{ fontSize: 12, color: '#7a8c9c', marginBottom: 8, lineHeight: 1.5 }}>
              Отобразится в мини-апп в вашей карточке спикера рядом с ссылками на соц сети.
            </div>
            <label style={labelCss}>Название</label>
            <input style={inputCss} value={me.knowledge_base_title || ''} onChange={(e) => update({ knowledge_base_title: e.target.value })} placeholder="Например: Презентация выступления" />
            <label style={labelCss}>Ссылка</label>
            <input style={inputCss} value={me.knowledge_base_url || ''} onChange={(e) => update({ knowledge_base_url: e.target.value })} placeholder="https://…" />
          </Section>
        )}

        {/* Партнёрский блок — перенесён сюда из вкладки «Материалы» (2026-05-30).
            На Материалах остаются только то что используется в анонсах
            (реф-ссылки, афиши, тексты). Партнёрка — про деньги/регистрацию,
            это к Профилю. */}
        {materials && (
          materials.speaker_external_ref_param ? (
            <Section title="Кабинет партнёра организатора">
              <div style={{ fontSize: 12, color: '#7a8c9c', marginBottom: 8, lineHeight: 1.5 }}>
                Вы зарегистрированы партнёром организатора и получаете процент с продаж приведённых
                участников. В кабинете партнёра видны <strong>финансовые начисления</strong> по вашим
                продажам — это отдельный сторонний сервис организатора, не ПЛЮСОН.
                Статистика переходов и регистраций по вашим реф-ссылкам — на вкладке «Материалы».
              </div>
              {materials.partner_dashboard_url && (
                <a
                  href={materials.partner_dashboard_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '8px 14px', borderRadius: 8,
                    background: PEACH, color: DARK, fontSize: 13, fontWeight: 700,
                    textDecoration: 'none', marginBottom: 10,
                  }}
                >
                  Кабинет партнёра / отслеживание оплат →
                </a>
              )}
              <div style={{ fontSize: 11, color: '#5a6a7a', lineHeight: 1.5 }}>
                Пароль от кабинета был отправлен на ваш email при регистрации — проверьте папку «Спам».
                Если письмо не нашли — воспользуйтесь формой восстановления пароля на странице входа.
              </div>
            </Section>
          ) : (
            materials.partner_landing_configured && (() => {
              const rows = [
                { key: 'telegram', label: 'Telegram', url: materials.partner_link.telegram },
                { key: 'vk',       label: 'VK',       url: materials.partner_link.vk },
                { key: 'max',      label: 'MAX',      url: materials.partner_link.max },
              ].filter(r => !!r.url) as Array<{ key: string; label: string; url: string }>
              if (rows.length === 0) return null
              return (
                <Section title="Ссылка регистрации на получение % кэшбэка">
                  <div style={{ fontSize: 12, color: '#7a8c9c', marginBottom: 8, lineHeight: 1.5 }}>
                    Пройдите по ссылке, чтобы зарегистрироваться партнёром организатора на получение
                    вознаграждения с привлечённых участников.
                  </div>
                  {rows.map(({ key, label, url }) => {
                    const k = `prt:${key}`
                    return (
                      <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: DARK, width: 70, flexShrink: 0 }}>{label}</span>
                        <code style={{
                          flex: 1, fontSize: 12, color: '#1a2a3a', background: '#f5f7fa',
                          padding: '6px 10px', borderRadius: 6, overflow: 'hidden',
                          textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace',
                          border: '1px solid #e0e7ec',
                        }}>{url}</code>
                        <button
                          onClick={() => { navigator.clipboard.writeText(url); setRefCopied(k); setTimeout(() => setRefCopied(''), 1500) }}
                          style={{
                            background: PEACH, color: DARK, fontWeight: 700,
                            border: 'none', borderRadius: 6, padding: '6px 10px',
                            cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
                          }}
                        >
                          {refCopied === k ? '✓' : '📋'}
                        </button>
                        <QrLinkButton url={url} name={label} className="p-1.5 rounded flex items-center" iconSize={16} iconClass="text-[#25455D]" />
                      </div>
                    )
                  })}
                  <div style={{ fontSize: 11, color: '#5a6a7a', lineHeight: 1.5, marginTop: 10 }}>
                    После регистрации пароль для доступа к партнёрскому кабинету придёт вам на email —
                    проверьте папку «Спам». Если не нашли — восстановите пароль на странице входа в кабинет.
                  </div>
                </Section>
              )
            })()
          )
        )}

        {error && <div style={{ background: '#ffe9e0', color: '#a83e1c', padding: 12, borderRadius: 10, marginBottom: 12, fontSize: 14 }}>{error}</div>}

        <button
          onClick={onSave}
          disabled={saving}
          style={{
            width: '100%', padding: '16px',
            background: PEACH, color: DARK, fontWeight: 700, fontSize: 16,
            border: 'none', borderRadius: 12,
            cursor: saving ? 'wait' : 'pointer', marginBottom: 24,
            position: 'sticky', bottom: 12,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            opacity: saving ? 0.85 : 1,
          }}
        >
          {saving && (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ animation: 'spkSpin 0.8s linear infinite' }}>
              <circle cx="12" cy="12" r="9" stroke={DARK} strokeOpacity="0.25" strokeWidth="3" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke={DARK} strokeWidth="3" strokeLinecap="round" />
            </svg>
          )}
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
        {savedAt && <div style={{ textAlign: 'center', fontSize: 12, color: '#5a8b5a', marginBottom: 24 }}>Сохранено в {savedAt.toLocaleTimeString('ru-RU').slice(0, 5)}</div>}
        </>}

        <style jsx global>{`
          @keyframes spkSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        `}</style>
      </div>

      {/* Lightbox — раскрытие фото/афиши на весь экран */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(10,21,32,0.92)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: 20, cursor: 'zoom-out',
          }}
        >
          <img
            src={lightbox}
            alt=""
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '95vw', maxHeight: '85vh', objectFit: 'contain', borderRadius: 10, cursor: 'default' }}
          />
          <div style={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 8 }}>
            <a
              href={lightbox}
              download
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{
                padding: '8px 14px', background: PEACH, color: DARK, fontWeight: 700,
                borderRadius: 8, fontSize: 13, textDecoration: 'none',
              }}
            >
              ⬇ Скачать
            </a>
            <button
              type="button"
              onClick={() => setLightbox(null)}
              style={{
                padding: '8px 14px', background: '#fff', color: DARK, fontWeight: 700,
                borderRadius: 8, fontSize: 13, border: 'none', cursor: 'pointer',
              }}
            >
              Закрыть
            </button>
          </div>
        </div>
      )}

      {/* ── Модалка входа/регистрации ПЛЮСОН (миграция 167) ── */}
      {plusonModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,21,32,0.6)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: 20 }}>
          <div
            style={{ background: '#fff', borderRadius: 14, padding: 22, width: '100%', maxWidth: 380, boxShadow: '0 12px 40px rgba(0,0,0,.3)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: DARK, marginBottom: 6 }}>
              {plusonModal === 'register' ? 'Создать кабинет ПЛЮСОН' : 'Войти в ПЛЮСОН'}
            </div>
            <div style={{ fontSize: 12.5, color: '#6b7c8e', marginBottom: 14, lineHeight: 1.5 }}>
              {plusonModal === 'register'
                ? 'Создадим вам бесплатный кабинет — там вы заведёте свои лид-магниты и подключите их как подарок.'
                : 'Введите email и пароль вашего кабинета ПЛЮСОН, чтобы выбрать свой лид-магнит.'}
            </div>
            <label style={labelCss}>Email</label>
            <input style={inputCss} type="email" value={plEmail} onChange={(e) => setPlEmail(e.target.value)} placeholder="you@example.com" autoFocus />
            <label style={labelCss}>Пароль</label>
            <input style={inputCss} type="password" value={plPassword} onChange={(e) => setPlPassword(e.target.value)} placeholder="••••••••" />
            {plError && <div style={{ color: '#b04a4a', fontSize: 12.5, marginTop: 10 }}>{plError}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <button onClick={doPlusonAuth} disabled={plBusy || !plEmail.trim() || !plPassword}
                style={{ ...btnCss, background: DARK, color: '#fff', opacity: (plBusy || !plEmail.trim() || !plPassword) ? 0.6 : 1, flex: 1 }}>
                {plBusy ? '…' : plusonModal === 'register' ? 'Создать и подключить' : 'Подключить'}
              </button>
              <button onClick={() => !plBusy && setPlusonModal(null)} style={{ ...btnCss }}>Отмена</button>
            </div>
            <div style={{ marginTop: 12, textAlign: 'center', fontSize: 12 }}>
              {plusonModal === 'login' ? (
                <button onClick={() => { setPlusonModal('register'); setPlError(null) }}
                  style={{ background: 'none', border: 'none', color: DARK, cursor: 'pointer', textDecoration: 'underline' }}>
                  Ещё нет кабинета? Создать
                </button>
              ) : (
                <button onClick={() => { setPlusonModal('login'); setPlError(null) }}
                  style={{ background: 'none', border: 'none', color: DARK, cursor: 'pointer', textDecoration: 'underline' }}>
                  Уже есть кабинет? Войти
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SpeakerPicker({ list, chosenId, setChosenId, onUsernameAutofill }: {
  list: SpeakerListItem[]
  chosenId: number | null
  setChosenId: (n: number | null) => void
  onUsernameAutofill?: (name: string) => void
}) {
  const [query, setQuery] = useState<string>('')
  const [open, setOpen] = useState<boolean>(false)
  const chosen = list.find(sp => sp.speaker_event_id === chosenId) || null
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim()
  const filtered = norm(query)
    ? list.filter(sp => norm(sp.full_name).includes(norm(query)))
    : list
  return (
    <div style={{ position: 'relative', marginBottom: 14 }}>
      {/* Реальное username-поле для менеджера паролей. Визуально скрыто, но
          в DOM и в форме — Chrome/Safari берут отсюда «логин» при сохранении
          и сюда подставляют его при автозаполнении. onChange ловит autofill. */}
      <input
        type="text"
        name="username"
        autoComplete="username"
        tabIndex={-1}
        aria-hidden="true"
        value={chosen ? chosen.full_name : ''}
        onChange={(e) => onUsernameAutofill?.(e.target.value)}
        style={{ position: 'absolute', opacity: 0, height: 0, width: 0, padding: 0, border: 'none', pointerEvents: 'none' }}
      />
      <input
        type="text"
        value={chosen && !open ? chosen.full_name : query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          if (chosen) setChosenId(null)
        }}
        onFocus={() => { setOpen(true); if (chosen) setQuery(''); }}
        onBlur={() => setTimeout(() => setOpen(false), 180)}
        placeholder="Начните вводить фамилию…"
        autoComplete="off"
        style={{
          width: '100%', padding: '12px 14px', borderRadius: 10,
          border: '1px solid #d4dee5', fontSize: 15, background: '#fff', boxSizing: 'border-box',
        }}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0,
          background: '#fff', border: '1px solid #d4dee5', borderRadius: 10,
          marginTop: 4, maxHeight: 240, overflowY: 'auto', zIndex: 10,
          boxShadow: '0 4px 14px rgba(37,69,93,0.15)',
        }}>
          {filtered.map(sp => (
            <button
              key={sp.speaker_event_id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); setChosenId(sp.speaker_event_id); setQuery(''); setOpen(false); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '10px 14px', border: 'none', background: 'transparent',
                fontSize: 14, cursor: 'pointer', borderBottom: '1px solid #f0f3f6',
              }}
            >
              {sp.full_name}
            </button>
          ))}
        </div>
      )}
      {open && filtered.length === 0 && query.trim() && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0,
          background: '#fff', border: '1px solid #d4dee5', borderRadius: 10,
          marginTop: 4, padding: '12px 14px', fontSize: 13, color: '#7a8c9c',
          zIndex: 10, boxShadow: '0 4px 14px rgba(37,69,93,0.15)',
        }}>
          Никого не нашли с такой фамилией. Уточните у организатора, что вы добавлены спикером.
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string, children: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', borderRadius: 14, padding: '14px 18px 20px', marginBottom: 14, boxShadow: '0 2px 6px rgba(37,69,93,0.05)' }}>
      <div style={{ fontWeight: 700, color: DARK, fontSize: 15, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  )
}

function MaterialsTab({
  materials, refCopied, setRefCopied, setLightbox,
}: {
  materials: SpeakerMaterials | null
  refCopied: string
  setRefCopied: (s: string) => void
  setLightbox: (s: string | null) => void
}) {
  if (!materials) {
    return <div style={{ fontSize: 13, color: '#7a8c9c', padding: 20 }}>Загружаем материалы…</div>
  }

  const sectionCss: React.CSSProperties = {
    background: '#fff', borderRadius: 14, padding: '14px 18px 20px',
    marginBottom: 14, boxShadow: '0 2px 6px rgba(37,69,93,0.05)',
  }
  const titleCss: React.CSSProperties = { fontWeight: 700, color: DARK, fontSize: 15, marginBottom: 8 }
  const subCss: React.CSSProperties = { fontSize: 12, color: '#7a8c9c', marginBottom: 12, lineHeight: 1.5 }
  const copyBtnCss: React.CSSProperties = {
    background: PEACH, color: DARK, fontWeight: 700,
    padding: '6px 12px', borderRadius: 8, border: 'none',
    cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
  }

  function copy(key: string, text: string) {
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setRefCopied(key)
      setTimeout(() => setRefCopied(''), 2200)
    })
  }

  // Подставить плейсхолдеры в текст-анонс.
  const placeholders = materials.placeholders
  function fillPlaceholders(raw: string): string {
    return (raw || '')
      .replace(/\{link\}/g,  placeholders.link  || '')
      .replace(/\{event\}/g, placeholders.event || '')
      .replace(/\{date\}/g,  placeholders.date  || '')
      .replace(/\{brand\}/g, placeholders.brand || '')
  }

  const refLinkRows = [
    { key: 'telegram', label: 'Telegram', url: materials.ref_links.telegram },
    { key: 'vk',       label: 'VK',       url: materials.ref_links.vk },
    { key: 'max',      label: 'MAX',      url: materials.ref_links.max },
  ].filter(x => !!x.url) as { key: string; label: string; url: string }[]

  // Карточка для видео — превью с native controls + кнопка скачать.
  function VideoCard({ url, alt }: { url: string; alt: string }) {
    return (
      <div style={{
        border: '1px solid #d4dee5', borderRadius: 10, overflow: 'hidden', background: '#000',
        maxWidth: 320,
      }}>
        <video
          src={url}
          controls
          preload="metadata"
          style={{ width: '100%', display: 'block', background: '#000' }}
        />
        <a
          href={url}
          download
          target="_blank"
          rel="noreferrer"
          aria-label={alt}
          style={{
            display: 'block', textAlign: 'center', padding: '6px 8px',
            fontSize: 11, color: DARK, textDecoration: 'none',
            background: '#fff', borderTop: '1px solid #d4dee5',
          }}
        >
          ⬇ Скачать
        </a>
      </div>
    )
  }

  return (
    <div>
      {/* Реф-ссылки спикера — перенесены в начало вкладки (2026-05-30).
          Это главное что спикер копирует и шлёт своей аудитории. */}
      {refLinkRows.length > 0 && (
        <div style={sectionCss}>
          <div style={titleCss}>Ваши реф-ссылки на событие</div>
          <div style={subCss}>
            Делитесь любой из этих ссылок — все, кто перейдёт и зарегистрируется, засчитаются как ваши приглашённые.
          </div>
          {refLinkRows.map(({ key, label, url }) => {
            const k = `ref:${key}`
            return (
              <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: DARK, width: 70, flexShrink: 0 }}>{label}</span>
                <code style={{
                  flex: 1, fontSize: 12, color: '#1a2a3a', background: '#f5f7fa',
                  padding: '6px 10px', borderRadius: 6, overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace',
                  border: '1px solid #e0e7ec',
                }}>{url}</code>
                <button onClick={() => copy(k, url)} style={copyBtnCss}>
                  {refCopied === k ? '✓' : '📋'}
                </button>
                <QrLinkButton url={url} name={label} className="p-1.5 rounded flex items-center" iconSize={16} iconClass="text-[#25455D]" />
              </div>
            )
          })}
        </div>
      )}

      {/* Фото для сайта (collaborators.photo_url).
          Используется на лендинге события и в визитке Mini App. */}
      {materials.photo_url && (
        <div style={sectionCss}>
          <div style={titleCss}>Фото для сайта</div>
          <div style={subCss}>
            Используется на лендинге события, в визитке Mini App и в сторонних виджетах.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
            <div style={{
              border: '1px solid #d4dee5', borderRadius: 10, overflow: 'hidden', background: '#f5f7fa',
            }}>
              <img
                src={materials.photo_url}
                alt="Фото профиля"
                onClick={() => setLightbox(materials.photo_url!)}
                style={{
                  width: '100%', aspectRatio: '1/1',
                  objectFit: 'cover', cursor: 'zoom-in', display: 'block',
                }}
              />
              <a
                href={materials.photo_url}
                download
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'block', textAlign: 'center', padding: '6px 8px',
                  fontSize: 11, color: DARK, textDecoration: 'none',
                  background: '#fff', borderTop: '1px solid #d4dee5',
                }}
              >
                ⬇ Скачать
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Афиша «для рассылок по боту» намеренно НЕ показывается спикеру в его
          кабинете — это служебное фото для бота организатора, спикеру нужна
          только индивидуальная афиша «для анонсов» (ниже). */}

      {/* Афиши для анонсов — множественные, отмеченные организатором
          чек-боксом «Для анонсов» в этой конференции (миграция 122). */}
      {materials.announcement_posters && materials.announcement_posters.length > 0 && (
        <div style={sectionCss}>
          <div style={titleCss}>Афиши для анонсов</div>
          <div style={subCss}>
            Афиши, которые организатор приготовил для распространения. Скачайте любую и
            опубликуйте в своих каналах, чтобы пригласить аудиторию.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
            {materials.announcement_posters.map(p => (
              <div key={p.id} style={{
                border: '1px solid #d4dee5', borderRadius: 10, overflow: 'hidden', background: '#f5f7fa',
              }}>
                <img
                  src={p.url}
                  alt={p.label || ''}
                  onClick={() => setLightbox(p.url)}
                  style={{
                    width: '100%', aspectRatio: '1/1',
                    objectFit: 'cover', cursor: 'zoom-in', display: 'block',
                  }}
                />
                {p.label && (
                  <div style={{ padding: '4px 8px', fontSize: 11, color: '#6b7c8b', borderTop: '1px solid #e6edf3' }}>
                    {p.label}
                  </div>
                )}
                <a
                  href={p.url}
                  download
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'block', textAlign: 'center', padding: '6px 8px',
                    fontSize: 11, color: DARK, textDecoration: 'none',
                    background: '#fff', borderTop: '1px solid #d4dee5',
                  }}
                >
                  ⬇ Скачать
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Общие афиши */}
      <div style={sectionCss}>
        <div style={titleCss}>Общие афиши</div>
        <div style={subCss}>
          Картинки для анонса в ваших каналах. Кликните, чтобы открыть на весь экран, или скачайте.
        </div>
        {materials.posters.length === 0 ? (
          <div style={{ fontSize: 13, color: '#9aaab8', padding: '14px 0' }}>Афиш пока нет. Попросите организатора добавить.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
            {materials.posters.map(p => (
              <div key={p.id} style={{
                border: '1px solid #d4dee5', borderRadius: 10, overflow: 'hidden', background: '#f5f7fa',
              }}>
                <img
                  src={p.url}
                  alt={p.orientation}
                  onClick={() => setLightbox(p.url)}
                  style={{
                    width: '100%',
                    aspectRatio: p.orientation === 'horizontal' ? '16/9' : p.orientation === 'vertical' ? '9/16' : '1/1',
                    objectFit: 'cover', cursor: 'zoom-in', display: 'block',
                  }}
                />
                <a
                  href={p.url}
                  download
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'block', textAlign: 'center', padding: '6px 8px',
                    fontSize: 11, color: DARK, textDecoration: 'none',
                    background: '#fff', borderTop: '1px solid #d4dee5',
                  }}
                >
                  ⬇ Скачать
                </a>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Афиши по дням события */}
      {materials.day_posters && materials.day_posters.length > 0 && (
        <div style={sectionCss}>
          <div style={titleCss}>Афиши по дням</div>
          <div style={subCss}>
            Своя афиша под каждый день события — берите ту, про которую делаете анонс.
          </div>
          {Array.from(new Set(materials.day_posters.map(p => p.day)))
            .sort((a, b) => a - b)
            .map(dayNum => {
              const dayItems = materials.day_posters!.filter(p => p.day === dayNum)
              const title = dayItems[0]?.day_title || `День ${dayNum}`
              return (
                <div key={dayNum} style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: DARK, marginBottom: 8 }}>
                    {title}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
                    {dayItems.map(p => (
                      <div key={p.id} style={{
                        border: '1px solid #d4dee5', borderRadius: 10, overflow: 'hidden', background: '#f5f7fa',
                      }}>
                        <img
                          src={p.url}
                          alt={`${title} — ${p.orientation}`}
                          onClick={() => setLightbox(p.url)}
                          style={{
                            width: '100%',
                            aspectRatio: p.orientation === 'horizontal' ? '16/9' : p.orientation === 'vertical' ? '9/16' : '1/1',
                            objectFit: 'cover', cursor: 'zoom-in', display: 'block',
                          }}
                        />
                        <a
                          href={p.url}
                          download
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            display: 'block', textAlign: 'center', padding: '6px 8px',
                            fontSize: 11, color: DARK, textDecoration: 'none',
                            background: '#fff', borderTop: '1px solid #d4dee5',
                          }}
                        >
                          ⬇ Скачать
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
        </div>
      )}

      {/* Индивидуальное видео */}
      {materials.speaker_video_url && (
        <div style={sectionCss}>
          <div style={titleCss}>Индивидуальное видео</div>
          <div style={subCss}>
            Видео, подготовленное организатором лично для вас. Можно посмотреть прямо тут или скачать.
          </div>
          <VideoCard url={materials.speaker_video_url} alt="Индивидуальное видео" />
        </div>
      )}

      {/* Общее видео */}
      {materials.event_video_url && (
        <div style={sectionCss}>
          <div style={titleCss}>Общее видео</div>
          <div style={subCss}>
            Видео для анонса события в ваших каналах. Можно посмотреть прямо тут или скачать.
          </div>
          <VideoCard url={materials.event_video_url} alt="Общее видео" />
        </div>
      )}

      {/* Тексты-анонсы */}
      <div style={sectionCss}>
        <div style={titleCss}>Тексты для анонса</div>
        <div style={subCss}>
          Готовые тексты от организатора. Реф-ссылка, название и дата уже подставлены — просто скопируйте и отправьте своей аудитории.
        </div>
        {materials.announcement_texts.length === 0 ? (
          <div style={{ fontSize: 13, color: '#9aaab8', padding: '14px 0' }}>Текстов пока нет. Попросите организатора добавить.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {materials.announcement_texts.map(t => {
              const filled = fillPlaceholders(t.content)
              const k = `txt:${t.id}`
              return (
                <div key={t.id} style={{
                  border: '1px solid #d4dee5', borderRadius: 10, padding: 12,
                  background: '#f9fbfc',
                }}>
                  <pre style={{
                    fontSize: 13, lineHeight: 1.55, color: '#1a2a3a',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    margin: 0, fontFamily: 'Roboto, sans-serif',
                  }}>{filled}</pre>
                  <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
                    <button onClick={() => copy(k, filled)} style={copyBtnCss}>
                      {refCopied === k ? '✓ Скопировано' : '📋 Скопировать текст'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Реф-ссылки и партнёрский блок перенесены: реф-ссылки — в начало
          этой вкладки, партнёрка — в вкладку «Профиль» (2026-05-30). */}
    </div>
  )
}

function PlatformAccountField({
  label, username, locked, onChange, placeholder, inputCss, labelCss,
}: {
  label: string
  username: string | null
  locked: boolean
  onChange: (v: string) => void
  placeholder: string
  inputCss: React.CSSProperties
  labelCss: React.CSSProperties
}) {
  return (
    <div>
      <label style={labelCss}>
        {label}
        {locked && <span style={{ marginLeft: 6, fontSize: 11, color: '#5a8b5a' }}>✓ привязан</span>}
      </label>
      <input
        style={{
          ...inputCss,
          background: locked ? '#f5f7fa' : '#fff',
          color: locked ? '#7a8c9c' : '#1a2a3a',
          cursor: locked ? 'not-allowed' : 'text',
        }}
        value={username || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        readOnly={locked}
        disabled={locked}
      />
      {locked && (
        <div style={{ fontSize: 11, color: '#7a8c9c', marginTop: 2 }}>
          Этот аккаунт привязан автоматически — изменить его нельзя.
        </div>
      )}
    </div>
  )
}

// ─────────────────────── Вкладка ЖЮРИ: оценка участников ───────────────────────

// ─────────────────────── Вкладка ПРИГЛАШЁННЫЕ: реф-статистика спикера ───────────────────────
function InvitedTab({ token }: { token: string }) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<any>(null)
  const [filter, setFilter] = useState<'all' | 'reg' | 'unreg'>('all')

  useEffect(() => {
    setLoading(true)
    fetch(`${API}/api/v1/public/speaker-cabinet/me/invited`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).then(setData).finally(() => setLoading(false))
  }, [token])

  if (loading) return <div style={{ padding: 20, color: '#7a8c9c' }}>Загрузка…</div>
  if (!data) return <div style={{ padding: 20, color: '#7a8c9c' }}>Не удалось загрузить.</div>

  const people: any[] = data.people || []
  const shown = people.filter(p =>
    filter === 'all' ? true : filter === 'reg' ? p.is_registered : !p.is_registered)

  const platLabel = (s: string) => s === 'telegram' ? 'TG' : s === 'vk' ? 'VK' : s === 'max' ? 'MAX' : s === 'email' ? '✉' : ''

  const Stat = ({ label, value }: { label: string; value: number }) => (
    <div style={{
      flex: 1, background: '#fff', border: '1px solid #e1e8ee', borderRadius: 12,
      padding: '14px 10px', textAlign: 'center',
    }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: DARK }}>{value}</div>
      <div style={{ fontSize: 12, color: '#7a8c9c', marginTop: 2 }}>{label}</div>
    </div>
  )

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: DARK, margin: '4px 0 12px' }}>
        Ваши приглашённые
      </h2>
      <p style={{ fontSize: 13, color: '#7a8c9c', margin: '0 0 14px' }}>
        Люди, которые пришли по вашей реферальной ссылке на это событие.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <Stat label="Зашли" value={data.entered || 0} />
        <Stat label="Зарегистрировались" value={data.registered || 0} />
        <Stat label="В чате" value={data.in_chat || 0} />
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {([
          { k: 'all' as const, l: `Все (${people.length})` },
          { k: 'reg' as const, l: `✓ Зарегистрированы (${people.filter(p => p.is_registered).length})` },
          { k: 'unreg' as const, l: `Не зарегистрированы (${people.filter(p => !p.is_registered).length})` },
        ]).map(b => (
          <button key={b.k} type="button" onClick={() => setFilter(b.k)}
            style={{
              padding: '7px 12px', borderRadius: 20, fontSize: 12.5, cursor: 'pointer',
              border: filter === b.k ? `1px solid ${DARK}` : '1px solid #d4dee5',
              background: filter === b.k ? DARK : '#fff',
              color: filter === b.k ? '#fff' : '#5a6b7a', fontWeight: filter === b.k ? 700 : 500,
            }}>{b.l}</button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: '#9aa9b7', fontSize: 14 }}>
          Пока никого нет.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {shown.map((p, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: '#fff', border: '1px solid #e8eef3', borderRadius: 10, padding: '10px 12px',
            }}>
              <div style={{
                width: 18, textAlign: 'center', flexShrink: 0,
                fontSize: 15, fontWeight: 800, lineHeight: 1,
                color: p.is_registered ? '#2ecc71' : '#cdd6de',
              }} title={p.is_registered ? 'Зарегистрирован' : 'Не зарегистрирован'}>
                {p.is_registered ? '✓' : '–'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {p.account_url ? (
                  <a href={p.account_url} target="_blank" rel="noreferrer"
                     style={{ color: DARK, fontWeight: 600, fontSize: 14, textDecoration: 'none' }}>
                    {p.name} ↗
                  </a>
                ) : (
                  <span style={{ color: DARK, fontWeight: 600, fontSize: 14 }}>{p.name}</span>
                )}
                <div style={{ fontSize: 11.5, color: '#9aa9b7', marginTop: 1 }}>
                  {platLabel(p.platform_slug)}{p.username ? ` · @${String(p.username).replace(/^@/, '')}` : ''}
                  {p.is_in_chat ? ' · в чате' : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────── Вкладка РЕКЛАМНЫЕ ИНТЕГРАЦИИ ───────────────────────
function MyBroadcastsTab({ token }: { token: string }) {
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<any[]>([])
  const [cardLink, setCardLink] = useState<string | null>(null)
  const [landingLink, setLandingLink] = useState<string | null>(null)
  const [preview, setPreview] = useState<any | null>(null)
  // Тест-отправка: подтверждение (что и куда придёт) → отправка.
  const [testConfirm, setTestConfirm] = useState<any | null>(null)
  const [testTargets, setTestTargets] = useState<any[] | null>(null)
  const [testBusy, setTestBusy] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    fetch(`${API}/api/v1/public/speaker-cabinet/me/my-broadcasts`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => {
        setItems(d.broadcasts || [])
        setCardLink(d.card_link || null)
        setLandingLink(d.landing_link || null)
      })
      .finally(() => setLoading(false))
  }, [token])

  const PLAT_LABEL: Record<string, string> = { telegram: 'Telegram', vk: 'VK', max: 'MAX' }

  async function openTest(b: any) {
    setTestConfirm(b); setTestTargets(null); setTestResult(null)
    try {
      const r = await fetch(
        `${API}/api/v1/public/speaker-cabinet/me/my-broadcasts/${b.id}/test-targets`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const d = await r.json()
      setTestTargets(d.targets || [])
    } catch {
      setTestTargets([])
    }
  }

  async function runTest() {
    if (!testConfirm) return
    setTestBusy(true); setTestResult(null)
    try {
      const r = await fetch(
        `${API}/api/v1/public/speaker-cabinet/me/my-broadcasts/${testConfirm.id}/test`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      )
      const d = await r.json()
      if (r.ok && d.ok) {
        setTestResult(`Отправили вам в ${d.sent} ${d.sent === 1 ? 'аккаунт' : 'аккаунта(ов)'}. Проверьте свои боты.`)
      } else {
        setTestResult(d.detail || 'Не удалось отправить. Возможно, вы ещё не писали боту события.')
      }
    } catch {
      setTestResult('Ошибка отправки. Попробуйте ещё раз.')
    } finally {
      setTestBusy(false)
    }
  }

  const statusChip = (s: string) => {
    const done = s === 'done'
    return (
      <span style={{
        fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
        color: done ? '#0a7d3d' : '#8a5a00',
        background: done ? '#e3f6ea' : '#fff2dd',
        whiteSpace: 'nowrap',
      }}>
        {done ? 'Отправлено' : 'В очереди'}
      </span>
    )
  }

  if (loading) return <div style={{ padding: 20, color: '#7a8c9c' }}>Загрузка…</div>

  const LinkBlock = ({ title, url, hint }: { title: string; url: string; hint?: string }) => (
    <div style={{
      background: '#fff', border: '1px solid #e1e8ee', borderRadius: 12,
      padding: '12px 14px', marginBottom: 10,
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 4 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: '#7a8c9c', marginBottom: 6 }}>{hint}</div>}
      <a href={url} target="_blank" rel="noopener noreferrer"
        style={{ fontSize: 13, color: '#2563eb', wordBreak: 'break-all', textDecoration: 'underline' }}>
        {url}
      </a>
    </div>
  )

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: DARK, margin: '4px 0 6px' }}>
        Рекламные интеграции
      </h2>
      <p style={{ fontSize: 13, color: '#7a8c9c', margin: '0 0 14px' }}>
        Всё для продвижения события с вами: ваша карточка в кабинете участника, лендинг события и рассылки, в которых вы фигурируете.
      </p>

      {cardLink && (
        <LinkBlock
          title="Ваша карточка в кабинете участника"
          hint="Ссылка на просмотр вашей карточки участниками события."
          url={cardLink}
        />
      )}
      {landingLink && (
        <LinkBlock
          title="ВЫ НА ЛЕНДИНГЕ"
          hint="Лендинг события — покажите его своей аудитории."
          url={landingLink}
        />
      )}

      <h3 style={{ fontSize: 15, fontWeight: 700, color: DARK, margin: '18px 0 8px' }}>
        Рассылки с вами
      </h3>

      {items.length === 0 ? (
        <div style={{ padding: 20, color: '#7a8c9c', textAlign: 'center' }}>
          Пока нет рассылок с вами.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map(b => (
            <div key={b.id} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              background: '#fff', border: '1px solid #e1e8ee', borderRadius: 12,
              padding: '12px 14px',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: DARK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {b.name}
                </div>
                {b.fire_at_msk && (
                  <div style={{ fontSize: 12, color: '#7a8c9c', marginTop: 2 }}>
                    {b.fire_at_msk} МСК
                  </div>
                )}
              </div>
              {statusChip(b.status)}
              <button
                type="button"
                onClick={() => openTest(b)}
                title="Отправить тест себе"
                style={{
                  padding: '8px 12px', borderRadius: 10, border: '1px solid #d4dee5',
                  background: '#f6f9fb', cursor: 'pointer', flexShrink: 0,
                  fontSize: 13, fontWeight: 600, color: DARK, whiteSpace: 'nowrap',
                }}
              >
                Протестировать
              </button>
              <button
                type="button"
                onClick={() => setPreview(b)}
                title="Посмотреть сообщение"
                style={{
                  width: 38, height: 38, borderRadius: 10, border: '1px solid #d4dee5',
                  background: '#f6f9fb', cursor: 'pointer', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={DARK} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {testConfirm && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(10,21,32,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16,
        }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 22, maxWidth: 460, width: '100%' }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: DARK, marginBottom: 8 }}>
              Отправить тест себе
            </div>
            <div style={{ fontSize: 14, color: '#4a5a68', lineHeight: 1.5, marginBottom: 6 }}>
              Рассылка «{testConfirm.name}» будет отправлена <b>только вам</b> — в ваши
              же аккаунты через боты события. Больше никто её не получит.
            </div>

            {testTargets === null ? (
              <div style={{ fontSize: 13, color: '#7a8c9c', padding: '10px 0' }}>Проверяем ваши аккаунты…</div>
            ) : testTargets.length === 0 ? (
              <div style={{
                fontSize: 13, color: '#8a5a00', background: '#fff2dd',
                border: '1px solid #ffe0ad', borderRadius: 10, padding: '10px 12px', margin: '10px 0',
              }}>
                Мы не нашли ваш аккаунт ни на одной площадке события. Чтобы тест дошёл —
                сначала напишите боту события хотя бы «привет», и попробуйте снова.
              </div>
            ) : (
              <div style={{
                background: '#f6f9fb', border: '1px solid #e1e8ee', borderRadius: 10,
                padding: '10px 12px', margin: '10px 0',
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: DARK, marginBottom: 6 }}>
                  Придёт вам сюда:
                </div>
                {testTargets.map((t, i) => (
                  <div key={i} style={{ fontSize: 13, color: '#4a5a68', marginBottom: 3 }}>
                    • <b>{PLAT_LABEL[t.platform] || t.platform}</b> ({t.nick}) — через {t.bot}
                  </div>
                ))}
              </div>
            )}

            {testResult && (
              <div style={{ fontSize: 13, color: DARK, background: '#e3f6ea',
                border: '1px solid #b7e6c8', borderRadius: 10, padding: '10px 12px', margin: '6px 0' }}>
                {testResult}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 14, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setTestConfirm(null)}
                style={{ padding: '9px 16px', borderRadius: 10, border: '1px solid #d4dee5',
                  background: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#4a5a68' }}>
                {testResult ? 'Закрыть' : 'Отмена'}
              </button>
              {!testResult && (
                <button type="button" onClick={runTest}
                  disabled={testBusy || !testTargets || testTargets.length === 0}
                  style={{ padding: '9px 16px', borderRadius: 10, border: 'none',
                    background: (testBusy || !testTargets || testTargets.length === 0) ? '#c9d4dc' : DARK,
                    color: '#fff', cursor: (testBusy || !testTargets || testTargets.length === 0) ? 'default' : 'pointer',
                    fontSize: 14, fontWeight: 700 }}>
                  {testBusy ? 'Отправляем…' : 'Отправить мне'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div
          onClick={() => setPreview(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(10,21,32,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, zIndex: 1000,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 16, maxWidth: 440, width: '100%',
              maxHeight: '85vh', overflowY: 'auto', padding: 18,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: DARK }}>{preview.name}</div>
              <button type="button" onClick={() => setPreview(null)}
                style={{ border: 'none', background: 'transparent', fontSize: 22, color: '#7a8c9c', cursor: 'pointer', lineHeight: 1 }}>
                ×
              </button>
            </div>
            <div style={{ marginBottom: 10 }}>{statusChip(preview.status)}</div>
            {preview.media_type === 'video' && preview.video ? (
              <video src={preview.video} controls style={{ width: '100%', borderRadius: 12, marginBottom: 12, maxHeight: 260 }} />
            ) : preview.photo ? (
              <img src={preview.photo} alt="" style={{ width: '100%', borderRadius: 12, marginBottom: 12, objectFit: 'contain', maxHeight: 320 }} />
            ) : null}
            <div
              style={{ fontSize: 14, color: '#1a2b38', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}
              dangerouslySetInnerHTML={{ __html: preview.text || '' }}
            />
            {preview.button_text && (
              <div style={{
                marginTop: 14, textAlign: 'center', padding: '10px 12px',
                borderRadius: 12, border: '1px solid #d4dee5', color: '#2563eb',
                fontSize: 14, fontWeight: 600,
              }}>
                {preview.button_text}
              </div>
            )}
            {Array.isArray(preview.buttons) && preview.buttons.map((btn: any, i: number) => btn?.text && (
              <div key={i} style={{
                marginTop: 8, textAlign: 'center', padding: '10px 12px',
                borderRadius: 12, border: '1px solid #d4dee5', color: '#2563eb',
                fontSize: 14, fontWeight: 600,
              }}>
                {btn.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SlotTab({ token, myName }: { token: string; myName: string }) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<any>(null)
  const [activeStage, setActiveStage] = useState<number | null>(null)
  // раскрытые дни-аккордеоны (day_number). null = ещё не трогали → откроется первый
  const [openDays, setOpenDays] = useState<Set<number> | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // если у спикера несколько тем — выбранная тема для занимаемого слота
  const [selectedTopicId, setSelectedTopicId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${API}/api/v1/public/speaker-cabinet/me/program`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).then((d) => {
      setData(d)
      setSelectedId(null)
      // предзаполняем выбор темы текущей темой моего слота (если занят)
      const mine = (d.sessions || []).find((s: any) => s.is_mine)
      setSelectedTopicId(mine?.topic_id ?? null)
    }).finally(() => setLoading(false))
  }, [token])

  useEffect(() => { load() }, [load])

  if (loading) return <div style={{ padding: 20, color: '#7a8c9c' }}>Загрузка…</div>
  if (!data) return <div style={{ padding: 20, color: '#7a8c9c' }}>Не удалось загрузить программу.</div>

  const sessions: any[] = data.sessions || []
  const days: any[] = data.days || []
  const allStages: any[] = data.stages || []
  const mySlot = sessions.find(s => s.is_mine) || null

  // Показываем ВСЕ дни этапов спикера — это его программа, он должен видеть
  // весь тур целиком, даже дни без свободных слотов (все места заняты, орг-встречи).
  const daysWithSlots = days

  // этапы-вкладки = этапы из бэка, у которых есть дни со слотами.
  // Дни без этапа (stage_id=null) собираем в псевдо-этап «Без этапа».
  const stageHasSlots = (sid: number | null) =>
    daysWithSlots.some(d => (d.stage_id ?? null) === sid)
  const stageTabs = allStages
    .filter(st => stageHasSlots(st.id))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  const hasOrphanDays = daysWithSlots.some(d => (d.stage_id ?? null) === null)

  // активный этап = этап моего слота, иначе первый этап со слотами
  const myDay = mySlot ? days.find(d => d.day_number === mySlot.day) : null
  const myStageId = myDay ? (myDay.stage_id ?? null) : undefined
  const ORPHAN = -1
  const effStage = activeStage != null ? activeStage
    : (myStageId !== undefined ? (myStageId ?? ORPHAN)
      : (stageTabs[0] ? stageTabs[0].id : (hasOrphanDays ? ORPHAN : null)))

  const fmtDate = (iso: string | null) => {
    if (!iso) return ''
    try {
      return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', timeZone: 'Europe/Moscow' })
    } catch { return '' }
  }
  const dayLabel = (d: any) => d.title || `День ${d.day_number}`

  // дни активного этапа (со слотами) — рисуем аккордеоном друг под другом
  const stageDays = daysWithSlots
    .filter(d => (effStage === ORPHAN ? (d.stage_id ?? null) === null : (d.stage_id ?? null) === effStage))
    .sort((a, b) => a.day_number - b.day_number)

  // какие дни раскрыты: трогали → openDays; не трогали → день моего слота, иначе первый
  const defaultOpenDay = (myDay && stageDays.some(d => d.day_number === myDay.day_number))
    ? myDay.day_number
    : (stageDays[0]?.day_number ?? null)
  const isDayOpen = (dn: number) => openDays != null ? openDays.has(dn) : dn === defaultOpenDay
  const toggleDay = (dn: number) => {
    setOpenDays(prev => {
      const base = prev != null ? new Set(prev) : (defaultOpenDay != null ? new Set([defaultOpenDay]) : new Set<number>())
      base.has(dn) ? base.delete(dn) : base.add(dn)
      return base
    })
  }
  const slotsOfDay = (dn: number) => sessions
    .filter(s => s.day === dn)
    .sort((a, b) => (a.sort_order - b.sort_order) || String(a.start_time || '').localeCompare(String(b.start_time || '')))

  const myTopics: Array<{ id: number; topic: string }> = data.my_topics || []

  async function save() {
    // занимаем выбранный слот; если ничего не выбрано, но слот уже мой —
    // сохраняем смену темы для текущего слота.
    const targetId = selectedId ?? (mySlot ? mySlot.id : null)
    if (targetId == null) return
    setSaving(true); setMsg(null)
    try {
      const r = await fetch(`${API}/api/v1/public/speaker-cabinet/me/claim-slot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session_id: targetId, topic_id: selectedTopicId }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.detail || 'Не удалось сохранить')
      setMsg({ ok: true, text: 'Готово! Слот и тема сохранены.' })
      load()
    } catch (e: any) {
      setMsg({ ok: false, text: String(e.message || e) })
      load()
    } finally {
      setSaving(false)
    }
  }

  async function release() {
    if (!confirm('Освободить ваш слот? Он станет доступен другим спикерам.')) return
    setSaving(true); setMsg(null)
    try {
      const r = await fetch(`${API}/api/v1/public/speaker-cabinet/me/release-slot`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.detail || 'Ошибка') }
      setMsg({ ok: true, text: 'Слот освобождён.' })
      load()
    } catch (e: any) {
      setMsg({ ok: false, text: String(e.message || e) })
    } finally { setSaving(false) }
  }

  const timeStr = (s: any) => {
    const a = s.start_time ? String(s.start_time).slice(0, 5) : ''
    const b = s.end_time ? String(s.end_time).slice(0, 5) : ''
    if (a && b) return `${a}–${b} МСК`
    if (a) return `${a} МСК`
    return ''
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: DARK, margin: '4px 0 6px' }}>Мой слот в программе</h2>

      {/* Шапка с кнопкой Сохранить + подсказкой */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 5, background: '#f4f7f9',
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '10px 0', marginBottom: 8,
      }}>
        {(() => {
          const canSave = selectedId != null || mySlot != null
          return (
            <button
              type="button"
              onClick={save}
              disabled={!canSave || saving}
              style={{
                background: !canSave ? '#cfd9e0' : PEACH,
                color: DARK, border: 'none', borderRadius: 12,
                padding: '11px 22px', fontWeight: 800, fontSize: 14,
                cursor: !canSave ? 'not-allowed' : 'pointer',
              }}
            >
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
          )
        })()}
        <span style={{ fontSize: 13, color: '#7a8c9c' }}>
          Выберите день и свободный слот, затем нажмите «Сохранить».
        </span>
        {/* Если у спикера несколько тем — выбор темы. Виден всегда: можно сменить
            тему даже у уже занятого своего слота. */}
        {myTopics.length > 1 && (selectedId != null || mySlot) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', marginTop: 4 }}>
            <span style={{ fontSize: 13, color: DARK, fontWeight: 600 }}>Тема выступления:</span>
            <select
              value={selectedTopicId ?? ''}
              onChange={e => setSelectedTopicId(e.target.value ? Number(e.target.value) : null)}
              style={{ flex: 1, minWidth: 200, padding: '8px 10px', borderRadius: 10, border: '1px solid #d4dee5', fontSize: 13, background: '#fff' }}
            >
              <option value="">— по умолчанию (первая тема) —</option>
              {myTopics.map(t => <option key={t.id} value={t.id}>{t.topic}</option>)}
            </select>
          </div>
        )}
      </div>

      {msg && (
        <div style={{
          padding: '10px 12px', borderRadius: 10, marginBottom: 12, fontSize: 13,
          background: msg.ok ? '#e9f7ee' : '#fdecec',
          color: msg.ok ? '#1f7a44' : '#b3261e',
          border: `1px solid ${msg.ok ? '#bfe6cd' : '#f3c2bd'}`,
        }}>{msg.text}</div>
      )}

      {/* Предупреждение про живую тему */}
      <div style={{
        padding: '10px 12px', borderRadius: 10, marginBottom: 12, fontSize: 12.5,
        background: '#fff7ed', border: '1px solid #fcd9b6', color: '#9a5b1a',
      }}>
        Тему вашего выступления вы задаёте в «Профиле». В программе она появится автоматически
        и обновится сама, если вы её измените. Пока тема не задана — у слота будет
        «Тема будет уточнена позже».
      </div>

      {/* Текущий слот: дата 13.07.2026 · время · Тема */}
      {mySlot ? (
        <div style={{
          padding: '10px 12px', borderRadius: 10, marginBottom: 12, fontSize: 13,
          background: '#eef6ff', border: '1px solid #cfe2f7', color: DARK,
        }}>
          {(() => {
            const d = days.find(x => x.day_number === mySlot.day)
            const dateStr = d?.day_date
              ? (() => { try { return new Date(d.day_date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow' }) } catch { return '' } })()
              : ''
            return <>Ваш слот: <b>{dateStr}</b> · <b>{timeStr(mySlot)}</b> · {mySlot.topic || 'Тема будет уточнена позже'}.{' '}</>
          })()}
          <button type="button" onClick={release} disabled={saving}
            style={{ background: 'none', border: 'none', color: '#b3261e', textDecoration: 'underline', cursor: 'pointer', fontSize: 13, padding: 0 }}>
            освободить
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 13, color: '#7a8c9c', marginBottom: 12 }}>
          Вы ещё не заняли слот. Выберите свободный ниже.
        </div>
      )}

      {/* Вкладки этапов (как в программе) */}
      {(stageTabs.length > 0 || hasOrphanDays) && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap',
          borderBottom: '1px solid #e1e8ee', paddingBottom: 10 }}>
          {stageTabs.map(st => (
            <button key={st.id} type="button"
              onClick={() => { setActiveStage(st.id); setOpenDays(null); setSelectedId(null) }}
              style={{
                padding: '8px 14px', borderRadius: 10, fontSize: 13, cursor: 'pointer',
                border: `1px solid ${effStage === st.id ? DARK : '#d4dee5'}`,
                background: effStage === st.id ? DARK : '#fff',
                color: effStage === st.id ? '#fff' : DARK, fontWeight: effStage === st.id ? 700 : 500,
              }}>
              {st.title}
            </button>
          ))}
          {hasOrphanDays && (
            <button type="button"
              onClick={() => { setActiveStage(ORPHAN); setOpenDays(null); setSelectedId(null) }}
              style={{
                padding: '8px 14px', borderRadius: 10, fontSize: 13, cursor: 'pointer',
                border: `1px solid ${effStage === ORPHAN ? DARK : '#d4dee5'}`,
                background: effStage === ORPHAN ? DARK : '#fff',
                color: effStage === ORPHAN ? '#fff' : DARK, fontWeight: effStage === ORPHAN ? 700 : 500,
              }}>
              Без этапа
            </button>
          )}
        </div>
      )}

      {/* Дни аккордеоном друг под другом: дата · название → стрелка → слоты внутри */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {stageDays.length === 0 && (
          <div style={{ fontSize: 13, color: '#7a8c9c' }}>В этом этапе пока нет дней.</div>
        )}
        {stageDays.map(d => {
          const opened = isDayOpen(d.day_number)
          const slots = slotsOfDay(d.day_number)
          const freeCount = slots.filter(s => s.is_free).length
          return (
            <div key={d.day_number} style={{ border: '1px solid #e1e8ee', borderRadius: 14, overflow: 'hidden', background: '#fff' }}>
              {/* шапка дня */}
              <button type="button" onClick={() => toggleDay(d.day_number)}
                style={{
                  width: '100%', textAlign: 'left', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '13px 14px', background: opened ? '#f4f7f9' : '#fff', border: 'none',
                }}>
                <span style={{
                  display: 'inline-block', transition: 'transform .15s',
                  transform: opened ? 'rotate(90deg)' : 'none', color: '#7a8c9c', fontSize: 14,
                }}>▶</span>
                <span style={{ color: '#7a8c9c', fontWeight: 600, fontSize: 13, minWidth: 70 }}>{fmtDate(d.day_date)}</span>
                <span style={{ flex: 1, fontWeight: 700, color: DARK, fontSize: 13.5 }}>{dayLabel(d)}</span>
                <span style={{ fontSize: 12, color: freeCount > 0 ? '#1f7a44' : '#9aa9b7', fontWeight: 600 }}>
                  {freeCount > 0 ? `свободно ${freeCount}` : 'нет мест'}
                </span>
              </button>
              {/* слоты дня */}
              {opened && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 12px 12px' }}>
                  {slots.length === 0 && (
                    <div style={{ fontSize: 13, color: '#7a8c9c' }}>В этом дне пока нет слотов.</div>
                  )}
                  {slots.map(s => {
                    const free = s.is_free
                    const mine = s.is_mine
                    const selected = selectedId === s.id
                    return (
                      <button
                        key={s.id}
                        type="button"
                        disabled={!free && !mine}
                        onClick={() => { if (free) setSelectedId(prev => prev === s.id ? null : s.id) }}
                        style={{
                          textAlign: 'left', width: '100%',
                          display: 'flex', alignItems: 'center', gap: 12,
                          padding: '12px 14px', borderRadius: 12,
                          // занят чужим → светло-красный полупрозрачный; мой → голубой; свободный/выбранный → как было
                          border: `2px solid ${selected ? PEACH : mine ? '#9ec6f0' : free ? '#d4dee5' : 'rgba(220,53,69,0.25)'}`,
                          background: mine ? '#eef6ff' : selected ? '#fff7ef' : free ? '#fff' : 'rgba(255,80,80,0.10)',
                          cursor: (!free && !mine) ? 'default' : 'pointer',
                        }}
                      >
                        <div style={{
                          width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                          border: `2px solid ${selected ? PEACH : '#c3cfd8'}`,
                          background: selected ? PEACH : (mine ? '#9ec6f0' : 'transparent'),
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          {(selected || mine) && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff' }} />}
                        </div>
                        <div style={{ minWidth: 96, fontWeight: 700, color: DARK, fontSize: 14 }}>{timeStr(s)}</div>
                        <div style={{ flex: 1 }}>
                          {free ? (
                            <span style={{ color: '#1f7a44', fontWeight: 600, fontSize: 13 }}>Свободно</span>
                          ) : (
                            <div>
                              <div style={{ fontWeight: 700, color: DARK, fontSize: 13.5 }}>
                                {s.occupant_name || 'Занято'}{mine ? ' (вы)' : ''}
                              </div>
                              <div style={{ fontSize: 12.5, color: '#7a8c9c', marginTop: 1 }}>{s.topic}</div>
                            </div>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function JudgingTab({ token }: { token: string }) {
  const params = useParams()
  const eventSlug = String(params?.event_slug || '')
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<any>(null)
  const [stageId, setStageId] = useState<number | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  // Ссылки на textarea обратной связи по каждому участнику — чтобы при фиксации
  // читать актуальный введённый текст (а не только сохранённый onBlur).
  const fbRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  // Ссылки на инпуты оценок (ключ `criterionId|subjectKey`) — чтобы при фиксации
  // читать актуально введённое значение, даже если onBlur ещё не сработал.
  const scoreRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${API}/api/v1/public/tournament-jury/me${stageId ? `?stage_id=${stageId}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json()).then(d => {
        setData(d)
        // по умолчанию первый этап (без варианта «Все этапы»)
        if (stageId == null && d?.stages?.length > 0) setStageId(d.stages[0].id)
      }).finally(() => setLoading(false))
  }, [token, stageId])
  useEffect(() => { load() }, [load])

  const scoreVal = (criterionId: number, key: string): string => {
    const s = (data?.my_scores || []).find((x: any) => x.criterion_id === criterionId && x.key === key)
    return s ? String(s.value_number) : ''
  }
  const fbVal = (key: string): string => {
    const f = (data?.my_feedback || []).find((x: any) => x.key === key && (stageId ? x.stage_id === stageId : x.stage_id == null))
    return f ? f.body : ''
  }
  const saveScore = async (criterionId: number, key: string, value: string, scaleMax: number, inputEl?: HTMLInputElement) => {
    if (value === '') return
    let num = Number(value)
    if (isNaN(num)) return
    // нельзя ниже 0 и выше максимума критерия
    if (num < 0) num = 0
    if (num > scaleMax) num = scaleMax
    if (inputEl && String(num) !== value) inputEl.value = String(num)  // поправить поле визуально
    await fetch(`${API}/api/v1/public/tournament-jury/score`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ criterion_id: criterionId, key, value: num }),
    })
    // НЕ перезагружаем страницу — балл уже сохранён, чтобы не сбивать фокус/скролл при вводе.
  }
  const saveFb = async (key: string, body: string) => {
    await fetch(`${API}/api/v1/public/tournament-jury/feedback`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, body, stage_id: stageId }),
    })
  }
  const lockedKeys: string[] = data?.locked_keys || []
  const isLocked = (key: string) => lockedKeys.includes(key)
  const myAvg = (key: string): string => {
    const v = data?.my_avg_by_key?.[key]
    return v == null ? '—' : String(v)
  }
  // Фиксация оценки ОДНОГО участника. Требуем: ВСЕ критерии проставлены +
  // развёрнутая обратная связь (≥10 слов).
  const lockSubject = async (key: string, name: string) => {
    // Проверка: все критерии этапа должны быть заполнены (нельзя частично).
    // Актуальное значение берём из поля (может быть ещё не сохранено onBlur),
    // фолбэк — на сохранённое.
    const crits = data?.criteria || []
    const curVal = (cid: number) => {
      const raw = scoreRefs.current[`${cid}|${key}`]?.value
      return (raw != null ? raw : scoreVal(cid, key)).trim()
    }
    const missing = crits.filter((c: any) => curVal(c.id) === '')
    if (missing.length > 0) {
      alert(`Нельзя сохранить оценку — не проставлены все критерии.\n\nОсталось заполнить: ${missing.map((c: any) => c.title).join(', ')}`)
      return
    }
    // Досохраняем оценки, которые ещё не ушли на сервер (onBlur не сработал).
    for (const c of crits) {
      const el = scoreRefs.current[`${c.id}|${key}`]
      if (el && el.value !== '') await saveScore(c.id, key, el.value, Number(c.scale_max))
    }
    // Актуальный текст берём из поля (может быть ещё не сохранён onBlur).
    const fb = ((fbRefs.current[key]?.value ?? fbVal(key)) || '').trim()
    const words = fb ? fb.split(/\s+/).filter(Boolean).length : 0
    if (words === 0) {
      alert('Сначала напишите обратную связь участнику — без неё зафиксировать нельзя.')
      return
    }
    if (words < 10) {
      alert(`Обратная связь слишком короткая (${words} сл.). Дайте развёрнутый комментарий — минимум 10 слов: что было хорошо и что развивать.`)
      return
    }
    if (!confirm(`Зафиксировать оценку участнику «${name}»?`)) return
    // Сохраняем фидбек перед фиксацией (на случай если onBlur не сработал).
    await saveFb(key, fb)
    await fetch(`${API}/api/v1/public/tournament-jury/lock`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, stage_id: stageId }),
    })
    load()
  }

  if (loading) return <div style={{ padding: 20, textAlign: 'center', color: '#7a8c9c' }}>Загрузка…</div>
  if (!data?.subjects?.length) return <div style={{ padding: 16, color: '#7a8c9c', fontSize: 14 }}>Вам пока не назначили участников для оценки. Обратитесь к организатору.</div>

  const done = (data.subjects || []).filter((s: any) =>
    (data.criteria || []).some((c: any) => scoreVal(c.id, s.key) !== '')
  ).length

  return (
    <div>
      {data.stages?.length > 0 && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <select value={stageId ?? ''} onChange={(e) => setStageId(e.target.value ? Number(e.target.value) : null)}
            style={{ padding: '10px 14px', borderRadius: 10, border: 'none', fontSize: 15, fontWeight: 800,
                     color: PEACH, background: 'linear-gradient(45deg, #25455D, #0a1520)', cursor: 'pointer' }}>
            {data.stages.map((s: any) => <option key={s.id} value={s.id} style={{ color: '#1a2a3a', background: '#fff', fontWeight: 400 }}>{s.title}</option>)}
          </select>
          {stageId && eventSlug && (
            <a href={`/t/${eventSlug}/${stageId}`} target="_blank" rel="noreferrer"
              style={{ fontSize: 13, color: DARK, textDecoration: 'underline', fontWeight: 700 }}>
              🏆 Турнирная таблица этапа
            </a>
          )}
        </div>
      )}

      {(data.criteria || []).length === 0 ? (
        <div style={{ padding: 16, color: '#7a8c9c', fontSize: 14, background: '#f8fafc', borderRadius: 10 }}>
          На этом этапе нет критериев оценки жюри — оценивать нечего.
        </div>
      ) : (
       <>
      <div style={{ fontSize: 13, color: '#7a8c9c', marginBottom: 12 }}>Оценено: {done} из {data.subjects.length}</div>

      {data.subjects.map((s: any) => {
        const material = s.material
        const isOpen = open === s.key
        const locked = isLocked(s.key)
        const scored = (data.criteria || []).some((c: any) => scoreVal(c.id, s.key) !== '')
        return (
          <div key={s.key} style={{ border: `2px solid ${PEACH}`, borderRadius: 12, marginBottom: 12, overflow: 'hidden', boxShadow: '0 1px 4px rgba(255,207,164,0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '12px 14px', background: 'linear-gradient(135deg, #fff3e6, #ffe8d1)' }} onClick={() => setOpen(isOpen ? null : s.key)}>
              <b style={{ color: DARK }}>{s.name}</b>
              {locked
                ? <span style={{ fontSize: 12, color: '#047857', fontWeight: 700 }}>🔒 зафиксировано</span>
                : <span style={{ fontSize: 12, color: scored ? '#16a34a' : '#7a6a55' }}>{scored ? '✓ оценено' : '○ не оценен'}</span>}
              {scored && <span style={{ fontSize: 12, color: DARK, fontWeight: 700 }}>· моя оценка: {myAvg(s.key)}</span>}
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: '50%', background: DARK, color: PEACH, fontSize: 14, fontWeight: 800, transform: isOpen ? 'none' : 'rotate(-90deg)', transition: 'transform .15s', flexShrink: 0 }}>▾</span>
            </div>
            {isOpen && (
              <div style={{ padding: 14 }}>
                {material && (
                  <a href={material} target="_blank" rel="noreferrer"
                    style={{ display: 'inline-block', marginBottom: 12, color: DARK, fontWeight: 600, fontSize: 14 }}>
                    🔗 Смотреть материалы участника
                  </a>
                )}
                {data.criteria.length === 0 && <div style={{ fontSize: 13, color: '#94a3b8' }}>На этом этапе нет критериев для оценки жюри.</div>}
                {data.criteria.map((c: any) => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{c.title}</div>
                      {c.description && (
                        <div style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.4, whiteSpace: 'pre-line', marginTop: 2 }}>{c.description}</div>
                      )}
                    </div>
                    <input type="number" min={0} max={c.scale_max} step="0.1" defaultValue={scoreVal(c.id, s.key)}
                      ref={(el) => { scoreRefs.current[`${c.id}|${s.key}`] = el }}
                      onBlur={(e) => saveScore(c.id, s.key, e.target.value, Number(c.scale_max), e.target)}
                      style={{ width: 70, padding: '6px 8px', borderRadius: 8, border: '1px solid #d4dee5', textAlign: 'center', flexShrink: 0, background: '#fff' }} />
                    <span style={{ color: '#94a3b8', fontSize: 13, flexShrink: 0, paddingTop: 8 }}>/ {c.scale_max}</span>
                  </div>
                ))}
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: DARK, marginBottom: 4 }}>💬 Обратная связь участнику <span style={{ color: '#dc2626', fontWeight: 400 }}>— обязательна, минимум 10 слов</span></div>
                  <textarea defaultValue={fbVal(s.key)} placeholder="Почему такие оценки и что рекомендую развивать (развёрнуто, минимум 10 слов)…"
                    ref={(el) => { fbRefs.current[s.key] = el }}
                    onBlur={(e) => saveFb(s.key, e.target.value)}
                    style={{ width: '100%', minHeight: 70, padding: 10, borderRadius: 8, border: '1px solid #d4dee5', fontSize: 14, fontFamily: 'inherit', background: '#fff' }} />
                </div>
                {/* Фиксация по участнику. Оценки можно менять всегда — фиксация лишь
                    отмечает «готово» (участник видит, что жюри завершило). */}
                {locked && (
                  <div style={{ marginTop: 10, fontSize: 13, color: '#047857', fontWeight: 600 }}>🔒 Оценка зафиксирована. Можно поправить и зафиксировать заново.</div>
                )}
                <button onClick={() => lockSubject(s.key, s.name)}
                  style={{ marginTop: 10, width: '100%', padding: '10px 16px', borderRadius: 10, border: 'none', background: DARK, color: PEACH, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                  🔒 {locked ? 'Обновить фиксацию' : 'Зафиксировать оценку этого участника'}
                </button>
              </div>
            )}
          </div>
        )
      })}
       </>
      )}
    </div>
  )
}

// ─────────────────────── Вкладка УЧАСТНИКА: мои результаты ───────────────────────

function MyResultsTab({ token }: { token: string }) {
  const params = useParams()
  const eventSlug = String(params?.event_slug || '')
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<any>(null)
  // Свёрнутые пакеты (ключ = `${stage_id}:${pkg.id}`). По умолчанию раскрыты.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const toggle = (key: string) => setCollapsed(p => ({ ...p, [key]: !p[key] }))

  useEffect(() => {
    fetch(`${API}/api/v1/public/tournament-jury/my-results`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setData(d)).finally(() => setLoading(false))
  }, [token])

  if (loading) return <div style={{ padding: 20, textAlign: 'center', color: '#7a8c9c' }}>Загрузка…</div>
  if (!data?.is_tournament) return <div style={{ padding: 16, color: '#7a8c9c', fontSize: 14 }}>Это событие — не турнир.</div>
  // Показываем этапы, если есть оценки ИЛИ хотя бы назначенные жюри (участник
  // видит своих жюри со статусом «оценка не проставлена»).
  const hasAnyJurors = (data.stages || []).some((s: any) => (s.assigned_jurors || []).length > 0)
  if (!data?.has_results && !hasAnyJurors) return <div style={{ padding: 16, color: '#7a8c9c', fontSize: 14 }}>Результатов пока нет — жюри ещё не назначены.</div>

  const medal = (p: number | null) => p == null ? '' : (p <= 3 ? ['🥇','🥈','🥉'][p-1] : '#'+p)

  return (
    <div>
      <div style={{ fontSize: 13, color: '#7a8c9c', marginBottom: 14 }}>Ваши оценки по всем этапам — полная прозрачность, с комментариями жюри.</div>

      {/* Ссылка-материал, которую по этому спикеру получают жюри (= «Папка с видео») */}
      {data.my_material && (
        <div style={{ border: `2px solid ${PEACH}`, borderRadius: 12, padding: 14, marginBottom: 16, background: 'linear-gradient(135deg, #fff3e6, #ffe8d1)' }}>
          <div style={{ fontWeight: 800, color: DARK, marginBottom: 6, fontSize: 14 }}>Вот такую ссылку получают жюри — нажмите и проверьте себя!</div>
          <a href={data.my_material} target="_blank" rel="noreferrer"
            style={{ color: DARK, fontWeight: 600, fontSize: 14, wordBreak: 'break-all', textDecoration: 'underline' }}>
            {data.my_material}
          </a>
        </div>
      )}

      {(data.stages || []).map((st: any) => {
        const stKey = `stage:${st.stage_id}`
        const stCollapsed = collapsed[stKey]
        return (
        <div key={String(st.stage_id)} style={{ marginBottom: 22 }}>
          {/* заголовок этапа — кликабельный, сворачивает весь тур */}
          <div onClick={() => toggle(stKey)}
            style={{ fontSize: 15, fontWeight: 800, color: PEACH, background: 'linear-gradient(45deg, #25455D, #0a1520)', marginBottom: 8, padding: '10px 14px', borderRadius: 10, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <span>{st.stage_title}</span>
            <span style={{ fontSize: 14, transform: stCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform .15s', flexShrink: 0 }}>▾</span>
          </div>
          {!stCollapsed && (<>
          {st.stage_id && eventSlug && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
              <a href={`/t/${eventSlug}/${st.stage_id}`} target="_blank" rel="noreferrer"
                style={{ fontSize: 13, color: DARK, textDecoration: 'underline', fontWeight: 700 }}>
                🏆 Турнирная таблица этапа
              </a>
              <a href={`/t/${eventSlug}/${st.stage_id}/reglament`} target="_blank" rel="noreferrer"
                style={{ fontSize: 13, color: DARK, textDecoration: 'underline' }}>
                📋 Регламент подсчёта баллов
              </a>
            </div>
          )}

          {/* Назначенные жюри — раскрывающиеся блоки: оценки по критериям +
              средний балл + обратная связь этого жюри. Видны даже до оценок. */}
          {(st.assigned_jurors || []).length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: DARK, marginBottom: 8 }}>👥 Ваши жюри на этом этапе</div>
              {st.assigned_jurors.map((j: any, i: number) => {
                const jKey = `juror:${st.stage_id}:${i}`
                const jOpen = !collapsed[jKey]   // по умолчанию раскрыт если оценил
                const canOpen = j.has_scored
                return (
                  <div key={i} onClick={() => canOpen && toggle(jKey)}
                    style={{ border: `2px solid ${PEACH}`, borderRadius: 12, marginBottom: 8, overflow: 'hidden', boxShadow: '0 1px 4px rgba(255,207,164,0.4)', cursor: canOpen ? 'pointer' : 'default' }}>
                    <div
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'linear-gradient(135deg, #fff3e6, #ffe8d1)' }}>
                      <span style={{ fontWeight: 700, color: DARK, fontSize: 14 }}>{j.juror_name}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {j.has_scored ? (
                          <b style={{ color: DARK, fontSize: 15 }}>{j.avg ?? '—'}</b>
                        ) : (
                          <span style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8' }}>оценка не проставлена</span>
                        )}
                        {canOpen && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: '50%', background: DARK, color: PEACH, fontSize: 14, fontWeight: 800, transform: jOpen ? 'none' : 'rotate(-90deg)', transition: 'transform .15s', flexShrink: 0 }}>▾</span>
                        )}
                      </span>
                    </div>
                    {canOpen && jOpen && (
                      <div style={{ padding: '8px 14px 12px' }}>
                        {(j.criteria || []).map((c: any, ci: number) => (
                          <div key={ci} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0', borderTop: ci ? '1px solid #f1f5f9' : 'none' }}>
                            <span style={{ color: '#475569' }}>{c.title}</span>
                            <b>{c.value ?? '—'}</b>
                          </div>
                        ))}
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0 0', marginTop: 4, borderTop: '2px solid #e2e8f0', fontWeight: 700, color: DARK }}>
                          <span>Средний балл</span>
                          <span>{j.avg ?? '—'}</span>
                        </div>
                        {j.feedback && (
                          <div style={{ marginTop: 10, background: '#f8fafc', borderRadius: 8, padding: 10, fontSize: 13, color: '#334155', lineHeight: 1.4 }}>
                            <div style={{ fontWeight: 700, color: DARK, marginBottom: 4 }}>💬 Обратная связь</div>
                            {j.feedback}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {!st.has_results ? (
            <div style={{ fontSize: 14, color: '#94a3b8', padding: '4px 0 8px' }}>За этот этап оценок пока нет.</div>
          ) : (
            <>
              <div style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)', borderRadius: 14, padding: 16, color: '#fff', marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>Место на этапе</div>
                    <div style={{ fontSize: 24, fontWeight: 800 }}>{medal(st.place)} {st.place}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 13, opacity: 0.8 }}>Итог этапа</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: PEACH }}>{st.total}</div>
                  </div>
                </div>
              </div>

              {/* Оценки сгруппированы ПО ПАКЕТАМ: заголовок пакета (вес + нормализация + балл пакета), затем критерии */}
              {(st.packages || []).map((pkg: any) => {
                const pkgCols = (st.columns || []).filter((c: any) => c.package_id === pkg.id)
                if (pkgCols.length === 0) return null
                const pkgScore = st.package_scores?.[String(pkg.id)]
                const pkgKey = `pkg:${st.stage_id}:${pkg.id}`
                const pkgCollapsed = collapsed[pkgKey]
                return (
                  <div key={pkg.id} style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 14, marginBottom: 10 }}>
                    <div onClick={() => toggle(pkgKey)}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: pkgCollapsed ? 0 : 8, cursor: 'pointer', gap: 10 }}>
                      <div style={{ fontWeight: 700, color: DARK }}>
                        <span style={{ fontSize: 12, marginRight: 6, display: 'inline-block', transform: pkgCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform .15s' }}>▾</span>
                        {pkg.title}
                        <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 400, marginLeft: 6 }}>вес {pkg.weight}</span>
                        {pkg.normalize && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: '#b45309', background: '#FFF3E0', border: '1px solid #FFCFA4', borderRadius: 5, padding: '1px 5px', marginLeft: 6 }}
                            title="Нормализация: баллы критериев приводятся к доле от лучшего результата">норм.</span>
                        )}
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 10, color: '#94a3b8' }}>балл пакета</div>
                        <b style={{ color: DARK }}>{pkgScore ?? '—'}</b>
                      </div>
                    </div>
                    {!pkgCollapsed && pkgCols.map((c: any) => (
                      <div key={c.criterion_id} style={{ padding: '4px 0', borderTop: '1px solid #f1f5f9' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                          <span>{c.title}</span>
                          <b>{st.cells?.[String(c.criterion_id)] ?? '—'}</b>
                        </div>
                        {c.description && (
                          <div style={{ color: '#b0bcc8', fontSize: 11, lineHeight: 1.3, whiteSpace: 'pre-line', marginTop: 1 }}>{c.description}</div>
                        )}
                      </div>
                    ))}
                    {/* Пакет схемы s1 (напр. «Вовлечение»): полный расчёт —
                        моя сырая сумма, лидер (фамилия+значение), нормализация ×10. */}
                    {!pkgCollapsed && pkg.scheme === 's1' && (() => {
                      const myRaw = st.package_raw_sums?.[String(pkg.id)]
                      const leader = pkg.leader
                      return (
                        <div style={{ marginTop: 8, borderTop: '2px solid #e2e8f0', paddingTop: 8, fontSize: 13, color: '#475569', lineHeight: 1.6 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>Моя сумма баллов (с учётом весов)</span>
                            <b style={{ color: DARK }}>{myRaw ?? '—'}</b>
                          </div>
                          {leader && (
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span>Лидер: {leader.name}</span>
                              <b style={{ color: DARK }}>{leader.value}</b>
                            </div>
                          )}
                          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: 12 }}>
                            <span>Расчёт: моя сумма ÷ сумма лидера × 10</span>
                            <span>{myRaw != null && leader?.value ? `${myRaw} ÷ ${leader.value} × 10` : ''}</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: DARK, marginTop: 2 }}>
                            <span>Нормализованный балл пакета</span>
                            <span>{pkgScore ?? '—'}</span>
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                )
              })}
              {/* Общий блок «Обратная связь жюри» убран — фидбек теперь
                  внутри раскрывающегося блока каждого жюри выше. */}
            </>
          )}
          </>)}
        </div>
        )
      })}
    </div>
  )
}
