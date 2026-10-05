import { fetchJSON, describeError } from '../lib/fetch'
import type { BBox } from '../lib/geo'
import type { Hazard, HazardTier, SourceStatus } from '../lib/hazardEngine'

/**
 * Hazard sources (all keyless, CORS-enabled):
 *  - NWS active alerts (warnings / advisories / statements; watches too when IEM is down)
 *  - SPC watches as polygons via IEM
 *  - SPC Day 1–3 convective outlooks via the NOAA MapServer
 *  - replay fixtures under /fixtures/<name>/ for the scripted hazard tests
 */
export const NWS_ALERTS = 'https://api.weather.gov/alerts/active'
export const IEM_WATCHES = 'https://mesonet.agron.iastate.edu/json/spcwatch.py'
export const SPC_OUTLOOKS = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer'

// ---- state lookup (coarse bboxes) so we can ask NWS for the right `area=` list ----
const STATE_BBOX: Record<string, BBox> = {
  AL: { west: -88.5, south: 30.1, east: -84.9, north: 35.0 }, AR: { west: -94.7, south: 33.0, east: -89.6, north: 36.5 }, AZ: { west: -114.9, south: 31.3, east: -109.0, north: 37.0 },
  CA: { west: -124.5, south: 32.5, east: -114.1, north: 42.0 }, CO: { west: -109.1, south: 36.9, east: -102.0, north: 41.0 }, CT: { west: -73.8, south: 40.9, east: -71.7, north: 42.1 },
  DC: { west: -77.2, south: 38.8, east: -76.9, north: 39.0 }, DE: { west: -75.8, south: 38.4, east: -74.9, north: 39.9 }, FL: { west: -87.7, south: 24.4, east: -79.9, north: 31.0 },
  GA: { west: -85.7, south: 30.3, east: -80.8, north: 35.0 }, IA: { west: -96.7, south: 40.3, east: -90.1, north: 43.6 }, ID: { west: -117.3, south: 41.9, east: -111.0, north: 49.0 },
  IL: { west: -91.6, south: 36.9, east: -87.0, north: 42.6 }, IN: { west: -88.1, south: 37.7, east: -84.7, north: 41.8 }, KS: { west: -102.1, south: 36.9, east: -94.5, north: 40.1 },
  KY: { west: -89.6, south: 36.4, east: -81.9, north: 39.2 }, LA: { west: -94.1, south: 28.8, east: -88.7, north: 33.1 }, MA: { west: -73.6, south: 41.2, east: -69.8, north: 42.9 },
  MD: { west: -79.5, south: 37.9, east: -74.9, north: 39.8 }, ME: { west: -71.1, south: 42.9, east: -66.9, north: 47.5 }, MI: { west: -90.5, south: 41.6, east: -82.1, north: 48.3 },
  MN: { west: -97.3, south: 43.4, east: -89.4, north: 49.4 }, MO: { west: -95.8, south: 35.9, east: -89.0, north: 40.7 }, MS: { west: -91.7, south: 30.1, east: -88.0, north: 35.0 },
  MT: { west: -116.1, south: 44.3, east: -104.0, north: 49.1 }, NC: { west: -84.4, south: 33.8, east: -75.4, north: 36.6 }, ND: { west: -104.1, south: 45.9, east: -96.5, north: 49.1 },
  NE: { west: -104.1, south: 39.9, east: -95.3, north: 43.1 }, NH: { west: -72.6, south: 42.6, east: -70.6, north: 45.4 }, NJ: { west: -75.6, south: 38.9, east: -73.8, north: 41.4 },
  NM: { west: -109.1, south: 31.3, east: -103.0, north: 37.1 }, NV: { west: -120.1, south: 35.0, east: -114.0, north: 42.1 }, NY: { west: -79.8, south: 40.4, east: -71.8, north: 45.1 },
  OH: { west: -84.9, south: 38.4, east: -80.5, north: 42.0 }, OK: { west: -103.1, south: 33.6, east: -94.4, north: 37.1 }, OR: { west: -124.7, south: 41.9, east: -116.4, north: 46.3 },
  PA: { west: -80.6, south: 39.7, east: -74.6, north: 42.3 }, RI: { west: -71.9, south: 41.1, east: -71.1, north: 42.1 }, SC: { west: -83.4, south: 32.0, east: -78.5, north: 35.3 },
  SD: { west: -104.1, south: 42.4, east: -96.4, north: 46.0 }, TN: { west: -90.4, south: 34.9, east: -81.6, north: 36.7 }, TX: { west: -106.7, south: 25.8, east: -93.5, north: 36.6 },
  UT: { west: -114.1, south: 36.9, east: -109.0, north: 42.1 }, VA: { west: -83.7, south: 36.5, east: -75.2, north: 39.5 }, VT: { west: -73.5, south: 42.7, east: -71.4, north: 45.1 },
  WA: { west: -124.8, south: 45.5, east: -116.9, north: 49.1 }, WI: { west: -92.9, south: 42.4, east: -86.7, north: 47.1 }, WV: { west: -82.7, south: 37.2, east: -77.7, north: 40.7 },
  WY: { west: -111.1, south: 40.9, east: -104.0, north: 45.1 },
}
export function statesForBBox(b: BBox): string[] {
  return Object.entries(STATE_BBOX)
    .filter(([, s]) => !(s.east < b.west || s.west > b.east || s.north < b.south || s.south > b.north))
    .map(([k]) => k)
}

