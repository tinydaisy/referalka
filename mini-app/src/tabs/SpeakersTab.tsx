import EventDescription from '../components/EventDescription'
import { useState, useEffect, useRef } from 'react'
import { getSpeakers, getProgramPublic } from '../api'

// «ДД.ММ.ГГГГ HH:MM–HH:MM МСК» из даты дня и времён сессии.
function fmtSlot(dayDate?: string | null, t1?: string | null, t2?: string | null): string {
  let d = ''
  if (dayDate) {
    const s = String(dayDate).slice(0, 10).split('-')
    if (s.length === 3) d = `${s[2]}.${s[1]}.${s[0]}`
  }
  const a = t1 ? String(t1).slice(0, 5) : ''
  const b = t2 ? String(t2).slice(0, 5) : ''
  const time = a && b ? `${a}–${b} МСК` : a ? `${a} МСК` : ''
  return [d, time].filter(Boolean).join(' ')
}

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
  website_url?: string | null
  speaker_topic?: string | null
  gift_after_speech_title?: string | null
  gift_lm_name?: string | null
  gift_lp_name?: string | null
  gift_raffle_title?: string | null
  knowledge_base_title?: string | null
  knowledge_base_url?: string | null
  topics?: { topic: string }[]
}

const PEACH = 'var(--peach)'
const DARK  = 'var(--dark)'

// ⚠️ ПЕРВЫЙ оттенок — из темы клиента (`--card-tint`): именно он
// задаёт «фирменность» ряда карточек. Остальные пять дают чередование,
// чтобы соседние карточки не сливались, и остаются нейтральными.
const PASTELS = ['var(--card-tint)', '#f0f5fb', '#fbf2f0', '#f3f5f0', '#fdf6e8', '#f5f0fb']

const ROLE_LABELS: Record<string, string> = {
  speaker:    'Спикер',
  headliner:  'Хедлайнер',
  partner:    'Партнёр',
  organizer:  'Организатор',
  jury:       'Жюри',
}

const ROLE_COLORS: Record<string, { bg: string; fg: string }> = {
  speaker:    { bg: 'var(--peach)', fg: 'var(--dark)' },
  headliner:  { bg: 'var(--dark)', fg: 'var(--peach)' },
  partner:    { bg: '#e8e9eb', fg: '#5a6a7a' },
  organizer:  { bg: '#d6e4f0', fg: 'var(--dark)' },
  jury:       { bg: '#f0d8ff', fg: '#5b2a8c' },
}

