import type { ReactNode } from 'react'

const APP_URL = import.meta.env.VITE_APP_URL || 'https://pluson.ru'
const REGISTER_URL = `${APP_URL}/register`
const APP_DOMAIN = APP_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')

const IconGift = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={22} height={22}>
    <polyline points="20 12 20 22 4 22 4 12" />
    <rect x="2" y="7" width="20" height="5" />
    <line x1="12" y1="22" x2="12" y2="7" />
    <path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z" />
    <path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z" />
  </svg>
)

const IconTarget = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={22} height={22}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </svg>
)

const IconStats = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={22} height={22}>
    <line x1="18" y1="20" x2="18" y2="10" />
    <line x1="12" y1="20" x2="12" y2="4" />
    <line x1="6"  y1="20" x2="6"  y2="14" />
  </svg>
)

const IconBot = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={22} height={22}>
    <rect x="3" y="8" width="18" height="12" rx="2" />
    <line x1="12" y1="4" x2="12" y2="8" />
    <circle cx="12" cy="3" r="1" />
    <circle cx="9"  cy="14" r="1" />
    <circle cx="15" cy="14" r="1" />
    <line x1="8" y1="20" x2="8"  y2="22" />
    <line x1="16" y1="20" x2="16" y2="22" />
  </svg>
)

interface Feature {
  icon: ReactNode
  title: string
  desc: string
}

const FEATURES: Feature[] = [
  {
    icon: <IconGift />,
    title: 'Партнёрские ссылки за вас',
    desc: 'Каждый зарегистрированный получает свою ссылку. Приглашает друзей — забирает подарки. Подарки выдаёт бот сам.',
  },
  {
    icon: <IconTarget />,
    title: 'Лендинг + Mini App за 5 минут',
    desc: 'Афиша, программа, регистрация — без программистов. Готово к запуску в тот же день.',
  },
  {
    icon: <IconStats />,
    title: 'Видно всё в одном кабинете',
    desc: 'Кто пришёл, кто привёл, какие посты сработали. Никакого Excel по итогам.',
  },
  {
    icon: <IconBot />,
    title: 'Свой бот в Telegram',
    desc: 'На про-тарифе — свой брендовый бот с приветствиями и рассылками от вашего имени.',
  },
]

function openCabinet() {
  const tg = (window as any).Telegram?.WebApp
  if (tg?.openLink) {
    tg.openLink(REGISTER_URL)
  } else {
    window.open(REGISTER_URL, '_blank')
  }
}

export default function PlussonPromoTab() {
  return (
    <div className="fade-in" style={{ paddingBottom: 16 }}>
      <div
        className="grad-header"
        style={{
          textAlign: 'center',
          padding: '32px 24px 36px',
          marginBottom: 0,
        }}
      >
        <img
          src="/images/logo_no_ivision_wwhite.png"
          alt="iViSiON: ПЛЮСОН"
          style={{ height: 32, marginBottom: 12, opacity: 0.95 }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
        <div style={{ color: 'var(--peach)', fontSize: 11, letterSpacing: 2, fontWeight: 700, opacity: 0.85 }}>
          iViSiON: ПЛЮСОН
        </div>
        <h1 style={{ color: 'white', fontSize: 18, fontWeight: 800, marginTop: 12, lineHeight: 1.35 }}>
          Платформа для организаторов и экспертов: управляйте событием от А до Я — спикеры, рассылки, рефералы в одном месте
        </h1>
        <p style={{ color: 'rgba(255,255,255,0.78)', fontSize: 13, marginTop: 10 }}>
          Регистрируйся бесплатно
        </p>
      </div>

      <div style={{ padding: '20px 16px 0' }}>
        <div
          style={{
            background: 'white',
            border: '2px solid var(--peach)',
            borderRadius: 16,
            padding: 18,
            textAlign: 'center',
            boxShadow: '0 4px 14px rgba(var(--peach-rgb), 0.25)',
          }}
        >
          <div style={{ color: 'var(--text)', fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
            Готовы попробовать?
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 14, lineHeight: 1.4 }}>
            Создайте кабинет за минуту — карта не нужна
          </div>
          <button
            onClick={openCabinet}
            style={{
              background: 'var(--peach)',
              color: 'var(--dark)',
              border: 'none',
              padding: '13px 22px',
              borderRadius: 12,
              fontWeight: 800,
              fontSize: 14,
              cursor: 'pointer',
              width: '100%',
            }}
          >
            Создать кабинет →
          </button>
          <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 10 }}>
            Откроется {APP_DOMAIN}
          </div>
        </div>

        <div
          style={{
            margin: '20px 4px 12px',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.8,
            textTransform: 'uppercase',
            color: 'var(--muted)',
          }}
        >
          Что получите
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {FEATURES.map(f => (
            <div
              key={f.title}
              style={{
                background: 'white',
                borderRadius: 14,
                padding: 14,
                boxShadow: '0 2px 8px rgba(37, 69, 93, 0.06)',
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  background: 'linear-gradient(135deg, var(--warn-bg), var(--peach))',
                  color: 'var(--dark)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {f.icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: 'var(--text)', fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
                  {f.title}
                </div>
                <div style={{ color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.5 }}>
                  {f.desc}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
