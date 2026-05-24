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
  poster_url: string | null
  tg_channel_url: string | null
  vk_url: string | null
  max_url: string | null
  instagram_url: string | null
  website_url: string | null
  tg_channel_id: string | null
  email: string | null
  phone: string | null
  personal_tg_id: string | null
  personal_tg_username: string | null
  personal_vk_id: string | null
  personal_vk_username: string | null
  personal_max_id: string | null
  personal_max_username: string | null
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
}

const TOKEN_KEY = (slug: string) => `speaker_cabinet_token_${slug}`

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
      if (r.status === 401) {
        localStorage.removeItem(TOKEN_KEY(slug))
        setToken(null)
        setMe(null)
        return
      }
      if (!r.ok) throw new Error((await r.json()).detail || 'Ошибка')
      setMe(await r.json())
    } catch (e: any) {
      setError(String(e.message || e))
    }
  }, [token, slug])

  useEffect(() => {
    loadMe()
  }, [loadMe])

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
      const payload: any = {
        name: me.name, title: me.title, achievements: me.achievements,
        photo_url: me.photo_url, poster_url: me.poster_url,
        tg_channel_url: me.tg_channel_url, tg_channel_id: me.tg_channel_id,
        vk_url: me.vk_url, max_url: me.max_url,
        instagram_url: me.instagram_url, website_url: me.website_url,
        email: me.email, phone: me.phone,
        personal_tg_id: me.personal_tg_id, personal_tg_username: me.personal_tg_username,
        personal_vk_id: me.personal_vk_id, personal_vk_username: me.personal_vk_username,
        personal_max_id: me.personal_max_id, personal_max_username: me.personal_max_username,
        topics: me.topics,
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
      setSavedAt(new Date())
    } catch (e: any) {
      setError(String(e.message || e))
    } finally {
      setSaving(false)
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
          <select
            value={chosenId || ''}
            onChange={(e) => setChosenId(e.target.value ? Number(e.target.value) : null)}
            style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: '1px solid #d4dee5', fontSize: 15, marginBottom: 14, background: '#fff' }}
          >
            <option value="">— выберите —</option>
            {(list || []).map((sp) => (
              <option key={sp.speaker_event_id} value={sp.speaker_event_id}>
                {sp.full_name}
              </option>
            ))}
          </select>

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

  const update = (patch: Partial<SpeakerMe>) => setMe((m) => m ? ({ ...m, ...patch }) : m)
  const updTopics = (i: number, v: string) => {
    const arr = [...(me?.topics || [])]
    arr[i] = v
    update({ topics: arr })
  }
  const addTopic = () => update({ topics: [...(me?.topics || []), ''] })
  const removeTopic = (i: number) => update({ topics: (me?.topics || []).filter((_, idx) => idx !== i) })
  const updAch = (i: number, v: string) => {
    const arr = [...(me?.achievements || [])]
    arr[i] = v
    update({ achievements: arr })
  }
  const addAch = () => update({ achievements: [...(me?.achievements || []), ''] })
  const removeAch = (i: number) => update({ achievements: (me?.achievements || []).filter((_, idx) => idx !== i) })

  return (
    <div style={{ minHeight: '100vh', background: '#f5f7fa', padding: 16, fontFamily: 'Roboto, sans-serif' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ background: `linear-gradient(45deg, ${DARK}, #0a1520)`, color: '#fff', padding: 20, borderRadius: 14, marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, opacity: 0.7 }}>«{me.event_title}»</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{me.name || 'Спикер'}</div>
          </div>
          <button onClick={onLogout} style={{ background: 'transparent', border: '1px solid #fff', color: '#fff', padding: '8px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Выйти</button>
        </div>

        <Section title="Профиль">
          <label style={labelCss}>Имя и фамилия</label>
          <input style={inputCss} value={me.name || ''} onChange={(e) => update({ name: e.target.value })} />

          <label style={labelCss}>Должность / роль</label>
          <input style={inputCss} value={me.title || ''} onChange={(e) => update({ title: e.target.value })} placeholder="Кто вы и чем занимаетесь" />

          <label style={labelCss}>Email</label>
          <input style={inputCss} type="email" value={me.email || ''} onChange={(e) => update({ email: e.target.value })} />

          <label style={labelCss}>Телефон</label>
          <input style={inputCss} type="tel" value={me.phone || ''} onChange={(e) => update({ phone: e.target.value })} />

          <label style={labelCss}>Фото профиля (URL)</label>
          <input style={inputCss} value={me.photo_url || ''} onChange={(e) => update({ photo_url: e.target.value })} placeholder="https://…" />
          {me.photo_url && <img src={me.photo_url} alt="" style={{ width: 90, height: 90, objectFit: 'cover', borderRadius: 12, marginTop: 8 }} />}

          <label style={labelCss}>Афиша (URL)</label>
          <input style={inputCss} value={me.poster_url || ''} onChange={(e) => update({ poster_url: e.target.value })} placeholder="https://…" />

          <div style={labelCss}>Регалии (по одной на строку)</div>
          {(me.achievements || []).map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input style={{ ...inputCss }} value={a} onChange={(e) => updAch(i, e.target.value)} />
              <button onClick={() => removeAch(i)} style={{ padding: '0 12px', background: '#fff', border: '1px solid #d4dee5', borderRadius: 8, cursor: 'pointer' }}>×</button>
            </div>
          ))}
          <button onClick={addAch} style={{ padding: '8px 14px', background: '#fff', border: `1px dashed ${PEACH}`, color: DARK, borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>+ добавить регалию</button>
        </Section>

        <Section title="Соцсети и каналы">
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

        <Section title="Личные аккаунты (никнейм или ID)">
          <div style={{ fontSize: 12, color: '#7a8c9c', marginBottom: 8 }}>Используются для связи с вами и для проверки бот-в-канале. Не показываются другим участникам.</div>
          <label style={labelCss}>Telegram username</label>
          <input style={inputCss} value={me.personal_tg_username || ''} onChange={(e) => update({ personal_tg_username: e.target.value })} placeholder="username (без @)" />
          <label style={labelCss}>Telegram ID</label>
          <input style={inputCss} value={me.personal_tg_id || ''} onChange={(e) => update({ personal_tg_id: e.target.value })} />
          <label style={labelCss}>VK username</label>
          <input style={inputCss} value={me.personal_vk_username || ''} onChange={(e) => update({ personal_vk_username: e.target.value })} placeholder="id123456 или nickname" />
          <label style={labelCss}>MAX username</label>
          <input style={inputCss} value={me.personal_max_username || ''} onChange={(e) => update({ personal_max_username: e.target.value })} />
        </Section>

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
            <label style={labelCss}>Название</label>
            <input style={inputCss} value={me.knowledge_base_title || ''} onChange={(e) => update({ knowledge_base_title: e.target.value })} placeholder="Например: Презентация выступления" />
            <label style={labelCss}>Ссылка</label>
            <input style={inputCss} value={me.knowledge_base_url || ''} onChange={(e) => update({ knowledge_base_url: e.target.value })} placeholder="https://…" />
          </Section>
        )}

        {error && <div style={{ background: '#ffe9e0', color: '#a83e1c', padding: 12, borderRadius: 10, marginBottom: 12, fontSize: 14 }}>{error}</div>}

        <button
          onClick={onSave}
          disabled={saving}
          style={{ width: '100%', padding: '16px', background: PEACH, color: DARK, fontWeight: 700, fontSize: 16, border: 'none', borderRadius: 12, cursor: saving ? 'wait' : 'pointer', marginBottom: 24, position: 'sticky', bottom: 12 }}
        >
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
        {savedAt && <div style={{ textAlign: 'center', fontSize: 12, color: '#5a8b5a', marginBottom: 24 }}>Сохранено в {savedAt.toLocaleTimeString('ru-RU').slice(0, 5)}</div>}
      </div>
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
