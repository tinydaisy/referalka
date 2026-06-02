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
import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'

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
  gift_raffle_title: string | null
  gift_raffle_url: string | null
  knowledge_base_title: string | null
  knowledge_base_url: string | null
  show_topic_field: boolean
  show_gift_after_speech_field: boolean
  show_knowledge_base_field: boolean
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

type CabinetTab = 'profile' | 'materials'

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
        payload.gift_after_speech_title = me.gift_after_speech_title
        payload.gift_after_speech_url = me.gift_after_speech_url
      }
      if (me.raffle_enabled) {
        payload.gift_raffle_title = me.gift_raffle_title
        payload.gift_raffle_url = me.gift_raffle_url
      }
      if (me.show_knowledge_base_field) {
        payload.knowledge_base_title = me.knowledge_base_title
        payload.knowledge_base_url = me.knowledge_base_url
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

          <label style={{ display: 'block', fontSize: 13, color: '#5c7589', marginBottom: 6 }}>Найдите свою фамилию</label>
          <SpeakerPicker list={list || []} chosenId={chosenId} setChosenId={setChosenId} />

          <label style={{ display: 'block', fontSize: 13, color: '#5c7589', marginBottom: 6 }}>Код доступа (из сообщения от организатора)</label>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="abcd1234"
            style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: '1px solid #d4dee5', fontSize: 15, marginBottom: 16, fontFamily: 'monospace', letterSpacing: 2 }}
          />

          {error && <div style={{ background: '#ffe9e0', color: '#a83e1c', padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

          <button
            onClick={onAuth}
            style={{ width: '100%', padding: '14px', background: PEACH, color: DARK, fontWeight: 700, fontSize: 15, border: 'none', borderRadius: 10, cursor: 'pointer' }}
          >
            Войти
          </button>

          <p style={{ marginTop: 16, fontSize: 12, color: '#7a8c9c', lineHeight: 1.5 }}>
            Сессия живёт 24 часа. Можно передать ссылку и код ассистенту — он заполнит за вас.
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
              <div style={{ fontSize: 18, fontWeight: 700 }}>{me.name || 'Спикер'}</div>
            </div>
            <button onClick={onLogout} style={{ background: 'transparent', border: '1px solid #fff', color: '#fff', padding: '8px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Выйти</button>
          </div>
        </div>

        {/* Вкладки кабинета */}
        <div style={{
          display: 'flex', gap: 4, marginBottom: 14,
          borderBottom: '1px solid #d4dee5',
        }}>
          {([
            { key: 'profile'   as CabinetTab, label: 'Профиль' },
            { key: 'materials' as CabinetTab, label: 'Материалы' },
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

          <label style={labelCss}>Должность / роль</label>
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
          <div style={{ fontSize: 11, color: '#7a8c9c', marginTop: 4, lineHeight: 1.5 }}>
            Выложите 1–2 видео: одно из <b>личной жизни</b> (отдых, хобби) и одно из <b>профессиональной</b> (выступаете на сцене, общаетесь с клиентами, в рабочей обстановке).
          </div>

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

        <Section title="Соцсети и каналы">
          <div style={{ fontSize: 12, color: '#7a8c9c', marginTop: -2, marginBottom: 6, lineHeight: 1.5 }}>
            Эти ссылки отображаются в Mini App события в вашей карточке — участники увидят их и смогут перейти прямо на ваш канал / сообщество / сайт.
          </div>
          <label style={labelCss}>Telegram-канал (ссылка)</label>
          <input style={inputCss} value={me.tg_channel_url || ''} onChange={(e) => update({ tg_channel_url: e.target.value })} placeholder="https://t.me/…" />
          <label style={labelCss}>VK-сообщество (ссылка)</label>
          <input style={inputCss} value={me.vk_url || ''} onChange={(e) => update({ vk_url: e.target.value })} placeholder="https://vk.com/…" />
          <label style={labelCss}>MAX-канал (ссылка)</label>
          <input style={inputCss} value={me.max_url || ''} onChange={(e) => update({ max_url: e.target.value })} placeholder="https://max.ru/…" />
          <label style={labelCss}>Instagram (Нельзяграм)</label>
          <input style={inputCss} value={me.instagram_url || ''} onChange={(e) => update({ instagram_url: e.target.value })} placeholder="https://instagram.com/… или @username" />
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
            <label style={labelCss}>Название</label>
            <input style={inputCss} value={me.gift_after_speech_title || ''} onChange={(e) => update({ gift_after_speech_title: e.target.value })} placeholder="Например: Чек-лист по нутрициологии" />
            <label style={labelCss}>Ссылка</label>
            <input style={inputCss} value={me.gift_after_speech_url || ''} onChange={(e) => update({ gift_after_speech_url: e.target.value })} placeholder="https://…" />
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
                  Открыть кабинет партнёра →
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
                      </div>
                    )
                  })}
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
    </div>
  )
}

function SpeakerPicker({ list, chosenId, setChosenId }: {
  list: SpeakerListItem[]
  chosenId: number | null
  setChosenId: (n: number | null) => void
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

  const partnerRows = [
    { key: 'telegram', label: 'Telegram', url: materials.partner_link.telegram },
    { key: 'vk',       label: 'VK',       url: materials.partner_link.vk },
    { key: 'max',      label: 'MAX',      url: materials.partner_link.max },
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
