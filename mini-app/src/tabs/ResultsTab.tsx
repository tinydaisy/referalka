interface Props {
  event: any
  participant: any
  onOpenEvent?: (slug: string) => void   // переход на следующее событие через App.tsx::openEvent
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

export default function ResultsTab({ event, participant, onOpenEvent }: Props) {
  const successor = event?.successor
  const isConference = ['conference','turnir'].includes(event?.module_slug)
  const hasVip = !!event?.vip_url
  const isRegistered = !!participant?.is_registered

  // Дата завершения
  const endDateLabel = formatEndDate(event?.end_at || event?.start_at)

  // Клик «Зарегистрироваться» по карточке следующего события — та же логика
  // что в Хабе: вызываем App.tsx::openEvent(slug). Он либо редиректит на
  // лендинг клиента (window.location.replace), либо открывает встроенный
  // лендинг события, либо переоткрывает в зарегистрированном состоянии.
  function gotoSuccessor(e: React.MouseEvent) {
    e.preventDefault()
    if (successor?.slug && onOpenEvent) onOpenEvent(successor.slug)
  }

  // ─── Вариант для НОВОГО участника (опоздал, не зарегистрирован) ───
  if (!isRegistered) {
    return (
      <div className="fade-in">
        {/* Шапка с персиковым подзаголовком прямо под названием */}
        <div style={{ padding: '0 0 14px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', lineHeight: 1.2, marginBottom: 6 }}>
            {event?.title || 'Событие'}
          </h1>
          <div style={{ fontSize: 13, color: DARK, fontWeight: 800 }}>
            Как жаль! Событие прошло{endDateLabel ? ` ${endDateLabel}` : ''}
          </div>
        </div>

        {/* А дальше — карточка следующего события с афишей */}
        {successor && (
          <div style={{
            background: 'linear-gradient(135deg, #fff8f0, white)',
            border: `2px solid ${PEACH}`, borderRadius: 16,
            padding: 14, marginBottom: 12, cursor: 'pointer',
          }}>
            <div style={{
              background: PEACH, color: DARK,
              fontSize: 15, fontWeight: 900, letterSpacing: 0.5,
              textAlign: 'center', textTransform: 'uppercase',
              padding: '12px 10px', borderRadius: 12, marginBottom: 12,
              lineHeight: 1.25,
            }}>Ждём вас на следующем мероприятии 👇👇👇</div>
            {successor.poster_url && (
              <img src={successor.poster_url} alt={successor.title}
                   style={{
                     width: '100%', height: 'auto',
                     borderRadius: 12, marginBottom: 10, display: 'block',
                   }} />
            )}
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1a2a3a', marginBottom: 4 }}>{successor.title}</div>
            {successor.start_at && (
              <div style={{ fontSize: 12, color: '#6b7c8e', marginBottom: 10 }}>
                {formatEndDate(successor.start_at)}
              </div>
            )}
            <a href={`/event/${successor.slug}`} onClick={gotoSuccessor} style={{
              display: 'block', background: DARK, color: PEACH,
              padding: 10, borderRadius: 10, textAlign: 'center',
              fontWeight: 700, fontSize: 13, textDecoration: 'none',
              cursor: 'pointer',
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
  // Карточки «привели / подарки / место в ТОПе» больше не дублируем —
  // эта статистика живёт во вкладке «🎯 Игра».
  const totalAudience = event?.total_audience ?? participant?.total_audience ?? 0

  return (
    <div className="fade-in">
      {/* Шапка с персиковым подзаголовком */}
      <div style={{ padding: '0 0 14px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', lineHeight: 1.2, marginBottom: 6 }}>
          {event?.title || 'Событие'}
        </h1>
        <div style={{ fontSize: 13, color: DARK, fontWeight: 800 }}>
          Событие завершилось! Спасибо вам!
        </div>
        {endDateLabel && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{endDateLabel}</div>
        )}
      </div>

      {/* ВИП с записями — только для конференции с заданным vip_url */}
      {isConference && hasVip && (
        <a href={event.vip_url} target="_blank" rel="noreferrer" style={{
          display: 'block', textDecoration: 'none',
          background: PEACH, color: DARK,
          borderRadius: 14, padding: '16px 16px', marginBottom: 14,
          textAlign: 'center', fontWeight: 900, fontSize: 15,
          letterSpacing: 1.2, textTransform: 'uppercase',
          boxShadow: '0 4px 14px rgba(255,207,164,0.55)',
          border: `1px solid rgba(37,69,93,0.08)`,
        }}>
          Купить VIP-тариф с записями
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

      {/* А дальше — карточка следующего события с афишей */}
      {successor && (
        <div style={{
          background: 'linear-gradient(135deg, #fff8f0, white)',
          border: `2px solid ${PEACH}`, borderRadius: 16,
          padding: 14, marginBottom: 12, cursor: 'pointer',
        }}>
          <div style={{
            background: PEACH, color: DARK,
            fontSize: 15, fontWeight: 900, letterSpacing: 0.5,
            textAlign: 'center', textTransform: 'uppercase',
            padding: '12px 10px', borderRadius: 12, marginBottom: 12,
            lineHeight: 1.25,
          }}>Ждём вас на следующем мероприятии 👇👇👇</div>
          {successor.poster_url && (
            <img src={successor.poster_url} alt={successor.title}
                 style={{
                   width: '100%', height: 'auto',
                   borderRadius: 12, marginBottom: 10, display: 'block',
                 }} />
          )}
          <div style={{ fontSize: 15, fontWeight: 700, color: '#1a2a3a', marginBottom: 4 }}>{successor.title}</div>
          {successor.start_at && (
            <div style={{ fontSize: 12, color: '#6b7c8e', marginBottom: 10 }}>
              {formatEndDate(successor.start_at)}
            </div>
          )}
          <a href={`/event/${successor.slug}`} onClick={gotoSuccessor} style={{
            display: 'block', background: DARK, color: PEACH,
            padding: 10, borderRadius: 10, textAlign: 'center',
            fontWeight: 700, fontSize: 13, textDecoration: 'none',
            cursor: 'pointer',
          }}>Зарегистрироваться →</a>
        </div>
      )}
    </div>
  )
}
