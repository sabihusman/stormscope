// P3 hazards: replay fixtures (positive, negative-timing, ice) + a live run.
import { chromium } from 'playwright'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
// --mock answers every API locally (zero live calls, scripts/lib/mock-server.mjs); live-only checks are skipped and said so.
const MOCK = process.argv.includes('--mock')
assertBudget(MOCK ? 'hazards-check.mjs (mock)' : 'hazards-check.mjs')
import { mkdirSync } from 'node:fs'
import { allowLocation, openMap, openMore, openTrip, pageText, setLayers, setSheet, setUnits, sheetText, tripText, searchPlace, openNow } from './lib/ui.mjs'

const BASE = (process.argv[2] || 'http://localhost:5174/').replace(/\/$/, '')
const OUT = process.argv[3] || 'e2e-shots/hazards'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, geolocation: { latitude: 39.9526, longitude: -75.1652 }, permissions: ['geolocation'] })
await ctx.addInitScript(() => { try { if (!localStorage.getItem('stormscope.layers')) localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: false, station: false, nowcast: false })) } catch {} })
const page = await ctx.newPage()
const __recordBudget = trackOpenMeteo(page, MOCK ? 'hazards-check.mjs (mock)' : 'hazards-check.mjs')
if (MOCK) await installMocks(ctx, { focus: { lat: 39.9526, lng: -75.1652 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
// Replays ship their recorded route + Open-Meteo response: none of these may be requested live.
const liveCalls = []
page.on('request', (r) => /open-meteo\.com\/v1\/(forecast|archive|era5)|valhalla1\.openstreetmap\.de|router\.project-osrm\.org/.test(r.url()) && liveCalls.push(r.url()))
// Replays drive the Trip page only: no station observation for the fixture's origin either (NWS points /
// stations, or the Open-Meteo "current" fallback a blocked NWS call would trigger — Oct 9).
const stationCalls = []
page.on('request', (r) => /api\.weather\.gov\/(points|stations)\/|open-meteo\.com\/v1\/forecast\?[^ ]*current=surface_pressure/.test(r.url()) && stationCalls.push(r.url()))

const report = async (ms = 120000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const s = await page.evaluate(() => {
      const j = window.__store.get().journey
      const d = j.hazards.data
      return {
        state: j.hazards.state, err: j.hazards.error, wstate: j.weather.state, werr: j.weather.error, rstate: j.routes.state, rerr: j.routes.error,
        hits: d?.hits.map((h) => ({ id: h.hazard.id, event: h.hazard.event, tier: h.hazard.tier, first: h.firstEta, last: h.lastEta })) ?? null,
        nearby: d?.nearby.map((n) => ({ id: n.hazard.id, reason: n.reason })) ?? null,
        sources: d?.sources ?? null, unresolved: d?.unresolved.length ?? null, historical: j.weather.data?.historical,
      }
    })
    if (s.hits || s.err || s.werr || s.rerr) return s
    await page.waitForTimeout(1000)
  }
  return page.evaluate(() => { const s = window.__store.get(); const j = s.journey; const msgs = [...document.querySelectorAll('.toast')].map((e) => e.textContent.trim().slice(0, 80)).join(' | '); return { state: `${j.hazards.state} (replay=${s.replay?.id ?? 'none'} to=${j.to?.name ?? "none"} routes=${j.routes.state}${j.routes.error ? " err=" + j.routes.error : ""} weather=${j.weather.state}${j.weather.error ? " err=" + j.weather.error : ""}${msgs ? ' · on screen: ' + msgs : ''})`, hits: null } })
}
const panelText = () => tripText(page)

// ---------------- 1. Positive: depart 20:20Z
await page.goto(`${BASE}/?replay=greenfield-2020z`, { waitUntil: 'load' })
let r = await report()
check('[20:20Z] replay loaded, route + ERA5 weather + hazards evaluated', !!r.hits && r.historical === true, `${r.state}${r.err ? ' · ' + r.err : ''}${r.werr ? ' · weather: ' + r.werr : ''}${r.rerr ? ' · route: ' + r.rerr : ''}`)
if (r.hits) {
  const ids = r.hits.map((h) => h.id)
  check('[20:20Z] TO.W #41 flagged at ETA', ids.includes('DMX TO.W #41'))
  check('[20:20Z] TO.W #42 flagged at ETA', ids.includes('DMX TO.W #42'))
  check('[20:20Z] Tornado Watch 277 (PDS) shown', ids.includes('spc-watch-277'), r.hits.filter((h) => h.tier === 'watch').map((h) => h.event).join(', '))
  check('[20:20Z] watches 276/278/279 NOT flagged', !ids.some((i) => /spc-watch-27[689]/.test(i)))
  check('[20:20Z] SPC Day 1 Moderate risk + significant tornado flagged', r.hits.some((h) => /Moderate risk/.test(h.event)) && r.hits.some((h) => /significant/.test(h.event)), r.hits.filter((h) => h.tier === 'outlook').map((h) => h.event).join(' | '))
  check('[20:20Z] other overlapping polygons reported as nearby-not-at-ETA', r.nearby.length >= 8, `${r.nearby.length} nearby`)
  const t = await panelText()
  check('[20:20Z] summary says warnings in effect (severe tone)', /warning.* in effect where you/.test(t))
  check('[20:20Z] replay banner states archived products + reanalysis', /Replay/.test(t) && /ERA5/.test(t))
  // The app fits the route once it is ready (RouteLayer, retried up to 4 times 1.5 s apart); under load the
  // 600 ms flight can take ~2 s to land. Wait for the camera to settle instead of reading it at a fixed 1.5 s.
  const camAt = () => page.evaluate(() => ({ z: +window.__map.getZoom().toFixed(1), c: window.__map.getCenter().lng.toFixed(2), moving: window.__map.isMoving() }))
  let cam = await camAt()
  for (const t0 = Date.now(); (cam.z >= 9 || cam.moving) && Date.now() - t0 < 8000; cam = await camAt()) await page.waitForTimeout(250)
  check('[20:20Z] map fitted to the route (zoomed out to the corridor)', cam.z < 9 && !cam.moving, JSON.stringify(cam))
  await page.screenshot({ path: `${OUT}/greenfield-2020z.png` })
}

// ---------------- 2. Negative timing: depart 22:00Z
await page.goto(`${BASE}/?replay=greenfield-2200z`, { waitUntil: 'load' })
r = await report()
check('[22:00Z] replay evaluated', !!r.hits, `${r.state}${r.err ? ' · ' + r.err : ''}${r.werr ? ' · weather: ' + r.werr : ''}${r.rerr ? ' · route: ' + r.rerr : ''}`)
if (r.hits) {
  const ids = r.hits.map((h) => h.id)
  check('[22:00Z] TO.W #41 NOT flagged (expired before ETA)', !ids.includes('DMX TO.W #41'))
  check('[22:00Z] TO.W #42 NOT flagged (expired before ETA)', !ids.includes('DMX TO.W #42'))
  check('[22:00Z] no warning polygons at any ETA', !r.hits.some((h) => h.tier === 'warning'), r.hits.filter((h) => h.tier === 'warning').map((h) => h.id).join(', ') || 'none')
  check('[22:00Z] Tornado Watch 277 still shown (valid to 02:03Z)', ids.includes('spc-watch-277'))
  const n41 = r.nearby.find((n) => n.id === 'DMX TO.W #41')
  check('[22:00Z] #41 listed as nearby with reason expired-before-eta', n41?.reason === 'expired-before-eta', JSON.stringify(n41))
  check('[22:00Z] ≥ 10 polygons overlap spatially but are time-excluded', r.nearby.length >= 10, `${r.nearby.length} nearby`)
  check('[22:00Z] outlook still valid and shown', r.hits.some((h) => h.tier === 'outlook'))
  const t = await panelText()
  check('[22:00Z] summary: no warnings at ETA BUT watch covers route (no all-clear)', /No warnings at your ETAs, but/.test(t) && !/all-clear\b/.test(t.replace(/not an all-clear/g, '')))
  await page.screenshot({ path: `${OUT}/greenfield-2200z.png` })
}

// ---------------- 3. Ice storm: depart 06:00Z 14 Dec 2024
await page.goto(`${BASE}/?replay=ice-storm-2024-12-14`, { waitUntil: 'load' })
r = await report()
check('[ice] replay evaluated', !!r.hits, `${r.state}${r.err ? ' · ' + r.err : ''}${r.werr ? ' · weather: ' + r.werr : ''}${r.rerr ? ' · route: ' + r.rerr : ''}`)
if (r.hits) {
  const ids = r.hits.map((h) => h.id)
  check('[ice] Ice Storm Warning flagged at ETA', ids.includes('DMX IS.W #1'), ids.join(', '))
  check('[ice] Winter Weather Advisory flagged at ETA', ids.includes('DMX WW.Y #10'))
  const cond = await page.evaluate(() => window.__store.get().journey.weather.data?.samples.map((s) => s.condition.code))
  check('[ice] model thresholds: at least one sample classed ice/snow from ERA5', cond?.some((c) => c === 'ice' || c === 'snow' || c === 'heavy-snow'), [...new Set(cond ?? [])].join(','))
  await page.screenshot({ path: `${OUT}/ice-storm.png` })
}

check('Replays made no live Open-Meteo or routing request (cached route + response in the fixture)', liveCalls.length === 0, liveCalls.length ? liveCalls.slice(0, 2).map((u) => u.slice(0, 80)).join(' | ') : 'three replays, zero live calls')
check('Replays made no station observation request for the origin (NWS points/stations or the Open-Meteo fallback)', stationCalls.length === 0, stationCalls.length ? stationCalls.slice(0, 2).map((u) => u.slice(0, 80)).join(' | ') : 'none')
const cachedProvider = await page.evaluate(() => window.__store.get().journey.weather.data?.provider ?? '')
check('Replay provider line says the response is cached', /cached in the fixture/.test(cachedProvider), cachedProvider)

// ---------------- 4. Live: Philadelphia → Baltimore, sources must report status
if (MOCK) console.log('SKIP  (mock) live journey section: needs live NWS/SPC/RWIS')
else {
await page.goto(`${BASE}/`, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
await page.waitForTimeout(4000)
await openTrip(page)
await page.getByRole('searchbox', { name: 'Destination' }).fill('Baltimore')
await page.waitForTimeout(2500)
await page.getByRole('option').first().click()
r = await report(150000)
check('[live] hazards evaluated for a live journey', !!r.hits, `${r.state}${r.err ? ' · ' + r.err : ''}`)
if (r.hits) {
  const st = r.sources
  check('[live] every source reports ok/unavailable (never silent)', ['warnings', 'watches', 'outlooks'].every((k) => st[k] && (st[k].state === 'ok' || st[k].state === 'unavailable')), JSON.stringify(st))
  const t = await panelText()
  check('[live] panel shows per-source status lines', /NWS warnings \/ advisories:/.test(t) && /SPC watches:/.test(t) && /SPC outlooks/.test(t))
  check('[live] no bare "all clear" wording', !/all clear|all-clear\.$/i.test(t))
  await page.screenshot({ path: `${OUT}/live-phl-bwi.png` })
}
check('No page errors', errs.length === 0, errs[0])

}
__recordBudget()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
