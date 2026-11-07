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
 * "within the last 4 min" (or "just now") for the oldest check — `timeAgo`'s own rounding, which only grows with age,
 * so a newer card's "N min ago" (read from the same shared clock) is never more than this. Null when nothing has data.
 */
export function withinText(oldest: number | null, now: number): string | null {
  if (!oldest) return null
  const ago = timeAgo(oldest, now)
  return ago === 'just now' ? 'just now' : `within the last ${ago.replace(/ ago$/, '')}`
}

/** "Everything on Now checked within the last 4 min" (+ "· gauges: last refresh failed"), or null before any data. */
export function nowCheckedLine(sources: CheckedSource[], now: number): string | null {
  const s = checkedSummary(sources)
  const within = withinText(s.oldest, now)
  if (!within) return null
  const failed = s.failing.length ? ` · ${s.failing.join(', ')}: last refresh failed` : ''
  return `Everything on Now checked ${within}${failed}`
}
