// Zero-live-call harness for performance work and the overnight walkthrough.
//
// Every API host is answered locally from SAVED bodies where we have them (Open-Meteo journey
// responses, the recorded Valhalla route, the RWIS archive + station list, the rivers snapshot) and
// from structurally faithful synthesized bodies where we do not (RainViewer frame list + a generated
// radar tile, NWS points/stations/observations, NWPS/USGS gauges, geocoding, empty hazard products).
// Values from synthesized bodies are for timing only and never ship. Tile hosts (basemap vector
// tiles, terrain, GIBS) cannot be faked without changing MapLibre's work, so they come from a
// Playwright HAR: `record: true` captures them live ONCE (through the budget guard), afterwards
// they replay with `notFound: 'abort'` — nothing leaves the machine.
import { readFileSync, existsSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const F = (p) => JSON.parse(readFileSync(p, 'utf8'))
const saved = {
  omLocations: (() => {
    const r = F('public/fixtures/2024-05-21-greenfield/weather.greenfield-2020z.json').response
    return Array.isArray(r) ? r : [r]
  })(),
  route: F('public/fixtures/2024-12-14-ice-storm/route.41.587_-93.625__41.661_-91.530.json'),
  rwisStations: F('public/fixtures/2024-12-14-ice-storm/rwis_stations.json'),
  rwisCsv: readFileSync('public/fixtures/2024-12-14-ice-storm/rwis_i80_2024-12-13_15.csv', 'utf8'),
  rivers: existsSync('scripts/fixtures/rivers-iowa.json') ? F('scripts/fixtures/rivers-iowa.json') : { sites: [], nwpsLids: [], medians: {} },
}

// ---------- Open-Meteo: real hourly series from the saved journey bodies, reshaped to the request ----------
const HOUR = 3600
function omSeries(locIdx, field, nHours, startSec) {
  const loc = saved.omLocations[locIdx % saved.omLocations.length]
  const h = loc.hourly
  const out = []
  for (let i = 0; i < nHours; i++) {
    const k = (i + locIdx) % h.time.length
    let v
    switch (field) {
      case 'precipitation':
      case 'rain':
        v = h.precipitation[k] ?? 0
        break
      case 'snowfall':
        v = h.snowfall?.[k] ?? 0
        break
      case 'cloud_cover':
        v = h.cloud_cover[k] ?? 0
        break
      case 'temperature_2m':
        v = h.temperature_2m[k] ?? 10
        break
      case 'apparent_temperature':
        v = (h.temperature_2m[k] ?? 10) - 1.5
        break
      case 'precipitation_probability':
        v = Math.min(100, Math.round((h.precipitation[k] ?? 0) * 60 + 10))
        break
      case 'is_day':
        v = 1
        break
      case 'weather_code':
        v = h.weather_code[k] ?? 1
        break
      case 'wind_gusts_10m':
        v = h.wind_gusts_10m[k] ?? 20
        break
      case 'wind_speed_10m':
        v = ((h.wind_gusts_10m[k] ?? 20) / 3.6) * 0.7 // m/s from gusts
        break
      case 'wind_direction_10m':
        v = (200 + 40 * Math.sin((i + locIdx) / 3) + 360) % 360
        break
      case 'visibility':
        v = Math.max(800, 24000 - (h.precipitation[k] ?? 0) * 4000)
        break
      case 'pressure_msl':
        v = 1012 + 3 * Math.sin(i / 6)
        break
      case 'surface_pressure':
        v = 985 + 3 * Math.sin(i / 6)
        break
      case 'relative_humidity_2m':
        v = 60 + 20 * Math.sin(i / 4)
        break
      default:
        v = 0
    }
    out.push(typeof v === 'number' ? Math.round(v * 100) / 100 : v)
  }
  void startSec
  return out
}
const omOptions = { timezone: 'GMT', omitDaily: false, noMonitors: false }
/**
 * The monitor service for the mocked suites: AirNow-style sites around the focus (Johnston, Iowa by default).
 * Readings carry the END of the observation hour (AirNow's hour label). Distances from the focus (1° lat ≈ 111.2 km):
 *   fresh        PM2.5 + ozone, 30 min old, ≈ 9 km   (PM2.5 AQI 62 Moderate, ozone AQI 41 Good)
 *   ozone-only   ozone 25 min old, ≈ 8 km            (AQI 55 Moderate) — nothing on the Smoke view
 *   edge-in      PM2.5 + ozone, 1 h 55 min old, 24.5 km north (PM2.5 AQI 160 Unhealthy, ozone AQI 70) — counts
 *   edge-out     PM2.5 30 min old, 25.5 km south     (AQI 90) — outside 25 km, never counts for the place
 *   stale-edge   PM2.5 2 h 05 min old, ≈ 5 km        — stale, never counts
 *   stale        PM2.5 + ozone, 3 h old, ≈ 19 km
 *   offline      PM2.5 site with no readings
 * noMonitors: an empty report (the "No monitor within 25 km" state).
 */
function monitorSites(url, focus) {
  const q = new URL(url).searchParams
  const now = Date.now()
  const H = 3_600_000
  const site = (id, name, dLat, dLng, parameters, readings) => ({ id, name, agency: 'Polk Co. Air Quality Division (mock)', lngLat: { lat: focus.lat + dLat, lng: focus.lng + dLng }, parameters, readings })
  const sites = omOptions.noMonitors ? [] : [
    site('mock-fresh', 'Public Works (mock)', -0.07, 0.06, ['PM2.5', 'OZONE'], [
      { parameter: 'PM2.5', value: 17.3, unit: 'UG/M3', aqi: 62, time: now - 30 * 60_000 },
      { parameter: 'OZONE', value: 44, unit: 'PPB', aqi: 41, time: now - 30 * 60_000 },
    ]),
    site('mock-ozone-only', 'Carpenter (mock)', -0.06, 0.05, ['OZONE'], [{ parameter: 'OZONE', value: 59, unit: 'PPB', aqi: 55, time: now - 25 * 60_000 }]),
    site('mock-edge-in', 'Edge 24.5 km (mock)', 24.5 / 111.2, 0, ['PM2.5', 'OZONE'], [
      { parameter: 'PM2.5', value: 72.5, unit: 'UG/M3', aqi: 160, time: now - 115 * 60_000 },
      { parameter: 'OZONE', value: 68, unit: 'PPB', aqi: 70, time: now - 115 * 60_000 },
    ]),
    site('mock-edge-out', 'Edge 25.5 km (mock)', -25.5 / 111.2, 0, ['PM2.5'], [{ parameter: 'PM2.5', value: 30.2, unit: 'UG/M3', aqi: 90, time: now - 30 * 60_000 }]),
    site('mock-stale-edge', 'Stale 2 h 05 (mock)', 0.04, -0.03, ['PM2.5'], [{ parameter: 'PM2.5', value: 12, unit: 'UG/M3', aqi: 51, time: now - 125 * 60_000 }]),
    site('mock-stale', 'Sheldahl (mock)', 0.17, 0.02, ['PM2.5', 'OZONE'], [
      { parameter: 'PM2.5', value: 9.1, unit: 'UG/M3', aqi: 38, time: now - 3 * H },
      { parameter: 'OZONE', value: 40, unit: 'PPB', aqi: 37, time: now - 3 * H },
    ]),
    site('mock-offline', 'East High (mock)', -0.1, 0.1, ['PM2.5'], []),
    // Overlap fixtures (PM2.5 only, all fresh): a Good disc meeting the Unhealthy edge-in disc; an Unhealthy-for-
    // Sensitive-Groups disc that reaches into the fresh ∩ edge-in lens (three discs); Very Unhealthy and
    // Hazardous discs off to the south-west meeting each other only.
    site('mock-good', 'Good NE (mock)', 0.3, 0.3, ['PM2.5'], [{ parameter: 'PM2.5', value: 5, unit: 'UG/M3', aqi: 21, time: now - 20 * 60_000 }]),
    site('mock-usg', 'USG west (mock)', 0.08, -0.2, ['PM2.5'], [{ parameter: 'PM2.5', value: 45, unit: 'UG/M3', aqi: 125, time: now - 20 * 60_000 }]),
    site('mock-vu', 'Very unhealthy SW (mock)', -0.3, -0.3, ['PM2.5'], [{ parameter: 'PM2.5', value: 180, unit: 'UG/M3', aqi: 250, time: now - 20 * 60_000 }]),
    site('mock-haz', 'Hazardous SW (mock)', -0.3, -0.44, ['PM2.5'], [{ parameter: 'PM2.5', value: 300, unit: 'UG/M3', aqi: 350, time: now - 20 * 60_000 }]),
  ]
  const bbox = (q.get('bbox') ?? '').split(',').map(Number)
  const inView = bbox.length === 4 && bbox.every(Number.isFinite) ? sites.filter((s) => s.lngLat.lng >= bbox[0] && s.lngLat.lng <= bbox[2] && s.lngLat.lat >= bbox[1] && s.lngLat.lat <= bbox[3]) : sites
  return { fetchedAt: now, sites: inView }
}
/** UTC offset in seconds of an IANA zone at a moment. */
function tzOffsetSec(tz, at = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at))
  const g = (t) => Number(parts.find((p) => p.type === t).value)
  return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - at) / 1000)
}
function openMeteo(url) {
  const u = new URL(url)
  const q = u.searchParams
  const lats = (q.get('latitude') ?? '0').split(',').map(Number)
  const lngs = (q.get('longitude') ?? '0').split(',').map(Number)
  const nowH = Math.floor(Date.now() / 1000 / HOUR) * HOUR
  let start = nowH - Number(q.get('past_hours') ?? 0) * HOUR
  let hours = Number(q.get('forecast_hours') ?? 0) + Number(q.get('past_hours') ?? 0)
  if (q.get('start_hour')) {
    start = Math.floor(Date.parse(q.get('start_hour') + ':00Z') / 1000 / HOUR) * HOUR
    hours = Math.max(1, Math.round((Date.parse(q.get('end_hour') + ':00Z') / 1000 - start) / HOUR) + 1)
  }
  if (!hours) hours = 24 * Number(q.get('forecast_days') ?? 2)
  const hourlyFields = (q.get('hourly') ?? '').split(',').filter(Boolean)
  const minFields = (q.get('minutely_15') ?? '').split(',').filter(Boolean)
  const curFields = (q.get('current') ?? '').split(',').filter(Boolean)
  const locs = lats.map((lat, i) => {
    const loc = { latitude: lat, longitude: lngs[i] ?? lngs[0], generationtime_ms: 0.3, utc_offset_seconds: 0, timezone: 'GMT', timezone_abbreviation: 'GMT', elevation: 280 + (i % 7) * 12 }
    if (hourlyFields.length) {
      loc.hourly_units = Object.fromEntries([['time', 'unixtime'], ...hourlyFields.map((f) => [f, 'x'])])
      loc.hourly = { time: Array.from({ length: hours }, (_, k) => start + k * HOUR) }
      for (const f of hourlyFields) loc.hourly[f] = omSeries(i, f, hours, start)
    }
    if (minFields.length) {
      const ms = Math.floor(Date.parse(q.get('start_minutely_15') + ':00Z') / 1000 / 900) * 900
      const me = Math.floor(Date.parse(q.get('end_minutely_15') + ':00Z') / 1000 / 900) * 900
      const n = Math.max(1, Math.round((me - ms) / 900) + 1)
      loc.minutely_15 = { time: Array.from({ length: n }, (_, k) => ms + k * 900) }
      for (const f of minFields) {
        const hourly = omSeries(i, f, Math.ceil(n / 4) + 1, ms)
        loc.minutely_15[f] = Array.from({ length: n }, (_, k) => (f === 'precipitation' || f === 'rain' || f === 'snowfall' ? hourly[Math.floor(k / 4)] / 4 : hourly[Math.floor(k / 4)]))
      }
    }
    if (curFields.length) {
      loc.current = { time: nowH, interval: 900 }
      for (const f of curFields) loc.current[f] = omSeries(i, f, 1, nowH)[0]
    }
    // Daily (only with `daily=`): days from today's local midnight in the resolved zone, aggregated from the
    // same hourly series (weather code at local noon, max / min temperature, precipitation sum, max probability).
    const dailyFields = (q.get('daily') ?? '').split(',').filter(Boolean)
    if (dailyFields.length && !omOptions.omitDaily) {
      const tz = q.get('timezone') === 'auto' ? omOptions.timezone : (q.get('timezone') ?? 'GMT')
      const off = tzOffsetSec(tz)
      loc.timezone = tz
      loc.utc_offset_seconds = off
      const nDays = Number(q.get('forecast_days') ?? 7)
      const localMidnight = Math.floor((Date.now() / 1000 + off) / 86400) * 86400 - off
      const days = Array.from({ length: nDays }, (_, k) => localMidnight + k * 86400)
      const hoursAll = { temperature_2m: omSeries(i, 'temperature_2m', nDays * 24, localMidnight), precipitation: omSeries(i, 'precipitation', nDays * 24, localMidnight), precipitation_probability: omSeries(i, 'precipitation_probability', nDays * 24, localMidnight), weather_code: omSeries(i, 'weather_code', nDays * 24, localMidnight) }
      const day = (k) => (arr) => arr.slice(k * 24, k * 24 + 24)
      loc.daily_units = Object.fromEntries([['time', 'unixtime'], ...dailyFields.map((f) => [f, 'x'])])
      loc.daily = { time: days }
      for (const f of dailyFields) {
        loc.daily[f] = days.map((_, k) => {
          const d = day(k)
          if (f === 'weather_code') return d(hoursAll.weather_code)[12] ?? 0
          if (f === 'temperature_2m_max') return Math.max(...d(hoursAll.temperature_2m))
          if (f === 'temperature_2m_min') return Math.min(...d(hoursAll.temperature_2m))
          if (f === 'precipitation_sum') return Math.round(d(hoursAll.precipitation).reduce((a, b) => a + (b ?? 0), 0) * 10) / 10
          if (f === 'precipitation_probability_max') return Math.max(...d(hoursAll.precipitation_probability).map((v) => v ?? 0))
          return null
        })
      }
    }
    return loc
  })
  return locs.length === 1 ? locs[0] : locs
}

