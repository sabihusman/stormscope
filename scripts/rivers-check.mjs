// River gauges with the layer ON: the one-request bbox query for 10-day discharge medians must
// return the same sites and medians as the old one-request-per-site path, and the app must be
// using those medians. One Iowa viewport (Des Moines, 40 km — the app's own river radius).
//
//   node scripts/rivers-check.mjs [base-url] [shots-dir]      run the checks
//   node scripts/rivers-check.mjs --record                    refresh the saved snapshot
//
// The snapshot (scripts/fixtures/rivers-iowa.json) stores, for a FIXED 10-day window, the sites
// with discharge in the bbox, their medians computed the old way (per-site daily queries), and
// the NOAA NWPS gauge ids — so "bbox query == snapshot" is stable from day to day, while the
// old-vs-new comparison is re-done live on every run.
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { assertBudget, guardedFetch, remaining, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap, openMore, openTrip, pageText, setLayers, setSheet, setUnits, sheetText, tripText, searchPlace, openNow } from './lib/ui.mjs'
// --mock answers every API locally (zero live calls, scripts/lib/mock-server.mjs); live-only checks are skipped and said so.
const MOCK = process.argv.includes('--mock')
assertBudget(MOCK ? 'rivers-check.mjs (mock)' : 'rivers-check.mjs', { openMeteo: !MOCK }) // the Now screen fetches one Open-Meteo location per place on every load

const record = process.argv.includes('--record')
const BASE = process.argv.find((a) => /^https?:/.test(a)) || 'http://localhost:5174/'
const OUT = process.argv.find((a, i) => i >= 2 && !/^https?:/.test(a) && !a.startsWith('--')) || 'e2e-shots/rivers'
mkdirSync(OUT, { recursive: true })
const SNAP = 'scripts/fixtures/rivers-iowa.json'
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}

// Same bbox the app builds: bboxAround(focus, RIVER_RADIUS_M) in src/lib/geo.ts.
const FOCUS = { lat: 41.5868, lng: -93.625 } // Des Moines, IA
const RADIUS_M = 40_000
const EARTH = 6_371_008.8
const deg = (rad) => (rad * 180) / Math.PI
const dLat = deg(RADIUS_M / EARTH)
const dLng = deg(RADIUS_M / (EARTH * Math.max(Math.cos((FOCUS.lat * Math.PI) / 180), 1e-6)))
const bbox = { west: FOCUS.lng - dLng, east: FOCUS.lng + dLng, south: FOCUS.lat - dLat, north: FOCUS.lat + dLat }
const bb = `${bbox.west.toFixed(3)},${bbox.south.toFixed(3)},${bbox.east.toFixed(3)},${bbox.north.toFixed(3)}`

