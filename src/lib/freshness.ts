import type { Resource } from '../types'
import { timeAgo } from './time'

export interface CheckedSource {
  name: string
  r: Resource<unknown>
}

export interface CheckedSummary {
  /** The oldest "fetched" time among the sources that have data: no card on the screen shows an older check. */
  oldest: number | null
  /** Sources that have data but whose last refresh failed (their cards say so; the summary names them). */
  failing: string[]
}

/** The oldest check among the sources that have data, and which of them failed their last refresh. */
export function checkedSummary(sources: CheckedSource[]): CheckedSummary {
  const withData = sources.filter((s) => s.r.data != null && s.r.freshness?.fetchedAt)
  const times = withData.map((s) => s.r.freshness!.fetchedAt)
  return {
    oldest: times.length ? Math.min(...times) : null,
    failing: withData.filter((s) => s.r.error).map((s) => s.name),
  }
}

/**
 * "within the last 5 min" (or "just now") for the oldest check, rounded UP: 4 min 20 s is "within the last 5 min",
 * a true bound. A card's own `timeAgo` rounds to the nearest, and nearest(a) ≤ up(a) ≤ up(oldest) for any age a up
 * to the oldest, so no card on the same shared clock reads more than this. Null when nothing has data.
 */
export function withinText(oldest: number | null, now: number): string | null {
  if (!oldest) return null
  const s = Math.max(0, Math.round((now - oldest) / 1000))
  if (s < 10) return timeAgo(oldest, now) // "just now", the same cut-off as the cards
  const m = Math.ceil(s / 60)
  if (m <= 1) return 'within the last minute'
  if (m < 60) return `within the last ${m} min`
  const h = Math.ceil(m / 60)
  return h < 48 ? `within the last ${h} h` : `within the last ${Math.ceil(h / 24)} d`
}

/** "Everything on Now checked within the last 4 min" (+ "· gauges: last refresh failed"), or null before any data. */
export function nowCheckedLine(sources: CheckedSource[], now: number): string | null {
  const s = checkedSummary(sources)
  const within = withinText(s.oldest, now)
  if (!within) return null
  const failed = s.failing.length ? ` · ${s.failing.join(', ')}: last refresh failed` : ''
  return `Everything on Now checked ${within}${failed}`
}
