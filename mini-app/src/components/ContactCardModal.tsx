import { useEffect, useState } from 'react'
import { getParticipantCard } from '../api'

interface Messenger {
  platform_slug: string
  platform_name: string
  icon_url?: string | null
  color_hex?: string | null
  username?: string | null
  url?: string | null
}

interface Card {
  id: number
  name: string
  messengers: Messenger[]
}

interface Props {
  eventSlug: string
  participantId: number
  viewerTgId: number
  onClose: () => void
}

const PEACH = '#FFCFA4'
const DARK = '#25455D'

function openExternal(url: string) {
  const tg = (window as any).Telegram?.WebApp
  // ⚠️ `openTelegramLink` понимает только домен `t.me`; наши ссылки —
  // на `telegram.me`. Без приведения человек уезжал во внешний браузер.
  if (tg?.openTelegramLink && /^https?:\/\/(?:t|telegram)\.me\//i.test(url)) {
    tg.openTelegramLink(url.replace(/^https:\/\/telegram\.me\//i, 'https://t.me/')); return
  }
  if (tg?.openLink) { tg.openLink(url); return }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export default function ContactCardModal({ eventSlug, participantId, viewerTgId, onClose }: Props) {
  const [card, setCard] = useState<Card | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    getParticipantCard(eventSlug, participantId, viewerTgId)
      .then((r: any) => setCard(r))
      .catch((e: any) => setError(e?.message || 'Не удалось загрузить карточку'))
      .finally(() => setLoading(false))
  }, [eventSlug, participantId, viewerTgId])

  const initials = (card?.name || '?').trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase()

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(10,21,32,0.7)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      zIndex: 1000,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'white', borderRadius: '16px 16px 0 0',
        width: '100%', maxWidth: 520,
        padding: '20px 18px 24px', maxHeight: '85vh', overflowY: 'auto',
      }}>
        <div style={{ width: 40, height: 4, background: '#ddd', borderRadius: 2, margin: '0 auto 16px' }} />

        {loading && (
          <div style={{ textAlign: 'center', padding: '30px 0', color: '#888', fontSize: 13 }}>
            Загружаем…
          </div>
        )}

        {!loading && error && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ color: '#c0392b', fontSize: 13, marginBottom: 12 }}>{error}</div>
            <button onClick={onClose} style={{
              padding: '10px 20px', border: 0, borderRadius: 10,
              background: PEACH, color: DARK, fontSize: 13, fontWeight: 700,
              cursor: 'pointer', fontFamily: 'inherit',
            }}>Закрыть</button>
          </div>
        )}

        {!loading && card && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
              <div style={{
                width: 56, height: 56, borderRadius: '50%',
                background: 'linear-gradient(135deg, #FFCFA4, #d4a574)',
                color: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 800, fontSize: 18, flexShrink: 0,
              }}>{initials}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3 style={{ color: DARK, fontSize: 17, fontWeight: 800, margin: '0 0 2px',
                              wordBreak: 'break-word' }}>
                  {card.name}
                </h3>
                <div style={{ fontSize: 11, color: '#8a96a3' }}>Карточка контакта</div>
              </div>
            </div>

            {card.messengers.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px 0', color: '#8a96a3', fontSize: 13 }}>
                У участника нет привязанных мессенджеров
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}>
                {card.messengers.map(m => {
                  const clickable = !!m.url
                  return (
                    <button
                      key={m.platform_slug}
                      disabled={!clickable}
                      onClick={() => m.url && openExternal(m.url)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        background: '#f6f8fb', border: '1px solid #e5e9f0',
                        borderRadius: 12, padding: '10px 12px',
                        cursor: clickable ? 'pointer' : 'default',
                        opacity: clickable ? 1 : 0.6,
                        textAlign: 'left', fontFamily: 'inherit',
                        width: '100%',
                      }}
                    >
                      <div style={{
                        width: 36, height: 36, borderRadius: 10,
                        background: m.color_hex || DARK,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0, color: 'white', fontWeight: 800, fontSize: 15,
                      }}>
                        {m.platform_name.slice(0, 1).toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: DARK }}>
                          {m.platform_name}
                        </div>
                        <div style={{ fontSize: 11, color: '#6b7c8e',
                                       overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {m.username ? `@${m.username.replace(/^@+/, '')}` : 'без публичного юзернейма'}
                        </div>
                      </div>
                      {clickable && (
                        <span style={{ fontSize: 18, color: PEACH, fontWeight: 700, marginRight: 4 }}>›</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            <button onClick={onClose} style={{
              width: '100%', padding: '12px', marginTop: 14, border: 0,
              background: 'transparent', color: '#888', fontSize: 13, fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit',
            }}>
              Закрыть
            </button>
          </>
        )}
      </div>
    </div>
  )
}
