import { inBBox, type LngLat } from './geo'
import type { Block } from '../state/store'

export interface PointSample {
  /** Nearest forecast grid point (block key + index). */
  blockKey: string
  /** mm/h now, cloud %, wind m/s + direction at the current hour. */
  precipNowMm: number
  cloudPct: number
  windMs: number
  windDirDeg: number
  /** mm over the next 24 h. */
  rain24Mm: number
  /** Hourly precipitation (mm) for the next 24 h. */
  hourly: { time: number; precipMm: number; cloudPct: number }[]
  fetchedAt: number
}

/**
 * Conditions at an arbitrary map point from the forecast blocks already in memory (no request):
 * the nearest grid point of the block that contains it, read at the current hour.
 */
export function sampleBlocks(blocks: Block[], p: LngLat, now = Date.now()): PointSample | null {
  const b = blocks.find((x) => x.grid.data && inBBox(p, x.bbox)) ?? blocks.find((x) => x.grid.data)
  const g = b?.grid.data
  if (!b || !g) return null
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < g.spec.points.length; i++) {
    const q = g.spec.points[i]
    const d = (q.lng - p.lng) ** 2 + (q.lat - p.lat) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  let h = g.times.findIndex((t) => t > now) - 1
  if (h < 0) h = 0
  const end = Math.min(g.times.length, h + 24)
  let rain24 = 0
  const hourly = []
  for (let k = h; k < end; k++) {
    const mm = g.precipitation[best][k] ?? 0
    rain24 += mm
    hourly.push({ time: g.times[k], precipMm: mm, cloudPct: g.cloudCover[best][k] ?? 0 })
  }
  return {
    blockKey: b.key,
    precipNowMm: g.precipitation[best][h] ?? 0,
    cloudPct: g.cloudCover[best][h] ?? 0,
    windMs: g.windSpeed[best][h] ?? 0,
    windDirDeg: g.windDir[best][h] ?? 0,
    rain24Mm: rain24,
    hourly,
    fetchedAt: b.grid.freshness?.fetchedAt ?? now,
  }
}

/** "2.1 mi NE of Johnston" style relation of a point to the place. */
export function bearingLabel(from: LngLat, to: LngLat): string {
  const dLng = (to.lng - from.lng) * Math.cos(((from.lat + to.lat) / 2) * (Math.PI / 180))
  const dLat = to.lat - from.lat
  const deg = ((Math.atan2(dLng, dLat) * 180) / Math.PI + 360) % 360
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return dirs[Math.round(deg / 45) % 8]
}