// ---------- Radar: 10-min frames ending ~10 min ago + one generated 512×512 PNG for every tile ----------
function crc32(buf) {
  let c
  const table = crc32.t ?? (crc32.t = Array.from({ length: 256 }, (_, n) => { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 }))
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
let radarPng = null
function radarTile() {
  if (radarPng) return radarPng
  const w = 512
  const raw = Buffer.alloc((w * 4 + 1) * w)
  for (let y = 0; y < w; y++) {
    raw[y * (w * 4 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4
      // a few soft blobs, mostly transparent (what a quiet radar frame looks like)
      const d1 = Math.hypot(x - 160, y - 200) / 90
      const d2 = Math.hypot(x - 380, y - 330) / 60
      const a = Math.max(0, 1 - d1, 1 - d2)
      raw[o] = 60
      raw[o + 1] = 140
      raw[o + 2] = 220
      raw[o + 3] = Math.round(a * 180)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(w, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  radarPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
  return radarPng
}
function rainviewer() {
  const now = Math.floor(Date.now() / 1000 / 600) * 600 - 600
  const past = Array.from({ length: 13 }, (_, i) => ({ time: now - (12 - i) * 600, path: `/v2/radar/${now - (12 - i) * 600}` }))
  const nowcast = Array.from({ length: 3 }, (_, i) => ({ time: now + (i + 1) * 600, path: `/v2/radar/nowcast_${now + (i + 1) * 600}` }))
  return { version: '2.0', generated: now, host: 'https://tilecache.rainviewer.com', radar: { past, nowcast }, satellite: { infrared: [] } }
}

// ---------- GIBS capabilities: GeoColor + Band13 for east/west with a 3 h / 10 min range ----------
function gibsCapabilities() {
  const end = new Date(Math.floor((Date.now() - 70 * 60_000) / 600_000) * 600_000)
  const start = new Date(end.getTime() - 3 * 3_600_000)
  const layer = (id) => `<Layer><ows:Identifier>${id}</ows:Identifier><Dimension><ows:Identifier>Time</ows:Identifier><Default>${end.toISOString()}</Default><Value>${start.toISOString()}/${end.toISOString()}/PT10M</Value></Dimension></Layer>`
  return `<?xml version="1.0"?><Capabilities>${['GOES-East_ABI_GeoColor', 'GOES-East_ABI_Band13_Clean_Infrared', 'GOES-West_ABI_GeoColor', 'GOES-West_ABI_Band13_Clean_Infrared'].map(layer).join('')}</Capabilities>`
}

// ---------- NWS station observations ----------
function nws(url, focus, alerts = []) {
  const u = new URL(url)
  if (u.pathname.startsWith('/points/')) return { properties: { observationStations: 'https://api.weather.gov/gridpoints/DMX/73,52/stations', gridId: 'DMX', gridX: 73, gridY: 52 } }
  if (/\/stations$/.test(u.pathname)) return { features: [{ properties: { stationIdentifier: 'KDSM', name: 'Des Moines International Airport' }, geometry: { coordinates: [focus.lng - 0.08, focus.lat - 0.1] } }, { properties: { stationIdentifier: 'KIKV', name: 'Ankeny Regional Airport' }, geometry: { coordinates: [focus.lng + 0.1, focus.lat + 0.06] } }] }
  if (/\/observations\/latest$/.test(u.pathname)) {
    const qv = (value, unitCode) => ({ value, unitCode })
    return { geometry: { coordinates: [focus.lng - 0.08, focus.lat - 0.1] }, properties: { timestamp: new Date(Date.now() - 12 * 60_000).toISOString(), textDescription: 'Mostly Cloudy', temperature: qv(14.4, 'wmoUnit:degC'), windDirection: qv(210, 'wmoUnit:degree_(angle)'), windSpeed: qv(18.4, 'wmoUnit:km_h-1'), windGust: qv(31, 'wmoUnit:km_h-1'), barometricPressure: qv(98530, 'wmoUnit:Pa'), seaLevelPressure: qv(101250, 'wmoUnit:Pa'), relativeHumidity: qv(68, 'wmoUnit:percent'), precipitationLastHour: qv(0.3, 'wmoUnit:mm'), precipitationLast3Hours: qv(null, 'wmoUnit:mm'), precipitationLast6Hours: qv(null, 'wmoUnit:mm') } }
  }
  // `alerts` (installMocks option): synthetic active alerts for the point, e.g. [{ event: 'Severe Thunderstorm Warning', severity: 'Severe' }].
  if (u.pathname.startsWith('/alerts/active')) return { type: 'FeatureCollection', features: alerts.map((a, i) => ({ properties: { id: `mock-${i}`, event: a.event, severity: a.severity ?? 'Severe', urgency: 'Expected', certainty: 'Likely', headline: a.headline ?? `${a.event} issued ${new Date().toUTCString()}`, description: a.description ?? 'Mock alert text.', instruction: a.instruction ?? null, onset: new Date(Date.now() - 10 * 60_000).toISOString(), ends: new Date(Date.now() + 90 * 60_000).toISOString(), expires: new Date(Date.now() + 90 * 60_000).toISOString(), senderName: 'NWS Des Moines IA', areaDesc: 'Polk, IA', messageType: 'Alert', ...a } })) }
  if (u.pathname.startsWith('/zones/')) return { geometry: null, properties: {} }
  return {}
}

// ---------- River gauges from the rivers snapshot (positions laid out around the focus) ----------
// Geocoder: a few Iowa places so a suite can change place to somewhere *different*; anything else is Iowa City.
const PLACES = [
  { re: /ames/i, name: 'Ames', latitude: 42.0308, longitude: -93.6319, admin2: 'Story County' },
  { re: /cedar/i, name: 'Cedar Rapids', latitude: 41.9779, longitude: -91.6656, admin2: 'Linn County' },
  { re: /johnston/i, name: 'Johnston', latitude: 41.673, longitude: -93.698, admin2: 'Polk County' },
  { re: /des moines/i, name: 'Des Moines', latitude: 41.5868, longitude: -93.625, admin2: 'Polk County' },
  { re: /miami/i, name: 'Miami', latitude: 25.7617, longitude: -80.1918, admin1: 'Florida', admin2: 'Miami-Dade County' },
]
function geocode(q) {
  const p = PLACES.find((x) => x.re.test(q)) ?? { name: 'Iowa City', latitude: 41.6611, longitude: -91.5302, admin2: 'Johnson County' }
  return { name: p.name, latitude: p.latitude, longitude: p.longitude, country: 'United States', admin1: p.admin1 ?? 'Iowa', admin2: p.admin2 }
}
function nwps(url, focus) {
  const u = new URL(url)
  const lids = saved.rivers.nwpsLids
  const pos = (i) => ({ lat: focus.lat + 0.25 * Math.sin(i * 1.7) * (1 + (i % 3) / 3), lng: focus.lng + 0.3 * Math.cos(i * 1.3) * (1 + (i % 4) / 4) })
  const status = (i) => ({ observed: { primary: 4 + (i % 9) * 0.7, primaryUnit: 'ft', secondary: 1.2 + (i % 5), secondaryUnit: 'kcfs', floodCategory: i % 11 === 0 ? 'action' : 'no_flooding', validTime: new Date(Date.now() - 20 * 60_000).toISOString() }, forecast: { primary: 4.2 + (i % 9) * 0.7, primaryUnit: 'ft', secondary: -999, secondaryUnit: 'kcfs', floodCategory: 'no_flooding', validTime: new Date(Date.now() + 6 * 3_600_000).toISOString() } })
  const m = u.pathname.match(/\/gauges\/([^/]+)$/)
  if (m) {
    const i = Math.max(0, lids.indexOf(m[1]))
    return { lid: m[1], name: `Gauge ${m[1]}`, latitude: pos(i).lat, longitude: pos(i).lng, status: status(i), usgsId: (saved.rivers.sites[i] ?? 'USGS-00000000').replace('USGS-', ''), flood: { stageUnits: 'ft', flowUnits: 'kcfs', categories: { action: { stage: 12, flow: 10 }, minor: { stage: 15, flow: 14 }, moderate: { stage: 18, flow: 18 }, major: { stage: 22, flow: 24 } } } }
  }
  return { gauges: lids.map((lid, i) => ({ lid, name: `Gauge ${lid}`, latitude: pos(i).lat, longitude: pos(i).lng, status: status(i) })) }
}
function usgs(url, focus) {
  const u = new URL(url)
  const sites = saved.rivers.sites
  const pos = (i) => ({ lat: focus.lat + 0.2 * Math.sin(i * 2.1), lng: focus.lng + 0.28 * Math.cos(i * 1.9) })
  const now = new Date().toISOString()
  if (u.pathname.includes('/latest-continuous/')) {
    const features = []
    sites.forEach((id, i) => {
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [pos(i).lng, pos(i).lat] }, properties: { monitoring_location_id: id, parameter_code: '00060', time: now, value: String((saved.rivers.medians[id]?.median ?? 500) * (1 + (i % 4) * 0.15)), unit_of_measure: 'ft^3/s', approval_status: 'Provisional' } })
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [pos(i).lng, pos(i).lat] }, properties: { monitoring_location_id: id, parameter_code: '00065', time: now, value: String(3 + (i % 6) * 0.8), unit_of_measure: 'ft', approval_status: 'Provisional' } })
    })
    return { type: 'FeatureCollection', features }
  }
  if (u.pathname.includes('/monitoring-locations/')) return { type: 'FeatureCollection', features: sites.map((id, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [pos(i).lng, pos(i).lat] }, properties: { monitoring_location_number: id.replace('USGS-', ''), monitoring_location_name: `Stream at site ${i + 1}`, site_type_code: 'ST' } })) }
  if (u.pathname.includes('/daily/')) {
    const features = []
    for (const id of sites) for (let d = 0; d < 10; d++) features.push({ type: 'Feature', geometry: null, properties: { monitoring_location_id: id, parameter_code: '00060', statistic_id: '00003', time: new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10), value: String(saved.rivers.medians[id]?.median ?? 500), approval_status: 'Provisional' } })
    return { type: 'FeatureCollection', features }
  }
  return { type: 'FeatureCollection', features: [] }
}

