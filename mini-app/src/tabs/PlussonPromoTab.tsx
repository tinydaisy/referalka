const APP_URL = import.meta.env.VITE_APP_URL || 'https://pluson.ru'
const REGISTER_URL = `${APP_URL}/register`
const APP_DOMAIN = APP_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')

const FEATURES = [
  {
    title: 'Партнёрские ссылки за вас',
    desc: 'Каждый зарегистрированный получает свою ссылку. Приглашает друзей — забирает подарки. Подарки выдаёт бот сам.',
  },
  {
    title: 'Лендинг + Mini App за 5 минут',
    desc: 'Афиша, программа, регистрация — без программистов. Готово к запуску в тот же день.',
  },
  {
    title: 'Видно всё в одном кабинете',
    desc: 'Кто пришёл, кто привёл, какие посты сработали. Никакого Excel по итогам.',
  },
  {
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
          alt="ПЛЮСОН"
          style={{ height: 32, marginBottom: 12, opacity: 0.95 }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
        <div style={{ color: '#FFCFA4', fontSize: 11, letterSpacing: 2, fontWeight: 700, opacity: 0.85 }}>
          ПЛЮСОН
        </div>
        <h1 style={{ color: 'white', fontSize: 22, fontWeight: 800, marginTop: 12, lineHeight: 1.25 }}>
          Сделайте так же<br />со своим событием
        </h1>
        <p style={{ color: 'rgba(255,255,255,0.78)', fontSize: 13, marginTop: 8 }}>
          Бесплатно — пока сервис в бета-режиме
        </p>
      </div>

      <div style={{ padding: '20px 16px 0' }}>
        <div
          style={{
            background: 'white',
            border: '2px solid #FFCFA4',
            borderRadius: 16,
            padding: 18,
            textAlign: 'center',
            boxShadow: '0 4px 14px rgba(255, 207, 164, 0.25)',
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
              background: '#FFCFA4',
              color: '#25455D',
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
              }}
            >
              <div style={{ color: 'var(--text)', fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
                {f.title}
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 12.5, lineHeight: 1.5 }}>
                {f.desc}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
