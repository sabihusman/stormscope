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
 * AirNow's "UTC" field ("2026-10-17T20:00") is the START of the measurement hour — the same label as AirNow's
 * hourly files, which document it as "the beginning of the measurement period" (matched value for value against
 * the files on Oct 17, 2026; see BUILD_LOG). A completed hourly average therefore ended at label + 1 h, which
 * is the reading's time; "N min ago" and the 2 h freshness rule count from it. A row whose hour has not ended
 * at fetch time is AirNow's placeholder for the hour in progress (published 10–30 min into the hour with no
 * raw concentration and the previous hour's NowCast value repeated), and the same placeholder stays under a
 * finished hour's label until the agency's measurement for it arrives (10–30 min after the hour; some stations
 * report hours late). `sitesFromRecords` keeps only rows with a raw concentration, so the latest reading is
 * always the newest MEASURED hour and its age the true age.
 */
export function hourEndMs(utc) {
  const t = Date.parse(String(utc).replace(/Z?$/, 'Z'))
  return Number.isFinite(t) ? t + 3_600_000 : null
}

/**
 * AirNow /aq/data records (verbose, dataType B) → the service's sites: one entry per site, the latest reading
 * per parameter. Record fields used: Latitude, Longitude, UTC, Parameter, Unit, Value, AQI, SiteName,
 * AgencyName, FullAQSCode / IntlAQSCode (whichever is present).
 */
export function sitesFromRecords(records, now = Date.now()) {
  const bySite = new Map()
  for (const r of records ?? []) {
    const param = PARAMS[String(r.Parameter ?? '').toUpperCase().replace(/\s/g, '')] ?? PARAMS[r.Parameter]
    if (!param) continue
    const lat = Number(r.Latitude), lng = Number(r.Longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    const id = String(r.FullAQSCode ?? r.IntlAQSCode ?? `${lat.toFixed(4)},${lng.toFixed(4)}`)
    const time = hourEndMs(r.UTC)
    if (time == null) continue
    if (time > now) continue // the hour in progress: a NowCast placeholder, not a measurement
    let site = bySite.get(id)
    if (!site) {
      site = { id, name: String(r.SiteName ?? id), agency: String(r.AgencyName ?? ''), lngLat: { lng, lat }, parameters: [], readings: [] }
      bySite.set(id, site)
    }
    if (!site.parameters.includes(param)) site.parameters.push(param)
    const aqi = r.AQI == null || r.AQI < 0 ? null : Number(r.AQI)
    // raw: the agency's hourly concentration as reported (−999 = none → null); negative values are below the
    // instrument's detection limit and are shown as such — the AQI stays as AirNow reports it.
    const rawC = r.RawConcentration == null ? null : Number(r.RawConcentration)
    const reading = { parameter: param, value: r.Value == null ? null : Number(r.Value), unit: String(r.Unit ?? ''), aqi: Number.isFinite(aqi) ? aqi : null, time, raw: rawC == null || !Number.isFinite(rawC) || rawC <= -900 ? null : rawC }
    // Only rows with a real measurement count: a row with no raw concentration is AirNow's placeholder (the
    // previous hour's NowCast copied under the next label, published before the agency's hour arrives), so
    // the newest row WITH a raw value is the station's latest reading and its age is the true age.
    if (reading.raw == null) continue
    const i = site.readings.findIndex((x) => x.parameter === param)
    if (i < 0) site.readings.push(reading)
    else if (site.readings[i].time < time) site.readings[i] = reading
  }
  return [...bySite.values()]
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
export function upstreamUrl(bbox, now = Date.now(), key = '') {
  const fmt = (t) => new Date(t).toISOString().slice(0, 13)
  const end = Math.floor(now / 3_600_000) * 3_600_000
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
    includerawconcentrations: '1',
    API_KEY: key,
  })
  return `https://www.airnowapi.org/aq/data/?${q.toString()}`
}