const sevMap = (s: string | undefined): Hazard['severity'] => (s === 'Extreme' || s === 'Severe' || s === 'Moderate' || s === 'Minor' ? s : 'Unknown')
function tierFor(event: string): HazardTier {
  if (/warning/i.test(event)) return 'warning'
  if (/watch/i.test(event)) return 'watch'
  if (/advisory/i.test(event)) return 'advisory'
  return 'statement'
}
/** Weather/road-relevant events only (skips e.g. marine, air quality, beach hazards). */
const RELEVANT =
  /tornado|thunderstorm|flood|flash|winter|ice|snow|blizzard|freez|wind|fog|dust|hurricane|tropical|storm|extreme (cold|heat)|wind chill|heat/i

interface NwsAlert {
  id: string
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null
  properties: {
    id: string
    event: string
    headline?: string
    severity?: string
    onset?: string
    effective?: string
    sent?: string
    ends?: string
    expires?: string
    affectedZones?: string[]
    areaDesc?: string
    parameters?: Record<string, string[]>
  }
}

/** Active NWS alerts for the given states, normalised. Watches are included (zone-based) and tagged. */
export async function fetchNwsHazards(states: string[], signal?: AbortSignal): Promise<Hazard[]> {
  if (!states.length) return []
  const j = await fetchJSON<{ features: NwsAlert[] }>(`${NWS_ALERTS}?area=${states.join(',')}&status=actual&message_type=alert,update`, {
    signal,
    timeoutMs: 30_000,
    headers: { Accept: 'application/geo+json' },
  })
  const out: Hazard[] = []
  for (const f of j.features) {
    const p = f.properties
    if (!RELEVANT.test(p.event)) continue
    const from = Date.parse(p.onset ?? p.effective ?? p.sent ?? '') || Date.now()
    const to = Date.parse(p.ends ?? p.expires ?? '') || from + 6 * 3_600_000
    const tags: string[] = []
    const tor = p.parameters?.tornadoDetection?.[0]
    if (tor) tags.push(`tornado ${tor}`)
    const dmg = p.parameters?.tornadoDamageThreat?.[0] ?? p.parameters?.thunderstormDamageThreat?.[0]
    if (dmg) tags.push(`damage ${dmg}`)
    const hail = p.parameters?.maxHailSize?.[0]
    if (hail) tags.push(`hail ${hail}"`)
    const wind = p.parameters?.maxWindGust?.[0]
    if (wind) tags.push(`gusts ${wind}`)
    out.push({
      id: p.id,
      tier: tierFor(p.event),
      event: p.event,
      headline: p.headline,
      severity: sevMap(p.severity),
      validFrom: from,
      validTo: to,
      geometry: f.geometry,
      zones: f.geometry ? undefined : (p.affectedZones ?? []).map((u) => u.split('/').slice(-2).join('/')),
      source: 'NWS',
      url: `https://alerts.weather.gov/search?id=${encodeURIComponent(p.id)}`,
      tags,
    })
  }
  return out
}

