import { useEffect, useState } from 'react'
import { getClientProfile, getClientOfferings } from '../api'

interface Props { clientId: number }

interface Achievement { label: string; value: string }
interface Profile {
  id: number; name: string; bio?: string;
  profile_photo_url?: string; positioning?: string;
  achievements?: Achievement[];
  social_links?: { instagram?: string; telegram?: string; youtube?: string; vk?: string; website?: string };
}
interface Offering {
  id: number; title: string; description?: string;
  action_url?: string; is_paid: boolean; cover_url?: string;
}

const SOCIAL_ICONS: Record<string, string> = {
  instagram: '📷',
  telegram:  '✈️',
  youtube:   '▶️',
  vk:        '🔵',
  website:   '🌐',
}

function OfferingCard({ o }: { o: Offering }) {
  return (
    <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12, flexShrink: 0,
        background: 'linear-gradient(45deg, #25455D, #0a1520)',
        border: '1px solid var(--border)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', fontSize: 22
      }}>
        {o.is_paid ? '💼' : '📄'}
      </div>
      <div style={{ flex: 1 }}>
        <p style={{ color: 'white', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{o.title}</p>
        {o.description && (
          <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.4, marginBottom: 10 }}>{o.description}</p>
        )}
        {o.action_url && (
          <a href={o.action_url} target="_blank" rel="noreferrer"
             className="btn btn-sm btn-outline"
             style={{ display: 'inline-block', width: 'auto', textDecoration: 'none' }}>
            Узнать подробнее →
          </a>
        )}
      </div>
    </div>
  )
}

export default function EcosystemTab({ clientId }: Props) {
  const [profile,  setProfile]  = useState<Profile  | null>(null)
  const [paid,     setPaid]     = useState<Offering[]>([])
  const [free,     setFree]     = useState<Offering[]>([])
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    Promise.all([
      getClientProfile(clientId).catch(() => null),
      getClientOfferings(clientId).catch(() => ({ paid: [], free: [] })),
    ])
      .then(([p, o]) => { setProfile(p); setPaid(o?.paid || []); setFree(o?.free || []) })
      .finally(() => setLoading(false))
  }, [clientId])

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)' }}>Загружаем...</div>

  const social = profile?.social_links || {}
  const ach    = profile?.achievements || []

  return (
    <div className="fade-in" style={{ padding: '20px 16px 20px' }}>
      {/* Visit card */}
      <div style={{ textAlign: 'center', marginBottom: 18 }}>
        <div className="avatar-lg">
          {profile?.profile_photo_url
            ? <img src={profile.profile_photo_url} alt={profile.name} />
            : (profile?.name || '?')[0]
          }
        </div>
        <h2 style={{ color: 'white', fontSize: 20, fontWeight: 700, marginTop: 14 }}>{profile?.name || 'Организатор'}</h2>
        {profile?.positioning && (
          <p style={{ color: 'var(--peach)', fontSize: 13, marginTop: 6, lineHeight: 1.4, padding: '0 8px' }}>
            {profile.positioning}
          </p>
        )}
        {profile?.bio && (
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 12, lineHeight: 1.5, textAlign: 'left' }}>
            {profile.bio}
          </p>
        )}
      </div>

      {/* Achievements */}
      {ach.length > 0 && (
        <div className="ach-grid">
          {ach.slice(0, 3).map((a, i) => (
            <div key={i} className="ach">
              <div className="v">{a.value}</div>
              <div className="l">{a.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Social */}
      {Object.keys(social).filter(k => social[k as keyof typeof social]).length > 0 && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 24 }}>
          {Object.entries(social).map(([k, url]) => url ? (
            <a key={k} href={url} target="_blank" rel="noreferrer"
               style={{
                 width: 38, height: 38, borderRadius: 10, background: 'var(--card)',
                 border: '1px solid var(--border)', display: 'flex',
                 alignItems: 'center', justifyContent: 'center', fontSize: 18,
                 textDecoration: 'none'
               }}>
              {SOCIAL_ICONS[k] || '🔗'}
            </a>
          ) : null)}
        </div>
      )}

      {/* Paid offerings */}
      {paid.length > 0 && (
        <>
          <p className="sec-h" style={{ padding: '12px 0 8px' }}>💼 Платно</p>
          {paid.map(o => <OfferingCard key={o.id} o={o} />)}
        </>
      )}

      {/* Free offerings */}
      {free.length > 0 && (
        <>
          <p className="sec-h" style={{ padding: '20px 0 8px' }}>📄 Бесплатно</p>
          {free.map(o => <OfferingCard key={o.id} o={o} />)}
        </>
      )}

      {/* Empty state */}
      {paid.length === 0 && free.length === 0 && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 13 }}>
          Скоро здесь появятся продукты и материалы
        </div>
      )}
    </div>
  )
}
