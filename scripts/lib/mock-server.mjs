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
function nws(url, focus) {
  const u = new URL(url)
  if (u.pathname.startsWith('/points/')) return { properties: { observationStations: 'https://api.weather.gov/gridpoints/DMX/73,52/stations', gridId: 'DMX', gridX: 73, gridY: 52 } }
  if (/\/stations$/.test(u.pathname)) return { features: [{ properties: { stationIdentifier: 'KDSM', name: 'Des Moines International Airport' }, geometry: { coordinates: [focus.lng - 0.08, focus.lat - 0.1] } }, { properties: { stationIdentifier: 'KIKV', name: 'Ankeny Regional Airport' }, geometry: { coordinates: [focus.lng + 0.1, focus.lat + 0.06] } }] }
  if (/\/observations\/latest$/.test(u.pathname)) {
    const qv = (value, unitCode) => ({ value, unitCode })
    return { geometry: { coordinates: [focus.lng - 0.08, focus.lat - 0.1] }, properties: { timestamp: new Date(Date.now() - 12 * 60_000).toISOString(), textDescription: 'Mostly Cloudy', temperature: qv(14.4, 'wmoUnit:degC'), windDirection: qv(210, 'wmoUnit:degree_(angle)'), windSpeed: qv(18.4, 'wmoUnit:km_h-1'), windGust: qv(31, 'wmoUnit:km_h-1'), barometricPressure: qv(98530, 'wmoUnit:Pa'), seaLevelPressure: qv(101250, 'wmoUnit:Pa'), relativeHumidity: qv(68, 'wmoUnit:percent'), precipitationLastHour: qv(0.3, 'wmoUnit:mm'), precipitationLast3Hours: qv(null, 'wmoUnit:mm'), precipitationLast6Hours: qv(null, 'wmoUnit:mm') } }
  }
  if (u.pathname.startsWith('/alerts/active')) return { type: 'FeatureCollection', features: [] }
  if (u.pathname.startsWith('/zones/')) return { geometry: null, properties: {} }
  return {}
}

// ---------- River gauges from the rivers snapshot (positions laid out around the focus) ----------
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
  const hit = basemapIndex[p]
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
export async function installMocks(context, { har = null, record = false, focus = { lat: 41.673, lng: -93.698 }, failHosts = [] } = {}) {
  const live = []
  // failHosts: hosts that answer 429 (to exercise the app's rate-limit / unavailable wording).
  if (failHosts.length) await context.route((u) => failHosts.includes(new URL(u).host), (route) => route.fulfill({ status: 429, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: true, reason: 'Minutely API request limit exceeded (harness)' }) }))
  if (har) {
    await context.routeFromHAR(har, { update: record, notFound: record ? 'fallback' : 'abort', url: /^https:\/\/(tiles\.openfreemap\.org|s3\.amazonaws\.com|gibs\.earthdata\.nasa\.gov)\// })
  }
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|\[::1\])/, async (route, req) => {
    const url = req.url()
    const host = new URL(url).host
    try {
      if (/open-meteo\.com\/v1\/(forecast|era5)/.test(url)) return route.fulfill(json(openMeteo(url)))
      if (host === 'archive-api.open-meteo.com' || host === 'historical-forecast-api.open-meteo.com') return route.fulfill(json(openMeteo(url)))
      if (host === 'geocoding-api.open-meteo.com') return route.fulfill(json({ results: [{ name: 'Iowa City', latitude: 41.6611, longitude: -91.5302, country: 'United States', admin1: 'Iowa', admin2: 'Johnson County' }] }))
      if (host === 'nominatim.openstreetmap.org') return route.fulfill(json(url.includes('/reverse') ? { name: 'Johnston', display_name: 'Johnston, Polk County, Iowa, United States', address: { city: 'Johnston', state: 'Iowa', country: 'United States' } } : []))
      if (host === 'api.rainviewer.com') return route.fulfill(json(rainviewer()))
      if (host === 'tilecache.rainviewer.com') return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=600' }, body: radarTile() })
      if (host === 'api.weather.gov' || host === 'alerts.weather.gov') return route.fulfill(json(nws(url, focus)))
      if (host === 'api.water.noaa.gov') return route.fulfill(json(nwps(url, focus)))
      if (host === 'api.waterdata.usgs.gov') return route.fulfill(json(usgs(url, focus)))
      if (host === 'hydro.nationalmap.gov') return route.fulfill(json({ type: 'FeatureCollection', features: [] }))
      if (host === 'valhalla1.openstreetmap.de') return route.fulfill(json(valhalla()))
      if (host === 'router.project-osrm.org') return route.fulfill(json({ code: 'NoRoute', routes: [] }, 400))
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
  return { live }
}
