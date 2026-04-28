import { useEffect, useState } from 'react'
import { verifyCode, getRafflePrizes } from '../api'

interface Props { event: any; participant: any }

const PEACH = '#FFCFA4'
const DARK = '#25455D'

interface Prize {
  id: number
  title: string
  description?: string
  icon_emoji?: string
  places_count: number
  value_label?: string
}

interface Ticket {
  number: string
}

export default function RaffleTab({ event, participant }: Props) {
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ valid: boolean; message: string; tickets?: number } | null>(null)
  const [tickets, setTickets] = useState<Ticket[]>(participant?.tickets || [])
  const [prizes, setPrizes] = useState<Prize[]>([])
  const [prizesOpen, setPrizesOpen] = useState(true)

  // Подписки на спикеров — статус
  const subsAllOk = !!participant?.subscriptions_ok
  const starterTicket = participant?.starter_ticket_number

  useEffect(() => {
    if (event?.id) {
      getRafflePrizes(event.id)
        .then((r: any) => setPrizes(r.items || []))
        .catch(() => setPrizes([]))
    }
  }, [event?.id])

  async function checkCode() {
    if (!code.trim()) return
    setLoading(true); setResult(null)
    try {
      const res = await verifyCode(event?.id || 1, code.trim(), participant?.id || 1)
      setResult({ valid: res.valid, message: res.message, tickets: res.tickets_reward })
      if (res.valid && res.tickets_reward) {
        // Добавляем мокнутые номера, реальные подгрузим при следующем reload
        const newOnes: Ticket[] = Array.from({ length: res.tickets_reward }, (_, i) => ({
          number: `№${String(Math.floor(Math.random() * 99999)).padStart(5, '0')}`,
        }))
        setTickets(t => [...t, ...newOnes])
        setCode('')
      }
    } catch {
      setResult({ valid: false, message: 'Ошибка при проверке. Попробуйте ещё раз.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fade-in">
      {/* Билеты участника */}
      <div style={{
        background: 'white', borderRadius: 16, padding: 18, textAlign: 'center', marginBottom: 14,
        boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
      }}>
        <div style={{
          fontSize: 11, color: '#6b7c8e', fontWeight: 700, letterSpacing: 0.8,
          textTransform: 'uppercase', marginBottom: 8,
        }}>
          У вас {tickets.length} {tickets.length === 1 ? 'билет' : 'билетов'}
        </div>
        {tickets.length === 0 ? (
          <div style={{ fontSize: 13, color: '#6b7c8e', padding: 10 }}>
            Подпишитесь на каналы — получите первый билет
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
            {tickets.map((t, i) => (
              <div key={i} style={{
                background: 'linear-gradient(135deg, #FFCFA4, #f5b97e)', color: DARK,
                padding: '7px 10px', borderRadius: 8, fontWeight: 700, fontSize: 12,
              }}>{t.number}</div>
            ))}
          </div>
        )}
      </div>

      {/* Подписка → стартовый билет (свёрнуто если ОК) */}
      {subsAllOk ? (
        <div style={{
          background: '#e8f5e9', border: '1px solid #a5d6a7', borderRadius: 12,
          padding: '12px 14px', marginBottom: 12,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ fontSize: 18 }}>✅</div>
          <div style={{ flex: 1, fontSize: 12, color: '#1b5e20', fontWeight: 600 }}>
            Вы подписаны{starterTicket ? ` — стартовый билет ${starterTicket} ваш` : ''}
          </div>
        </div>
      ) : (
        <div style={{
          background: 'linear-gradient(135deg, #fff8f0, white)',
          border: `2px solid ${PEACH}`, borderRadius: 16,
          padding: 14, marginBottom: 12, textAlign: 'center',
        }}>
          <div style={{ fontSize: 26, marginBottom: 6 }}>🔒</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a', marginBottom: 4 }}>
            Подпишитесь на наши каналы
          </div>
          <div style={{ fontSize: 11, color: '#6b7c8e', lineHeight: 1.5 }}>
            После подписки автоматически получите стартовый билет
          </div>
        </div>
      )}

      {/* Кодовое слово */}
      <div style={{
        background: 'white', borderRadius: 14, padding: 14, marginBottom: 12,
        boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#1a2a3a', marginBottom: 4 }}>
          + билет за кодовое слово
        </div>
        <div style={{ fontSize: 12, color: '#6b7c8e', marginBottom: 10 }}>
          Спикер назовёт слово в эфире — введите ниже:
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text" placeholder="введите слово"
            value={code}
            onChange={e => { setCode(e.target.value); setResult(null) }}
            onKeyDown={e => e.key === 'Enter' && checkCode()}
            style={{
              flex: 1, padding: 12, border: '2px solid #e5eaef', borderRadius: 10,
              fontSize: 14, outline: 'none', color: DARK,
            }}
          />
          <button onClick={checkCode} disabled={loading || !code.trim()}
                  style={{
                    background: DARK, color: PEACH, padding: '12px 16px', border: 'none',
                    borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: 'pointer',
                    opacity: loading || !code.trim() ? 0.5 : 1,
                  }}>{loading ? '…' : 'OK'}</button>
        </div>
        {result && (
          <div style={{
            marginTop: 10, padding: '10px 12px', borderRadius: 10, fontSize: 12, fontWeight: 600,
            background: result.valid ? '#e8f5e9' : '#ffe5e5',
            color: result.valid ? '#1b5e20' : '#c62828',
          }}>
            {result.valid ? `🎉 ${result.message}` : `❌ ${result.message}`}
          </div>
        )}
      </div>

      {/* Призы — раскрывающийся блок */}
      {prizes.length > 0 && (
        <div style={{
          background: 'white', borderRadius: 14, padding: 14, marginBottom: 10,
          boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
        }}>
          <div onClick={() => setPrizesOpen(!prizesOpen)}
               style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a' }}>
              🎁 Призы розыгрыша · {prizes.length}
            </div>
            <div style={{ fontSize: 20, color: prizesOpen ? PEACH : '#c5cdd6',
                          transform: prizesOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>›</div>
          </div>
          {prizesOpen && (
            <div style={{ marginTop: 10 }}>
              {prizes.map((p, i) => (
                <div key={p.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 0', borderTop: i === 0 ? 'none' : '1px solid #f0f2f5',
                }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 8,
                    background: 'linear-gradient(135deg, #fff4e0, #FFCFA4)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0,
                  }}>{p.icon_emoji || '🎁'}</div>
                  <div style={{ flex: 1, fontSize: 12, fontWeight: 600, color: '#1a2a3a' }}>
                    {p.title}
                    {p.value_label && (
                      <div style={{ fontSize: 10, color: '#b86b00', fontWeight: 700, marginTop: 2 }}>
                        {p.value_label}
                      </div>
                    )}
                  </div>
                  <div style={{
                    fontSize: 10, fontWeight: 700, color: '#b86b00',
                    background: '#fff4e0', padding: '3px 7px', borderRadius: 5,
                  }}>{p.places_count} {p.places_count === 1 ? 'место' : 'места'}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
