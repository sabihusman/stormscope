import { fetchJSON } from '../lib/fetch'
import type { LngLat } from '../lib/geo'
import { POLLUTANTS } from '../lib/aqi'
import { budgeted } from './openMeteo'

/**
 * Open-Meteo Air Quality API (CAMS global forecast for North America: 0.4° ≈ 45 km grid; CAMS Europe 0.1°).
 * Variables (confirmed against the current docs, 2026-10-11): `us_aqi` and the per-pollutant US AQI values
 * `us_aqi_pm2_5`, `us_aqi_pm10`, `us_aqi_ozone`, `us_aqi_nitrogen_dioxide`, `us_aqi_sulphur_dioxide`,
 * `us_aqi_carbon_monoxide`, all available as `current=`. Every location counts one call against the shared
 * Open-Meteo quota (the same 10 000 / day), so the map samples at the model's own ~0.4° spacing and never
 * more than 64 locations per request.
 */
export const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality'
const VARS = ['us_aqi', ...POLLUTANTS.map((p) => `us_aqi_${p.key}`)]

export interface AirQualityPoint {
  lngLat: LngLat
  /** Model time of the current value (ms epoch). */
  time: number
  aqi: number | null
  /** Per-pollutant US AQI values keyed as Open-Meteo names them. */
  byPollutant: Partial<Record<(typeof POLLUTANTS)[number]['key'], number | null>>
  /** The pollutant with the highest index (the one the overall AQI reports), when known. */
  dominant: (typeof POLLUTANTS)[number]['key'] | null
}

interface OmAqResponse {
  latitude: number
  longitude: number
  current: Record<string, number | null> & { time: number }
}

function toPoint(r: OmAqResponse): AirQualityPoint {
  const by: AirQualityPoint['byPollutant'] = {}
  let dominant: AirQualityPoint['dominant'] = null
  let best = -1
  for (const p of POLLUTANTS) {
    const v = r.current[`us_aqi_${p.key}`] ?? null
    by[p.key] = v
    if (v != null && v > best) {
      best = v
      dominant = p.key
    }
  }
  return { lngLat: { lng: r.longitude, lat: r.latitude }, time: r.current.time * 1000, aqi: r.current.us_aqi ?? null, byPollutant: by, dominant }
}

/** Current modeled AQI at one point (the Now tile). One location. */
export async function fetchAirQualityPoint(p: LngLat, signal?: AbortSignal): Promise<AirQualityPoint> {
  const url = `${AIR_QUALITY_URL}?latitude=${p.lat.toFixed(3)}&longitude=${p.lng.toFixed(3)}&current=${VARS.join(',')}&timeformat=unixtime&timezone=GMT`
  const j = await budgeted(1, () => fetchJSON<OmAqResponse>(url, { signal, timeoutMs: 20_000 }))
  return toPoint(j)
}

/** Current modeled AQI at up to 64 points in one request (the map overlay). N locations = N calls of quota. */
export async function fetchAirQualityGrid(points: LngLat[], signal?: AbortSignal): Promise<AirQualityPoint[]> {
  if (!points.length) return []
  if (points.length > 64) throw new Error(`air-quality grid: ${points.length} points, the cap is 64`)
  const url = `${AIR_QUALITY_URL}?latitude=${points.map((p) => p.lat.toFixed(3)).join(',')}&longitude=${points.map((p) => p.lng.toFixed(3)).join(',')}&current=${VARS.join(',')}&timeformat=unixtime&timezone=GMT`
  const j = await budgeted(points.length, () => fetchJSON<OmAqResponse | OmAqResponse[]>(url, { signal, timeoutMs: 25_000 }))
  return (Array.isArray(j) ? j : [j]).map(toPoint)
}
