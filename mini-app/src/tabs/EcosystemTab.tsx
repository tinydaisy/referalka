import { useEffect, useState } from 'react'
import { getClientProfile, getClientOfferings } from '../api'
import OwnerPage from '../pages/OwnerPage'

interface Props { clientId: number }

interface Achievement { label: string; value: string }
interface Profile {
  id: number
  name: string
  // Бренд
  brand_name?: string | null
  brand_logo_url?: string | null
  profile_photo_url?: string | null   // фото бренда
  positioning?: string | null         // позиционирование бренда
  achievements?: Achievement[]
  // Основатель
  owner_name?: string | null
  owner_photo_url?: string | null
  owner_positioning?: string | null
  owner_achievements?: Achievement[]
  bio?: string | null
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
  const [showOwner, setShowOwner] = useState(false)

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

  // Отдельная страница «Об основателе»
  if (showOwner) {
    return <OwnerPage profile={profile} onBack={() => setShowOwner(false)} />
  }

  const brand = profile.brand_name || profile.name
  const brandRole = profile.positioning || ''
  const brandAch = (profile.achievements || []).slice(0, 4)
  const items = tab === 'free' ? free : paid

  // Карточка-тизер основателя — показываем только если хоть что-то заполнено
  const ownerName = profile.owner_name || ''
  const hasOwner = !!(ownerName || profile.owner_photo_url || profile.owner_positioning || profile.bio)

  return (
    <div className="fade-in">
      {/* Шапка-бренд */}
      <div style={{
        padding: '20px 18px 16px',
        background: 'linear-gradient(45deg, #25455D, #0a1520)',
        color: 'white', position: 'relative', overflow: 'hidden',
        margin: '-16px -16px 12px', borderRadius: 0,
      }}>
        <div style={{
          position: 'absolute', top: -40, right: -40, width: 160, height: 160,
          background: 'radial-gradient(circle, rgba(255,207,164,0.18) 0%, transparent 70%)',
        }} />
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', position: 'relative' }}>
          {profile.brand_logo_url ? (
            <img src={profile.brand_logo_url} alt=""
                 style={{
                   width: 72, height: 72, borderRadius: 14,
                   objectFit: 'contain', background: 'transparent',
                   flexShrink: 0,
                 }} />
          ) : (
            <div style={{
              width: 72, height: 72, borderRadius: 14,
              background: 'linear-gradient(135deg, #d4789a, #8b4561)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'white', fontWeight: 700, fontSize: 24,
              border: `2px solid ${PEACH}`, flexShrink: 0,
            }}>{initials(brand)}</div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 0.5, lineHeight: 1.15 }}>{brand}</div>
            {brandRole && (
              <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.75)', marginTop: 5, lineHeight: 1.35 }}>
                {brandRole}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Регалии бренда — скрываем если пусто */}
      {brandAch.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {brandAch.map((a, i) => (
              <div key={i} style={{
                background: 'white',
                padding: '10px 12px', borderRadius: 12,
                boxShadow: '0 1px 4px rgba(37,69,93,0.06)',
                border: '1px solid #f0f0f0',
              }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: DARK, lineHeight: 1.1 }}>{a.value}</div>
                <div style={{ fontSize: 11, color: '#6b7c8e', marginTop: 3, lineHeight: 1.25 }}>{a.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Карточка-тизер основателя */}
      {hasOwner && (
        <button onClick={() => setShowOwner(true)}
                style={{
                  width: '100%', textAlign: 'left', cursor: 'pointer',
                  background: '#FFF1E2', borderRadius: 14, padding: 12,
                  border: '1px solid #FFE0C2', boxShadow: '0 1px 4px rgba(37,69,93,0.06)',
                  marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12,
                }}>
          {profile.owner_photo_url ? (
            <img src={profile.owner_photo_url} alt=""
                 style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', flexShrink: 0,
                          border: `2px solid ${PEACH}` }} />
          ) : (
            <div style={{
              width: 48, height: 48, borderRadius: '50%', flexShrink: 0,
              background: 'linear-gradient(135deg, #d4789a, #8b4561)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'white', fontWeight: 700, fontSize: 16, border: `2px solid ${PEACH}`,
            }}>{initials(ownerName || profile.name)}</div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: DARK, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase' }}>
              Об основателе
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginTop: 2, lineHeight: 1.2 }}>
              {ownerName || profile.name}
            </div>
            {profile.owner_positioning && (
              <div style={{ fontSize: 12, color: '#6b7c8e', marginTop: 3, lineHeight: 1.3,
                            overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
                            WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                {profile.owner_positioning}
              </div>
            )}
          </div>
          <div style={{ fontSize: 24, color: DARK, fontWeight: 600, marginRight: 4 }}>›</div>
        </button>
      )}

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