const USGS = 'https://api.waterdata.usgs.gov/ogcapi/v0'
const NWPS = 'https://api.water.noaa.gov/nwps/v1'
// Every Node-side request is charged to the day's host cap before it is sent (guardedFetch refuses past the cap).
const SCRIPT = record ? 'rivers-check.mjs --record (node)' : 'rivers-check.mjs (node)'
const get = async (url) => {
  const r = await guardedFetch(url, SCRIPT)
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`)
  return r.json()
}
const iso = (d) => d.toISOString().slice(0, 10)
const median = (vals) => {
  const v = vals.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b)
  return v.length >= 3 ? v[Math.floor(v.length / 2)] : null
}
/** Sites in the bbox that currently report discharge (the ids the app asks medians for). */
async function sitesWithFlow() {
  const j = await get(`${USGS}/collections/latest-continuous/items?f=json&limit=400&bbox=${bb}&parameter_code=00060`)
  return [...new Set(j.features.map((f) => f.properties.monitoring_location_id))].sort()
}
/** New path: one bbox request, grouped per site. */
async function mediansBbox(ids, start, end) {
  const j = await get(`${USGS}/collections/daily/items?f=json&limit=4000&bbox=${bb}&parameter_code=00060&statistic_id=00003&datetime=${start}/${end}`)
  const by = {}
  for (const f of j.features) {
    const id = f.properties.monitoring_location_id
    if (!ids.includes(id)) continue
    ;(by[id] ??= []).push(Number(f.properties.value))
  }
  const out = {}
  for (const id of ids) {
    const m = median(by[id] ?? [])
    if (m != null) out[id] = { median: m, n: by[id].length }
  }
  return out
}
/** Old path: one request per site (what the app did before the refactor). */
async function mediansPerSite(ids, start, end, days = 10) {
  const out = {}
  for (const id of ids) {
    const j = await get(`${USGS}/collections/daily/items?f=json&limit=${days + 2}&monitoring_location_id=${encodeURIComponent(id)}&parameter_code=00060&statistic_id=00003&datetime=${start}/${end}`)
    const vals = j.features.map((f) => Number(f.properties.value))
    const m = median(vals)
    if (m != null) out[id] = { median: m, n: vals.length }
  }
  return out
}
const same = (a, b) => {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.join() !== kb.join()) return `site sets differ: ${ka.length} vs ${kb.length} (only in first: ${ka.filter((k) => !(k in b)).join(',') || '-'}; only in second: ${kb.filter((k) => !(k in a)).join(',') || '-'})`
  for (const k of ka) if (a[k].median !== b[k].median || a[k].n !== b[k].n) return `${k}: ${a[k].median} (n=${a[k].n}) vs ${b[k].median} (n=${b[k].n})`
  return ''
}

if (record) {
  // Up to ~30 sites + 1 listing: refuse to start a recording the cap can't finish (it would stop mid-way).
  if (remaining('api.waterdata.usgs.gov') < 31) {
    console.log(`SKIP  rivers-check.mjs --record: needs up to 31 USGS requests, ${remaining('api.waterdata.usgs.gov')} left in today's cap`)
    process.exit(3)
  }
  // A fully APPROVED window (USGS reviews daily means months later; provisional values get revised),
  // so the saved medians are stable and the comparison can be exact. Override with SNAP_START/SNAP_END.
  const startIso = process.env.SNAP_START ?? '2025-06-01'
  const endIso = process.env.SNAP_END ?? '2025-06-10'
  const sites = await sitesWithFlow()
  const medians = await mediansPerSite(sites, startIso, endIso)
  const statuses = await get(`${USGS}/collections/daily/items?f=json&limit=4000&bbox=${bb}&parameter_code=00060&statistic_id=00003&datetime=${startIso}/${endIso}`)
  const notApproved = statuses.features.filter((f) => f.properties.approval_status !== 'Approved')
  if (notApproved.length) {
    console.log(`FAIL  window ${startIso}..${endIso} has ${notApproved.length} non-approved daily values (${[...new Set(notApproved.map((f) => f.properties.approval_status))].join(', ')}) — pick an older window`)
    process.exit(1)
  }
  const start = new Date(startIso)
  const end = new Date(endIso)
  const nwps = await get(`${NWPS}/gauges?bbox.xmin=${bbox.west.toFixed(3)}&bbox.ymin=${bbox.south.toFixed(3)}&bbox.xmax=${bbox.east.toFixed(3)}&bbox.ymax=${bbox.north.toFixed(3)}&srid=EPSG_4326`)
  const nwpsLids = (nwps.gauges ?? []).map((g) => g.lid).sort()
  mkdirSync('scripts/fixtures', { recursive: true })
  writeFileSync(SNAP, JSON.stringify({ capturedAt: new Date().toISOString(), focus: FOCUS, radiusM: RADIUS_M, bbox, window: { start: iso(start), end: iso(end), approvalStatus: 'Approved', dailyValues: statuses.features.length }, sites, medians, nwpsLids }, null, 2) + '\n')
  console.log(`snapshot: ${sites.length} sites with discharge, ${Object.keys(medians).length} medians (per-site path), ${nwpsLids.length} NWPS gauges, window ${iso(start)}..${iso(end)} → ${SNAP}`)
  process.exit(0)
}

const snap = JSON.parse(readFileSync(SNAP, 'utf8'))
const need = 2 + snap.sites.length + 1
if (remaining('api.waterdata.usgs.gov') < need) {
  console.log(`SKIP  rivers-check.mjs: needs ${need} USGS requests, ${remaining('api.waterdata.usgs.gov')} left in today's cap`)
  process.exit(3)
}

