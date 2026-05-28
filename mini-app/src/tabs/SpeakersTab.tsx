import { useState, useEffect, useRef } from 'react'
import { getSpeakers } from '../api'

interface Props {
  event: any
  tgUser?: any
  /** Если передан — после загрузки скроллим к этой карточке и подсвечиваем. */
  highlightSpeakerEventId?: number | null
  onHighlightConsumed?: () => void
}

interface Speaker {
  id: number
  speaker_id?: number
  name: string
  title?: string
  photo_url?: string
  role?: string
  achievements?: string[] | null
  tg_channel_url?: string | null
  vk_url?: string | null
  max_url?: string | null
  instagram_url?: string | null
  speaker_topic?: string | null
  gift_after_speech_title?: string | null
  gift_raffle_title?: string | null
  knowledge_base_title?: string | null
  knowledge_base_url?: string | null
  topics?: { topic: string }[]
}

const PEACH = '#FFCFA4'
const DARK  = '#25455D'

const PASTELS = ['#fff8f0', '#f0f5fb', '#fbf2f0', '#f3f5f0', '#fdf6e8', '#f5f0fb']

const ROLE_LABELS: Record<string, string> = {
  speaker:    'Спикер',
  headliner:  'Хедлайнер',
  partner:    'Партнёр',
  organizer:  'Организатор',
  jury:       'Жюри',
}

const ROLE_COLORS: Record<string, { bg: string; fg: string }> = {
  speaker:    { bg: '#FFCFA4', fg: '#25455D' },
  headliner:  { bg: '#25455D', fg: '#FFCFA4' },
  partner:    { bg: '#e8e9eb', fg: '#5a6a7a' },
  organizer:  { bg: '#d6e4f0', fg: '#25455D' },
  jury:       { bg: '#f0d8ff', fg: '#5b2a8c' },
}

function tgLink(url?: string | null): string | null {
  if (!url) return null
  if (/^https?:\/\//i.test(url)) return url
  if (url.startsWith('@')) return `https://t.me/${url.slice(1)}`
  return `https://t.me/${url}`
}

function initials(name?: string) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  return (parts[0]?.[0] || '').toUpperCase() + (parts[1]?.[0] || '').toUpperCase()
}

function openExternalLink(url: string) {
  if (typeof window === 'undefined' || !url) return
  const tg = (window as any).Telegram?.WebApp
  if (tg?.openLink) { try { tg.openLink(url); return } catch {} }
  try { window.open(url, '_blank') } catch { window.location.href = url }
}