// ---- zone geometry for county/zone-based products (fetched lazily, cached) ----
const zoneCache = new Map<string, Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon | null>>()
export function fetchZoneGeometry(zone: string, signal?: AbortSignal) {
  // zone like "county/IAC001" or "forecast/IAZ060"
  let p = zoneCache.get(zone)
  if (!p) {
    p = fetchJSON<{ geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon | null }>(`https://api.weather.gov/zones/${zone}`, { signal, timeoutMs: 20_000 })
      .then((z) => z.geometry)
      .catch(() => null)
    zoneCache.set(zone, p)
  }
  return p
}
/** Merge the zones of a zone-based hazard into one MultiPolygon (capped so one busy day can't trigger hundreds of fetches). */
export async function resolveZones(h: Hazard, maxZones = 30, signal?: AbortSignal): Promise<Hazard> {
  if (h.geometry || !h.zones?.length) return h
  const polys: GeoJSON.Position[][][] = []
  for (const z of h.zones.slice(0, maxZones)) {
    const g = await fetchZoneGeometry(z, signal)
    if (!g) continue
    if (g.type === 'Polygon') polys.push(g.coordinates)
    else polys.push(...g.coordinates)
  }
  return polys.length ? { ...h, geometry: { type: 'MultiPolygon', coordinates: polys } } : h
}

// ---- SPC watches (polygons) via IEM ----
interface IemWatch {
  properties: { number: number; type: 'TOR' | 'SVR'; is_pds: boolean; issue: string; expire: string; spcurl: string; max_hail_size?: number; max_wind_gust_knots?: number }
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
}
export function watchToHazard(f: IemWatch): Hazard {
  const p = f.properties
  const kind = p.type === 'TOR' ? 'Tornado Watch' : 'Severe Thunderstorm Watch'
  return {
    id: `spc-watch-${p.number}`,
    tier: 'watch',
    event: `${kind} ${p.number}${p.is_pds ? ' (PDS)' : ''}`,
    severity: p.is_pds ? 'Extreme' : 'Severe',
    validFrom: Date.parse(p.issue),
    validTo: Date.parse(p.expire),
    geometry: f.geometry,
    source: 'SPC via IEM',
    url: p.spcurl,
    tags: [p.max_hail_size ? `hail to ${p.max_hail_size}"` : '', p.max_wind_gust_knots ? `gusts to ${p.max_wind_gust_knots} kt` : ''].filter(Boolean),
  }
}
export async function fetchWatches(signal?: AbortSignal): Promise<Hazard[]> {
  const j = await fetchJSON<{ features: IemWatch[] }>(IEM_WATCHES, { signal, timeoutMs: 20_000 })
  return (j.features ?? []).map(watchToHazard)
}

// ---- SPC outlooks (Day 1–3) ----
/** MapServer layer ids: categorical + probabilistic tornado (Day 1/2) and categorical + probabilistic (Day 3). */
const OUTLOOK_LAYERS: { id: number; day: 1 | 2 | 3; kind: 'cat' | 'torn' | 'prob' }[] = [
  { id: 1, day: 1, kind: 'cat' },
  { id: 3, day: 1, kind: 'torn' },
  { id: 9, day: 2, kind: 'cat' },
  { id: 11, day: 2, kind: 'torn' },
  { id: 17, day: 3, kind: 'cat' },
  { id: 19, day: 3, kind: 'prob' },
]
const CAT_LABELS: Record<string, string> = { TSTM: 'general thunderstorms', MRGL: 'Marginal risk', SLGT: 'Slight risk', ENH: 'Enhanced risk', MDT: 'Moderate risk', HIGH: 'High risk' }
const catSeverity = (label: string): Hazard['severity'] => (label === 'HIGH' ? 'Extreme' : label === 'MDT' || label === 'ENH' ? 'Severe' : label === 'SLGT' ? 'Moderate' : 'Minor')

