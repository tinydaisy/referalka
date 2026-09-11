import { useEffect, useState } from 'react'
import { getClientEvents } from '../api'

interface Props {
  clientId: number
  tgId?: number
  onOpenEvent: (slug: string) => void
}

type ParticipationStatus = 'new' | 'interested' | 'registered' | null

interface Ev {
  id: number
  slug: string
  title: string
  poster_url?: string
  start_at?: string
  end_at?: string
  // ⚠️ `always` — событие с галочкой «Идёт постоянно, даты нет»
  // (`events.is_evergreen`): запись на консультацию, доступ к материалам,
  // бессрочный приём заявок. Бэкенд отдаёт такие ОТДЕЛЬНОЙ группой, и её
  // обязательно надо рисовать: раньше календарь читал только now/upcoming/past,
  // и бессрочное событие молча пропадало из списка — клиент видел пустоту.
  bucket: 'now' | 'upcoming' | 'past' | 'always'
  participation_status?: ParticipationStatus
}

// ⚠️ Год печатаем ВСЕГДА. Без него дата обрывочна: «15 июня» не отвечает на
// вопрос «какого года», а у события дата может быть и следующей, и позапрошлой.
function formatDate(dt?: string) {
  if (!dt) return ''
  try {
    return new Date(dt).toLocaleDateString('ru', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow',
    })
  } catch { return '' }
}

// ⚠️⚠️ Однодневность события считается по ДАТЕ в МСК, а не сравнением строк
// start_at/end_at. Те — полные метки времени (19:00 и 21:00 одного дня), они
// НИКОГДА не равны, и выводилось «15 июня 2060 — 15 июня 2060»: одна и та же
// дата дважды.
function sameDay(a?: string, b?: string) {
  if (!a || !b) return false
  try {
    const key = (s: string) =>
      new Date(s).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' })
    return key(a) === key(b)
  } catch { return false }
}

// Афиша карточки события: ничего не рендерим, если URL пустой или картинка не загрузилась
function EventPoster({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return null
  return <img className="poster" src={src} alt={alt} onError={() => setFailed(true)} />
}

function StatusPill({ status }: { status: ParticipationStatus }) {
  if (!status) return null
  if (status === 'registered') return <span className="status-pill status-pill-registered">✓ Вы записаны</span>
  if (status === 'interested') return <span className="status-pill status-pill-interested">Вы интересовались</span>
  return <span className="status-pill status-pill-new">Новое</span>
}

function Section({ title, items, onOpen }: { title: string; items: Ev[]; onOpen: (s: string) => void }) {
  if (!items.length) return null
  return (
    <>
      {title && <div className="sec-h">{title}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px 4px' }}>
        {items.map(e => (
          <div key={e.id} className="hub-card fade-in" onClick={() => onOpen(e.slug)}>
            <EventPoster src={e.poster_url} alt={e.title} />
            <div className="body">
              <div className="badge-row">
                {/* ⚠️ У бессрочного НЕ пишем «Скоро»: оно не начнётся — оно
                    открыто всегда. Зелёный, как у идущего: записаться можно
                    прямо сейчас. */}
                <span className={`badge badge-${e.bucket === 'now' || e.bucket === 'always' ? 'green' : e.bucket === 'past' ? 'gray' : 'gold'}`}>
                  {e.bucket === 'always' ? '● Открыто всегда'
                    : e.bucket === 'now' ? '● Идёт сейчас'
                    : e.bucket === 'past' ? 'Завершено' : 'Скоро'}
                </span>
                <StatusPill status={e.participation_status ?? null} />
              </div>
              <div className="title">{e.title}</div>
              {(e.start_at || e.end_at) && (
                <div className="meta">{formatDate(e.start_at)}{e.end_at && !sameDay(e.start_at, e.end_at) ? ` — ${formatDate(e.end_at)}` : ''}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

export default function CalendarTab({ clientId, tgId, onOpenEvent }: Props) {
  const [data, setData] = useState<{ always: Ev[]; now: Ev[]; upcoming: Ev[]; past: Ev[] }>(
    { always: [], now: [], upcoming: [], past: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getClientEvents(clientId, undefined, tgId)
      // ⚠️ Группы подставляем с запасом: пока на прод не приехал бэкенд с
      // `always`, ключа в ответе нет — и `data.always.length` уронил бы вкладку
      // целиком, то есть календарь пропал бы вообще у всех.
      .then((d: Partial<Record<'always' | 'now' | 'upcoming' | 'past', Ev[]>>) =>
        setData({
          always: d.always ?? [], now: d.now ?? [],
          upcoming: d.upcoming ?? [], past: d.past ?? [],
        }))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [clientId, tgId])

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)' }}>Загружаем события…</div>

  const empty = !data.always.length && !data.now.length && !data.upcoming.length && !data.past.length
  if (empty) {
    return (
      <div style={{ textAlign: 'center', paddingTop: 60, padding: 16 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>📅</div>
        <p style={{ color: 'var(--text)', fontWeight: 700, fontSize: 16 }}>Пока нет событий</p>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
          Организатор скоро объявит<br />ближайшие мероприятия
        </p>
      </div>
    )
  }

  return (
    <div className="fade-in" style={{ paddingBottom: 16 }}>
      <Section title="🔴 Сейчас идёт"  items={data.now}      onOpen={onOpenEvent} />
      <Section title="📅 Скоро"        items={data.upcoming} onOpen={onOpenEvent} />
      {/* ⚠️ Бессрочные — ПОСЛЕ датированных: у тех есть срок, и они важнее по
          времени. Но выше архива — записаться на них можно прямо сейчас. */}
      <Section title="♾️ Открыто всегда" items={data.always} onOpen={onOpenEvent} />
      <ArchiveSection items={data.past} onOpen={onOpenEvent} />
    </div>
  )
}

function ArchiveSection({ items, onOpen }: { items: Ev[]; onOpen: (s: string) => void }) {
  const [open, setOpen] = useState(false)
  if (!items.length) return null
  return (
    <>
      <div style={{ padding: '0 16px', marginTop: 8 }}>
        <button
          onClick={() => setOpen(v => !v)}
          style={{
            background: 'transparent',
            border: '1px dashed var(--muted)',
            borderRadius: 12,
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            color: 'var(--muted)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            width: '100%',
          }}
        >
          <span>Архив прошедших · {items.length}</span>
          <span style={{ fontSize: 12, transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
        </button>
      </div>
      {open && <Section title="" items={items} onOpen={onOpen} />}
    </>
  )
}
