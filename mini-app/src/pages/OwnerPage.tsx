/**
 * Страница «Об основателе» — открывается из карточки-тизера в EcosystemTab.
 * Большое фото, имя, позиционирование, факты в цифрах, биография, соцсети.
 */
import EventDescription from '../components/EventDescription'

interface Achievement { label: string; value: string }
interface TgChannel { url: string; chat_id?: string; name?: string }
interface Profile {
  id: number
  name: string
  owner_photo_url?: string | null
  owner_positioning?: string | null
  owner_achievements?: Achievement[]
  bio?: string | null
  // social_links: telegram_channels — массив (миграция 114),
  // остальные ключи — одиночные ссылки.
  social_links?: {
    telegram_channels?: TgChannel[]
    instagram?: string
    youtube?: string
    vk?: string
    website?: string
  } & Record<string, any>
}

interface Props {
  profile: Profile
  onBack: () => void
}

const PEACH = '#FFCFA4'
const DARK = '#25455D'

function IconTelegram() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19l-9.49 5.99-4.1-1.3c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71l-4.1-3.03-1.97 1.92c-.23.23-.42.42-.86.42z"/>
    </svg>
  )
}
function IconInstagram() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="5" ry="5"/>
      <circle cx="12" cy="12" r="4"/>
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
    </svg>
  )
}
function IconYoutube() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.6 3.6 12 3.6 12 3.6s-7.6 0-9.4.5A3 3 0 0 0 .5 6.2C0 8 0 12 0 12s0 4 .5 5.8A3 3 0 0 0 2.6 19.9c1.8.5 9.4.5 9.4.5s7.6 0 9.4-.5a3 3 0 0 0 2.1-2.1C24 16 24 12 24 12s0-4-.5-5.8zM9.6 15.6V8.4l6.3 3.6-6.3 3.6z"/>
    </svg>
  )
}
function IconVk() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12.8 17.4c-6.5 0-10.2-4.4-10.4-11.8h3.3c.1 5.4 2.5 7.7 4.4 8.2V5.6h3.1v4.7c1.9-.2 3.9-2.4 4.6-4.7h3.1c-.5 2.9-2.7 5.1-4.3 6 1.6.7 4.2 2.6 5.2 6.1h-3.4c-.8-2.5-2.6-4.4-5.2-4.6v4.6h-.4z"/>
    </svg>
  )
}
function IconGlobe() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>
  )
}

// Telegram-каналы — отдельным списком (массив), остальные соцсети — одиночные иконки.
const SOCIAL_META: { key: 'instagram' | 'youtube' | 'vk' | 'website'; label: string; Icon: () => JSX.Element }[] = [
  { key: 'instagram', label: 'Instagram', Icon: IconInstagram },
  { key: 'youtube',   label: 'YouTube',   Icon: IconYoutube },
  { key: 'vk',        label: 'VK',        Icon: IconVk },
  { key: 'website',   label: 'Сайт',      Icon: IconGlobe },
]

function initials(name: string): string {
  const parts = (name || '').trim().split(/\s+/)
  if (!parts[0]) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

export default function OwnerPage({ profile, onBack }: Props) {
  const name = profile.name
  const role = profile.owner_positioning || ''
  const ach = (profile.owner_achievements || []).filter(a => a.label?.trim() && a.value?.trim())
  const socials = SOCIAL_META.filter(s => profile.social_links?.[s.key])
  const tgChannels: TgChannel[] = Array.isArray(profile.social_links?.telegram_channels)
    ? profile.social_links!.telegram_channels!
    : []

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

      {/* Фото — большое. Если фото нет — ничего не показываем (без заглушек). */}
      {profile.owner_photo_url && (
        <div style={{ margin: '14px 0 16px' }}>
          <img src={profile.owner_photo_url} alt={name}
               style={{
                 width: '100%', maxHeight: 360, objectFit: 'cover',
                 borderRadius: 16, border: `2px solid ${PEACH}`,
               }} />
        </div>
      )}

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

      {/* Регалии (clients.bio) — без заголовка.
          ⚠️ Через EventDescription: с 2026-08-13 регалии редактируются с
          форматированием (жирный, курсив, списки). Обычный текст старых
          записей выводится как раньше — компонент сам решает по содержимому. */}
      {profile.bio && (
        <div style={{ marginBottom: 16 }}>
          <EventDescription
            text={profile.bio}
            style={{
              background: 'white', padding: 14, borderRadius: 14,
              border: '1px solid #f0f0f0', boxShadow: '0 1px 4px rgba(37,69,93,0.06)',
              fontSize: 14, color: '#3a4a5a', lineHeight: 1.55,
            }}
          />
        </div>
      )}

      {/* Соцсети (Telegram-каналов может быть несколько, остальные — по одному) */}
      {(socials.length > 0 || tgChannels.length > 0) && (
        <div style={{ marginBottom: 24 }}>
          <div style={{
            fontSize: 10, color: PEACH, fontWeight: 700, letterSpacing: 1.5,
            textTransform: 'uppercase', marginBottom: 8, paddingLeft: 2,
          }}>
            Соцсети
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {tgChannels.map((ch, i) => (
              <a key={`tg-${i}`} href={ch.url} target="_blank" rel="noreferrer"
                 style={{
                   display: 'inline-flex', alignItems: 'center', gap: 8,
                   background: 'linear-gradient(135deg, #25455D, #0a1520)',
                   padding: '10px 14px', borderRadius: 12, border: 'none',
                   color: PEACH, fontWeight: 800, fontSize: 13, textDecoration: 'none',
                   boxShadow: '0 2px 6px rgba(37,69,93,0.18)',
                 }}>
                <span style={{ display: 'inline-flex', color: PEACH }}><IconTelegram /></span>
                {ch.name?.trim() ? ch.name : 'Telegram'}
              </a>
            ))}
            {socials.map(s => (
              <a key={s.key} href={profile.social_links?.[s.key]} target="_blank" rel="noreferrer"
                 style={{
                   display: 'inline-flex', alignItems: 'center', gap: 8,
                   background: 'linear-gradient(135deg, #25455D, #0a1520)',
                   padding: '10px 14px', borderRadius: 12, border: 'none',
                   color: PEACH, fontWeight: 800, fontSize: 13, textDecoration: 'none',
                   boxShadow: '0 2px 6px rgba(37,69,93,0.18)',
                 }}>
                <span style={{ display: 'inline-flex', color: PEACH }}><s.Icon /></span> {s.label}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
