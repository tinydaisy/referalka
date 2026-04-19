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
