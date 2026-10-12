import { isFresh, type MonitorParameter, type MonitorReading, type MonitorSite } from '../api/airnow'
import { haversine, type LngLat } from './geo'

/** A point counts as measured for a pollutant only within this distance of a monitor measuring it. */
export const MEASURED_WITHIN_M = 25_000

export interface Measured {
  site: MonitorSite
  reading: MonitorReading
  /** Distance from the place to the monitor, metres. */
  distanceM: number
}

/**
 * The nearest monitor to `at` with a reading of `pollutant` under two hours old and within 25 km, or null:
 * then the place has no measurement for that pollutant (no estimate is ever substituted).
 */
export function nearestMeasured(sites: MonitorSite[], pollutant: MonitorParameter, at: LngLat, now = Date.now()): Measured | null {
  let best: Measured | null = null
  for (const site of sites) {
    const reading = site.readings.find((r) => r.parameter === pollutant && r.aqi != null && isFresh(r, now))
    if (!reading) continue
    const distanceM = haversine(at, site.lngLat)
    if (distanceM > MEASURED_WITHIN_M) continue
    if (!best || distanceM < best.distanceM) best = { site, reading, distanceM }
  }
  return best
}

/** Monitors with a fresh reading of the pollutant (the circles layer draws one 25 km disc per entry). */
export function freshMonitors(sites: MonitorSite[], pollutant: MonitorParameter, now = Date.now()): { site: MonitorSite; reading: MonitorReading }[] {
  const out: { site: MonitorSite; reading: MonitorReading }[] = []
  for (const site of sites) {
    const reading = site.readings.find((r) => r.parameter === pollutant && r.aqi != null && isFresh(r, now))
    if (reading) out.push({ site, reading })
  }
  return out
}
