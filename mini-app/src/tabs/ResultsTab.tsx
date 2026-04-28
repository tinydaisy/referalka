interface Props {
  event: any
  participant: any
}

const PEACH = '#FFCFA4'
const DARK = '#25455D'

function formatEndDate(d: string | Date | null | undefined): string {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  if (isNaN(date.getTime())) return ''
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']
  return `${date.getDate()} ${months[date.getMonth()]}`
}

export default function ResultsTab({ event, participant }: Props) {
  const successor = event?.successor
  const isConference = event?.module_slug === 'conference'
  const hasVip = !!event?.has_vip_tariff
  const isRegistered = !!participant?.is_registered

  // Дата завершения
  const endDateLabel = formatEndDate(event?.end_at || event?.start_at)

  // ─── Вариант для НОВОГО участника (опоздал, не зарегистрирован) ───
  if (!isRegistered) {
    return (
      <div className="fade-in">
        {/* Шапка с персиковым подзаголовком прямо под названием */}
        <div style={{ padding: '0 0 14px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', lineHeight: 1.2, marginBottom: 6 }}>
            {event?.title || 'Событие'}
          </h1>
          <div style={{ fontSize: 13, color: PEACH, fontWeight: 600 }}>
            Как жаль! Событие прошло{endDateLabel ? ` ${endDateLabel}` : ''}
          </div>
        </div>

        {/* А дальше */}
        {successor && (
          <div style={{
            background: 'linear-gradient(135deg, #fff8f0, white)',
            border: `2px solid ${PEACH}`, borderRadius: 16,
            padding: 14, marginBottom: 12, cursor: 'pointer',
          }}>
            <div style={{ fontSize: 11, color: '#b86b00', fontWeight: 700,
                          letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 6 }}>А дальше</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1a2a3a', marginBottom: 4 }}>{successor.title}</div>
            {successor.start_at && (
              <div style={{ fontSize: 12, color: '#6b7c8e', marginBottom: 10 }}>
                {formatEndDate(successor.start_at)}
              </div>
            )}
            <a href={`/event/${successor.slug}`} style={{
              display: 'block', background: DARK, color: PEACH,
              padding: 10, borderRadius: 10, textAlign: 'center',
              fontWeight: 700, fontSize: 13, textDecoration: 'none',
            }}>Зарегистрироваться →</a>
          </div>
        )}

        <div style={{
          background: '#1a2a3a', border: '1px solid var(--border)', borderRadius: 10,
          padding: 12, fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, textAlign: 'center',
        }}>
          В следующий раз приходите заранее — будет розыгрыш призов, партнёрская программа и подарки за приглашённых друзей
        </div>
      </div>
    )
  }

  // ─── Вариант для ЗАРЕГИСТРИРОВАННОГО участника ───
  const visited     = participant?.visited_count    ?? participant?.referrals_count ?? 0
  const registered  = participant?.registered_count ?? participant?.points_total    ?? 0
  const giftsCount  = participant?.gifts_received_count ?? 0
  const myRank      = participant?.my_rank
  const totalAudience = event?.total_audience ?? participant?.total_audience ?? 0

  return (
    <div className="fade-in">
      {/* Шапка с персиковым подзаголовком */}
      <div style={{ padding: '0 0 14px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'white', lineHeight: 1.2, marginBottom: 6 }}>
          {event?.title || 'Событие'}
        </h1>
        <div style={{ fontSize: 13, color: PEACH, fontWeight: 600 }}>
          Событие завершилось! Спасибо вам!
        </div>
        {endDateLabel && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{endDateLabel}</div>
        )}
      </div>

      {/* ВИП с записями — только для конференции с has_vip_tariff */}
      {isConference && hasVip && (
        <a href={event?.vip_url || '#'} target="_blank" rel="noreferrer" style={{
          display: 'block', textDecoration: 'none',
          background: 'linear-gradient(135deg, #FFCFA4, #d4a574)', color: DARK,
          borderRadius: 14, padding: '14px 16px', marginBottom: 14,
          textAlign: 'center', fontWeight: 900, fontSize: 14,
          letterSpacing: 1, textTransform: 'uppercase',
          boxShadow: '0 4px 12px rgba(255,207,164,0.4)',
        }}>
          {event?.vip_title || 'Купить VIP-тариф с записями'}
        </a>
      )}

      {/* Большая цифра охвата (если есть) */}
      {totalAudience > 0 && (
        <div style={{
          background: 'linear-gradient(135deg, #25455D, #0a1520)', color: 'white',
          borderRadius: 16, padding: '22px 16px', marginBottom: 14, textAlign: 'center',
        }}>
          <div style={{ fontSize: 44, fontWeight: 900, color: PEACH, lineHeight: 1 }}>
            {totalAudience.toLocaleString('ru-RU')}
          </div>
          <div style={{ fontSize: 13, opacity: 0.85, marginTop: 8 }}>человек охватили вместе</div>
        </div>
      )}

      {/* Ваши результаты — 3 квадрата в линию */}
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
                    color: '#6b7c8e', margin: '4px 4px 10px' }}>Ваши результаты</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
        <div style={{
          background: 'white', borderRadius: 12, padding: '12px 6px', textAlign: 'center',
          boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
        }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: DARK }}>
            {registered}{visited > registered ? ` / ${visited}` : ''}
          </div>
          <div style={{ fontSize: 11, color: '#6b7c8e', marginTop: 4 }}>
            {visited > registered ? 'привели / переходов' : (registered === 1 ? 'привели' : 'привели')}
          </div>
        </div>
        <div style={{
          background: 'white', borderRadius: 12, padding: '12px 6px', textAlign: 'center',
          boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
        }}>
          <div style={{ fontSize: 22, fontWeight: 900, color: DARK }}>{giftsCount}</div>
          <div style={{ fontSize: 11, color: '#6b7c8e', marginTop: 4 }}>{giftsCount === 1 ? 'подарок' : 'подарка'}</div>
        </div>
        {myRank && (
          <div style={{
            background: 'white', borderRadius: 12, padding: '12px 6px', textAlign: 'center',
            border: `2px solid ${PEACH}`, boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
          }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: '#b86b00' }}>№{myRank}</div>
            <div style={{ fontSize: 11, color: '#6b7c8e', marginTop: 4 }}>место в ТОПе</div>
          </div>
        )}
      </div>

      {/* А дальше */}
      {successor && (
        <div style={{
          background: 'linear-gradient(135deg, #fff8f0, white)',
          border: `2px solid ${PEACH}`, borderRadius: 16,
          padding: 14, marginBottom: 12, cursor: 'pointer',
        }}>
          <div style={{ fontSize: 11, color: '#b86b00', fontWeight: 700,
                        letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 6 }}>А дальше</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#1a2a3a', marginBottom: 4 }}>{successor.title}</div>
          {successor.start_at && (
            <div style={{ fontSize: 12, color: '#6b7c8e', marginBottom: 10 }}>
              {formatEndDate(successor.start_at)}
            </div>
          )}
          <a href={`/event/${successor.slug}`} style={{
            display: 'block', background: DARK, color: PEACH,
            padding: 10, borderRadius: 10, textAlign: 'center',
            fontWeight: 700, fontSize: 13, textDecoration: 'none',
          }}>Зарегистрироваться →</a>
        </div>
      )}
    </div>
  )
}