async function trackSpeakerClick(
  eventId: number,
  ecId: number,
  kind: 'tg_channel' | 'vk' | 'max' | 'instagram' | 'website' | 'knowledge_base',
  user?: { id?: number | string } | null,
) {
  try {
    const tgId = user?.id ? String(user.id) : ''
    const platform = (await import('../platform')).getPlatformName()
    const body: any = { kind }
    if (platform === 'telegram' && tgId) body.tg_id = tgId
    if (platform === 'vk' && tgId) body.vk_user_id = tgId
    if (platform === 'max' && tgId) body.max_user_id = tgId
    await fetch(`${import.meta.env.VITE_API_URL}/api/v1/public/events/${eventId}/speakers/${ecId}/click-track`, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (_) {}
}

export default function SpeakersTab({ event, tgUser, highlightSpeakerEventId, onHighlightConsumed }: Props) {
  const [speakers, setSpeakers] = useState<Speaker[]>([])
  const [loading, setLoading] = useState(true)
  const [highlightId, setHighlightId] = useState<number | null>(null)
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({})

  // Если родитель попросил подсветить конкретного спикера (deeplink из
  // карусели/слота программы) — после загрузки скроллим к карточке.
  useEffect(() => {
    if (!highlightSpeakerEventId || loading) return
    const el = cardRefs.current[highlightSpeakerEventId]
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightId(highlightSpeakerEventId)
    setTimeout(() => {
      setHighlightId(null)
      onHighlightConsumed?.()
    }, 1800)
  }, [highlightSpeakerEventId, loading])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        // Единый endpoint /conference/speakers/public — отдаёт все поля
        // (knowledge_base_title/url, темы, подарки) для коллабораторов
        // ЛЮБОГО события: конференции и турнира. Endpoint /public/events/{id}/collaborators
        // не возвращает knowledge_base — поэтому здесь его не используем.
        const data = await getSpeakers(event.id)
        if (cancelled) return
        const items: Speaker[] = (data.speakers || []).map((c: any) => ({
          id: c.id,
          speaker_id: c.speaker_id,
          name: c.name,
          title: c.title,
          photo_url: c.photo_url,
          role: c.role,
          achievements: c.achievements,
          tg_channel_url: c.tg_channel_url,
          vk_url: c.vk_url,
          max_url: c.max_url,
          instagram_url: c.instagram_url,
          speaker_topic: c.speaker_topic,
          gift_after_speech_title: c.gift_after_speech_title,
          gift_raffle_title: c.gift_raffle_title,
          knowledge_base_title: c.knowledge_base_title,
          knowledge_base_url: c.knowledge_base_url,
          topics: c.topics,
        }))
        setSpeakers(items)
      } catch (e) {
        if (!cancelled) setSpeakers([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [event?.id])

  if (loading) {
    return <div style={{ padding: 20, color: '#6b7c8e' }}>Загружаем…</div>
  }
  if (speakers.length === 0) {
    return <div style={{ padding: 20, color: '#6b7c8e', textAlign: 'center' }}>Список спикеров пока пуст.</div>
  }

  return (
    <div style={{ padding: '16px 12px 80px' }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, color: DARK, margin: '4px 8px 14px' }}>
        Спикеры и жюри
      </h1>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {speakers.map((sp, idx) => {
          const roleLabel = sp.role && ROLE_LABELS[sp.role]
          const roleColors = (sp.role && ROLE_COLORS[sp.role]) || ROLE_COLORS.speaker
          const topicsList: string[] = Array.isArray(sp.topics) && sp.topics.length > 0
            ? sp.topics.map(t => t.topic).filter(Boolean)
            : (sp.speaker_topic ? [sp.speaker_topic] : [])
          const tg = tgLink(sp.tg_channel_url)
          const insta = sp.instagram_url
            ? (sp.instagram_url.startsWith('http') ? sp.instagram_url : `https://instagram.com/${sp.instagram_url.replace(/^@/, '')}`)
            : null
          const ach = (sp.achievements || []).filter(a => a && a.trim())

          const socials: Array<{ label: string; url: string; primary: boolean; kind: 'tg_channel' | 'vk' | 'max' | 'instagram' }> = []
          if (tg) socials.push({ label: 'Тг-канал', url: tg, primary: true, kind: 'tg_channel' })
          if (sp.vk_url) socials.push({ label: 'ВКонтакте', url: sp.vk_url, primary: false, kind: 'vk' })
          if (sp.max_url) socials.push({ label: 'MAX', url: sp.max_url, primary: false, kind: 'max' })
          if (insta) socials.push({ label: 'Нельзяграм', url: insta, primary: false, kind: 'instagram' })

          return (
            <div
              key={sp.id}
              ref={el => { cardRefs.current[sp.id] = el }}
              style={{
                background: PASTELS[idx % PASTELS.length],
                borderRadius: 14, padding: 14,
                boxShadow: highlightId === sp.id
                  ? '0 4px 16px rgba(255,207,164,0.5)'
                  : '0 2px 8px rgba(37,69,93,0.05)',
                border: highlightId === sp.id ? `2px solid ${PEACH}` : '2px solid transparent',
                transition: 'border-color 0.3s, box-shadow 0.3s',
              }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
                <div style={{
                  width: 56, height: 56, borderRadius: '50%', flexShrink: 0,
                  background: sp.photo_url ? `center/cover url(${sp.photo_url})` : 'linear-gradient(45deg, #25455D, #0a1520)',
                  border: `2px solid ${PEACH}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: PEACH, fontWeight: 700, fontSize: 18,
                }}>
                  {!sp.photo_url && initials(sp.name)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {roleLabel && (
                    <span style={{
                      display: 'inline-block', background: roleColors.bg, color: roleColors.fg,
                      fontSize: 10, padding: '2px 8px', borderRadius: 10, fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4,
                    }}>{roleLabel}</span>
                  )}
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#1a2a3a', lineHeight: 1.2 }}>{sp.name}</div>
                  {sp.title && (
                    <div style={{ fontSize: 12, color: '#6b7c8e', marginTop: 2, lineHeight: 1.3 }}>{sp.title}</div>
                  )}
                </div>
              </div>

              {topicsList.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700, marginBottom: 4 }}>
                    {topicsList.length > 1 ? 'Темы' : 'Тема'}
                  </div>
                  {topicsList.map((t, ti) => (
                    <div key={ti} style={{ fontSize: 13, color: '#1a2a3a', fontWeight: 600, lineHeight: 1.35, marginBottom: ti < topicsList.length - 1 ? 6 : 0 }}>
                      {t}
                    </div>
                  ))}
                </div>
              )}

              {ach.length > 0 && (
                <ul style={{ margin: '0 0 8px', padding: 0, listStyle: 'none' }}>
                  {ach.map((a, i) => (
                    <li key={i} style={{ fontSize: 12, color: '#3a4a5a', lineHeight: 1.4, paddingLeft: 14, position: 'relative', marginBottom: 3 }}>
                      <span style={{ position: 'absolute', left: 0, top: -1, color: DARK, fontWeight: 700, fontSize: 14 }}>•</span>
                      {a}
                    </li>
                  ))}
                </ul>
              )}

              {socials.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
                  {socials.map((s) => (
                    <button
                      key={s.kind}
                      type="button"
                      onClick={() => {
                        trackSpeakerClick(event.id, sp.id, s.kind, tgUser)
                        openExternalLink(s.url)
                      }}
                      style={{
                        background: s.primary ? DARK : 'white',
                        color: s.primary ? 'white' : DARK,
                        border: s.primary ? 'none' : `1px solid ${DARK}`,
                        padding: '7px 8px', borderRadius: 10,
                        fontSize: 11, fontWeight: 600, textAlign: 'center', cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      }}
                    >
                      <span>{s.label}</span>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 16, height: 16, borderRadius: '50%', background: PEACH,
                        color: DARK, fontWeight: 800, fontSize: 11, lineHeight: 1,
                      }}>→</span>
                    </button>
                  ))}
                </div>
              )}

              {sp.knowledge_base_title && sp.knowledge_base_url && (
                <button
                  type="button"
                  onClick={() => {
                    trackSpeakerClick(event.id, sp.id, 'knowledge_base', tgUser)
                    openExternalLink(sp.knowledge_base_url!)
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, marginTop: 10,
                    padding: '10px 12px', borderRadius: 10,
                    background: 'rgba(37,69,93,0.06)', border: '1px solid rgba(37,69,93,0.15)',
                    color: DARK, cursor: 'pointer', textAlign: 'left', width: '100%',
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={PEACH} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, color: '#6b7c8e', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700 }}>База знаний</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: DARK, lineHeight: 1.3 }}>{sp.knowledge_base_title}</div>
                  </div>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 20, height: 20, borderRadius: '50%', background: PEACH,
                    color: DARK, fontWeight: 800, fontSize: 13, lineHeight: 1, flexShrink: 0,
                  }}>→</span>
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
