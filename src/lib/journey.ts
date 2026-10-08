/**
 * Journey weather: sample a route by travel time, fetch the forecast for every
 * sample, and read the values valid at the moment you'll be there.
 */
import { fetchJSON, HttpError } from '../lib/fetch'
import type { LngLat } from './geo'
import type { RouteResult } from '../api/routing'
import { OPEN_METEO_URL, openMeteoBudgeted } from '../api/openMeteo'

export const MAX_SAMPLES = 120
/** First N hours of driving are sampled every ~5 min using 15-minutely data (HRRR / ICON-D2 / AROME); beyond that every ~15 min hourly. */
export const FINE_HOURS = 6

export type Severity = 0 | 1 | 2 | 3 // clear · caution · hazardous · severe
export const SEVERITY_COLORS: Record<Severity, string> = { 0: '#22c55e', 1: '#facc15', 2: '#f97316', 3: '#ef4444' }
export interface Condition {
  code: string // 'clear' | 'rain' | 'heavy-rain' | 'snow' | 'heavy-snow' | 'ice' | 'fog' | 'wind' | 'storm'
  label: string
  severity: Severity
}
export interface JourneySample {
  idx: number // route vertex index
  lngLat: LngLat
  /** Seconds from departure. */
  offsetS: number
  /** Absolute ETA (ms). */
  eta: number
  distM: number
  /** Values valid at ETA. */
  tempC: number | null
  precipMm: number | null // per hour-equivalent rate (mm/h)
  rainMm: number | null
  snowCm: number | null
  gustKmh: number | null
  visibilityM: number | null
  cloudPct: number | null
  weatherCode: number | null
  /** 'minutely' when native 15-min data was used, 'hourly' otherwise. */
  resolution: 'minutely' | 'hourly'
  condition: Condition
}
export interface JourneyWeather {
  samples: JourneySample[]
  worst: Condition
  fetchedAt: number
  /** Locations consumed from the Open-Meteo budget. */
  calls: number
  /** True when the trip is in the past and ERA5 reanalysis was used instead of a forecast. */
  historical: boolean
  provider: string
}
export const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive'
/** Archived model runs "as issued" (not hindsight). https://open-meteo.com/en/docs/historical-forecast-api */
export const HISTORICAL_FORECAST_URL = 'https://historical-forecast-api.open-meteo.com/v1/forecast'
export type WeatherSource = 'auto' | 'era5' | 'historical-forecast'
/** ERA5 reanalysis lags real time by ~5 days; anything older than that is "historical". */
export const HISTORICAL_AFTER_MS = 5 * 86_400_000

/** Driving time the forecast strip covers; longer trips are capped here and the panel says so. */
export const TRIP_CAP_S = 24 * 3600
export const isCapped = (route: RouteResult) => route.durationS > TRIP_CAP_S

/**
 * Pick vertex indices ~every `fineStepS` for the first FINE_HOURS, then every `coarseStepS`, capped at
 * MAX_SAMPLES and at TRIP_CAP_S of driving (the last sample of a capped trip is the 24 h mark, not the destination).
 */
export function sampleRoute(route: RouteResult, fineStepS = 300, coarseStepS = 900): number[] {
  const idx: number[] = [0]
  let next = fineStepS
  const capped = isCapped(route)
  for (let i = 1; i < route.offsetS.length; i++) {
    const t = route.offsetS[i]
    if (capped && t > TRIP_CAP_S) break
    if (t >= next) {
      idx.push(i)
      next = t + (t < FINE_HOURS * 3600 ? fineStepS : coarseStepS)
    }
  }
  if (!capped && idx[idx.length - 1] !== route.coords.length - 1) idx.push(route.coords.length - 1)
  // Thin evenly if over the cap.
  if (idx.length > MAX_SAMPLES) {
    const step = idx.length / MAX_SAMPLES
    const thinned = Array.from({ length: MAX_SAMPLES }, (_, k) => idx[Math.floor(k * step)])
    thinned[thinned.length - 1] = idx[idx.length - 1]
    return thinned
  }
  return idx
}

