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
