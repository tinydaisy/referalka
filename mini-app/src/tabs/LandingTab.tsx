interface Props {
  event: any
  onRegister: () => void
}

function formatDateLong(dt?: string) {
  if (!dt) return ''
  try {
    return new Date(dt).toLocaleDateString('ru', {
      day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  } catch { return '' }
}

export default function LandingTab({ event, onRegister }: Props) {
  const heroPoster = event?.posters?.find((p: any) => p.orientation === 'horizontal')?.url || event?.poster_url

  return (
    <div className="fade-in" style={{ paddingBottom: 24 }}>
      {heroPoster && (
        <img src={heroPoster} alt={event?.title}
             style={{ width: '100%', display: 'block', aspectRatio: '16/9', objectFit: 'cover' }} />
      )}

      <div style={{ padding: '20px 16px 0' }}>
        <h1 style={{ color: 'white', fontSize: 22, fontWeight: 700, lineHeight: 1.25 }}>
          {event?.title || 'Событие'}
        </h1>

        {(event?.start_at || event?.end_at) && (
          <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10,
                        background: 'var(--card)', border: '1px solid var(--border)',
                        display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>📅</span>
            <span style={{ color: 'var(--peach)', fontSize: 13, fontWeight: 500 }}>
              {formatDateLong(event?.start_at)}
            </span>
          </div>
        )}

        {event?.address && (
          <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 10,
                        background: 'var(--card)', border: '1px solid var(--border)',
                        display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>📍</span>
            <span style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.4, wordBreak: 'break-word' }}>
              {event.address}
            </span>
          </div>
        )}

        {event?.description && (
          <p style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, lineHeight: 1.6, marginTop: 18, whiteSpace: 'pre-wrap' }}>
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
