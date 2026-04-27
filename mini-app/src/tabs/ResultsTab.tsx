interface Props {
  event: any
  participant: any
}

export default function ResultsTab({ event, participant }: Props) {
  const referrals = participant?.referrals_count || participant?.points_total || 0
  const successor = event?.successor

  return (
    <div className="fade-in" style={{ padding: '24px 16px 16px' }}>
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>🎉</div>
        <h2 style={{ color: 'white', fontSize: 20, fontWeight: 700 }}>
          {event?.title || 'Событие'} завершено
        </h2>
        <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 8, lineHeight: 1.5 }}>
          Спасибо что были с нами!
        </p>
      </div>

      {participant && (
        <div className="card" style={{ marginBottom: 16, textAlign: 'center' }}>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 6 }}>Вы привели</p>
          <div style={{ fontSize: 44, fontWeight: 700, color: 'var(--peach)' }}>{referrals}</div>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>друзей за это событие</p>
        </div>
      )}

      {successor && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <p className="sec-h" style={{ padding: '14px 16px 6px' }}>🎯 А дальше у нас</p>
          {successor.poster_url && (
            <img src={successor.poster_url} alt={successor.title}
                 style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block' }} />
          )}
          <div style={{ padding: '14px 16px 16px' }}>
            <p style={{ color: 'white', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
              {successor.title}
            </p>
            <a href={`/event/${successor.slug}`} className="btn btn-primary" style={{ textAlign: 'center', textDecoration: 'none', display: 'block' }}>
              Перейти →
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
