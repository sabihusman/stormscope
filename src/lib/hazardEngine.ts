/**
 * Hazard engine: intersects route samples (with ETAs) against hazard polygons
 * in space AND time. A hazard only counts when a sample is inside (or within
 * `bufferM` of) the polygon *and* its ETA falls inside the polygon's own
 * validity window. Spatial overlap alone is reported separately ("nearby, not
 * at your ETA") so the time-window logic is visible both ways.
 */
import { distancePointToPolyline, type LngLat } from './geo'
import type { JourneySample } from './journey'

export type HazardTier = 'warning' | 'watch' | 'advisory' | 'outlook' | 'statement'

export interface Hazard {
  id: string
  tier: HazardTier
  /** e.g. "Tornado Warning", "Tornado Watch 277 (PDS)", "SPC Day 1 Moderate risk" */
  event: string
  headline?: string
  /** NWS severity or derived: Extreme / Severe / Moderate / Minor / Unknown */
  severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown'
  /** Validity window of the geometry (ms). */
  validFrom: number
  validTo: number
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null
  /** Unresolved zone ids when geometry is null (county/zone-based products). */
  zones?: string[]
  source: string
  url?: string
  /** Free-form tags (tornado OBSERVED, PDS, hail size…). */
  tags?: string[]
}

export interface HazardHit {
  hazard: Hazard
  /** Sample indices (into samples[]) inside the polygon at their ETA. */
  samples: number[]
  firstEta: number
  lastEta: number
  firstDistM: number
  lastDistM: number
}
export interface HazardNearby {
  hazard: Hazard
  /** Why it did not count: expired before / starts after / not yet valid at the ETAs it overlaps. */
  reason: 'expired-before-eta' | 'starts-after-eta'
  samples: number[]
}
export type SourceStatus = { state: 'ok'; count: number; fetchedAt: number; note?: string } | { state: 'unavailable'; reason: string } | { state: 'not-applicable'; reason: string }
export interface HazardReport {
  hits: HazardHit[]
  nearby: HazardNearby[]
  /** Hazards that could not be placed (no geometry). */
  unresolved: Hazard[]
  sources: Record<'warnings' | 'watches' | 'outlooks', SourceStatus>
  evaluatedAt: number
  /** The "now" the evaluation assumed (replays use the fixture's departure). */
  now: number
}

function pip(pt: [number, number], ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function polys(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): [number, number][][][] {
  return (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as [number, number][][][]
}
/** Inside the polygon, or within bufferM of its outer boundary. */
export function nearPolygon(p: LngLat, g: GeoJSON.Polygon | GeoJSON.MultiPolygon, bufferM: number): boolean {
  const pt: [number, number] = [p.lng, p.lat]
  for (const poly of polys(g)) {
    if (pip(pt, poly[0]) && !poly.slice(1).some((h) => pip(pt, h))) return true
    if (bufferM > 0 && distancePointToPolyline(p, poly[0]) <= bufferM) return true
  }
  return false
}

export function evaluateHazards(
  samples: JourneySample[],
  hazards: Hazard[],
  sources: HazardReport['sources'],
  opts: { bufferM?: number; now?: number } = {},
): HazardReport {
  const bufferM = opts.bufferM ?? 5000
  const now = opts.now ?? Date.now()
  const hits: HazardHit[] = []
  const nearby: HazardNearby[] = []
  const unresolved: Hazard[] = []
  for (const h of hazards) {
    if (!h.geometry) {
      unresolved.push(h)
      continue
    }
    const inSpace: number[] = []
    const inBoth: number[] = []
    for (let k = 0; k < samples.length; k++) {
      const s = samples[k]
      if (!nearPolygon(s.lngLat, h.geometry, bufferM)) continue
      inSpace.push(k)
      if (s.eta >= h.validFrom && s.eta <= h.validTo) inBoth.push(k)
    }
    if (inBoth.length) {
      hits.push({
        hazard: h,
        samples: inBoth,
        firstEta: samples[inBoth[0]].eta,
        lastEta: samples[inBoth[inBoth.length - 1]].eta,
        firstDistM: samples[inBoth[0]].distM,
        lastDistM: samples[inBoth[inBoth.length - 1]].distM,
      })
    } else if (inSpace.length) {
      const etas = inSpace.map((k) => samples[k].eta)
      const reason: HazardNearby['reason'] = h.validTo < Math.min(...etas) ? 'expired-before-eta' : 'starts-after-eta'
      nearby.push({ hazard: h, reason, samples: inSpace })
    }
  }
  const rank: Record<HazardTier, number> = { warning: 0, watch: 1, advisory: 2, statement: 3, outlook: 4 }
  hits.sort((a, b) => rank[a.hazard.tier] - rank[b.hazard.tier] || a.firstEta - b.firstEta)
  return { hits, nearby, unresolved, sources, evaluatedAt: Date.now(), now }
}

/** Human summary that never claims a clear route. */
export function summarize(r: HazardReport): { headline: string; tone: 'severe' | 'caution' | 'info' | 'unknown' } {
  const anyUnavailable = Object.values(r.sources).some((s) => s.state === 'unavailable')
  const warn = r.hits.filter((h) => h.hazard.tier === 'warning')
  const watch = r.hits.filter((h) => h.hazard.tier === 'watch')
  const outlook = r.hits.filter((h) => h.hazard.tier === 'outlook')
  if (warn.length) return { headline: `${warn.length} warning${warn.length > 1 ? 's' : ''} in effect where you'll be — ${warn.map((h) => h.hazard.event).join(', ')}`, tone: 'severe' }
  if (watch.length) return { headline: `No warnings at your ETAs, but ${watch.map((h) => h.hazard.event).join(', ')} covers the route`, tone: 'caution' }
  if (anyUnavailable) return { headline: 'Some hazard sources are unavailable — this is not an all-clear', tone: 'unknown' }
  if (outlook.length) return { headline: `No warnings or watches at your ETAs; SPC outlook: ${outlook.map((h) => h.hazard.event).join(', ')}`, tone: 'caution' }
  if (r.sources.warnings.state === 'not-applicable') return { headline: 'Official hazard alerts are only checked inside the US', tone: 'unknown' }
  return { headline: 'No warnings, watches or SPC outlook risk at your ETAs right now — conditions can change; re-check before leaving', tone: 'info' }
}