function tgLink(url?: string | null): string | null {
  if (!url) return null
  if (/^https?:\/\//i.test(url)) return url
  if (url.startsWith('@')) return `https://telegram.me/${url.slice(1)}`
  return `https://telegram.me/${url}`
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

// Сегменты для группировки на странице (вместо плоского списка):
// «Жюри» отдельно от «Спикеров» в премиях/турнирах. Свёрнуть/развернуть
// каждую группу отдельно (изначально развёрнуты).
const SEGMENTS: Array<{ key: string; title: string; roles: string[] }> = [
  { key: 'organizer', title: 'Организаторы', roles: ['organizer'] },
  { key: 'jury',      title: 'Жюри',         roles: ['jury'] },
  { key: 'speaker',   title: 'Спикеры',      roles: ['headliner', 'speaker'] },
  { key: 'partner',   title: 'Партнёры',     roles: ['general_partner', 'partner'] },
]

function segmentFor(role: string | null | undefined): string {
  for (const s of SEGMENTS) if (role && s.roles.includes(role)) return s.key
  return 'speaker'
}

export default function SpeakersTab({ event, tgUser, highlightSpeakerEventId, onHighlightConsumed }: Props) {
  const [speakers, setSpeakers] = useState<Speaker[]>([])
  const [loading, setLoading] = useState(true)
  const [highlightId, setHighlightId] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // Развёрнутые регалии по спикеру: в карточке видно первые три, остальное
  // прячется под «Подробнее» (у части людей их несколько десятков).
  const [openAch, setOpenAch] = useState<Record<number, boolean>>({})
  // Слот спикера в программе: ec_id (event_collaborators.id) → «дата время».
  const [slotByEc, setSlotByEc] = useState<Record<number, string>>({})
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({})

  // Программа → мапа слотов. Берём ПЕРВЫЙ слот спикера (sessions отсортированы).
  useEffect(() => {
    if (!event?.id) return
    let cancelled = false
    getProgramPublic(event.id).then((r: any) => {
      if (cancelled) return
      const dayDate: Record<number, string> = {}
      for (const d of (r?.days || [])) if (d.day_number != null) dayDate[d.day_number] = d.day_date
      const map: Record<number, string> = {}
      for (const s of (r?.sessions || [])) {
        const ec = s.speaker_event_id
        if (!ec || map[ec]) continue
        const slot = fmtSlot(dayDate[s.day], s.start_time, s.end_time)
        if (slot) map[ec] = slot
      }
      setSlotByEc(map)
    }).catch(() => { if (!cancelled) setSlotByEc({}) })
    return () => { cancelled = true }
  }, [event?.id])

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
          website_url: c.website_url,
          speaker_topic: c.speaker_topic,
          gift_after_speech_title: c.gift_after_speech_title,
          gift_lm_name: c.gift_lm_name,
          gift_lp_name: c.gift_lp_name,
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
    return <div style={{ padding: 20, color: 'var(--muted)' }}>Загружаем…</div>
  }
  if (speakers.length === 0) {
    return <div style={{ padding: 20, color: 'var(--muted)', textAlign: 'center' }}>Список спикеров пока пуст.</div>
  }

  // Группируем спикеров по сегментам (Жюри / Спикеры / Организаторы / Партнёры).
  // Каждая группа выводится отдельным блоком с шевроном-сворачиванием.
  // Скрываем пустые сегменты. Спикеры внутри сегмента — в порядке как пришли с бэка.
  const grouped: Record<string, Speaker[]> = {}
  speakers.forEach(sp => {
    const seg = segmentFor(sp.role)
    if (!grouped[seg]) grouped[seg] = []
    grouped[seg].push(sp)
  })

  function renderSpeakerCard(sp: Speaker, idx: number) {
    return null // обратно в map ниже
  }

  return (
    <div style={{ padding: '16px 12px 80px' }}>
      {/* ⚠️ Заголовка «Спикеры и жюри» нет: вкладка уже так называется, а в
          коллабе жюри не бывает вовсе — там только организаторы. Группы
          внутри (Организаторы / Спикеры / Жюри) подписаны сами. */}
      {SEGMENTS.filter(s => (grouped[s.key]?.length || 0) > 0).map((segment, segIdx) => {
        const list = grouped[segment.key] || []
        const isCollapsed = !!collapsed[segment.key]
        return (
          <div key={segment.key} style={{ marginBottom: 18 }}>
            <button
              type="button"
              onClick={() => setCollapsed(c => ({ ...c, [segment.key]: !c[segment.key] }))}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 12px', borderRadius: 12, border: '1px solid #d9e2ea',
                background: 'var(--gradient)', color: '#fff',
                fontSize: 14, fontWeight: 700, cursor: 'pointer', marginBottom: 10,
              }}
            >
              <span>{segment.title} · {list.length}</span>
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 24, borderRadius: '50%', background: PEACH, color: DARK,
                transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s', fontWeight: 800, fontSize: 14,
              }}>▾</span>
            </button>
            {!isCollapsed && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {list.map((sp, idx) => {
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

          const site = (sp.website_url || '').trim()
            ? ((sp.website_url || '').trim().startsWith('http') ? (sp.website_url || '').trim() : `https://${(sp.website_url || '').trim()}`)
            : null

          const socials: Array<{ label: string; url: string; primary: boolean; kind: 'tg_channel' | 'vk' | 'max' | 'instagram' | 'website' }> = []
          if (tg) socials.push({ label: 'Тг-канал', url: tg, primary: true, kind: 'tg_channel' })
          if (sp.vk_url) socials.push({ label: 'ВКонтакте', url: sp.vk_url, primary: false, kind: 'vk' })
          if (sp.max_url) socials.push({ label: 'MAX', url: sp.max_url, primary: false, kind: 'max' })
          if (insta) socials.push({ label: 'Нельзяграм', url: insta, primary: false, kind: 'instagram' })
          if (site) socials.push({ label: 'Сайт', url: site, primary: false, kind: 'website' })

          return (
            <div
              key={sp.id}
              ref={el => { cardRefs.current[sp.id] = el }}
              style={{
                background: PASTELS[idx % PASTELS.length],
                borderRadius: 14, padding: 14,
                boxShadow: highlightId === sp.id
                  ? '0 4px 16px rgba(var(--peach-rgb), 0.5)'
                  : '0 2px 8px rgba(37,69,93,0.05)',
                border: highlightId === sp.id ? `2px solid ${PEACH}` : '2px solid transparent',
                transition: 'border-color 0.3s, box-shadow 0.3s',
              }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
                <div style={{
                  width: 56, height: 56, borderRadius: '50%', flexShrink: 0,
                  background: sp.photo_url ? `center/cover url(${sp.photo_url})` : 'var(--gradient)',
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
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', lineHeight: 1.2 }}>{sp.name}</div>
                  {sp.title && (
                    <EventDescription text={sp.title} style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.3 }} />
                  )}
                </div>
              </div>

              {/* Регалии — СВЕРХУ (как в веб-версии карточки спикера).
                  ⚠️ Показываем ПЕРВЫЕ ТРИ, остальное — под «Подробнее».
                  У части людей в карточке лежит развёрнутый рассказ о себе на
                  несколько десятков строк (переехал из профиля основателя): без
                  сворачивания одна карточка занимала весь экран, и соседние
                  спикеры становились ненаходимы. */}
              {ach.length > 0 && (() => {
                const opened = !!openAch[sp.id]
                const shown = opened ? ach : ach.slice(0, 3)
                return (
                  <div style={{ marginBottom: 8 }}>
                    <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                      {shown.map((a, i) => (
                        <li key={i} style={{ fontSize: 12, color: '#3a4a5a', lineHeight: 1.4, paddingLeft: 14, position: 'relative', marginBottom: 3 }}>
                          <span style={{ position: 'absolute', left: 0, top: -1, color: DARK, fontWeight: 700, fontSize: 14 }}>•</span>
                          {/* ⚠️ Через EventDescription: регалии клиент пишет с разметкой
                              (<b>), и голым текстом теги уезжали читателю видимыми. */}
                          <EventDescription text={a} />
                        </li>
                      ))}
                    </ul>
                    {ach.length > 3 && (
                      <button
                        onClick={() => setOpenAch(s => ({ ...s, [sp.id]: !opened }))}
                        style={{
                          background: 'none', border: 'none', padding: '4px 0 0 14px',
                          color: DARK, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', gap: 4,
                        }}>
                        {opened ? 'Свернуть' : 'Подробнее'}
                        <span style={{ fontSize: 10, transform: opened ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>▼</span>
                      </button>
                    )}
                  </div>
                )
              })()}

              {/* Тема + слот + подарок — ПОД регалиями (как в веб-версии) */}
              {(topicsList.length > 0 || slotByEc[sp.id] || sp.gift_after_speech_title || sp.gift_lm_name || sp.gift_lp_name) && (
                <div style={{ marginBottom: 8, borderTop: ach.length > 0 ? '1px solid #eef1f4' : 'none', paddingTop: ach.length > 0 ? 8 : 0 }}>
                  {(topicsList.length > 0 || slotByEc[sp.id]) && (
                    <>
                      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700, marginBottom: 4 }}>
                        {topicsList.length > 1 ? 'Темы' : 'Тема'}
                      </div>
                      {slotByEc[sp.id] && (
                        <div style={{ fontSize: 12, color: DARK, fontWeight: 800, marginBottom: 3 }}>
                          {slotByEc[sp.id]}
                        </div>
                      )}
                      {topicsList.map((t, ti) => (
                        <div key={ti} style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600, lineHeight: 1.35, marginBottom: ti < topicsList.length - 1 ? 6 : 0 }}>
                          {t}
                        </div>
                      ))}
                    </>
                  )}
                  {/* Подарок на эфире: ручной ИЛИ из ПЛЮСОНа (лид-магнит/пакет) */}
                  {(sp.gift_after_speech_title || sp.gift_lm_name || sp.gift_lp_name) && (
                    <div style={{ marginTop: (topicsList.length > 0 || slotByEc[sp.id]) ? 8 : 0, background: '#fff7ef', border: '1px solid #ffe0c2', borderRadius: 8, padding: '6px 10px' }}>
                      <div style={{ fontSize: 10, color: '#b26a1f', fontWeight: 700, marginBottom: 2 }}>🎁 Подарок на эфире</div>
                      <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600, lineHeight: 1.3 }}>
                        {sp.gift_after_speech_title || sp.gift_lm_name || sp.gift_lp_name}
                      </div>
                    </div>
                  )}
                </div>
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
                    <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700 }}>База знаний</div>
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
            )}
          </div>
        )
      })}
    </div>
  )
}
