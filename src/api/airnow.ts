import type { LngLat } from '../lib/geo'

/**
 * EPA AirNow monitoring sites, served by StormScope's own monitor service — the Vercel function `api/sites.js`
 * in this project (it holds the AirNow API key in AIRNOW_API_KEY, fetches the bounding-box site observations,
 * caches them within AirNow's limits and serves this JSON). The service URL defaults to the same origin
 * (`/api`); `VITE_MONITOR_SERVICE` at build time or `localStorage stormscope.monitorService` at run time
 * (the mocked suites) point elsewhere. The bbox is snapped outward to a 0.25° grid so nearby views share one
 * cached answer. When the function has no key it answers 503 "Monitor service not configured…", shown as is.
 *
 * AirNow Data Exchange Guidelines (EPA, August 2025): the data are preliminary and not fully verified; credit
 * the reporting agencies and the EPA AirNow program; disseminate values unaltered with the EPA AQI colours;
 * displays must say the data are preliminary. The UI carries that wording.
 */
export const AIRNOW_CREDIT = 'EPA AirNow and the reporting air quality agencies · preliminary data'

export type MonitorParameter = 'PM2.5' | 'OZONE' | 'PM10' | 'NO2' | 'SO2' | 'CO'

export interface MonitorReading {
  parameter: MonitorParameter
  /** Raw concentration as reported, with its unit. */
  value: number | null
  unit: string
  /** AirNow's AQI for the reading (NowCast for PM / 8 h for ozone, as the API reports it). */
  aqi: number | null
  /** The reading's time, ms epoch: AirNow's hour label, which is the end of the observation hour (ages count from it). */
  time: number
}

export interface MonitorSite {
  id: string
  name: string
  agency: string
  lngLat: LngLat
  /** The parameters this site measures (from AirNow's site list), whether or not a reading is in hand. */
  parameters: MonitorParameter[]
  readings: MonitorReading[]
}

export interface MonitorSitesResponse {
  fetchedAt: number
  sites: MonitorSite[]
}

/** The function's own message when AIRNOW_API_KEY is missing (shown on the Now card as is, never as "No monitor"). */
export const MONITOR_SERVICE_NOT_CONFIGURED = 'Monitor service not configured'
export const isServiceNotConfigured = (err: string | null | undefined) => !!err && err.startsWith(MONITOR_SERVICE_NOT_CONFIGURED)

export function monitorServiceUrl(): string {
  try {
    const rt = localStorage.getItem('stormscope.monitorService')
    if (rt) return rt.replace(/\/$/, '')
  } catch {
    /* ignore */
  }
  const env = (import.meta.env.VITE_MONITOR_SERVICE as string | undefined) ?? ''
  return (env || '/api').replace(/\/$/, '')
}

/** Snap a bbox outward to a 0.25° grid (the function does the same): nearby views share one cached answer. */
export function snapBbox(b: { west: number; south: number; east: number; north: number }, step = 0.25) {
  const f = (v: number) => Math.floor(v / step) * step
  const c = (v: number) => Math.ceil(v / step) * step
  return { west: Math.max(-180, f(b.west)), south: Math.max(-90, f(b.south)), east: Math.min(180, c(b.east)), north: Math.min(90, c(b.north)) }
}

/** Sites with their latest readings inside a bounding box. A 503 from the function carries its own message. */
export async function fetchMonitorSites(bbox: { west: number; south: number; east: number; north: number }, signal?: AbortSignal): Promise<MonitorSitesResponse> {
  const b = snapBbox(bbox)
  const url = `${monitorServiceUrl()}/sites?bbox=${b.west.toFixed(2)},${b.south.toFixed(2)},${b.east.toFixed(2)},${b.north.toFixed(2)}`
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } })
  let j: Partial<MonitorSitesResponse> & { error?: string } = {}
  try {
    j = (await res.json()) as typeof j
  } catch {
    j = {}
  }
  if (!res.ok) throw new Error(j.error ?? `Monitor service answered ${res.status}`)
  return { fetchedAt: j.fetchedAt ?? Date.now(), sites: (j.sites ?? []).map((s) => ({ ...s, readings: s.readings ?? [], parameters: s.parameters ?? [] })) }
}

/** A reading counts while it is under two hours old, measured from the end of its observation hour. */
export const FRESH_MS = 2 * 3_600_000
export const isFresh = (r: MonitorReading, now = Date.now()) => now - r.time < FRESH_MS
