// The monitor service's pure logic (api/_lib/airnow.js), without network or key:
//   bbox snapping and validation; AirNow records → sites with the latest reading per parameter, times at the
//   END of the observation hour (AirNow's hour label, no hour added), parameter names normalised (PM25 → PM2.5, O3 → OZONE); the site list merged so
//   an offline monitor is still listed; the upstream query shape (last three hours, OZONE,PM25, bbox, JSON).
//   node scripts/monitor-service-check.mjs [base-url] [shots-dir] [--mock]   (node only; base-url ignored)
import { readingTimeMs, mergeSiteList, parseBbox, parseSiteList, quantizeBbox, sitesFromRecords, upstreamUrl } from '../api/_lib/airnow.js'

const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}

// bbox
const q = quantizeBbox({ west: -93.83, south: 41.41, east: -93.48, north: 41.98 })
check('quantizeBbox snaps outward to 0.25°', q.west === -94 && q.south === 41.25 && q.east === -93.25 && q.north === 42, JSON.stringify(q))
check('parseBbox accepts w,s,e,n and rejects garbage, inverted and oversized boxes', !!parseBbox('-94,41,-93,42') && !parseBbox('x') && !parseBbox('-93,41,-94,42') && !parseBbox('-100,30,-80,42'))

// records → sites
const NOW = Date.UTC(2026, 9, 12, 3, 58)
const rec = (over) => ({ Latitude: 41.603, Longitude: -93.643, UTC: '2026-10-12T02:00', Parameter: 'PM2.5', Unit: 'UG/M3', Value: 6.0, AQI: 25, Category: { Number: 1, Name: 'Good' }, SiteName: 'Public Works', AgencyName: 'Polk Co. Air Quality Division', FullAQSCode: '840191535885', IntlAQSCode: '840191535885', ...over })
const sites = sitesFromRecords([
  rec({ UTC: '2026-10-12T01:00', AQI: 30, Value: 7.2 }), // older hour, must lose
  rec(),
  rec({ Parameter: 'OZONE', Unit: 'PPB', Value: 54, AQI: 50 }),
  rec({ Parameter: 'PM25', Latitude: 41.843, Longitude: -93.678, SiteName: 'Sheldahl', FullAQSCode: '191531579', AQI: -999, Value: -999 }), // AirNow's "no value"
  rec({ Parameter: 'O3', Latitude: 41.613, Longitude: -93.648, SiteName: 'Carpenter', FullAQSCode: '191530030', AQI: 55, Value: 59 }),
])
const pw = sites.find((s) => s.id === '840191535885')
check('One site per AQS code, the latest reading per parameter (01:00 dropped for 02:00)', sites.length === 3 && pw && pw.readings.length === 2 && pw.readings.find((r) => r.parameter === 'PM2.5').aqi === 25 && pw.readings.find((r) => r.parameter === 'PM2.5').value === 6, JSON.stringify(pw?.readings))
check("Reading time is AirNow's hour label as is — the END of the observation hour (label 02:00 UTC → 02:00 UTC, no hour added)", pw.readings[0].time === Date.UTC(2026, 9, 12, 2, 0) && readingTimeMs('2026-10-12T02:00') === Date.UTC(2026, 9, 12, 2, 0) && readingTimeMs('2026-10-12T02:00Z') === Date.UTC(2026, 9, 12, 2, 0) && readingTimeMs('garbage') === null, new Date(pw.readings[0].time).toISOString())
check('Parameter names normalised: PM25 → PM2.5, O3 → OZONE; a -999 AQI becomes null', sites.find((s) => s.id === '191531579').readings[0].parameter === 'PM2.5' && sites.find((s) => s.id === '191531579').readings[0].aqi === null && sites.find((s) => s.id === '191530030').readings[0].parameter === 'OZONE')
check('A site lists the parameters it reported', pw.parameters.join(',') === 'PM2.5,OZONE' && sites.find((s) => s.id === '191530030').parameters.join(',') === 'OZONE')
check('Site name, agency and coordinates carried through', pw.name === 'Public Works' && pw.agency === 'Polk Co. Air Quality Division' && pw.lngLat.lat === 41.603 && pw.lngLat.lng === -93.643)

// site list merge
const listText = [
  '840191535885|PM2.5|5885|Public Works|Active|IA1|Polk Co. Air Quality Division|R7|41.603000|-93.643000|281.000|-6.00|US|||19780| Des Moines, IA |19|IA|153|POLK||',
  '840191531427|PM2.5|1427|East High|Active|IA1|Polk Co. Air Quality Division|R7|41.590000|-93.600000|270.000|-6.00|US|||19780| Des Moines, IA |19|IA|153|POLK||',
  '840191531427|O3|1427|East High|Active|IA1|Polk Co. Air Quality Division|R7|41.590000|-93.600000|270.000|-6.00|US|||19780| Des Moines, IA |19|IA|153|POLK||',
  '191690011|O3|0011|Slater|Inactive|IA1|Polk Co. Air Quality Division|R7|41.880000|-93.690000|300.000|-6.00|US|||19780| Des Moines, IA |19|IA|169|STORY||',
  '483395006|WD|5006|Conroe|Active|TX1|TCEQ|R6|30.356700|-95.413900|61.000|-6.00|US|||26420| Houston |48|TX|339|MONTGOMERY||',
].join('\n')
const list = parseSiteList(listText)
check('Site list: one row per site with its pollutants, inactive sites and non-pollutant rows dropped', list.length === 2 && list.find((r) => r.id === '840191531427').parameters.join(',') === 'PM2.5,OZONE' && !list.find((r) => r.id === '191690011'), JSON.stringify(list.map((r) => r.id + ':' + r.parameters)))
const merged = mergeSiteList(sites, list, { west: -94, south: 41.25, east: -93.25, north: 42 })
const eh = merged.find((s) => s.id === '840191531427')
check('Merge: a listed site with no recent readings is included as offline (no readings), inside the bbox only', merged.length === 4 && eh && eh.readings.length === 0 && eh.parameters.join(',') === 'PM2.5,OZONE', JSON.stringify(merged.map((s) => s.id + ':' + s.readings.length)))

// upstream query
const u = new URL(upstreamUrl({ west: -94, south: 41.25, east: -93.25, north: 42 }, NOW, 'KEY'))
check('Upstream query: the last three UTC hours, OZONE,PM25, the bbox, JSON, verbose, dataType B, the key as API_KEY', u.searchParams.get('startDate') === '2026-10-12T00' && u.searchParams.get('endDate') === '2026-10-12T03' && u.searchParams.get('parameters') === 'OZONE,PM25' && u.searchParams.get('BBOX') === '-94,41.25,-93.25,42' && u.searchParams.get('format') === 'application/json' && u.searchParams.get('dataType') === 'B' && u.searchParams.get('verbose') === '1' && u.searchParams.get('API_KEY') === 'KEY' && u.hostname === 'www.airnowapi.org', u.search.replace('KEY', 'K…'))

console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
