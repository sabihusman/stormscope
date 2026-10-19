import { fetchJSON, limitTier } from '../lib/fetch'
import type { LngLat } from '../lib/geo'
import type { GridSpec, HourlyGrid, PlaceForecast, StationObs } from '../types'

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast'

/**
 * Free-tier budget: Open-Meteo counts every location in a request as a call and
 * allows 600/min (and 10k/day). We keep a rolling 60 s window of weights and wait
 * before a request that would exceed ~550, and back off once on a 429.
 */
const WINDOW_MS = 60_000
const MINUTE_BUDGET = 550
const recent: { t: number; w: number }[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export async function budgeted<T>(weight: number, run: () => Promise<T>): Promise<T> {
  for (;;) {
    const now = Date.now()
    while (recent.length && now - recent[0].t > WINDOW_MS) recent.shift()
    const used = recent.reduce((a, r) => a + r.w, 0)
    if (used + weight <= MINUTE_BUDGET) break
    await sleep(Math.max(500, WINDOW_MS - (now - recent[0].t) + 50))
  }
  recent.push({ t: Date.now(), w: weight })
  bumpDaily(weight)
  try {
    return await run()
  } catch (e) {
    if (limitTier(e) === 'minute') {
      await sleep(61_000)
      recent.push({ t: Date.now(), w: weight })
      return run()
    }
    throw e // hourly/daily: surface the reason, don't burn more calls
  }
}
/** Calls made today (UTC), persisted per browser. The real quota is per IP, so this is a floor, not the truth. */
const DAY_KEY = 'stormscope.omCalls'
function bumpDaily(weight: number) {
  try {
    const day = new Date().toISOString().slice(0, 10)
    const cur = JSON.parse(localStorage.getItem(DAY_KEY) ?? '{}') as { day?: string; n?: number }
    const n = (cur.day === day ? cur.n ?? 0 : 0) + weight
    localStorage.setItem(DAY_KEY, JSON.stringify({ day, n }))
  } catch {
    /* ignore */
  }
}
export function openMeteoCallsToday(): number {
  try {
    const day = new Date().toISOString().slice(0, 10)
    const cur = JSON.parse(localStorage.getItem(DAY_KEY) ?? '{}') as { day?: string; n?: number }
    return cur.day === day ? (cur.n ?? 0) : 0
  } catch {
    return 0
  }
}
/** Run an Open-Meteo request under the shared per-minute budget (weight = locations). */
export const openMeteoBudgeted = budgeted
/** Locations requested in the last minute (for the Sources panel). */
export const openMeteoBudget = () => recent.filter((r) => Date.now() - r.t <= WINDOW_MS).reduce((a, r) => a + r.w, 0)

interface OmHourly {
  time: number[]
  precipitation: (number | null)[]
  cloud_cover: (number | null)[]
  wind_speed_10m: (number | null)[]
  wind_direction_10m: (number | null)[]
}
interface OmLocation {
  latitude: number
  longitude: number
  elevation: number
  hourly: OmHourly
}

/** Fetch hourly precipitation / cloud / wind for every grid point in one request. */
export async function fetchHourlyGrid(
  spec: GridSpec,
  forecastHours: number,
  signal?: AbortSignal,
): Promise<HourlyGrid> {
  const lat = spec.points.map((p) => p.lat).join(',')
  const lng = spec.points.map((p) => p.lng).join(',')
  const url =
    `${OPEN_METEO_URL}?latitude=${lat}&longitude=${lng}` +
    `&hourly=precipitation,cloud_cover,wind_speed_10m,wind_direction_10m` +
    `&forecast_hours=${forecastHours}&past_hours=1&timeformat=unixtime&timezone=GMT&wind_speed_unit=ms&models=best_match`
  const raw = await budgeted(spec.points.length, () => fetchJSON<OmLocation | OmLocation[]>(url, { signal, timeoutMs: 25_000 }))
  const locs = Array.isArray(raw) ? raw : [raw]
  if (locs.length !== spec.points.length) throw new Error('Open-Meteo returned unexpected point count')
  const times = locs[0].hourly.time.map((t) => t * 1000)
  const pick = (h: OmHourly, k: keyof OmHourly) => Float32Array.from(h[k].map((v) => (v == null ? 0 : v)))
  return {
    spec,
    times,
    precipitation: locs.map((l) => pick(l.hourly, 'precipitation')),
    cloudCover: locs.map((l) => pick(l.hourly, 'cloud_cover')),
    windSpeed: locs.map((l) => pick(l.hourly, 'wind_speed_10m')),
    windDir: locs.map((l) => pick(l.hourly, 'wind_direction_10m')),
    elevation: Float32Array.from(locs.map((l) => l.elevation ?? 0)),
  }
}

interface OmCurrentResponse {
  latitude: number
  longitude: number
  elevation: number
  current: {
    time: number
    surface_pressure: number | null
    pressure_msl: number | null
    relative_humidity_2m: number | null
    wind_speed_10m: number | null
    wind_direction_10m: number | null
    wind_gusts_10m: number | null
    precipitation: number | null
    temperature_2m: number | null
  }
  hourly: { time: number[]; precipitation: (number | null)[]; pressure_msl: (number | null)[] }
}

interface OmPlaceResponse {
  latitude: number
  longitude: number
  timezone?: string
  utc_offset_seconds?: number
  /** Daily block (requested with the same call); local midnights as unixtime in the resolved zone. */
  daily?: {
    time: number[]
    weather_code?: (number | null)[]
    temperature_2m_max?: (number | null)[]
    temperature_2m_min?: (number | null)[]
    precipitation_sum?: (number | null)[]
    precipitation_probability_max?: (number | null)[]
  }
  current: {
    time: number
    is_day: number
    temperature_2m: number | null
    apparent_temperature: number | null
    weather_code: number | null
    precipitation: number | null
    relative_humidity_2m: number | null
    wind_speed_10m: number | null
    wind_direction_10m: number | null
    wind_gusts_10m: number | null
    cloud_cover: number | null
  }
  hourly: {
    time: number[]
    is_day?: number[]
    temperature_2m: (number | null)[]
    apparent_temperature: (number | null)[]
    weather_code: (number | null)[]
    precipitation: (number | null)[]
    precipitation_probability: (number | null)[]
    wind_speed_10m: (number | null)[]
    wind_direction_10m: (number | null)[]
    wind_gusts_10m: (number | null)[]
    cloud_cover: (number | null)[]
  }
}

/**
 * Current conditions + 48 h hourly + 7 daily for one place (the Now screen), in ONE call: the daily block
 * rides on the same request (Open-Meteo's forecast endpoint takes current, hourly and daily together;
 * `forecast_hours` bounds the hourly block and `forecast_days` the daily one — confirmed 2026-10-11:
 * 49 hourly + 7 daily rows in one response). `timezone=auto` resolves the place's zone, so the daily
 * days roll over at local midnight; `timeformat=unixtime` keeps every timestamp absolute. One location =
 * one call against the shared budget. The block grid cannot feed this: it carries no temperature.
 */
export async function fetchPlaceForecast(p: LngLat, signal?: AbortSignal): Promise<PlaceForecast> {
  const url =
    `${OPEN_METEO_URL}?latitude=${p.lat.toFixed(4)}&longitude=${p.lng.toFixed(4)}` +
    `&current=temperature_2m,apparent_temperature,weather_code,precipitation,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,is_day` +
    `&hourly=temperature_2m,apparent_temperature,weather_code,precipitation,precipitation_probability,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,is_day` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max&forecast_days=7` +
    `&forecast_hours=48&past_hours=1&timeformat=unixtime&timezone=auto&wind_speed_unit=ms&models=best_match`
  const j = await budgeted(1, () => fetchJSON<OmPlaceResponse>(url, { signal, timeoutMs: 20_000 }))
  const h = j.hourly
  const nowSec = j.current.time
  const utcOffsetSec = j.utc_offset_seconds ?? 0
  // Parsed defensively: a response without a usable daily block leaves `daily` empty and the rest intact.
  const d = j.daily
  const daily = Array.isArray(d?.time)
    ? d.time.map((t, i) => ({
        time: t * 1000,
        date: new Date((t + utcOffsetSec) * 1000).toISOString().slice(0, 10),
        code: d.weather_code?.[i] ?? null,
        maxC: d.temperature_2m_max?.[i] ?? null,
        minC: d.temperature_2m_min?.[i] ?? null,
        precipMm: d.precipitation_sum?.[i] ?? null,
        precipProb: d.precipitation_probability_max?.[i] ?? null,
      }))
    : []
  const hourly = h.time
    .map((t, i) => ({
      time: t * 1000,
      tempC: h.temperature_2m[i] ?? null,
      apparentC: h.apparent_temperature[i] ?? null,
      code: h.weather_code[i] ?? null,
      precipMm: h.precipitation[i] ?? null,
      precipProb: h.precipitation_probability?.[i] ?? null,
      windMs: h.wind_speed_10m[i] ?? null,
      gustMs: h.wind_gusts_10m[i] ?? null,
      windDirDeg: h.wind_direction_10m[i] ?? null,
      cloudPct: h.cloud_cover[i] ?? null,
      // Day or night at that hour (Open-Meteo's is_day; a response without it is treated as day).
      isDay: h.is_day ? h.is_day[i] !== 0 : true,
    }))
    // From the hour that contains "now" onwards.
    .filter((x) => x.time >= Math.floor(nowSec / 3600) * 3600 * 1000)
  return {
    lngLat: { lng: j.longitude, lat: j.latitude },
    current: {
      time: nowSec * 1000,
      tempC: j.current.temperature_2m,
      apparentC: j.current.apparent_temperature,
      code: j.current.weather_code,
      precipMm: j.current.precipitation,
      humidityPct: j.current.relative_humidity_2m,
      windMs: j.current.wind_speed_10m,
      gustMs: j.current.wind_gusts_10m,
      windDirDeg: j.current.wind_direction_10m,
      cloudPct: j.current.cloud_cover,
      isDay: j.current.is_day !== 0,
    },
    hourly,
    timezone: j.timezone ?? 'UTC',
    utcOffsetSec,
    daily,
  }
}

/** Open-Meteo "station-like" fallback for locations without a weather.gov station. */
export async function fetchOpenMeteoCurrent(p: LngLat, signal?: AbortSignal): Promise<StationObs> {
  const url =
    `${OPEN_METEO_URL}?latitude=${p.lat.toFixed(4)}&longitude=${p.lng.toFixed(4)}` +
    `&current=surface_pressure,pressure_msl,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,temperature_2m` +
    `&hourly=precipitation,pressure_msl&past_hours=24&forecast_hours=1&timeformat=unixtime&timezone=GMT&wind_speed_unit=ms`
  const j = await budgeted(1, () => fetchJSON<OmCurrentResponse>(url, { signal }))
  const nowIdx = j.hourly.time.findIndex((t) => t * 1000 > j.current.time * 1000) // first future hour
  const end = nowIdx === -1 ? j.hourly.time.length : nowIdx
  const sum = (from: number) =>
    j.hourly.precipitation.slice(Math.max(0, end - from), end).reduce<number>((a, b) => a + (b ?? 0), 0)
  const pNow = j.current.pressure_msl
  const p3h = j.hourly.pressure_msl[Math.max(0, end - 3)]
  return {
    stationId: 'open-meteo',
    name: 'Open-Meteo model analysis',
    lngLat: { lng: j.longitude, lat: j.latitude },
    distanceM: 0,
    observedAt: j.current.time * 1000,
    pressureHpa: pNow,
    pressureTrendHpa3h: pNow != null && p3h != null ? pNow - p3h : null,
    humidityPct: j.current.relative_humidity_2m,
    windSpeedMs: j.current.wind_speed_10m,
    windGustMs: j.current.wind_gusts_10m,
    windDirDeg: j.current.wind_direction_10m,
    tempC: j.current.temperature_2m,
    precip: { lastHourMm: sum(1), last3hMm: sum(3), last6hMm: sum(6), last24hMm: sum(24) },
    provider: 'open-meteo',
  }
}