// ---------- Routing from the recorded Valhalla route ----------
function encodePolyline6(coords) {
  let out = ''
  let plat = 0
  let plng = 0
  const enc = (v) => {
    let s = v < 0 ? ~(v << 1) : v << 1
    let str = ''
    while (s >= 0x20) {
      str += String.fromCharCode((0x20 | (s & 0x1f)) + 63)
      s >>= 5
    }
    return str + String.fromCharCode(s + 63)
  }
  for (const [lng, lat] of coords) {
    const la = Math.round(lat * 1e6)
    const ln = Math.round(lng * 1e6)
    out += enc(la - plat) + enc(ln - plng)
    plat = la
    plng = ln
  }
  return out
}
function valhalla() {
  const trip = (r) => ({ legs: [{ shape: encodePolyline6(r.coords), maneuvers: [{ time: r.durationS, length: r.distanceM / 1000, begin_shape_index: 0, end_shape_index: r.coords.length - 1, instruction: r.summary || 'Drive' }], summary: { length: r.distanceM / 1000, time: r.durationS } }], summary: { length: r.distanceM / 1000, time: r.durationS } })
  const [main, ...alts] = saved.route.routes
  return { trip: trip(main), alternates: alts.map((a) => ({ trip: trip(a) })) }
}

/** The FOSSGIS demo's limit: a path over 1 500 km answers 400 (error 154). Otherwise the recorded Iowa route. */
function valhallaFor(url) {
  try {
    const body = JSON.parse(new URL(url).searchParams.get('json') ?? '{}')
    const [a, b] = body.locations ?? []
    if (a && b && hav(a.lat, a.lon, b.lat, b.lon) > 1_500_000) return json({ error_code: 154, error: 'Path distance exceeds the max distance limit: 1500000 meters', status_code: 400, status: 'Bad Request' }, 400)
  } catch {
    /* fall through */
  }
  return json(valhalla())
}
const hav = (lat1, lon1, lat2, lon2) => { const r = Math.PI / 180; const dLat = (lat2 - lat1) * r; const dLon = (lon2 - lon1) * r; const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2; return 2 * 6371000 * Math.asin(Math.sqrt(s)) }
/** OSRM: a straight-line route with 60 vertices, duration at 90 km/h (so a coast-to-coast trip runs past 24 h). */
function osrm(url) {
  const m = new URL(url).pathname.match(/driving\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)/)
  if (!m) return { code: 'NoRoute', routes: [] }
  const [lng1, lat1, lng2, lat2] = m.slice(1).map(Number)
  const n = 60
  const coords = Array.from({ length: n }, (_, i) => [lng1 + ((lng2 - lng1) * i) / (n - 1), lat1 + ((lat2 - lat1) * i) / (n - 1)])
  const distance = hav(lat1, lng1, lat2, lng2) * 1.15
  const duration = distance / (90 / 3.6)
  const seg = Array.from({ length: n - 1 }, () => duration / (n - 1))
  return { code: 'Ok', routes: [{ distance, duration, geometry: { type: 'LineString', coordinates: coords }, legs: [{ annotation: { duration: seg } }] }] }
}

