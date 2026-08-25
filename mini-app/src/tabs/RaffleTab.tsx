import { useEffect, useState } from 'react'
import {
  checkConferenceSubscription,
  issueFreeTicket,
  submitRaffleKeyword,
  getMyRaffle,
  getRaffleSettings,
} from '../api'

interface Props { event: any; participant: any; tgUser: any }

const PEACH = 'var(--peach)'
const DARK = 'var(--dark)'

interface Ticket {
  id: number
  code_word: string
  created_at: string
}
interface WonPrize {
  prize_title: string
  prize_url: string | null
  speaker_name: string
  speaker_tg_username: string | null
  won_at: string
  ticket_id: number
}

function ticketNo(id: number): string {
  return '№' + String(id).padStart(5, '0')
}

export default function RaffleTab({ event, participant, tgUser }: Props) {
  const slug: string = event?.slug || ''
  const tgId: number | null = tgUser?.id ? Number(tgUser.id) : null

  const [introText, setIntroText] = useState<string | null>(null)
  const [grantsFree, setGrantsFree] = useState<boolean>(true)
  const [subsOk, setSubsOk] = useState<boolean | null>(null)
  const [subsText, setSubsText] = useState<string | null>(null)
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [wonPrizes, setWonPrizes] = useState<WonPrize[]>([])
  const [loading, setLoading] = useState(true)
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const hasFree = tickets.some(t => t.code_word === 'Free')

  useEffect(() => { reload() }, [slug, tgId])

  async function reload() {
    setLoading(true)
    try {
      const [s, my] = await Promise.all([
        getRaffleSettings(event?.id || 0).catch(() => ({})),
        tgId ? getMyRaffle(slug, tgId).catch(() => ({ tickets: [], won_prizes: [] })) : Promise.resolve({ tickets: [], won_prizes: [] }),
      ])
      setIntroText(s?.intro_text || null)
      setGrantsFree(s?.subscription_grants_starter_ticket !== false)
      setTickets(my?.tickets || [])
      setWonPrizes(my?.won_prizes || [])

      // Подписка проверяется только в этой вкладке (не при регистрации события).
      if (event?.id && tgId) {
        const sub = await checkConferenceSubscription(event.id, tgId).catch(() => null)
        if (sub) {
          setSubsOk(!sub.not_subscribed)
          setSubsText(sub.not_subscribed_text || null)
        } else {
          setSubsOk(true)
        }
      } else {
        setSubsOk(true)
      }
    } finally {
      setLoading(false)
    }
  }

  async function getFree() {
    if (!tgUser?.id) return
    setIssuing(true); setMsg(null)
    try {
      await issueFreeTicket(slug, {
        tg_id:      Number(tgUser.id),
        first_name: tgUser.first_name || '',
        last_name:  tgUser.last_name  || '',
        username:   tgUser.username   || '',
      })
      await reload()
    } catch (e: any) {
      setMsg({ kind: 'err', text: e.message || 'Не удалось выдать билет' })
    } finally {
      setIssuing(false)
    }
  }

  async function submitWord() {
    const w = code.trim()
    if (!w || !tgUser?.id) return
    setSubmitting(true); setMsg(null)
    try {
      const r = await submitRaffleKeyword(slug, {
        tg_id:      Number(tgUser.id),
        first_name: tgUser.first_name || '',
        last_name:  tgUser.last_name  || '',
        username:   tgUser.username   || '',
      }, w)
      setCode('')
      setMsg({ kind: 'ok', text: `Билет ${ticketNo(r.ticket_id)} ваш!` })
      await reload()
    } catch (e: any) {
      setMsg({ kind: 'err', text: e.message || 'Не удалось проверить слово' })
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>Загружаем…</div>
  }

  if (subsOk === false) {
    return (
      <div className="fade-in" style={{ padding: '12px 0' }}>
        <div style={{
          background: 'white', borderRadius: 16, padding: 18, marginBottom: 14,
          boxShadow: '0 2px 8px rgba(37,69,93,0.05)', textAlign: 'center',
        }}>
          <div style={{
            fontSize: 11, color: 'var(--muted)', fontWeight: 700, letterSpacing: 0.8,
            textTransform: 'uppercase', marginBottom: 8,
          }}>
            Розыгрыш закрыт
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: DARK, lineHeight: 1.35, marginBottom: 6 }}>
            Чтобы участвовать, подпишитесь на каналы организатора и спикеров
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.45 }}>
            После подписки получите стартовый билет и сможете вводить кодовые слова.
          </div>
        </div>
        {subsText && (
          <div
            style={{
              background: 'white', borderRadius: 12, padding: 12, fontSize: 13,
              color: DARK, lineHeight: 1.5, whiteSpace: 'pre-line',
              boxShadow: '0 2px 8px rgba(37,69,93,0.05)', marginBottom: 14,
            }}
            dangerouslySetInnerHTML={{ __html: subsText }}
          />
        )}
        <button
          onClick={reload}
          style={{
            width: '100%', padding: '14px 18px', borderRadius: 14,
            background: PEACH, color: DARK, fontSize: 15, fontWeight: 700,
            border: 'none', cursor: 'pointer',
          }}
        >
          Я подписался — проверить
        </button>
      </div>
    )
  }

  return (
    <div className="fade-in" style={{ padding: '12px 0' }}>
      {introText && (
        <div style={{
          background: 'white', borderRadius: 12, padding: 12, fontSize: 13,
          color: DARK, lineHeight: 1.5, marginBottom: 14,
          boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
        }}>
          {introText}
        </div>
      )}

      <div style={{
        background: 'white', borderRadius: 16, padding: 18, textAlign: 'center', marginBottom: 14,
        boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
      }}>
        <div style={{
          fontSize: 11, color: 'var(--muted)', fontWeight: 700, letterSpacing: 0.8,
          textTransform: 'uppercase', marginBottom: 10,
        }}>
          У вас {tickets.length} {tickets.length === 1 ? 'билет' : 'билетов'}
        </div>
        {tickets.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)', padding: 6, lineHeight: 1.5 }}>
            {grantsFree
              ? 'Получите стартовый билет — нажмите кнопку ниже, и вводите кодовые слова, которые называют спикеры.'
              : 'Вводите кодовые слова, которые называют спикеры — за каждое получите билет.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
            {tickets.map(t => (
              <span key={t.id} style={{
                background: 'var(--gradient-peach)', color: DARK,
                padding: '7px 10px', borderRadius: 8, fontWeight: 700, fontSize: 12,
              }}>
                {ticketNo(t.id)}
              </span>
            ))}
          </div>
        )}
      </div>

      {grantsFree && !hasFree && (
        <button
          onClick={getFree}
          disabled={issuing}
          style={{
            width: '100%', padding: '14px 18px', borderRadius: 14, marginBottom: 14,
            background: PEACH, color: DARK, fontSize: 15, fontWeight: 700,
            border: 'none', cursor: 'pointer', opacity: issuing ? 0.6 : 1,
          }}
        >
          {issuing ? 'Выдаём…' : '🎟 Получить бесплатный билет'}
        </button>
      )}

      {grantsFree && hasFree && (
        <div style={{
          background: '#e8f5e9', border: '1px solid #a5d6a7', borderRadius: 12,
          padding: '10px 14px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ fontSize: 18 }}>✓</div>
          <div style={{ flex: 1, fontSize: 12, color: '#1b5e20', fontWeight: 600 }}>
            Стартовый билет получен
          </div>
        </div>
      )}

      <div style={{
        background: 'white', borderRadius: 16, padding: 14, marginBottom: 14,
        boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: DARK, marginBottom: 4 }}>+1 билет за кодовое слово</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          Спикер назовёт слово в эфире — введите его здесь.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            placeholder="введите слово"
            value={code}
            onChange={e => setCode(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submitWord()}
            disabled={submitting}
            style={{
              flex: 1, padding: '11px 12px', borderRadius: 10, border: '1px solid #e0e4e8',
              fontSize: 14, fontFamily: 'inherit', outline: 'none',
            }}
          />
          <button
            onClick={submitWord}
            disabled={submitting || !code.trim()}
            style={{
              padding: '11px 18px', borderRadius: 10, border: 'none',
              background: DARK, color: PEACH, fontSize: 14, fontWeight: 700,
              cursor: 'pointer', opacity: submitting || !code.trim() ? 0.5 : 1,
            }}
          >
            OK
          </button>
        </div>

        {msg && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12,
            background: msg.kind === 'ok' ? '#e8f5e9' : '#ffebee',
            color: msg.kind === 'ok' ? '#1b5e20' : '#c62828',
          }}>
            {msg.text}
          </div>
        )}

        {tickets.filter(t => t.code_word !== 'Free').length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tickets.filter(t => t.code_word !== 'Free').map(t => (
              <span key={t.id} style={{
                background: '#f1f3f6', color: 'var(--muted)', padding: '4px 10px',
                borderRadius: 8, fontSize: 11, fontWeight: 600,
              }}>
                ✓ {t.code_word}
              </span>
            ))}
          </div>
        )}
      </div>

      {wonPrizes.length > 0 && (
        <div style={{
          background: 'var(--gradient)', color: 'white',
          borderRadius: 16, padding: 16, marginBottom: 14,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
            color: PEACH, marginBottom: 10,
          }}>
            🏆 Вы выиграли
          </div>
          {wonPrizes.map((p, i) => (
            <div key={i} style={{
              padding: '10px 0', borderTop: i ? '1px solid rgba(255,255,255,0.1)' : 'none',
            }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{p.prize_title}</div>
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>от {p.speaker_name}</div>
              {p.prize_url ? (
                <a href={p.prize_url} target="_blank" rel="noopener noreferrer" style={{
                  display: 'inline-block', background: PEACH, color: DARK,
                  padding: '8px 14px', borderRadius: 10, fontSize: 13, fontWeight: 700,
                  textDecoration: 'none',
                }}>
                  Забрать подарок →
                </a>
              ) : p.speaker_tg_username ? (
                <a href={`https://telegram.me/${p.speaker_tg_username.replace(/^@/, '')}`}
                   target="_blank" rel="noopener noreferrer" style={{
                  display: 'inline-block', background: PEACH, color: DARK,
                  padding: '8px 14px', borderRadius: 10, fontSize: 13, fontWeight: 700,
                  textDecoration: 'none',
                }}>
                  Написать @{p.speaker_tg_username.replace(/^@/, '')} →
                </a>
              ) : (
                <div style={{ fontSize: 12, opacity: 0.7 }}>Свяжитесь с организатором события</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
