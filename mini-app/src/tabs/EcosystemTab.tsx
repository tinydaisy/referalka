import { useEffect, useState } from 'react'
import { getClientProfile, getClientOfferings } from '../api'

interface Props { clientId: number }

interface Achievement { label: string; value: string }
interface Profile {
  id: number
  name: string
  brand_name?: string | null
  bio?: string
  profile_photo_url?: string
  positioning?: string
  achievements?: Achievement[]
  social_links?: { instagram?: string; telegram?: string; youtube?: string; vk?: string; website?: string }
}
interface Offering {
  id: number
  title: string
  description?: string
  action_url?: string
  is_paid: boolean
  cover_url?: string
}

const PEACH = '#FFCFA4'
const DARK = '#25455D'

function initials(name: string): string {
  const parts = (name || '').trim().split(/\s+/)
  if (!parts[0]) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

function OfferingCard({ o }: { o: Offering }) {
  return (
    <div style={{
      background: 'white', borderRadius: 14, padding: 14, marginBottom: 10,
      boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
    }}>
      <div style={{ display: 'flex', gap: 12 }}>
        {o.cover_url ? (
          <img src={o.cover_url} alt=""
               style={{ width: 44, height: 44, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />
        ) : (
          <div style={{
            width: 44, height: 44, borderRadius: 10, flexShrink: 0,
            background: 'linear-gradient(135deg, #fff4e0, #FFCFA4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
          }}>{o.is_paid ? '💼' : '📄'}</div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1a2a3a', marginBottom: 3 }}>{o.title}</div>
          {o.description && (
            <div style={{ fontSize: 12, color: '#6b7c8e', lineHeight: 1.4, marginBottom: 6 }}>{o.description}</div>
          )}
          {!o.is_paid && (
            <div style={{ fontSize: 13, fontWeight: 700, color: '#2e7d32' }}>Бесплатно</div>
          )}
        </div>
      </div>
      {o.action_url && (
        <a href={o.action_url} target="_blank" rel="noreferrer"
           style={{
             display: 'block', marginTop: 10,
             background: o.is_paid
               ? 'linear-gradient(135deg, #FFCFA4, #f5b97e)'
               : 'linear-gradient(135deg, #25455D, #0a1520)',
             color: o.is_paid ? DARK : PEACH,
             padding: 10, borderRadius: 10, textAlign: 'center',
             fontWeight: 700, fontSize: 13, textDecoration: 'none',
             boxShadow: o.is_paid ? '0 2px 6px rgba(255,207,164,0.4)' : 'none',
           }}>
          Получить
        </a>
      )}
    </div>
  )
}

export default function EcosystemTab({ clientId }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [paid, setPaid] = useState<Offering[]>([])
  const [free, setFree] = useState<Offering[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'free' | 'paid'>('free')

  useEffect(() => {
    Promise.all([
      getClientProfile(clientId).catch(() => null),
      getClientOfferings(clientId).catch(() => ({ paid: [], free: [] })),
    ])
      .then(([p, o]: any) => {
        setProfile(p)
        setPaid(o?.paid || [])
        setFree(o?.free || [])
      })
      .finally(() => setLoading(false))
  }, [clientId])

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)' }}>Загружаем…</div>
  if (!profile) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)' }}>Нет данных</div>

  const brand = profile.brand_name || profile.name
  const role = profile.positioning || ''
  const ach = (profile.achievements || []).slice(0, 4)
  const items = tab === 'free' ? free : paid

  return (
    <div className="fade-in">
      {/* Шапка-бренд */}
      <div style={{
        padding: '18px 18px 16px',
        background: 'linear-gradient(45deg, #25455D, #0a1520)',
        color: 'white', position: 'relative', overflow: 'hidden',
        margin: '-16px -16px 12px', borderRadius: 0,
      }}>
        <div style={{
          position: 'absolute', top: -40, right: -40, width: 160, height: 160,
          background: 'radial-gradient(circle, rgba(255,207,164,0.18) 0%, transparent 70%)',
        }} />
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', position: 'relative', marginBottom: 12 }}>
          {profile.profile_photo_url ? (
            <img src={profile.profile_photo_url} alt=""
                 style={{
                   width: 64, height: 64, borderRadius: '50%',
                   objectFit: 'cover', border: `2.5px solid ${PEACH}`, flexShrink: 0,
                 }} />
          ) : (
            <div style={{
              width: 64, height: 64, borderRadius: '50%',
              background: 'linear-gradient(135deg, #d4789a, #8b4561)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'white', fontWeight: 700, fontSize: 22,
              border: `2.5px solid ${PEACH}`, flexShrink: 0,
            }}>{initials(profile.name)}</div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, lineHeight: 1.3, marginBottom: 4 }}>
              <span style={{ color: PEACH, fontWeight: 700, letterSpacing: 1.5, fontSize: 10 }}>ЭКОСИСТЕМА</span>
              <span style={{ fontSize: 16, fontWeight: 900, letterSpacing: 1, marginLeft: 6 }}>{brand}</span>
            </div>
            <div style={{ fontSize: 12 }}>
              {role ? (
                <>
                  <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11 }}>{role}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 6 }}>{profile.name}</span>
                </>
              ) : (
                <span style={{ fontSize: 13, fontWeight: 700 }}>{profile.name}</span>
              )}
            </div>
          </div>
        </div>
        {ach.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, position: 'relative' }}>
            {ach.map((a, i) => (
              <div key={i} style={{
                flex: '1 0 calc(50% - 3px)',
                background: 'rgba(255,255,255,0.08)',
                padding: '7px 9px', borderRadius: 9,
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: PEACH }}>{a.value}</div>
                <div style={{ fontSize: 9.5, opacity: 0.75, marginTop: 2, lineHeight: 1.2 }}>{a.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Переключатель Бесплатно/Платно */}
      <div style={{
        display: 'flex', padding: 4, margin: '0 0 12px',
        background: 'linear-gradient(135deg, #25455D, #0a1520)',
        borderRadius: 14, gap: 4, boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.15)',
      }}>
        {(['free', 'paid'] as const).map(t => (
          <div key={t}
               onClick={() => setTab(t)}
               style={{
                 flex: 1, padding: '10px 4px', textAlign: 'center',
                 fontSize: 13, fontWeight: 700,
                 color: tab === t ? DARK : 'rgba(255,255,255,0.55)',
                 background: tab === t ? 'linear-gradient(135deg, #FFCFA4, #f5b97e)' : 'transparent',
                 borderRadius: 11, cursor: 'pointer',
                 boxShadow: tab === t ? '0 2px 8px rgba(255,207,164,0.4)' : 'none',
               }}>
            {t === 'free' ? 'Бесплатно' : 'Платно'}
          </div>
        ))}
      </div>

      {/* Список продуктов */}
      {items.length === 0 ? (
        <div style={{ color: 'var(--muted)', textAlign: 'center', padding: 30, fontSize: 13 }}>
          {tab === 'free' ? 'Бесплатных продуктов пока нет' : 'Платных продуктов пока нет'}
        </div>
      ) : items.map(o => <OfferingCard key={o.id} o={o} />)}
    </div>
  )
}
