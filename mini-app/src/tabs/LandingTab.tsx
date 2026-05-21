import EventDescription from '../components/EventDescription'

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
  // У конкурсов своя верстка: дата = окончание голосования, красный баннер
  // «Голосование всего до …», кнопка «КАК ГОЛОСОВАТЬ?», и она дублируется
  // сверху и снизу описания. Старые типы (base/conference/...) рендерятся как раньше.
  const isContest = event?.module_slug === 'contest'
  const ctaLabel = isContest ? 'КАК ГОЛОСОВАТЬ?' : 'Хочу участвовать'

  const cta = (
    <button
      className="btn btn-primary"
      style={isContest ? { fontWeight: 900, letterSpacing: 0.5 } : undefined}
      onClick={onRegister}
    >
      {ctaLabel}
    </button>
  )

  // ─── Контест: своя разметка ──────────────────────────────────────
  if (isContest) {
    const endLabel = formatDateLong(event?.end_at)
    return (
      <div className="fade-in" style={{ paddingBottom: 24 }}>
        {heroPoster && (
          <img src={heroPoster} alt={event?.title}
               style={{ width: 'calc(100% + 32px)', maxHeight: '70vh', margin: '-16px -16px 0', display: 'block',
                        objectFit: 'contain', borderRadius: '0 0 16px 16px' }} />
        )}

        <div style={{ padding: '20px 0 0' }}>
          <h1 style={{ color: 'var(--text)', fontSize: 22, fontWeight: 700, lineHeight: 1.25 }}>
            {event?.title || 'Голосование'}
          </h1>

          {endLabel && (
            <div style={{
              marginTop: 12,
              background: '#d32f2f',
              color: 'white',
              borderRadius: 12,
              padding: '12px 14px',
              fontSize: 14,
              fontWeight: 800,
              lineHeight: 1.35,
              boxShadow: '0 4px 14px rgba(211,47,47,0.25)',
            }}>
              ⏳ Голосование всего до {endLabel}!
            </div>
          )}

          {/* Кнопка-CTA НАД описанием — всегда показывается. */}
          <div style={{ marginTop: 16 }}>{cta}</div>

          {event?.description && (
            <>
              <EventDescription
                text={event.description}
                style={{ color: 'var(--text)', fontSize: 14, lineHeight: 1.6, marginTop: 18 }}
              />
              {/* Дубль кнопки ПОД описанием — если описание заполнено. */}
              <div style={{ marginTop: 18 }}>{cta}</div>
            </>
          )}
        </div>
      </div>
    )
  }

  // ─── Старые типы (base/conference/webinar/...) — без изменений ─────
  return (
    <div className="fade-in" style={{ paddingBottom: 24 }}>
      {heroPoster && (
        <img src={heroPoster} alt={event?.title}
             style={{ width: 'calc(100% + 32px)', margin: '-16px -16px 0', display: 'block',
                      objectFit: 'contain', borderRadius: '0 0 16px 16px' }} />
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

        {event?.description && (
          <EventDescription
            text={event.description}
            style={{ color: 'var(--text)', fontSize: 14, lineHeight: 1.6, marginTop: 18 }}
          />
        )}

        <button className="btn btn-primary" style={{ marginTop: 24 }} onClick={onRegister}>
          Хочу участвовать
        </button>
      </div>
    </div>
  )
}
