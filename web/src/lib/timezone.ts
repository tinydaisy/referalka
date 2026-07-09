const TZ_KEY = 'plusson_timezone'

export function getTimezone(): string {
  if (typeof window === 'undefined') return 'Europe/Moscow'
  return localStorage.getItem(TZ_KEY) || 'Europe/Moscow'
}

export function setTimezone(tz: string) {
  if (typeof window !== 'undefined') localStorage.setItem(TZ_KEY, tz)
}

export function formatTime(datetime: string | null | undefined, timezone?: string): string {
  if (!datetime) return '—:——'
  const tz = timezone || getTimezone()
  return new Date(datetime).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', timeZone: tz })
}

// Смещение таймзоны (мс) относительно UTC в момент `at`. Положительное для восточных зон.
function tzOffsetMs(at: Date, tz: string): number {
  const localStr = at.toLocaleString('en-CA', { timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const asUtc = new Date(localStr.replace(', ', 'T') + 'Z')
  return asUtc.getTime() - at.getTime()
}

// UTC ISO (или Date) → строка "YYYY-MM-DDTHH:MM" для <input type="datetime-local">,
// показывающая СТЕННОЕ время в таймзоне рассылок (МСК по умолчанию), а НЕ в tz браузера.
// Нужно, чтобы у клиента с зарубежной tz компьютера в редакторе показывалось московское время.
export function utcIsoToTzLocalInput(iso: string | null | undefined, timezone?: string): string {
  const tz = timezone || 'Europe/Moscow'
  const d = iso ? new Date(iso) : new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const g = (t: string) => parts.find(p => p.type === t)?.value || ''
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`
}

// Строку "YYYY-MM-DDTHH:MM" из <input type="datetime-local"> трактует как СТЕННОЕ время
// в таймзоне рассылок (МСК) и возвращает соответствующий реальный момент (мс epoch).
// Так же, как бэк (_parse_fire_at вешает на naive-строку tz клиента). Используется для
// сравнения «дата в прошлом?» — независимо от tz браузера.
export function tzLocalInputToEpochMs(local: string, timezone?: string): number {
  const tz = timezone || 'Europe/Moscow'
  // Трактуем ввод как UTC-момент, затем корректируем на смещение таймзоны.
  const asUtc = new Date(`${local}:00Z`)
  const offset = tzOffsetMs(asUtc, tz)
  return asUtc.getTime() - offset
}

// Конвертирует "2026-04-29" + "10:00" в UTC ISO строку с учётом таймзоны пользователя
export function localTimeToUtcIso(date: string, time: string, timezone?: string): string {
  const tz = timezone || getTimezone()
  // Берём offset таймзоны: разница между UTC и локальным временем в этой таймзоне
  const probe = new Date(`${date}T${time}:00Z`) // UTC probe
  const localStr = probe.toLocaleString('en-CA', { timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' })
  // en-CA даёт "YYYY-MM-DD, HH:MM:SS"
  const localDate = new Date(localStr.replace(', ', 'T') + 'Z')
  const offsetMs = localDate.getTime() - probe.getTime()
  // Вычитаем offset чтобы получить UTC для введённого локального времени
  const utcMs = new Date(`${date}T${time}:00Z`).getTime() - offsetMs
  return new Date(utcMs).toISOString()
}