// 1. Fixed, fully approved window: the bbox path must reproduce the saved per-site medians exactly
// (same sites, same value counts, same medians). Live old-vs-new equivalence is check 2.
if (snap.window.approvalStatus !== 'Approved') {
  console.log('FAIL  snapshot was not recorded from an approved window — re-record with --record')
  process.exit(1)
}
let newNow = snap.medians
if (MOCK) console.log('SKIP  (mock) live USGS comparisons (snapshot reproduction, old-vs-new path, site stability)')
else {
const fixedNew = await mediansBbox(snap.sites, snap.window.start, snap.window.end)
const d1 = same(snap.medians, fixedNew)
check(`bbox query reproduces the snapshot's per-site medians exactly (approved window ${snap.window.start}..${snap.window.end})`, !d1, d1 || `${Object.keys(fixedNew).length} sites, identical medians and counts`)

// 2. Live today: old per-site path vs new bbox path for the window the app uses right now.
const now = new Date()
const start = new Date(now.getTime() - 10 * 86_400_000)
const sitesNow = await sitesWithFlow()
const oldNow = await mediansPerSite(sitesNow, iso(start), iso(now))
newNow = await mediansBbox(sitesNow, iso(start), iso(now))
const d2 = same(oldNow, newNow)
check('old per-site path and new bbox path agree for today\'s window', !d2, d2 || `${Object.keys(newNow).length} sites, ${sitesNow.length} with discharge`)
check('site list is stable against the snapshot (≥ 90 % overlap)', sitesNow.filter((s) => snap.sites.includes(s)).length >= 0.9 * snap.sites.length, `${sitesNow.filter((s) => snap.sites.includes(s)).length}/${snap.sites.length}`)

// 3. The app itself, rivers ON at the same focus: its elevated-flow ratios must come from those medians.
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, geolocation: { latitude: FOCUS.lat, longitude: FOCUS.lng }, permissions: ['geolocation'] })
await ctx.addInitScript(() => { try { localStorage.setItem('stormscope.layers', JSON.stringify({ radar: false, satellite: false, rainfall: false, flood: false, rivers: true, station: false, nowcast: false })) } catch {} })
const page = await ctx.newPage()
const __recordBudget = trackTraffic(page, MOCK ? 'rivers-check.mjs (mock)' : 'rivers-check.mjs')
if (MOCK) await installMocks(ctx, { focus: FOCUS })
const usgsUrls = []
page.on('request', (r) => /api\.waterdata\.usgs\.gov/.test(r.url()) && usgsUrls.push(r.url()))
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
let riv = null
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(1000)
  riv = await page.evaluate(() => {
    const r = window.__store.get().rivers
    return { state: r.state, error: r.error, source: r.freshness?.source, gauges: r.data?.map((g) => ({ id: g.id, lid: g.lid, usgsId: g.usgsId, flow: g.flow?.value, flowRatio: g.flowRatio, risk: g.riskLevel, sources: g.sources })) ?? null }
  })
  if (riv.state === 'ready' || riv.state === 'error') break
}
check('Rivers panel loaded with the layer on', riv.state === 'ready' && (riv.gauges?.length ?? 0) > 0, `${riv.state} · ${riv.gauges?.length ?? 0} gauges · ${riv.source ?? riv.error ?? ''}`)
// One bbox `daily` request per gauge load (a first visit loads twice: once before and once after the service
// worker takes control), never a per-site query.
const dailyReqs = usgsUrls.filter((u) => /collections\/daily\//.test(u)).length
const loads = usgsUrls.filter((u) => /collections\/latest-continuous\//.test(u)).length
check('One USGS daily-medians request (bbox) per gauge load, no per-site queries', dailyReqs >= 1 && dailyReqs === loads && !usgsUrls.some((u) => /monitoring_location_id=/.test(u)), `${dailyReqs} daily request(s) for ${loads} load(s), ${usgsUrls.length} USGS requests in all`)
const withRatio = (riv.gauges ?? []).filter((g) => g.flowRatio != null && g.flow != null)
const bad = withRatio.filter((g) => { const m = newNow[g.usgsId]?.median; return m == null || Math.abs(g.flow / g.flowRatio - m) > Math.max(0.5, 0.001 * m) })
if (MOCK) console.log('SKIP  (mock) ratio-vs-median check: the mock synthesizes medians, the live run compares against USGS')
else check('every elevated-flow ratio in the app equals flow ÷ (bbox-path 10-day median)', withRatio.length >= 1 && bad.length === 0, bad.length ? bad.map((g) => `${g.usgsId}: flow ${g.flow} ratio ${g.flowRatio} → ${(g.flow / g.flowRatio).toFixed(1)} vs ${newNow[g.usgsId]?.median}`).join('; ') : `${withRatio.length} gauges with ratios`)
const lids = (riv.gauges ?? []).filter((g) => g.lid).map((g) => g.lid)
check('NOAA NWPS gauges match the snapshot (≥ 80 % overlap)', lids.filter((l) => snap.nwpsLids.includes(l)).length >= 0.8 * Math.min(lids.length, snap.nwpsLids.length), `${lids.filter((l) => snap.nwpsLids.includes(l)).length} of ${lids.length} listed`)
check('Partial-source note only when a source really failed', /USGS Water Data \+ NOAA NWPS/.test(riv.source ?? '') || /unavailable/.test(riv.source ?? ''), riv.source)
await openMore(page, 'Rivers & gauges')
await page.waitForTimeout(800)
await page.screenshot({ path: `${OUT}/rivers-iowa.png` })
__recordBudget()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
