/**
 * Road-ice reasoning. A pavement sensor can *confirm* ice only close to the
 * route and close to the time you'll be there:
 *   - station within STATION_RADIUS_M of the route sample, and
 *   - observation within OBS_WINDOW_MS of the sample's ETA, and
 *   - (live) the observation is not stale (older than STALE_MS).
 * Outside that, the forecast can only say "possible ice", and a station with
 * no readings is "unknown" — never "no ice".
 */
import { haversine } from './geo'
import type { JourneySample, Condition } from './journey'
import { worstSensor, type PavementState, type RwisStation } from '../api/rwis'

export const STATION_RADIUS_M = 5000
export const OBS_WINDOW_MS = 90 * 60_000
export const STALE_MS = 60 * 60_000

/** icy-confirmed: Warning/Frost/ice status in window · ice-watch: Ice/Snow Watch in window (possible only). */
export type RoadStatus = 'icy-confirmed' | 'ice-watch' | 'no-ice-observed' | 'unknown'
const STATUS_RANK: Record<RoadStatus, number> = { 'icy-confirmed': 3, 'ice-watch': 2, 'no-ice-observed': 1, unknown: 0 }
export interface RoadSample {
  idx: number
  status: RoadStatus
  station?: { id: string; name: string; distM: number; obsTime: number; pavementF: number | null; condition: string | null; state: PavementState }
}
export interface StationChip {
  id: string
  name: string
  lngLat: { lng: number; lat: number }
  distToRouteM: number
  /** Latest observation (live) or the one nearest the time you'd pass (replay). */
  obsTime: number | null
  ageMin: number | null
  stale: boolean
  pavementF: number | null
  condition: string | null
  state: PavementState
  /** Whether this station could confirm ice for at least one sample. */
  confirmsIce: boolean
  /** Whether this station reported an Ice/Snow Watch at an ETA on this trip (possible ice, not confirmed). */
  watchOnTrip: boolean
}
export interface RoadReport {
  samples: RoadSample[]
  stations: StationChip[]
  evaluatedAt: number
  now: number
  mode: 'live' | 'replay'
}

function pickObs(st: RwisStation, eta: number, mode: 'live' | 'replay') {
  if (!st.obs.length) return null
  if (mode === 'live') return st.obs[st.obs.length - 1]
  let best = st.obs[0]
  for (const o of st.obs) if (Math.abs(o.time - eta) < Math.abs(best.time - eta)) best = o
  return best
}

export function evaluateRoadIce(samples: JourneySample[], stations: RwisStation[], opts: { now: number; mode: 'live' | 'replay' }): RoadReport {
  const { now, mode } = opts
  const out: RoadSample[] = []
  const chips = new Map<string, StationChip>()

  // Stations near any sample (candidate set).
  const near = stations
    .map((st) => ({ st, dist: Math.min(...samples.map((s) => haversine(s.lngLat, st.lngLat))) }))
    .filter((x) => x.dist <= STATION_RADIUS_M)

  for (let k = 0; k < samples.length; k++) {
    const s = samples[k]
    let best: RoadSample = { idx: s.idx, status: 'unknown' }
    for (const { st } of near) {
      const d = haversine(s.lngLat, st.lngLat)
      if (d > STATION_RADIUS_M) continue
      const o = pickObs(st, s.eta, mode)
      if (!o) continue
      const inWindow = Math.abs(o.time - s.eta) <= OBS_WINDOW_MS
      const stale = mode === 'live' && now - o.time > STALE_MS
      const w = worstSensor(o)
      const info = { id: st.id, name: st.name, distM: Math.round(d), obsTime: o.time, pavementF: w.tempF, condition: w.condition, state: w.state }
      if (inWindow && !stale) {
        const status: RoadStatus = w.state === 'ice' ? 'icy-confirmed' : w.state === 'watch' ? 'ice-watch' : w.state === 'wet' || w.state === 'dry' ? 'no-ice-observed' : 'unknown'
        if (STATUS_RANK[status] > STATUS_RANK[best.status]) best = { idx: s.idx, status, station: info }
        if (status === 'icy-confirmed') break
      }
    }
    out.push(best)
  }

  // Chips: one per nearby station, with the obs the user would care about.
  const refEta = (st: RwisStation) => {
    let bestS = samples[0]
    let bestD = Infinity
    for (const s of samples) {
      const d = haversine(s.lngLat, st.lngLat)
      if (d < bestD) {
        bestD = d
        bestS = s
      }
    }
    return { eta: bestS.eta, dist: bestD }
  }
  for (const { st } of near) {
    const { eta, dist } = refEta(st)
    const o = pickObs(st, eta, mode)
    const w = o ? worstSensor(o) : { state: 'unknown' as PavementState, tempF: null, condition: null }
    const ageMin = o ? Math.round((now - o.time) / 60_000) : null
    const stale = !o || (mode === 'live' ? now - o.time > STALE_MS : Math.abs(o.time - eta) > OBS_WINDOW_MS)
    chips.set(st.id, {
      id: st.id,
      name: st.name,
      lngLat: st.lngLat,
      distToRouteM: Math.round(dist),
      obsTime: o?.time ?? null,
      ageMin,
      stale,
      pavementF: w.tempF,
      condition: w.condition,
      state: o ? w.state : 'unknown',
      confirmsIce: out.some((r) => r.status === 'icy-confirmed' && r.station?.id === st.id),
      watchOnTrip: out.some((r) => r.status === 'ice-watch' && r.station?.id === st.id),
    })
  }
  return { samples: out, stations: [...chips.values()].sort((a, b) => a.distToRouteM - b.distToRouteM), evaluatedAt: Date.now(), now, mode }
}

/** Forecast condition merged with the road report for display/colouring. */
/** Sensor condition text for display: feed placeholders ("NA", "N/A", blank) become "no reading". */
export function condText(c: string | null | undefined): string {
  return c && !/^\s*(n\/?a|null|none|-+)?\s*$/i.test(c) ? c : 'no reading'
}

export function effectiveCondition(sample: JourneySample, road?: RoadSample, units: 'metric' | 'imperial' = 'imperial'): Condition {
  const c = sample.condition
  const stn = road?.station ? road.station.name.replace(/\s*\(.*\)$/, '') : ''
  const f = road?.station?.pavementF
  const pav = f != null ? `, pavement ${units === 'imperial' ? `${Math.round(f)} °F` : `${Math.round(((f - 32) * 5) / 9)} °C`}` : ''
  if (road?.status === 'icy-confirmed' && road.station) {
    return { code: 'ice', label: `Icy — RWIS confirmed (${stn}${pav})`, severity: 3 }
  }
  // An Ice/Snow Watch is moisture at or below freezing, not a frozen film: "possible ice" whatever the forecast says.
  if (road?.status === 'ice-watch' && road.station) {
    return { code: 'ice', label: `Possible ice — ${stn} reports ${condText(road.station.condition ?? 'Ice Watch')}${pav}`, severity: 3 }
  }
  if (c.code === 'ice') {
    if (road?.status === 'no-ice-observed' && road.station) return { code: 'ice', label: `Possible ice (forecast) — ${road.station.name.replace(/\s*\(.*\)$/, '')} reports ${condText(road.station.condition ?? 'no ice')}`, severity: 3 }
    return { code: 'ice', label: 'Possible ice (forecast)', severity: 3 }
  }
  return c
}
