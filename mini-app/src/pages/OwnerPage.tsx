/**
 * Страница «Об основателе» — открывается из карточки-тизера в EcosystemTab.
 * Большое фото, имя, позиционирование, факты в цифрах, биография, соцсети.
 */
interface Achievement { label: string; value: string }
interface Profile {
  id: number
  name: string
  owner_name?: string | null
  owner_photo_url?: string | null
  owner_positioning?: string | null
  owner_achievements?: Achievement[]
  bio?: string | null
  social_links?: { instagram?: string; telegram?: string; youtube?: string; vk?: string; website?: string }
}

interface Props {
  profile: Profile
  onBack: () => void
}

const PEACH = '#FFCFA4'
const DARK = '#25455D'

const SOCIAL_META: { key: keyof NonNullable<Profile['social_links']>; label: string; icon: string }[] = [
  { key: 'telegram',  label: 'Telegram',  icon: '✈️' },
  { key: 'instagram', label: 'Instagram', icon: '📸' },
  { key: 'youtube',   label: 'YouTube',   icon: '▶️' },
  { key: 'vk',        label: 'VK',        icon: '🅥'  },
  { key: 'website',   label: 'Сайт',      icon: '🌐' },
]

function initials(name: string): string {
  const parts = (name || '').trim().split(/\s+/)
  if (!parts[0]) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

export default function OwnerPage({ profile, onBack }: Props) {
  const name = profile.owner_name || profile.name
  const role = profile.owner_positioning || ''
  const ach = (profile.owner_achievements || []).filter(a => a.label?.trim() && a.value?.trim())
  const socials = SOCIAL_META.filter(s => profile.social_links?.[s.key])

  return (
    <div className="fade-in">
      {/* Шапка с «Назад» */}
      <div style={{
        padding: '14px 18px',
        background: 'linear-gradient(45deg, #25455D, #0a1520)',
        color: 'white', position: 'relative', overflow: 'hidden',
        margin: '-16px -16px 0', borderRadius: 0,
      }}>
        <button onClick={onBack}
                style={{
                  background: 'rgba(255, 207, 164, 0.15)', border: 'none', color: 'white',
                  width: 36, height: 36, borderRadius: 10, cursor: 'pointer', fontSize: 20,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
          ‹
        </button>
        <div style={{ marginTop: 14, fontSize: 10, color: PEACH, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase' }}>
          Об основателе
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginTop: 4, lineHeight: 1.2 }}>{name}</h1>
        {role && (
          <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.78)', marginTop: 6, lineHeight: 1.4 }}>
            {role}
          </p>
        )}
      </div>

      {/* Фото — большое */}
      <div style={{ margin: '14px 0 16px' }}>
        {profile.owner_photo_url ? (
          <img src={profile.owner_photo_url} alt={name}
               style={{
                 width: '100%', maxHeight: 360, objectFit: 'cover',
                 borderRadius: 16, border: `2px solid ${PEACH}`,
               }} />
        ) : (
          <div style={{
            width: '100%', aspectRatio: '1', maxHeight: 360,
            background: 'linear-gradient(135deg, #d4789a, #8b4561)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'white', fontWeight: 700, fontSize: 64,
            borderRadius: 16, border: `2px solid ${PEACH}`,
          }}>{initials(name)}</div>
        )}
      </div>

      {/* Регалии основателя */}
      {ach.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {ach.map((a, i) => (
              <div key={i} style={{
                background: 'white', padding: '10px 12px', borderRadius: 12,
                border: '1px solid #f0f0f0', boxShadow: '0 1px 4px rgba(37,69,93,0.06)',
              }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: DARK, lineHeight: 1.1 }}>{a.value}</div>
                <div style={{ fontSize: 11, color: '#6b7c8e', marginTop: 3, lineHeight: 1.25 }}>{a.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Биография */}
      {profile.bio && (
        <div style={{ marginBottom: 16 }}>
          <div style={{
            background: 'white', padding: 14, borderRadius: 14,
            border: '1px solid #f0f0f0', boxShadow: '0 1px 4px rgba(37,69,93,0.06)',
            fontSize: 14, color: '#3a4a5a', lineHeight: 1.55, whiteSpace: 'pre-wrap',
          }}>
            {profile.bio}
          </div>
        </div>
      )}

      {/* Соцсети */}
      {socials.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{
            fontSize: 10, color: PEACH, fontWeight: 700, letterSpacing: 1.5,
            textTransform: 'uppercase', marginBottom: 8, paddingLeft: 2,
          }}>
            Соцсети
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {socials.map(s => (
              <a key={s.key} href={profile.social_links?.[s.key]} target="_blank" rel="noreferrer"
                 style={{
                   display: 'flex', alignItems: 'center', gap: 8,
                   background: 'white', padding: '10px 14px', borderRadius: 12,
                   border: '1px solid #f0f0f0', boxShadow: '0 1px 4px rgba(37,69,93,0.06)',
                   color: DARK, fontWeight: 600, fontSize: 13, textDecoration: 'none',
                 }}>
                <span style={{ fontSize: 16 }}>{s.icon}</span> {s.label}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