/** WMO weather code → coarse class. */
export function classify(code: number | null, precipMmH: number | null, snowCmH: number | null, tempC: number | null, gustKmh: number | null, visM: number | null): Condition {
  const p = precipMmH ?? 0
  const s = snowCmH ?? 0
  const freezing = tempC != null && tempC <= 1
  if (code != null && [95, 96, 99].includes(code)) return { code: 'storm', label: 'Thunderstorm', severity: 3 }
  if (code != null && [66, 67].includes(code)) return { code: 'ice', label: 'Freezing rain — possible ice', severity: 3 }
  if (p > 0.2 && freezing) return { code: 'ice', label: 'Precipitation near freezing — possible ice', severity: 3 }
  if (s >= 3 || (code != null && [75, 86].includes(code))) return { code: 'heavy-snow', label: 'Heavy snow', severity: 3 }
  if (p >= 10) return { code: 'heavy-rain', label: 'Very heavy rain', severity: 3 }
  if (gustKmh != null && gustKmh >= 70) return { code: 'wind', label: 'Damaging gusts', severity: 2 }
  if (visM != null && visM < 1000) return { code: 'fog', label: 'Low visibility', severity: 2 }
  if (s > 0.5 || (code != null && [71, 73, 77, 85].includes(code))) return { code: 'snow', label: 'Snow', severity: 2 }
  if (p >= 4) return { code: 'heavy-rain', label: 'Heavy rain', severity: 2 }
  if (gustKmh != null && gustKmh >= 50) return { code: 'wind', label: 'Gusty', severity: 1 }
  if (p > 0.2 || (code != null && code >= 51 && code <= 65)) return { code: 'rain', label: 'Rain', severity: 1 }
  if (code != null && [45, 48].includes(code)) return { code: 'fog', label: 'Fog', severity: 1 }
  return { code: 'clear', label: 'Fair', severity: 0 }
}

interface OmSeries {
  time: number[]
  temperature_2m?: (number | null)[]
  precipitation?: (number | null)[]
  rain?: (number | null)[]
  snowfall?: (number | null)[]
  wind_gusts_10m?: (number | null)[]
  visibility?: (number | null)[]
  weather_code?: (number | null)[]
  cloud_cover?: (number | null)[]
}
export interface OmPoint {
  latitude: number
  longitude: number
  hourly: OmSeries
  minutely_15?: OmSeries
}

/** Value of `key` valid at time t (ms): the interval containing t. */
function at(series: OmSeries | undefined, key: keyof OmSeries, t: number, stepMs: number): number | null {
  if (!series?.time) return null
  const arr = series[key] as (number | null)[] | undefined
  if (!arr) return null
  const i = Math.floor((t / 1000 - series.time[0]) / (stepMs / 1000))
  if (i < 0 || i >= arr.length) return null
  return arr[i]
}

/**
 * Fetch and evaluate the forecast at every sample. One multi-location request; the
 * budget weight is the number of samples. Throws `RateLimited` (a HttpError 429) upward
 * so the UI can say so explicitly.
 */
/**
 * Forecast (or reanalysis / archived forecast) valid at the ETA of every route sample.
 * `cachedRaw` is a previously recorded Open-Meteo response for exactly this route + departure
 * (replay fixtures): it is parsed the same way and costs no live call.
 */