// ---------- RWIS "currents" from the archive's last observation per station ----------
function rwisCurrents() {
  const lines = saved.rwisCsv.trim().split('\n').slice(1)
  const last = new Map()
  for (const l of lines) {
    const f = l.split(',')
    last.set(f[0], f)
  }
  const data = []
  for (const [id, m] of Object.entries(saved.rwisStations)) {
    const f = last.get(id)
    data.push({ station: id, name: m.name, network: 'IA_RWIS', utc_valid: new Date(Date.now() - (8 + data.length * 3) * 60_000).toISOString(), tmpf: f ? Number(f[2]) : 40, lon: m.lng, lat: m.lat, scond0: f?.[5] || null, tsf0: f && f[4] !== '' ? Number(f[4]) : null, scond1: f?.[7] || null, tsf1: f && f[6] !== '' ? Number(f[6]) : null })
  }
  return { data }
}

const json = (body, status = 200) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })

// ---------- Basemap: the REAL style / sprites / glyphs harvested from a local service-worker cache
// (e2e-shots/perf/basemap, see BUILD_LOG) + EMPTY vector tiles. MapLibre still parses the style, manages
// sources and tiles and runs its worker, but draws no roads/labels — tile hosts were at their daily
// cap, so basemap render cost is under-represented tonight; the live walkthrough covers it.
const BASEMAP_DIR = 'e2e-shots/perf/basemap'
const basemapIndex = existsSync(`${BASEMAP_DIR}/index.json`) ? F(`${BASEMAP_DIR}/index.json`) : {}
function basemap(url) {
  const p = new URL(url).pathname
  // The harvested sprite is the @2x variant of one sprite version; serve it for any version/density the style asks for.
  const spriteKey = /\/sprites\/[^/]+\/ofm(@2x)?\.(json|png)$/.test(p) ? Object.keys(basemapIndex).find((k) => k.endsWith(p.endsWith('.json') ? '.json' : '.png') && k.includes('/sprites/')) : null
  const hit = basemapIndex[p] ?? (spriteKey ? basemapIndex[spriteKey] : undefined)
  if (hit) return { status: 200, contentType: hit.type || 'application/octet-stream', headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=86400' }, body: readFileSync(`${BASEMAP_DIR}/${hit.file}`) }
  if (/\.pbf$/.test(p) && !p.includes('/fonts/')) return { status: 200, contentType: 'application/x-protobuf', headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=86400' }, body: Buffer.alloc(0) } // empty vector tile
  if (p.includes('/fonts/')) return { status: 204, headers: { 'access-control-allow-origin': '*' }, body: '' }
  if (p.startsWith('/planet')) return json({ tilejson: '3.0.0', tiles: ['https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 })
  return { status: 404, body: '' }
}
// Terrain (terrarium PNG, gentle synthetic slope) and GIBS tiles (tinted PNG): synthetic, timing only.
let terrainPng = null
function terrainTile() {
  if (terrainPng) return terrainPng
  const w = 256
  const raw = Buffer.alloc((w * 4 + 1) * w)
  for (let y = 0; y < w; y++) {
    raw[y * (w * 4 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const h = 32768 + 300 + 40 * Math.sin(x / 23) + 30 * Math.cos(y / 17) // terrarium: h = R*256 + G + B/256 - 32768
      const o = y * (w * 4 + 1) + 1 + x * 4
      raw[o] = Math.floor(h / 256)
      raw[o + 1] = Math.floor(h % 256)
      raw[o + 2] = Math.floor((h % 1) * 256)
      raw[o + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(w, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  terrainPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
  return terrainPng
}

/**
 * Install the mocks on a Playwright context. `focus` is the geolocation the session uses.
 * Returns { live: string[] } — URLs that fell through to the network (should stay empty in replay).
 */
export async function installMocks(context, { har = null, record = false, focus = { lat: 41.673, lng: -93.698 }, failHosts = [], failStatus = 429, alerts = [], liveTiles = false, delayHosts = {}, timezone = 'GMT', omitDaily = false, noMonitors = false } = {}) {
  const live = []
  // timezone: the IANA zone the mock's Open-Meteo answers resolve for `timezone=auto` (daily days roll over at
  // that zone's midnight); omitDaily: answer without the daily block (the 7-day tile's own error state);
  // noMonitors: the monitor service answers with no sites (the "No monitor within 25 km" state).
  omOptions.timezone = timezone
  omOptions.omitDaily = omitDaily
  omOptions.noMonitors = noMonitors
  // delayHosts: { host: ms } — the answer is held that long (live latency, for races such as Clear while a
  // hazards / road fetch is in flight).
  // liveTiles: the APIs are answered locally but the tile hosts (basemap, radar, satellite, terrain)
  // go to the network — through the guard, which must be registered before this (it counts them).
  const TILE_HOST = /^(tiles\.openfreemap\.org|tilecache\.rainviewer\.com|gibs\.earthdata\.nasa\.gov|s3\.amazonaws\.com)$/
  if (har) {
    await context.routeFromHAR(har, { update: record, notFound: record ? 'fallback' : 'abort', url: /^https:\/\/(tiles\.openfreemap\.org|s3\.amazonaws\.com|gibs\.earthdata\.nasa\.gov)\// })
  }
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|\[::1\])/, async (route, req) => {
    const url = req.url()
    const host = new URL(url).host
    if (liveTiles && TILE_HOST.test(host)) return route.fallback()
    // Live tiles need the live frame lists: the mock's radar paths are synthetic and the real tile host
    // answers them 410, which MapLibre treats as an errored tile and re-requests on every loop (Oct 9).
    if (liveTiles && (host === 'api.rainviewer.com' || (host === 'gibs.earthdata.nasa.gov' && url.includes('WMTSCapabilities')))) return route.fallback()
    globalThis.__qaMockedRequest?.(url)
    if (delayHosts[host]) await new Promise((r) => setTimeout(r, delayHosts[host]))
    try {
      if (/open-meteo\.com\/v1\/(forecast|era5)/.test(url)) return route.fulfill(json(openMeteo(url)))
      if (host === 'archive-api.open-meteo.com' || host === 'historical-forecast-api.open-meteo.com') return route.fulfill(json(openMeteo(url)))
      if (host === 'monitors.stormscope.test') return route.fulfill(json(monitorSites(url, focus)))
      if (host === 'geocoding-api.open-meteo.com') return route.fulfill(json({ results: [geocode(new URL(url).searchParams.get('name') ?? '')] }))
      if (host === 'nominatim.openstreetmap.org') return route.fulfill(json(url.includes('/reverse') ? { name: 'Johnston', display_name: 'Johnston, Polk County, Iowa, United States', address: { city: 'Johnston', state: 'Iowa', country: 'United States' } } : []))
      if (host === 'api.rainviewer.com') return route.fulfill(json(rainviewer()))
      if (host === 'tilecache.rainviewer.com') return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=600' }, body: radarTile() })
      if (host === 'api.weather.gov' || host === 'alerts.weather.gov') return route.fulfill(json(nws(url, focus, alerts)))
      if (host === 'api.water.noaa.gov') return route.fulfill(json(nwps(url, focus)))
      if (host === 'api.waterdata.usgs.gov') return route.fulfill(json(usgs(url, focus)))
      if (host === 'hydro.nationalmap.gov') return route.fulfill(json({ type: 'FeatureCollection', features: [] }))
      if (host === 'valhalla1.openstreetmap.de') return route.fulfill(valhallaFor(url))
      if (host === 'router.project-osrm.org') return route.fulfill(json(osrm(url)))
      if (host === 'mesonet.agron.iastate.edu') return route.fulfill(url.includes('currents.json') ? json(rwisCurrents()) : json({ type: 'FeatureCollection', features: [] }))
      if (host === 'mapservices.weather.noaa.gov') return route.fulfill(json({ type: 'FeatureCollection', features: [] }))
      if (host === 'gibs.earthdata.nasa.gov' && url.includes('WMTSCapabilities')) return route.fulfill({ status: 200, contentType: 'application/xml', headers: { 'access-control-allow-origin': '*' }, body: gibsCapabilities() })
      if (!har) {
        if (host === 'tiles.openfreemap.org') return route.fulfill(basemap(url))
        if (host === 's3.amazonaws.com') return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=86400' }, body: terrainTile() })
        if (host === 'gibs.earthdata.nasa.gov') return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=600' }, body: radarTile() })
      }
    } catch (e) {
      return route.fulfill(json({ error: true, reason: String(e) }, 500))
    }
    // Tile hosts handled by the HAR route (registered first, so it runs after this one falls through).
    live.push(url)
    return route.fallback()
  })
  // failHosts: hosts that answer 429 (to exercise the app's rate-limit / unavailable wording). Registered
  // last so Playwright runs it first.
  // failStatus: 429 by default (the app retries and keeps its loading state); 500 for a hard error state.
  if (failHosts.length) await context.route((u) => failHosts.includes(new URL(u).host), (route) => route.fulfill({ status: failStatus, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: true, reason: failStatus === 429 ? 'Minutely API request limit exceeded (harness)' : `Server error ${failStatus} (harness)` }) }))
  return { live }
}
