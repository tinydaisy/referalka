import { useState } from 'react'
import { verifyCode } from '../api'

interface Props { event: any; participant: any }

export default function RaffleTab({ event, participant }: Props) {
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ valid: boolean; message: string; tickets?: number } | null>(null)
  const [totalTickets, setTotalTickets] = useState(participant?.points_total || 0)

  async function checkCode() {
    if (!code.trim()) return
    setLoading(true)
    setResult(null)
    try {
      const res = await verifyCode(event?.id || 1, code.trim(), participant?.id || 1)
      setResult({ valid: res.valid, message: res.message, tickets: res.tickets_reward })
      if (res.valid && res.tickets_reward) {
        setTotalTickets(t => t + res.tickets_reward)
      }
    } catch {
      setResult({ valid: false, message: 'Ошибка при проверке. Попробуйте ещё раз.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fade-in" style={{ padding: '16px' }}>
      {/* Tickets counter */}
      <div className="card" style={{ textAlign: 'center', padding: '28px 16px', marginBottom: 16 }}>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 6 }}>Ваших билетов</p>
        <div style={{ fontSize: 72, fontWeight: 700, color: 'var(--peach)', lineHeight: 1 }}>
          {totalTickets}
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
          Чем больше билетов — тем выше шанс выиграть в розыгрыше
        </p>
      </div>

      {/* Code input */}
      <div className="card" style={{ marginBottom: 16 }}>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 10 }}>
          Введите кодовое слово спикера
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input-dark"
            type="text"
            placeholder="Кодовое слово..."
            value={code}
            onChange={e => { setCode(e.target.value); setResult(null) }}
            onKeyDown={e => e.key === 'Enter' && checkCode()}
            style={{ flex: 1 }}
          />
          <button
            onClick={checkCode}
            disabled={loading || !code.trim()}
            className="btn btn-sm btn-primary"
            style={{
              width: 'auto', flexShrink: 0, padding: '0 20px',
              opacity: (!code.trim() || loading) ? 0.5 : 1
            }}
          >
            {loading ? '...' : 'OK'}
          </button>
        </div>

        {/* Result */}
        {result && (
          <div style={{
            marginTop: 12, padding: '12px', borderRadius: 10,
            ...(result.valid
              ? { background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)' }
              : { background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' })
          }}>
            <p style={{ color: result.valid ? '#22c55e' : '#ef4444', fontSize: 13, fontWeight: 600 }}>
              {result.valid ? `🎉 ${result.message}` : `❌ ${result.message}`}
            </p>
            {result.valid && result.tickets && (
              <p style={{ color: 'var(--peach)', fontSize: 12, marginTop: 4 }}>
                +{result.tickets} {result.tickets === 1 ? 'билет' : result.tickets < 5 ? 'билета' : 'билетов'} добавлено
              </p>
            )}
          </div>
        )}
      </div>

      {/* How to get tickets */}
      <div className="card">
        <p style={{ color: 'white', fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
          Как получить билеты?
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[
            { emoji: '👥', title: 'Приглашайте друзей', desc: '1 билет за каждого зарегистрированного' },
            { emoji: '🔑', title: 'Кодовые слова спикеров', desc: 'От 1 до 5 билетов за каждое слово' },
            { emoji: '⭐️', title: 'Бонусные задания', desc: 'Следите за объявлениями организатора' },
          ].map(({ emoji, title, desc }) => (
            <div key={title} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 22, flexShrink: 0 }}>{emoji}</span>
              <div>
                <p style={{ color: 'white', fontSize: 13, fontWeight: 500 }}>{title}</p>
                <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
