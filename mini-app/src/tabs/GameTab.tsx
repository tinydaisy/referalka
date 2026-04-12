import { useState, useEffect } from 'react'
import { getGifts } from '../api'

const MOCK_GIFTS = [
  { id: 1, title: 'Запись вебинара', description: 'Полная запись первого дня', points_cost: 1, link_url: '#' },
  { id: 2, title: 'Чек-лист участника', description: 'PDF с материалами', points_cost: 5, link_url: '#' },
  { id: 3, title: 'VIP-доступ', description: 'Закрытый чат организаторов', points_cost: 10, link_url: '#' },
]

interface Props { event: any; participant: any; tgUser: any }

type Section = 'progress' | 'gifts' | 'materials' | 'share'

const APP_URL = import.meta.env.VITE_APP_URL || 'https://plusson.app'

export default function GameTab({ event, participant, tgUser }: Props) {
  const [section, setSection] = useState<Section>('progress')
  const [gifts, setGifts] = useState(MOCK_GIFTS)
  const [copied, setCopied] = useState(false)

  const refLink = participant?.ref_code
    ? `${APP_URL}/r/${participant.ref_code}`
    : `${APP_URL}/r/example`

  const referrals = participant?.referrals_count || participant?.points_total || 0
  const nextGift = gifts.find(g => g.points_cost > referrals)
  const toNext = nextGift ? nextGift.points_cost - referrals : 0

  useEffect(() => {
    if (event?.slug) {
      getGifts(event.slug).then(r => { if (r.gifts?.length) setGifts(r.gifts) }).catch(() => {})
    }
  }, [event?.slug])

  function copy() {
    navigator.clipboard.writeText(refLink)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function share() {
    const twa = (window as any).Telegram?.WebApp
    if (twa?.openTelegramLink) {
      const text = encodeURIComponent(`Присоединяйтесь к ${event?.title || 'событию'}! Участвуйте в реферальной игре и получайте подарки: ${refLink}`)
      twa.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${text}`)
    } else {
      copy()
    }
  }

  const pills: { id: Section; label: string }[] = [
    { id: 'progress', label: 'Прогресс' },
    { id: 'gifts', label: 'Подарки' },
    { id: 'materials', label: 'Материалы' },
    { id: 'share', label: 'Поделиться' },
  ]

  return (
    <div className="fade-in">
      {/* Pills */}
      <div className="pills">
        {pills.map(p => (
          <button key={p.id} className={`pill ${section === p.id ? 'active' : ''}`} onClick={() => setSection(p.id)}>
            {p.label}
          </button>
        ))}
      </div>

      {/* Progress section */}
      {section === 'progress' && (
        <div style={{ padding: '8px 16px 16px' }}>
          {/* Big counter */}
          <div className="card" style={{ textAlign: 'center', padding: '28px 16px', marginBottom: 12 }}>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 8 }}>Вы пригласили</p>
            <div style={{ fontSize: 64, fontWeight: 700, color: 'var(--peach)', lineHeight: 1 }}>{referrals}</div>
            <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 6 }}>
              {referrals === 1 ? 'человека' : referrals < 5 ? 'человека' : 'человек'}
            </p>

            {nextGift && (
              <div style={{ marginTop: 20 }}>
                <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
                  До следующего подарка: <span style={{ color: 'var(--peach)', fontWeight: 600 }}>ещё {toNext} чел.</span>
                </p>
                <div className="progress-track">
                  <div className="progress-fill" style={{
                    width: `${Math.round((referrals / nextGift.points_cost) * 100)}%`
                  }} />
                </div>
                <p style={{ color: 'rgba(255,207,164,0.6)', fontSize: 11, marginTop: 6 }}>
                  🎁 {nextGift.title}
                </p>
              </div>
            )}
          </div>

          {/* Share CTA */}
          <button className="btn btn-primary" onClick={() => setSection('share')} style={{ marginBottom: 8 }}>
            Пригласить друзей
          </button>
          <p style={{ color: 'var(--muted)', fontSize: 12, textAlign: 'center' }}>
            Поделитесь ссылкой — за каждого зарегистрированного вы получите подарок
          </p>
        </div>
      )}

      {/* Gifts section */}
      {section === 'gifts' && (
        <div style={{ padding: '8px 16px 16px' }}>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
            Подарки за приглашённых участников
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {gifts.map(g => {
              const unlocked = referrals >= g.points_cost
              return (
                <div key={g.id} className={`card ${unlocked ? 'gift-unlocked' : 'gift-locked'}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{
                    width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                    background: unlocked ? 'linear-gradient(45deg, #25455D, #0a1520)' : 'var(--card2)',
                    border: unlocked ? '1px solid var(--peach)' : '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20
                  }}>
                    {unlocked ? '🎁' : '🔒'}
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ color: unlocked ? 'white' : 'var(--muted)', fontWeight: 600, fontSize: 14 }}>{g.title}</p>
                    <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>{g.description}</p>
                    <p style={{ color: unlocked ? 'var(--peach)' : 'var(--muted)', fontSize: 11, marginTop: 3 }}>
                      {unlocked ? '✓ Разблокировано' : `Нужно ${g.points_cost} чел.`}
                    </p>
                  </div>
                  {unlocked && g.link_url && (
                    <a href={g.link_url} target="_blank" rel="noreferrer"
                      className="btn btn-sm btn-gold" style={{ width: 'auto', padding: '8px 14px', flexShrink: 0 }}>
                      Получить
                    </a>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Materials section */}
      {section === 'materials' && (
        <div style={{ padding: '8px 16px 16px', textAlign: 'center' }}>
          <div style={{ paddingTop: 40, paddingBottom: 20 }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📁</div>
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>
              Организатор пока не добавил материалы
            </p>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>
              Они появятся здесь ближе к событию
            </p>
          </div>
        </div>
      )}

      {/* Share section */}
      {section === 'share' && (
        <div style={{ padding: '8px 16px 16px' }}>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>Ваша реферальная ссылка</p>

          {/* Link block */}
          <div className="card" style={{ marginBottom: 12 }}>
            <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginBottom: 8 }}>Ваша ссылка:</p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code style={{
                flex: 1, background: 'var(--card2)', padding: '10px 12px',
                borderRadius: 10, fontSize: 12, color: 'var(--peach)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                border: '1px solid var(--border)'
              }}>
                {refLink}
              </code>
              <button onClick={copy} className="btn btn-sm btn-outline" style={{ width: 'auto', flexShrink: 0 }}>
                {copied ? '✓' : 'Копировать'}
              </button>
            </div>
          </div>

          <button className="btn btn-primary" onClick={share} style={{ marginBottom: 8 }}>
            Поделиться в Telegram
          </button>
          <button className="btn btn-outline" onClick={copy} style={{ marginBottom: 16 }}>
            {copied ? '✓ Ссылка скопирована!' : 'Скопировать ссылку'}
          </button>

          {/* Promo text */}
          <div className="card">
            <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginBottom: 8 }}>Текст для публикации:</p>
            <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
              🎯 Присоединяйтесь к {event?.title || 'событию'}!<br />
              Участвуйте в реферальной игре и получайте подарки за каждого приглашённого.<br /><br />
              👉 {refLink}
            </p>
            <button onClick={() => {
              navigator.clipboard.writeText(`🎯 Присоединяйтесь к ${event?.title || 'событию'}!\nУчаствуйте в реферальной игре и получайте подарки за каждого приглашённого.\n\n👉 ${refLink}`)
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            }} className="btn btn-outline" style={{ marginTop: 12 }}>
              Скопировать текст
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
