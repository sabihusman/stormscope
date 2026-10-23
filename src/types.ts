import type { BBox, LngLat } from './lib/geo'

export type LayerId = 'radar' | 'satellite' | 'rainfall' | 'flood' | 'rivers' | 'station' | 'nowcast' | 'aqcircles' | 'monitors'

export type RainHorizon = 6 | 12 | 24 | 48

/** Freshness metadata every dataset carries. */
export interface Freshness {
  /** When we fetched it (ms epoch). */
  fetchedAt: number
  /** When the provider says the data is valid/generated (ms epoch), if known. */
  dataTime?: number
  source: string
  sourceUrl: string
}

export type LoadState = 'idle' | 'loading' | 'ready' | 'error'
export interface Resource<T> {
  state: LoadState
  data: T | null
  error: string | null
  freshness: Freshness | null
  /** True when the data came back from an offline cache / is older than its refresh interval. */
  stale: boolean
}

// ---- Radar ----
export interface RadarFrame {
  time: number // seconds epoch
  path: string
  kind: 'past' | 'nowcast'
}
export interface RadarData {
  host: string
  generated: number
  frames: RadarFrame[]
}

// ---- Open-Meteo grid ----
export interface GridSpec {
  /** Block key (see lib/blocks.ts). */
  key: string
  bbox: BBox
  /** Number of points per side. */
  n: number
  /** Point coordinates, row-major, south→north, west→east, spanning the bbox inclusive. */
  points: LngLat[]
}

export interface HourlyGrid {
  spec: GridSpec
  /** Hour timestamps (ms epoch), UTC-aligned. */
  times: number[]
  /** [pointIndex][hourIndex] mm */
  precipitation: Float32Array[]
  /** [pointIndex][hourIndex] % */
  cloudCover: Float32Array[]
  /** [pointIndex][hourIndex] m/s */
  windSpeed: Float32Array[]
  /** [pointIndex][hourIndex] degrees (from) */
  windDir: Float32Array[]
  /** Elevation reported by the model (m). */
  elevation: Float32Array
}

// ---- Rivers ----
export interface RiverGauge {
  id: string
  name: string
  lngLat: LngLat
  /** NOAA NWPS location id. */
  lid?: string
  /** USGS monitoring location id (e.g. USGS-01473500). */
  usgsId?: string
  stage?: { value: number; unit: string; time: number }
  flow?: { value: number; unit: string; time: number }
  floodCategory: string
  categories?: { action?: number; minor?: number; moderate?: number; major?: number; unit: string }
  forecast?: { value: number; unit: string; time: number; floodCategory: string }
  /** Ratio of latest flow to recent (7-day) median, when known. */
  flowRatio?: number
  riskLevel: 'normal' | 'elevated' | 'high' | 'flooding' | 'unknown'
  sources: string[]
}

// ---- Station ----
export interface StationObs {
  stationId: string
  name: string
  lngLat: LngLat
  distanceM: number
  observedAt: number
  pressureHpa: number | null
  pressureTrendHpa3h?: number | null
  humidityPct: number | null
  windSpeedMs: number | null
  windGustMs: number | null
  windDirDeg: number | null
  tempC: number | null
  precip: { lastHourMm: number | null; last3hMm: number | null; last6hMm: number | null; last24hMm: number | null }
  textDescription?: string
  provider: 'weather.gov' | 'open-meteo'
}

// ---- Flood risk ----
export interface FloodCell {
  /** Polygon ring [lng,lat]. */
  ring: [number, number][]
  center: LngLat
  risk: number // 0..1
  rain24: number
  elevation: number
  relElevation: number
  drainageDistM: number | null
}
export interface FloodResult {
  cells: FloodCell[]
  drainageAvailable: boolean
  flowlineCount: number
  computedAt: number
  horizonHours: number
  /** The quick rain-only pass shown while the drainage data loads ("refining…"); the full pass replaces it. */
  preliminary?: boolean
}

// ---- Place forecast (the Now screen) ----
export interface HourPoint {
  time: number
  tempC: number | null
  apparentC: number | null
  code: number | null
  precipMm: number | null
  precipProb: number | null
  windMs: number | null
  gustMs: number | null
  windDirDeg: number | null
  cloudPct: number | null
  /** Day or night at that hour (for the icon). */
  isDay: boolean
}
export interface PlaceForecast {
  lngLat: LngLat
  current: {
    time: number
    tempC: number | null
    apparentC: number | null
    code: number | null
    precipMm: number | null
    humidityPct: number | null
    windMs: number | null
    gustMs: number | null
    windDirDeg: number | null
    cloudPct: number | null
    isDay: boolean
  }
  /** Hourly from the current hour, 48 h. */
  hourly: HourPoint[]
  /** The place's IANA timezone and the UTC offset Open-Meteo resolved for the response (days roll over at local midnight). */
  timezone: string
  utcOffsetSec: number
  /** Daily, 7 days from today in the place's timezone; empty when the response carried none. */
  daily: DayPoint[]
}

export interface DayPoint {
  /** Local midnight of the day (ms epoch). */
  time: number
  /** The local calendar date, YYYY-MM-DD. */
  date: string
  code: number | null
  maxC: number | null
  minC: number | null
  precipMm: number | null
  /** Maximum precipitation probability over the day, %. */
  precipProb: number | null
}

// ---- NWS active alerts for a point ----
export interface NwsAlert {
  id: string
  event: string
  severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown'
  urgency: string
  certainty: string
  headline: string | null
  description: string | null
  instruction: string | null
  onset: number | null
  ends: number | null
  expires: number | null
  senderName: string | null
  areaDesc: string | null
  /** NWS message type: Alert, Update, Cancel. */
  messageType: string | null
}
export interface AlertsData {
  alerts: NwsAlert[]
  /** 'us' when api.weather.gov covers the place; 'outside-us' when it answered 404/400 for the point. */
  coverage: 'us' | 'outside-us'
}

// ---- Location ----
export interface Place {
  name: string
  lngLat: LngLat
  source: 'geolocation' | 'search' | 'map'
}
