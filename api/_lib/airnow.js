// Pure helpers for the AirNow monitor service (no network, no key): unit-tested by scripts/monitor-service-check.mjs.
//
// AirNow Data Exchange Guidelines (EPA, August 2025): observational data are preliminary and not fully verified;
// credit the reporting agencies and the EPA AirNow program; values disseminated unaltered with the EPA AQI
// colours; displays must say the data are preliminary. The service passes AirNow's values through untouched.

export const PARAMS = { OZONE: 'OZONE', O3: 'OZONE', 'PM2.5': 'PM2.5', PM25: 'PM2.5', PM10: 'PM10', NO2: 'NO2', SO2: 'SO2', CO: 'CO' }
export const CREDIT = 'EPA AirNow and the reporting air quality agencies · preliminary data'

/** Snap a bbox outward to a 0.25° grid: repeated URLs for nearby views, so the CDN cache and AirNow see few distinct requests. */
export function quantizeBbox({ west, south, east, north }, step = 0.25) {
  const f = (v) => Math.floor(v / step) * step
  const c = (v) => Math.ceil(v / step) * step
  return { west: Math.max(-180, f(west)), south: Math.max(-90, f(south)), east: Math.min(180, c(east)), north: Math.min(90, c(north)) }
}

export function parseBbox(s) {
  const v = String(s ?? '').split(',').map(Number)
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) return null
  const [west, south, east, north] = v
  if (west >= east || south >= north || north - south > 6 || east - west > 8) return null
  return { west, south, east, north }
}

/**
 * AirNow's "UTC" field ("2026-10-17T20:00") labels the hour the reading is reported for, and that label is
 * the END of the observation hour: on Oct 17, 2026 the records labelled 20:00 UTC were already published at
 * 20:29 UTC (AirNow posts an hour's data 10–30 min after it ends), so a label cannot be the start of an hour
 * still in progress. The reading's time is the label itself; ages count from it.
 */
export function readingTimeMs(utc) {
  const t = Date.parse(String(utc).replace(/Z?$/, 'Z'))
  return Number.isFinite(t) ? t : null
}

/**
 * AirNow /aq/data records (verbose, dataType B) → the service's sites: one entry per site, the latest reading
 * per parameter. Record fields used: Latitude, Longitude, UTC, Parameter, Unit, Value, AQI, SiteName,
 * AgencyName, FullAQSCode / IntlAQSCode (whichever is present).
 */
export function sitesFromRecords(records, { all = false } = {}) {
  const bySite = new Map()
  for (const r of records ?? []) {
    const param = PARAMS[String(r.Parameter ?? '').toUpperCase().replace(/\s/g, '')] ?? PARAMS[r.Parameter]
    if (!param) continue
    const lat = Number(r.Latitude), lng = Number(r.Longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    const id = String(r.FullAQSCode ?? r.IntlAQSCode ?? `${lat.toFixed(4)},${lng.toFixed(4)}`)
    const time = readingTimeMs(r.UTC)
    if (time == null) continue
    let site = bySite.get(id)
    if (!site) {
      site = { id, name: String(r.SiteName ?? id), agency: String(r.AgencyName ?? ''), lngLat: { lng, lat }, parameters: [], readings: [] }
      bySite.set(id, site)
    }
    if (!site.parameters.includes(param)) site.parameters.push(param)
    const aqi = r.AQI == null || r.AQI < 0 ? null : Number(r.AQI)
    const reading = { parameter: param, value: r.Value == null ? null : Number(r.Value), unit: String(r.Unit ?? ''), aqi: Number.isFinite(aqi) ? aqi : null, time }
    // The agency's raw hourly concentration (−999 = missing), only when the upstream query asked for it.
    if (r.RawConcentration != null) reading.raw = Number(r.RawConcentration) < -900 ? null : Number(r.RawConcentration)
    if (all) {
      // Diagnostic: every reading in the window, oldest first.
      site.readings.push(reading)
      site.readings.sort((a, b) => a.time - b.time || a.parameter.localeCompare(b.parameter))
      continue
    }
    const i = site.readings.findIndex((x) => x.parameter === param)
    if (i < 0) site.readings.push(reading)
    else if (site.readings[i].time < time) site.readings[i] = reading
  }
  return [...bySite.values()]
}

/** Diagnostic window: `end=YYYY-MM-DDTHH` (UTC hour), accepted only within the last 72 h and not in the future. */
export function parseEndHour(s, now = Date.now()) {
  if (!s || !/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(String(s))) return null
  const t = Date.parse(`${s}:00:00Z`)
  if (!Number.isFinite(t) || t > now || t < now - 72 * 3_600_000) return null
  return t
}

/**
 * Merge the monitoring-site list (every site, even with no recent data) into the sites with readings, so an
 * offline monitor is still a (grey) dot. Site-list rows: { id, name, agency, lat, lng, parameters[] }.
 */
export function mergeSiteList(sites, listRows, bbox) {
  const out = new Map(sites.map((s) => [s.id, s]))
  for (const row of listRows ?? []) {
    if (row.lng < bbox.west || row.lng > bbox.east || row.lat < bbox.south || row.lat > bbox.north) continue
    const existing = out.get(row.id)
    if (existing) {
      for (const p of row.parameters) if (!existing.parameters.includes(p)) existing.parameters.push(p)
      continue
    }
    out.set(row.id, { id: row.id, name: row.name, agency: row.agency, lngLat: { lng: row.lng, lat: row.lat }, parameters: [...row.parameters], readings: [] })
  }
  return [...out.values()]
}

/** Parse AirNow's public monitoring_site_locations.dat (pipe-separated; one row per site × parameter). */
export function parseSiteList(text) {
  const rows = new Map()
  for (const line of String(text).split('\n')) {
    const c = line.split('|')
    if (c.length < 13) continue
    const param = PARAMS[String(c[1]).toUpperCase().replace(/\s/g, '')]
    if (!param) continue
    if (c[12] !== 'US' && c[12] !== 'CA' && c[12] !== 'MX') continue
    const id = c[0], lat = Number(c[8]), lng = Number(c[9])
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    let row = rows.get(id)
    if (!row) {
      row = { id, name: c[3], agency: c[6], lat, lng, parameters: [], active: c[4] === 'Active' }
      rows.set(id, row)
    }
    if (!row.parameters.includes(param)) row.parameters.push(param)
  }
  return [...rows.values()].filter((r) => r.active)
}

/** The AirNow data query for a bbox: the last three hours (the latest hour is often not yet published). */
export function upstreamUrl(bbox, now = Date.now(), key = '', { end: endAt = null, raw = false } = {}) {
  const fmt = (t) => new Date(t).toISOString().slice(0, 13)
  const end = Math.floor((endAt ?? now) / 3_600_000) * 3_600_000
  const start = end - 3 * 3_600_000
  const q = new URLSearchParams({
    startDate: fmt(start),
    endDate: fmt(end),
    parameters: 'OZONE,PM25',
    BBOX: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    dataType: 'B',
    format: 'application/json',
    verbose: '1',
    monitorType: '0',
    includerawconcentrations: raw ? '1' : '0',
    API_KEY: key,
  })
  return `https://www.airnowapi.org/aq/data/?${q.toString()}`
}
