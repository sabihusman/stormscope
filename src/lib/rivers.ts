import type { RiverGauge } from '../types'

/** A NOAA gauge counts as reporting when its newest reading is under this old and it is in service. */
export const GAUGE_REPORTING_MAX_AGE_MS = 24 * 3_600_000

/**
 * The NOAA forecast points that are actually reporting: a reading within 24 h and not out of service or
 * "obs not current". The Now tile and the More row count these; the Rivers page still lists every gauge.
 */
export function reportingNoaa(gauges: RiverGauge[] | null | undefined, now = Date.now()): RiverGauge[] {
  if (!gauges) return []
  return gauges.filter((g) => {
    if (!g.lid) return false
    if (g.floodCategory === 'out_of_service' || g.floodCategory === 'obs_not_current') return false
    const t = Math.max(g.stage?.time ?? 0, g.flow?.time ?? 0)
    return t > 0 && now - t <= GAUGE_REPORTING_MAX_AGE_MS
  })
}
