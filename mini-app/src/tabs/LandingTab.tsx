import { useEffect, useRef, useState } from 'react'
import EventDescription from '../components/EventDescription'

interface Props {
  event: any
  onRegister: () => void
}

// Вторая кнопка ПОД описанием нужна только когда описание длинное — иначе на экране
// две одинаковые кнопки почти вплотную. Порог — 26 строк ТЕКСТА НА ЭКРАНЕ.
// ⚠️ Считать переносы \n нельзя: строка переносится по ширине телефона, поэтому
// меряем реальную высоту отрендеренного блока и делим на высоту строки.
const LONG_DESC_LINES = 26
const DESC_FONT_SIZE = 14
const DESC_LINE_HEIGHT = 1.6           // как в стилях EventDescription ниже
const LINE_PX = DESC_FONT_SIZE * DESC_LINE_HEIGHT   // ≈ 22.4px

/** true — описание занимает больше LONG_DESC_LINES строк на экране. */
function useIsLongDescription(deps: any) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [isLong, setIsLong] = useState(false)
  useEffect(() => {
    const measure = () => {
      const el = ref.current
      if (!el) { setIsLong(false); return }
      setIsLong(el.offsetHeight / LINE_PX > LONG_DESC_LINES)
    }
    measure()
    // Шрифты/картинки внутри описания могут догрузиться и изменить высоту — перемеряем.
    const t = setTimeout(measure, 300)
    // Пересчитываем при повороте/ресайзе — ширина меняет число строк.
    window.addEventListener('resize', measure)
    return () => { clearTimeout(t); window.removeEventListener('resize', measure) }
  }, [deps])
  return { ref, isLong }
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
    // Если время не задано (бэк отдаёт 00:00 как fallback при пустом open_time
    // у конф/турниров и при дате без времени) — показываем только дату.
    if (timePart === '00:00') return datePart
    return `${datePart}, ${timePart} МСК`
  } catch { return '' }
}

/** Текст по умолчанию, когда клиент свой не задал. */
const PRE_REG_DEFAULT = 'Скоро сообщим о старте регистрации'

export default function LandingTab({ event, onRegister }: Props) {
  // ⚠️ Регистрация ещё не открыта (мигр. 345): дата известна, а спикеры,
  // программа и лендинг ещё готовятся. Вместо кнопки участия — крупный текст
  // и, если клиент задал, одна кнопка со своей ссылкой («Выступить спикером»,
  // «Стать жюри»). Афиша при этом берётся отдельная — «до старта регистрации»:
  // финальной может ещё не быть вовсе.
  const preReg = !!event?.registration_closed
  const heroPoster = (preReg && event?.pre_reg_poster_url)
    || event?.posters?.find((p: any) => p.orientation === 'horizontal')?.url
    || event?.poster_url
  // У конкурсов своя верстка: дата = окончание голосования, красный баннер
  // «Голосование всего до …», кнопка дублируется сверху и снизу описания.
  // Старые типы (base/conference/...) рендерятся как раньше.
  const isContest = event?.module_slug === 'contest'
  // Текст кнопки клиент задаёт в дашборде (events.landing_cta_label, миграция 212).
  // Пусто → прежние дефолты по типу события.
  const ctaLabel = (event?.landing_cta_label || '').trim()
    || (isContest ? 'КАК ГОЛОСОВАТЬ?' : 'Зарегистрироваться')

  // Блок «регистрация ещё не открыта» — встаёт РОВНО на место кнопки участия
  // во всех раскладках. Второй страницы не заводим: разошлась бы с этой при
  // первой же правке вёрстки события.
  const preRegBlock = (
    <div>
      <div style={{
        color: 'var(--text)', fontSize: 17, fontWeight: 700, lineHeight: 1.4,
        textAlign: 'center', padding: '4px 0 2px',
      }}>
        {(event?.pre_reg_text || '').trim() || PRE_REG_DEFAULT}
      </div>
      {/* Кнопка НЕОБЯЗАТЕЛЬНА: у большинства событий на этом этапе вести
          некуда, и пустая кнопка была бы хуже её отсутствия. */}
      {!!(event?.pre_reg_btn_label || '').trim() && !!(event?.pre_reg_btn_url || '').trim() && (
        <a
          className="btn btn-primary"
          href={event.pre_reg_btn_url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: 14 }}
        >
          {event.pre_reg_btn_label}
        </a>
      )}
    </div>
  )

  const cta = preReg ? preRegBlock : (
    <button
      className="btn btn-primary"
      style={isContest ? { fontWeight: 900, letterSpacing: 0.5 } : undefined}
      onClick={onRegister}
    >
      {ctaLabel}
    </button>
  )

  // Дубль кнопки под описанием.
  // ⚠️ Решает ГАЛОЧКА клиента (events.landing_cta_repeat, миграция 314), а не
  // измерение высоты: порог всегда врёт — у одного клиента три абзаца это уже
  // много, у другого длинный текст свёрстан так, что вторая кнопка мешает.
  // Клиент видит свою страницу и решает сам.
  // Автоопределение оставлено ЗАПАСНЫМ вариантом: у событий, созданных до
  // галочки, поведение не меняется — иначе у них кнопка внизу молча пропала бы.
  // ⚠️ Хук ВЫШЕ early-return (ветка конкурса) — иначе React #310.
  const { ref: descRef, isLong: descAutoLong } = useIsLongDescription(event?.description)
  // ⚠️ При закрытой регистрации дубль НЕ показываем: смысл второй кнопки —
  // не дать дочитавшему остаться без действия, а здесь действия и нет.
  // Повторённое дважды «скоро сообщим» выглядит как сбой вёрстки.
  const descIsLong = !preReg && (event?.landing_cta_repeat === true
    || (event?.landing_cta_repeat == null && descAutoLong))

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
              background: 'var(--live)',
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
              <div ref={descRef}>
                <EventDescription
                  text={event.description}
                  style={{ color: 'var(--text)', fontSize: DESC_FONT_SIZE, lineHeight: DESC_LINE_HEIGHT, marginTop: 18 }}
                />
              </div>
              {/* Дубль кнопки ПОД описанием — только если описание длинное (>26 строк). */}
              {descIsLong && <div style={{ marginTop: 18 }}>{cta}</div>}
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

        {/* Кнопка-CTA сразу под названием/датой — всегда показывается. */}
        <div style={{ marginTop: 16 }}>{cta}</div>

        {event?.description && (
          <>
            <div ref={descRef}>
              <EventDescription
                text={event.description}
                style={{ color: 'var(--text)', fontSize: DESC_FONT_SIZE, lineHeight: DESC_LINE_HEIGHT, marginTop: 18 }}
              />
            </div>
            {/* Дубль кнопки ПОД описанием — только если описание длинное (>26 строк). */}
            {descIsLong && <div style={{ marginTop: 18 }}>{cta}</div>}
          </>
        )}
      </div>
    </div>
  )
}
