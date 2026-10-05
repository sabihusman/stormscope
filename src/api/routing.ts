import { fetchJSON } from '../lib/fetch'
import { haversine, type LngLat } from '../lib/geo'
import { decodePolyline } from '../lib/polyline'

/**
 * Routing: Valhalla (FOSSGIS demo) primary — reliable alternates, avoid options;
 * OSRM demo as fallback. Both are keyless, fair-use, non-commercial, ≤ 1 req/s.
 */
export const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route'
export const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving'

export interface RouteResult {
  engine: 'valhalla' | 'osrm'
  /** [lng, lat] vertices. */
  coords: [number, number][]
  /** Cumulative geodesic distance to each vertex (m). */
  cumM: number[]
  /** Seconds from departure to each vertex (constant speed inside each maneuver/segment). */
  offsetS: number[]
  distanceM: number
  durationS: number
  summary: string
}

function cumulative(coords: [number, number][]): number[] {
  const cum = [0]
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine({ lng: coords[i - 1][0], lat: coords[i - 1][1] }, { lng: coords[i][0], lat: coords[i][1] }))
  return cum
}

interface ValhallaManeuver {
  time: number
  length: number
  begin_shape_index: number
  end_shape_index: number
  instruction: string
}
interface ValhallaTrip {
  trip: { legs: { shape: string; maneuvers: ValhallaManeuver[]; summary: { length: number; time: number } }[]; summary: { length: number; time: number } }
  alternates?: { trip: ValhallaTrip['trip'] }[]
}

function fromValhalla(trip: ValhallaTrip['trip'], engine: 'valhalla'): RouteResult {
  // One leg (A→B); multi-leg journeys are handled as separate routes per day.
  const leg = trip.legs[0]
  const coords = decodePolyline(leg.shape, 6)
  const cumM = cumulative(coords)
  const offsetS = new Array<number>(coords.length).fill(0)
  let t = 0
  // ETA at a vertex = time of preceding maneuvers + this maneuver's time × distance fraction.
  // Constant speed within a maneuver: ±2–3 min on a rural-interstate maneuver, up to ±5–8 min
  // when one maneuver mixes town and open road (see BUILD_LOG).
  for (const m of leg.maneuvers) {
    const d0 = cumM[m.begin_shape_index]
    const d1 = cumM[m.end_shape_index]
    for (let i = m.begin_shape_index; i <= m.end_shape_index; i++) offsetS[i] = t + m.time * (d1 > d0 ? (cumM[i] - d0) / (d1 - d0) : 0)
    t += m.time
  }
  const major = leg.maneuvers.filter((m) => m.length > 20).map((m) => m.instruction.replace(/^(Keep (left|right) to stay on|Continue on|Take the|Merge onto)\s*/i, '').replace(/\.$/, ''))
  return {
    engine,
    coords,
    cumM,
    offsetS,
    distanceM: trip.summary.length * 1000,
    durationS: trip.summary.time,
    summary: [...new Set(major)].slice(0, 3).join(' · ') || 'Local roads',
  }
}

export async function routeValhalla(from: LngLat, to: LngLat, alternates = 2, signal?: AbortSignal): Promise<RouteResult[]> {
  const body = { locations: [{ lat: from.lat, lon: from.lng }, { lat: to.lat, lon: to.lng }], costing: 'auto', alternates, units: 'kilometers' }
  const j = await fetchJSON<ValhallaTrip>(`${VALHALLA_URL}?json=${encodeURIComponent(JSON.stringify(body))}`, { signal, timeoutMs: 30_000 })
  const out = [fromValhalla(j.trip, 'valhalla')]
  for (const a of j.alternates ?? []) out.push(fromValhalla(a.trip, 'valhalla'))
  return out
}

interface OsrmRoute {
  code: string
  routes: { distance: number; duration: number; geometry: { coordinates: [number, number][] }; legs: { annotation: { duration: number[] } }[] }[]
}

export async function routeOsrm(from: LngLat, to: LngLat, signal?: AbortSignal): Promise<RouteResult[]> {
  const url = `${OSRM_URL}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&annotations=duration&alternatives=true`
  const j = await fetchJSON<OsrmRoute>(url, { signal, timeoutMs: 30_000 })
  if (j.code !== 'Ok') throw new Error(`OSRM: ${j.code}`)
  return j.routes.map((r) => {
    const coords = r.geometry.coordinates
    const cumM = cumulative(coords)
    // OSRM gives per-segment durations, so ETAs are exact per vertex.
    const seg = r.legs[0].annotation.duration
    const offsetS = [0]
    for (let i = 0; i < seg.length; i++) offsetS.push(offsetS[i] + seg[i])
    while (offsetS.length < coords.length) offsetS.push(offsetS[offsetS.length - 1])
    return { engine: 'osrm' as const, coords, cumM, offsetS, distanceM: r.distance, durationS: r.duration, summary: 'OSRM fastest route' }
  })
}

/** Valhalla first, OSRM if it fails. Never more than one request per second per engine. */
let lastCall = 0
export async function route(from: LngLat, to: LngLat, signal?: AbortSignal): Promise<{ routes: RouteResult[]; engine: 'valhalla' | 'osrm'; fallbackReason?: string }> {
  const wait = 1100 - (Date.now() - lastCall)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastCall = Date.now()
  try {
    const routes = await routeValhalla(from, to, 2, signal)
    return { routes, engine: 'valhalla' }
  } catch (e) {
    const routes = await routeOsrm(from, to, signal)
    return { routes, engine: 'osrm', fallbackReason: e instanceof Error ? e.message : String(e) }
  }
}