interface OutlookFeature {
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
  properties: { dn?: number; valid?: number | string; expire?: number | string; issue?: number | string; label?: string; label2?: string; DN?: number; VALID?: string; EXPIRE?: string; ISSUE?: string; LABEL?: string; LABEL2?: string }
}
function spcTime(v: number | string | undefined): number {
  if (v == null) return NaN
  if (typeof v === 'number') return v // epoch ms from the MapServer
  // SPC shapefile style: yyyymmddHHMM
  const m = String(v).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/)
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  return Date.parse(v)
}
export function outlookToHazard(f: OutlookFeature, day: 1 | 2 | 3, kind: 'cat' | 'torn' | 'prob'): Hazard | null {
  const p = f.properties
  const label = (p.label ?? p.LABEL ?? '').toString()
  const label2 = (p.label2 ?? p.LABEL2 ?? '').toString()
  if (!label) return null
  const valid = spcTime(p.valid ?? p.VALID)
  const expire = spcTime(p.expire ?? p.EXPIRE)
  let event: string
  let severity: Hazard['severity']
  if (kind === 'cat') {
    event = `SPC Day ${day} ${CAT_LABELS[label] ?? label}`
    severity = catSeverity(label)
  } else if (kind === 'torn') {
    const pct = label === 'SIGN' ? 'significant (hatched)' : `${Math.round(parseFloat(label) * 100)} %`
    event = `SPC Day ${day} tornado ${pct}`
    severity = label === 'SIGN' || parseFloat(label) >= 0.15 ? 'Extreme' : parseFloat(label) >= 0.05 ? 'Severe' : 'Moderate'
  } else {
    event = `SPC Day ${day} severe ${label === 'SIGN' ? 'significant (hatched)' : `${Math.round(parseFloat(label) * 100)} %`}`
    severity = label === 'SIGN' || parseFloat(label) >= 0.3 ? 'Severe' : 'Moderate'
  }
  return {
    id: `spc-d${day}-${kind}-${label}`,
    tier: 'outlook',
    event,
    headline: label2 || undefined,
    severity,
    validFrom: Number.isFinite(valid) ? valid : Date.now(),
    validTo: Number.isFinite(expire) ? expire : Date.now() + 36 * 3_600_000,
    geometry: f.geometry,
    source: 'SPC',
    url: `https://www.spc.noaa.gov/products/outlook/day${day}otlk.html`,
  }
}
export async function fetchOutlooks(bbox: BBox, signal?: AbortSignal): Promise<Hazard[]> {
  const out: Hazard[] = []
  const geometry = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`
  await Promise.all(
    OUTLOOK_LAYERS.map(async (L) => {
      const url =
        `${SPC_OUTLOOKS}/${L.id}/query?where=1%3D1&geometry=${encodeURIComponent(geometry)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
        `&outFields=dn,valid,expire,issue,label,label2&returnGeometry=true&outSR=4326&f=geojson`
      const j = await fetchJSON<{ features: OutlookFeature[] }>(url, { signal, timeoutMs: 25_000 })
      for (const f of j.features ?? []) {
        const h = outlookToHazard(f, L.day, L.kind)
        if (h) out.push(h)
      }
    }),
  )
  return out
}

