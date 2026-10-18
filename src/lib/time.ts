/** Human "updated X ago" formatting. */
export function timeAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

/**
 * The age of a measurement where the minutes matter up to two hours ("65 min ago" rather than "1 h ago"; the
 * air-monitor rule counts a reading fresh for 2 h), then hours and days like `timeAgo`.
 */
export function readingAge(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never'
  const m = Math.round(Math.max(0, now - ts) / 60_000)
  if (m < 1) return 'just now'
  if (m < 120) return `${m} min ago`
  return timeAgo(ts, now)
}

/** Short clock string in the user's locale, e.g. "14:35". */
export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** "Tue 14:00" style label for hourly frames. */
export function dayClock(ts: number): string {
  const d = new Date(ts)
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`
}

/** Relative offset such as "+2 h 30 min" or "-10 min". */
export function relOffset(fromTs: number, toTs: number): string {
  const min = Math.round((toTs - fromTs) / 60000)
  const sign = min < 0 ? '−' : '+'
  const a = Math.abs(min)
  if (a < 60) return `${sign}${a} min`
  const h = Math.floor(a / 60)
  const m = a % 60
  return m ? `${sign}${h} h ${m} min` : `${sign}${h} h`
}

export const MIN = 60_000
export const HOUR = 3_600_000