export async function fetchJourneyWeather(route: RouteResult, departureMs: number, signal?: AbortSignal, source: WeatherSource = 'auto', cachedRaw?: OmPoint | OmPoint[]): Promise<JourneyWeather> {
  const idx = sampleRoute(route)
  const pts = idx.map((i) => ({ lng: route.coords[i][0], lat: route.coords[i][1] }))
  const lastEta = departureMs + route.durationS * 1000
  // Ask only for the trip window: a 120-point request with whole days of 15-minutely data
  // takes >30 s on Open-Meteo; bounded to departure→arrival it takes ~7 s.
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16)
  const HOUR = 3_600_000
  const minEnd = Math.min(lastEta, departureMs + FINE_HOURS * HOUR)
  const wantMinutely = departureMs < Date.now() + 2 * 86_400_000 // 15-minutely is only published ~2 days out
  const historical = source === 'era5' || source === 'historical-forecast' || lastEta < Date.now() - HISTORICAL_AFTER_MS
  const asIssued = source === 'historical-forecast'
  const latlng = `latitude=${pts.map((p) => p.lat.toFixed(4)).join(',')}&longitude=${pts.map((p) => p.lng.toFixed(4)).join(',')}`
  const dayRange = `start_date=${new Date(departureMs - HOUR).toISOString().slice(0, 10)}&end_date=${new Date(lastEta + HOUR).toISOString().slice(0, 10)}`
  const url = historical
    ? asIssued
      ? // Replays "as the forecast was issued": archived GFS runs (what a driver could have seen that morning).
        `${HISTORICAL_FORECAST_URL}?${latlng}&${dayRange}&hourly=temperature_2m,precipitation,rain,snowfall,wind_gusts_10m,weather_code,cloud_cover&models=gfs_seamless&timeformat=unixtime&timezone=GMT`
      : // Replays with hindsight: ERA5 reanalysis (no 15-minutely, no visibility).
        `${ARCHIVE_URL}?${latlng}&${dayRange}&hourly=temperature_2m,precipitation,rain,snowfall,wind_gusts_10m,weather_code,cloud_cover&timeformat=unixtime&timezone=GMT`
    : `${OPEN_METEO_URL}?${latlng}` +
      `&hourly=temperature_2m,precipitation,rain,snowfall,wind_gusts_10m,visibility,weather_code,cloud_cover` +
      `&start_hour=${iso(departureMs - HOUR)}&end_hour=${iso(lastEta + HOUR)}` +
      (wantMinutely
        ? `&minutely_15=temperature_2m,precipitation,rain,snowfall,wind_gusts_10m,visibility,weather_code&start_minutely_15=${iso(departureMs)}&end_minutely_15=${iso(minEnd + 15 * 60_000)}`
        : '') +
      `&timeformat=unixtime&timezone=GMT`
  const raw = cachedRaw ?? (await openMeteoBudgeted(pts.length, () => fetchJSON<OmPoint | OmPoint[]>(url, { signal, timeoutMs: 60_000 })))
  const locs = Array.isArray(raw) ? raw : [raw]
  if (locs.length !== pts.length) throw new Error(cachedRaw ? 'Cached replay weather does not match this route (re-record the fixture)' : 'Forecast returned an unexpected number of points')

  const samples: JourneySample[] = idx.map((vi, k) => {
    const loc = locs[k]
    const eta = departureMs + route.offsetS[vi] * 1000
    const mt = loc.minutely_15?.time
    const useMin = !!mt && mt.length > 1 && eta >= mt[0] * 1000 && eta < (mt[mt.length - 1] + 900) * 1000
    const S = useMin ? loc.minutely_15! : loc.hourly
    const step = useMin ? 15 * 60_000 : 3_600_000
    const v = (key: keyof OmSeries) => at(S, key, eta, step)
    // Precip in a 15-min step is mm per 15 min → ×4 for an hourly-equivalent rate.
    const rate = useMin ? 4 : 1
    const precip = v('precipitation') != null ? (v('precipitation') as number) * rate : null
    const snow = v('snowfall') != null ? (v('snowfall') as number) * rate : null
    const temp = v('temperature_2m')
    const gust = v('wind_gusts_10m')
    const vis = v('visibility')
    const code = v('weather_code')
    return {
      idx: vi,
      lngLat: pts[k],
      offsetS: route.offsetS[vi],
      eta,
      distM: route.cumM[vi],
      tempC: temp,
      precipMm: precip,
      rainMm: v('rain') != null ? (v('rain') as number) * rate : null,
      snowCm: snow,
      gustKmh: gust,
      visibilityM: vis,
      cloudPct: at(loc.hourly, 'cloud_cover', eta, 3_600_000),
      weatherCode: code,
      resolution: useMin ? 'minutely' : 'hourly',
      condition: classify(code, precip, snow, temp, gust, vis),
    }
  })
  const worst = samples.reduce((w, s) => (s.condition.severity > w.severity ? s.condition : w), samples[0].condition)
  return {
    samples,
    worst,
    fetchedAt: Date.now(),
    calls: cachedRaw ? 0 : pts.length,
    historical,
    provider:
      (historical ? (asIssued ? 'Open-Meteo Historical Forecast API — GFS as issued that day (not hindsight)' : 'Open-Meteo ERA5 reanalysis (hindsight, hourly)') : 'Open-Meteo forecast (hourly + 15-minutely)') +
      (cachedRaw ? ' · response cached in the fixture, no live call' : ''),
  }
}

export const isRateLimited = (e: unknown) => e instanceof HttpError && e.status === 429