// ---- Replay fixtures ----
export interface ReplayScenario {
  id: string
  label: string
  fixture: string
  from: { name: string; lat: number; lng: number }
  to: { name: string; lat: number; lng: number }
  departure: string
  /** Weather for the replay: ERA5 hindsight (default) or the archived forecast as issued. */
  weather?: 'era5' | 'historical-forecast'
  /**
   * `route` / `weatherCache`: responses recorded by scripts/record-replays.mjs so a replay makes
   * no routing or Open-Meteo calls at all (the demo router and the forecast quota are per IP).
   */
  files: { warnings?: string; watches?: string; countyAlerts?: string; outlooks?: string[]; rwis?: string; rwisStations?: string; route?: string; weatherCache?: string }
  notes?: string
  /** Set from `?live=1`: ignore the cached route/weather files (used by the recorder). */
  live?: boolean
}
/** Fetch one file of a replay fixture (relative to its folder). */
export async function fetchReplayFile<T>(sc: ReplayScenario, file: string): Promise<T> {
  return fetchJSON<T>(`/fixtures/${sc.fixture}/${file}`, { timeoutMs: 15_000 })
}
export async function fetchReplayIndex(): Promise<ReplayScenario[]> {
  return fetchJSON<ReplayScenario[]>('/fixtures/index.json', { timeoutMs: 10_000 })
}
interface SbwFeature {
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
  properties: { wfo: string; phenomena: string; significance: string; eventid: number; polygon_begin: string; polygon_end: string; issue: string; expire: string; tornadotag?: string | null; damagetag?: string | null; hailtag?: string | number | null; windtag?: string | number | null; is_pds?: boolean; is_emergency?: boolean; href?: string; event?: string; counties?: string[] }
}
const PH: Record<string, string> = { TO: 'Tornado', SV: 'Severe Thunderstorm', FF: 'Flash Flood', FA: 'Flood', FL: 'Flood', IS: 'Ice Storm', WS: 'Winter Storm', BZ: 'Blizzard', WW: 'Winter Weather', HW: 'High Wind', FZ: 'Freeze', ZR: 'Freezing Rain', FG: 'Dense Fog' }
const SG: Record<string, string> = { W: 'Warning', A: 'Watch', Y: 'Advisory', S: 'Statement' }
export function sbwToHazard(f: SbwFeature): Hazard {
  const p = f.properties
  const event = p.event ?? `${PH[p.phenomena] ?? p.phenomena} ${SG[p.significance] ?? p.significance}`
  const tags = [p.tornadotag ? `tornado ${p.tornadotag}` : '', p.damagetag ? `damage ${p.damagetag}` : '', p.is_pds ? 'PDS' : '', p.hailtag ? `hail ${p.hailtag}"` : '', p.windtag ? `gusts ${p.windtag} mph` : ''].filter(Boolean)
  return {
    id: `${p.wfo} ${p.phenomena}.${p.significance} #${p.eventid}`,
    tier: tierFor(event),
    event,
    headline: p.counties ? `${p.counties.length} counties` : undefined,
    severity: p.phenomena === 'TO' ? (p.is_pds || p.is_emergency ? 'Extreme' : 'Severe') : p.significance === 'W' ? 'Severe' : p.significance === 'Y' ? 'Minor' : 'Moderate',
    validFrom: Date.parse(p.polygon_begin ?? p.issue),
    validTo: Date.parse(p.polygon_end ?? p.expire),
    geometry: f.geometry,
    source: `replay fixture (IEM archive, ${p.wfo})`,
    url: p.href,
    tags,
  }
}
export async function loadReplayHazards(s: ReplayScenario): Promise<{ hazards: Hazard[]; sources: Record<'warnings' | 'watches' | 'outlooks', SourceStatus> }> {
  const base = `/fixtures/${s.fixture}/`
  const hazards: Hazard[] = []
  const sources: Record<'warnings' | 'watches' | 'outlooks', SourceStatus> = {
    warnings: { state: 'not-applicable', reason: 'fixture has no warnings file' },
    watches: { state: 'not-applicable', reason: 'fixture has no watches file' },
    outlooks: { state: 'not-applicable', reason: 'fixture has no outlook files' },
  }
  const now = Date.now()
  const load = async (file: string) => fetchJSON<{ features: unknown[] }>(base + file, { timeoutMs: 15_000 })
  try {
    let n = 0
    if (s.files.warnings) {
      const j = await load(s.files.warnings)
      for (const f of j.features as SbwFeature[]) hazards.push(sbwToHazard(f))
      n += j.features.length
    }
    if (s.files.countyAlerts) {
      const j = await load(s.files.countyAlerts)
      for (const f of j.features as SbwFeature[]) hazards.push(sbwToHazard(f))
      n += j.features.length
    }
    if (s.files.warnings || s.files.countyAlerts) sources.warnings = { state: 'ok', count: n, fetchedAt: now }
  } catch (e) {
    sources.warnings = { state: 'unavailable', reason: describeError(e) }
  }
  if (s.files.watches)
    try {
      const j = await load(s.files.watches)
      for (const f of j.features as IemWatch[]) hazards.push(watchToHazard(f))
      sources.watches = { state: 'ok', count: j.features.length, fetchedAt: now }
    } catch (e) {
      sources.watches = { state: 'unavailable', reason: describeError(e) }
    }
  if (s.files.outlooks?.length)
    try {
      let n = 0
      for (const file of s.files.outlooks) {
        const kind: 'cat' | 'torn' | 'prob' = /torn|sigtorn/.test(file) ? 'torn' : /cat/.test(file) ? 'cat' : 'prob'
        const j = await load(file)
        for (const f of j.features as OutlookFeature[]) {
          const h = outlookToHazard(f, 1, kind)
          if (h) {
            hazards.push(h)
            n++
          }
        }
      }
      sources.outlooks = { state: 'ok', count: n, fetchedAt: now }
    } catch (e) {
      sources.outlooks = { state: 'unavailable', reason: describeError(e) }
    }
  return { hazards, sources }
}
