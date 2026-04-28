interface Props {
  event: any
  onRegister: () => void
}

function formatDateLong(dt?: string) {
  if (!dt) return ''
  try {
    // Жёстко в МСК — никаких сдвигов под браузер пользователя.
    const datePart = new Date(dt).toLocaleDateString('ru', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow',
    })
    const timePart = new Date(dt).toLocaleTimeString('ru', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
    })
    return `${datePart}, ${timePart} МСК`
  } catch { return '' }
}

export default function LandingTab({ event, onRegister }: Props) {
  const heroPoster = event?.posters?.find((p: any) => p.orientation === 'horizontal')?.url || event?.poster_url

  return (
    <div className="fade-in" style={{ paddingBottom: 24 }}>
      {heroPoster && (
        <img src={heroPoster} alt={event?.title}
             style={{ width: 'calc(100% + 32px)', margin: '-16px -16px 0', display: 'block',
                      aspectRatio: '16/9', objectFit: 'cover', borderRadius: '0 0 16px 16px' }} />
      )}

      <div style={{ padding: '20px 0 0' }}>
        <h1 style={{ color: 'var(--text)', fontSize: 22, fontWeight: 700, lineHeight: 1.25 }}>
          {event?.title || 'Событие'}
        </h1>

        {(event?.start_at || event?.end_at) && (
          <div className="card" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>📅</span>
            <span style={{ color: 'var(--warn)', fontSize: 13, fontWeight: 600 }}>
              {formatDateLong(event?.start_at)}
            </span>
          </div>
        )}

        {event?.address && (
          <div className="card" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>📍</span>
            <span style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.4, wordBreak: 'break-word' }}>
              {event.address}
            </span>
          </div>
        )}

        {event?.description && (
          <p style={{ color: 'var(--text)', fontSize: 14, lineHeight: 1.6, marginTop: 18, whiteSpace: 'pre-wrap' }}>
            {event.description}
          </p>
        )}

        <button className="btn btn-primary" style={{ marginTop: 24 }} onClick={onRegister}>
          Хочу участвовать
        </button>
      </div>
    </div>
  )
}
