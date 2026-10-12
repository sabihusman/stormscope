import { fetchJSON } from '../lib/fetch'
import type { LngLat } from '../lib/geo'

/**
 * EPA AirNow monitoring sites, served by StormScope's own small monitor service (phase 2: the service holds
 * the AirNow API key, fetches the bounding-box site observations, caches them within AirNow's limits and
 * serves this JSON). The service URL is set at build time (`VITE_MONITOR_SERVICE`) or at run time
 * (`localStorage stormscope.monitorService`, used by the mocked suites); with neither, the layer reports
 * that the service is not set up yet and makes no request.
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
  /** End of the observation hour, ms epoch (AirNow timestamps are the start of the hour; the reading covers that hour). */
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

export const MONITOR_SERVICE_NOT_SET = 'Monitor service not set up yet (AirNow sites need the keyed service)'

export function monitorServiceUrl(): string {
  try {
    const rt = localStorage.getItem('stormscope.monitorService')
    if (rt) return rt.replace(/\/$/, '')
  } catch {
    /* ignore */
  }
  const env = (import.meta.env.VITE_MONITOR_SERVICE as string | undefined) ?? ''
  return env.replace(/\/$/, '')
}

/** Sites with their latest readings inside a bounding box. Throws MONITOR_SERVICE_NOT_SET when no service is configured. */
export async function fetchMonitorSites(bbox: { west: number; south: number; east: number; north: number }, signal?: AbortSignal): Promise<MonitorSitesResponse> {
  const base = monitorServiceUrl()
  if (!base) throw new Error(MONITOR_SERVICE_NOT_SET)
  const url = `${base}/sites?bbox=${bbox.west.toFixed(2)},${bbox.south.toFixed(2)},${bbox.east.toFixed(2)},${bbox.north.toFixed(2)}`
  const j = await fetchJSON<MonitorSitesResponse>(url, { signal, timeoutMs: 20_000 })
  return { fetchedAt: j.fetchedAt ?? Date.now(), sites: (j.sites ?? []).map((s) => ({ ...s, readings: s.readings ?? [], parameters: s.parameters ?? [] })) }
}

/** A reading counts while it is under two hours old, measured from the end of its observation hour. */
export const FRESH_MS = 2 * 3_600_000
export const isFresh = (r: MonitorReading, now = Date.now()) => now - r.time < FRESH_MS
