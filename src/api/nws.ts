import { fetchJSON, HttpError } from '../lib/fetch'
import { haversine, type LngLat } from '../lib/geo'
import type { StationObs } from '../types'

/** NOAA / National Weather Service API. Docs: https://www.weather.gov/documentation/services-web-api */
export const NWS_URL = 'https://api.weather.gov'

// api.weather.gov asks clients to identify themselves. Browsers cannot set User-Agent,
// but the API honours a custom header for the same purpose in CORS contexts.
const headers = { Accept: 'application/geo+json' }

interface PointsResponse {
  properties: { observationStations: string; gridId: string; gridX: number; gridY: number }
}
interface StationsResponse {
  features: { properties: { stationIdentifier: string; name: string }; geometry: { coordinates: [number, number] } }[]
}
interface QV {
  value: number | null
  unitCode: string
}
interface ObsResponse {
  geometry: { coordinates: [number, number] } | null
  properties: {
    timestamp: string
    textDescription: string
    temperature: QV
    windDirection: QV
    windSpeed: QV
    windGust: QV
    barometricPressure: QV
    seaLevelPressure: QV
    relativeHumidity: QV
    precipitationLastHour: QV
    precipitationLast3Hours: QV
    precipitationLast6Hours: QV
  }
}

export class OutsideNwsCoverage extends Error {
  constructor() {
    super('Outside api.weather.gov coverage')
    this.name = 'OutsideNwsCoverage'
  }
}

const pointsCache = new Map<string, string>()

/**
 * Nearest station with a recent observation. api.weather.gov returns 404 for
 * points outside the US, which we surface as OutsideNwsCoverage so the caller
 * can fall back to Open-Meteo.
 */
export async function fetchNwsNearestObservation(p: LngLat, signal?: AbortSignal): Promise<StationObs> {
  const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`
  let stationsUrl = pointsCache.get(key)
  if (!stationsUrl) {
    try {
      const pts = await fetchJSON<PointsResponse>(`${NWS_URL}/points/${p.lat.toFixed(4)},${p.lng.toFixed(4)}`, {
        headers,
        signal,
      })
      stationsUrl = pts.properties.observationStations
      pointsCache.set(key, stationsUrl)
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 400)) throw new OutsideNwsCoverage()
      throw e
    }
  }
  const st = await fetchJSON<StationsResponse>(`${stationsUrl}?limit=6`, { headers, signal })
  if (!st.features.length) throw new OutsideNwsCoverage()

  // Stations are ordered by distance; try them in order until one has a fresh obs.
  let lastErr: unknown = null
  for (const f of st.features.slice(0, 4)) {
    const id = f.properties.stationIdentifier
    try {
      const obs = await fetchJSON<ObsResponse>(`${NWS_URL}/stations/${id}/observations/latest`, { headers, signal })
      const pr = obs.properties
      const ts = Date.parse(pr.timestamp)
      if (!Number.isFinite(ts) || Date.now() - ts > 6 * 3600_000) continue // skip dead stations
      const lngLat = { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }
      const kmh = (q: QV) => (q?.value == null ? null : q.unitCode.includes('km_h') ? q.value / 3.6 : q.value)
      const hpa = (q: QV) => (q?.value == null ? null : q.unitCode.includes('Pa') && !q.unitCode.includes('hPa') ? q.value / 100 : q.value)
      const mm = (q: QV) => (q?.value == null ? null : q.value)
      return {
        stationId: id,
        name: f.properties.name,
        lngLat,
        distanceM: haversine(p, lngLat),
        observedAt: ts,
        pressureHpa: hpa(pr.seaLevelPressure) ?? hpa(pr.barometricPressure),
        humidityPct: pr.relativeHumidity?.value ?? null,
        windSpeedMs: kmh(pr.windSpeed),
        windGustMs: kmh(pr.windGust),
        windDirDeg: pr.windDirection?.value ?? null,
        tempC: pr.temperature?.value ?? null,
        precip: {
          lastHourMm: mm(pr.precipitationLastHour),
          last3hMm: mm(pr.precipitationLast3Hours),
          last6hMm: mm(pr.precipitationLast6Hours),
          last24hMm: null,
        },
        textDescription: pr.textDescription,
        provider: 'weather.gov',
      }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('No recent observations from nearby stations')
}
