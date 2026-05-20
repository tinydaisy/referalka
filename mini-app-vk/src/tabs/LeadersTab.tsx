import { useEffect, useState } from 'react'
import { getMiniAppMyLeaders } from '../api'

interface Leader {
  client_id: number
  client_name?: string
  client_brand_name?: string
  client_photo_url?: string
  client_positioning?: string
  events_total: number
  via_lead_magnet: boolean
}

interface Props {
  tgUser: any
  onOpenLeader: (clientId: number) => void
}

export default function LeadersTab({ tgUser, onOpenLeader }: Props) {
  const [leaders, setLeaders] = useState<Leader[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!tgUser?.id) { setLoading(false); return }
    getMiniAppMyLeaders(Number(tgUser.id))
      .then((data: { leaders: Leader[] }) => setLeaders(data.leaders || []))
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [tgUser?.id])

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)' }}>Загружаем лидеров…</div>
  }

  if (error || !leaders.length) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🧑‍💼</div>
        <p style={{ color: 'var(--text)', fontWeight: 700, fontSize: 16 }}>
          У вас пока нет лидеров
        </p>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
          Перейдите по ссылке от организатора или эксперта —<br />и он появится здесь
        </p>
      </div>
    )
  }

  return (
    <div className="fade-in" style={{ paddingBottom: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 16px 4px' }}>
        {leaders.map(l => <LeaderCard key={l.client_id} l={l} onOpen={onOpenLeader} />)}
      </div>
    </div>
  )
}

function LeaderCard({ l, onOpen }: { l: Leader; onOpen: (id: number) => void }) {
  const brand = l.client_brand_name || l.client_name || 'Лидер'
  const [imgFailed, setImgFailed] = useState(false)
  return (
    <div
      onClick={() => onOpen(l.client_id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 14,
        background: 'var(--card-bg, #fff)',
        border: '1px solid var(--border, #eee)',
        borderRadius: 14,
        cursor: 'pointer',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}
    >
      {l.client_photo_url && !imgFailed ? (
        <img
          src={l.client_photo_url}
          alt={brand}
          onError={() => setImgFailed(true)}
          style={{ width: 52, height: 52, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
        />
      ) : (
        <div
          style={{
            width: 52, height: 52, borderRadius: '50%',
            background: 'linear-gradient(45deg, #25455D, #0a1520)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#FFCFA4', fontWeight: 700, fontSize: 20, flexShrink: 0,
          }}
        >
          {brand[0]?.toUpperCase()}
        </div>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {brand}
        </div>
        {l.client_positioning && (
          <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {l.client_positioning}
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
          {l.events_total > 0
            ? `${l.events_total} ${plural(l.events_total, 'событие', 'события', 'событий')}`
            : (l.via_lead_magnet ? 'Лид-магниты' : 'Нет публичных событий')}
        </div>
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 18, flexShrink: 0 }}>›</div>
    </div>
  )
}

function plural(n: number, one: string, few: string, many: string): string {
  const m = n % 10
  const t = n % 100
  if (m === 1 && t !== 11) return one
  if (m >= 2 && m <= 4 && (t < 12 || t > 14)) return few
  return many
}
