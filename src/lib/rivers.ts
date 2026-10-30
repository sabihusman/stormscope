import type { RiverGauge } from '../types'

/** A NOAA gauge counts as reporting when its newest reading is under this old and it is in service. */
export const GAUGE_REPORTING_MAX_AGE_MS = 24 * 3_600_000

/**
 * The NOAA forecast points that are actually reporting: a reading within 24 h and not out of service or
 * "obs not current". The Now tile and the More row count these; the Rivers page still lists every gauge.
 */
export function reportingNoaa(gauges: RiverGauge[] | null | undefined, now = Date.now()): RiverGauge[] {
  return (gauges ?? []).filter((g) => !!g.lid && isCurrent(g, now))
}

/** A gauge with a reading within 24 h that is in service (either source). */
export function isCurrent(g: RiverGauge, now = Date.now()): boolean {
  if (g.floodCategory === 'out_of_service' || g.floodCategory === 'obs_not_current') return false
  const t = Math.max(g.stage?.time ?? 0, g.flow?.time ?? 0)
  return t > 0 && now - t <= GAUGE_REPORTING_MAX_AGE_MS
}

/** The Rivers page's two sections: current gauges, then the stale (over 24 h) and out-of-service ones. */
export function splitGauges(gauges: RiverGauge[] | null | undefined, now = Date.now()): { current: RiverGauge[]; stale: RiverGauge[] } {
  const current: RiverGauge[] = []
  const stale: RiverGauge[] = []
  for (const g of gauges ?? []) (isCurrent(g, now) ? current : stale).push(g)
  return { current, stale }
}

/** USGS-only gauges that are current (the Rivers page has them; the Now tile notes how many). */
export const currentUsgsOnly = (gauges: RiverGauge[] | null | undefined, now = Date.now()) => (gauges ?? []).filter((g) => !g.lid && isCurrent(g, now))
