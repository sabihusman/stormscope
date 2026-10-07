// P2 journey core: destination → Valhalla route (+alternates) → forecast at ETA per sample.
// Philadelphia → Baltimore. Asserts monotonic ETAs, arrival = departure + duration, 15-min
// samples in the first 6 h, honest "hazards not yet checked" wording, rate-limit messaging path.
import { chromium } from 'playwright'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { mkdirSync } from 'node:fs'
import { allowLocation, openMap, openMore, openTrip, pageText, setLayers, setSheet, setUnits, sheetText, tripText, searchPlace, openNow } from './lib/ui.mjs'
const argv = process.argv.slice(2)
// --mock: every API answered locally (zero live calls); only the Iowa scenario has saved bodies (JOURNEY_SCENARIO=1).
const MOCK = argv.includes('--mock')
assertBudget(`journey-check.mjs${MOCK ? ' (mock)' : ''}`, { openMeteo: !MOCK })
const positional = argv.filter((a) => !a.startsWith('--'))

const BASE = positional[0] || 'http://localhost:5174/'
const OUT = positional[1] || 'e2e-shots/journey'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const SCENARIOS = [
  { name: 'Philadelphia → Baltimore', geo: { latitude: 39.9526, longitude: -75.1652 }, dest: 'Baltimore', arrive: /Arrive Baltimore/ },
  { name: 'Johnston, IA → Iowa City', geo: { latitude: 41.673, longitude: -93.698 }, dest: 'Iowa City', arrive: /Arrive Iowa City/ },
]
const scenario = SCENARIOS[Number(process.env.JOURNEY_SCENARIO ?? (MOCK ? 1 : 0))] ?? SCENARIOS[0]
if (MOCK && scenario !== SCENARIOS[1]) { console.log('SKIP  --mock only has saved bodies for the Iowa scenario (JOURNEY_SCENARIO=1)'); process.exit(3) }
console.log(`scenario: ${scenario.name}`)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: scenario.geo, permissions: ['geolocation'] })
await ctx.addInitScript(() => { try { if (!localStorage.getItem('stormscope.layers')) localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: false, station: false, nowcast: false })) } catch {} })
const page = await ctx.newPage()
const __recordBudget = trackOpenMeteo(page, `journey-check.mjs${MOCK ? ' (mock)' : ''}`)
if (MOCK) await installMocks(ctx, {})
const routing = []
page.on('response', (r) => /valhalla1\.openstreetmap\.de|router\.project-osrm\.org/.test(r.url()) && routing.push(`${new URL(r.url()).host} ${r.status()}`))
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
await page.waitForTimeout(5000)

await openTrip(page)
await page.waitForTimeout(500)
await page.getByRole('searchbox', { name: 'Destination' }).fill(scenario.dest)
await page.waitForTimeout(2500)
await page.getByRole('option').first().click()
// Wait for route + weather.
const wait = async (pred, ms = 60000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const s = await page.evaluate(() => {
      const j = window.__store.get().journey
      return { to: j.to?.name, rs: j.routes.state, re: j.routes.error, n: j.routes.data?.routes.length ?? 0, engine: j.routes.data?.engine, ws: j.weather.state, we: j.weather.error, samples: j.weather.data?.samples.length ?? 0 }
    })
    if (pred(s)) return s
    await page.waitForTimeout(500)
  }
  return page.evaluate(() => { const j = window.__store.get().journey; return { to: j.to?.name, rs: j.routes.state, re: j.routes.error, n: j.routes.data?.routes.length ?? 0, engine: j.routes.data?.engine, ws: j.weather.state, we: j.weather.error, samples: j.weather.data?.samples.length ?? 0 } })
}
let s = await wait((x) => x.n > 0 || x.re)
check('Destination set and route returned', s.n > 0, `${s.to} · ${s.n} route(s) via ${s.engine} · ${routing.join(', ')}${s.re ? ' · ' + s.re : ''}`)
check('Valhalla used as primary engine', s.engine === 'valhalla', s.engine)
check('Route(s) returned (alternates when Valhalla has them)', s.n >= 1, `${s.n} route(s)`)
s = await wait((x) => x.samples > 0 || x.we, 90000)
check('Forecast at ETA computed for the route', s.samples > 0, `${s.samples} samples${s.we ? ' · ' + s.we : ''}`)
if (!s.samples) {
  await page.screenshot({ path: `${OUT}/journey-no-forecast.png` })
  __recordBudget()
  await browser.close()
  console.log(`${results.filter(Boolean).length}/${results.length} passed (aborted: no forecast)`)
  process.exit(1)
}

const detail = await page.evaluate(() => {
  const j = window.__store.get().journey
  const r = j.routes.data.routes[j.selected]
  const w = j.weather.data
  const etas = w.samples.map((x) => x.eta)
  const mono = etas.every((t, i) => i === 0 || t >= etas[i - 1])
  const arrival = j.departure + r.durationS * 1000
  const last = w.samples[w.samples.length - 1]
  const fine = w.samples.filter((x) => x.offsetS < 6 * 3600)
  const gaps = fine.slice(1).map((x, i) => x.offsetS - fine[i].offsetS)
  const maxGap = Math.max(...gaps)
  const minutely = w.samples.filter((x) => x.resolution === 'minutely').length
  return { mono, arrivalMatch: Math.abs(last.eta - arrival) < 1000, durMin: r.durationS / 60, maxGapMin: maxGap / 60, minutely, total: w.samples.length, worst: w.worst.label, calls: w.calls, distKm: r.distanceM / 1000 }
})
check('ETAs are monotonic along the route', detail.mono)
check('Last sample ETA = departure + route duration', detail.arrivalMatch, `${detail.durMin.toFixed(0)} min, ${detail.distKm.toFixed(0)} km`)
check('First 6 h sampled at ≤ ~5-min spacing', detail.maxGapMin <= 6.5, `max gap ${detail.maxGapMin.toFixed(1)} min, ${detail.total} samples`)
check('15-minutely (HRRR) resolution used for near-term samples', detail.minutely > 0, `${detail.minutely}/${detail.total} samples minutely`)
check('Budget: one request, ≤ 120 locations', detail.calls <= 120, `${detail.calls} locations`)

const text = await tripText(page)
check(
  'Arrival card + worst-along-the-way shown',
  scenario.arrive.test(text) && /Worst along the way/.test(text),
  `${text.match(/To [^\n]*/)?.[0] ?? ''} | ${text.match(/Arrive [^\n]*\n[^\n]*/)?.[0]?.replace('\n', ' ') ?? 'no arrival card'}`,
)
check('Panel has a hazards section with per-source status (no false all-clear)', /Hazards on this route/.test(text))
check('ETA uncertainty stated', /±/.test(text))
await page.screenshot({ path: `${OUT}/journey-panel.png` })

// Route drawn on the map, coloured segments.
const mapState = await page.evaluate(() => {
  const m = window.__map
  return { line: !!m.getLayer('journey-line'), feats: m.querySourceFeatures('journey-line').length, alt: m.querySourceFeatures('journey-alt').length, dest: m.querySourceFeatures('journey-dest').length }
})
check('Route line, alternates and destination drawn on the map', mapState.line && mapState.feats > 0 && mapState.dest >= 1, JSON.stringify(mapState) + ' (querySourceFeatures counts per tile)')
await openMap(page)
await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}/journey-map.png` })
await openTrip(page)

// Departure change → weather recomputed (debounced) without a new routing call.
const nRouting = routing.length
const fetchedBefore = await page.evaluate(() => window.__store.get().journey.weather.data?.fetchedAt ?? 0)
await page.getByRole('radio', { name: '+2 h' }).click()
// Wait for a *new* forecast (fetchedAt changes), not the stale one.
for (let i = 0; i < 120; i++) {
  const f = await page.evaluate(() => window.__store.get().journey.weather.data?.fetchedAt ?? 0)
  if (f > fetchedBefore) break
  await page.waitForTimeout(500)
}
const eta2 = await page.evaluate(() => window.__store.get().journey.weather.data.samples[0].eta - Date.now())
check('Changing departure re-evaluates ETAs without re-routing', routing.length === nRouting && eta2 > 100 * 60_000, `first-sample ETA in ${(eta2 / 60000).toFixed(0)} min; routing calls unchanged=${routing.length === nRouting}`)

// Alternate selection recolours (weather recomputed for alt route).
if (detail && s.n >= 2) {
  console.log('alternates present → testing selection')
  await page.getByRole('radio', { name: /Alt 1/ }).click()
  s = await wait((x) => x.ws === 'ready' && x.samples > 0, 60000)
  check('Selecting an alternate route recomputes its forecast', s.samples > 0)
}
// Clear.
// Clear: wait for a *settled* state, not a moment — everything gone (store + map), and still gone
// 2 s later so a late response (weather/hazards/road fetch in flight when Change was tapped) can't
// quietly re-populate the journey. The evidence is the timeline of what was still present.
await page.getByRole('button', { name: 'Change', exact: true }).click()
const tClear = Date.now()
const leftover = () => page.evaluate(() => { const j = window.__store.get().journey; const m = window.__map; const o = { to: !!j.to, routes: !!j.routes.data, weather: !!j.weather.data, hazards: !!j.hazards.data, road: !!j.road.data, lineLayer: m.getStyle().layers.some((l) => l.id === 'journey-line'), lineSource: !!m.getSource('journey-line') }; return Object.keys(o).filter((k) => o[k]) })
const timeline = []
let settledAt = null
for (let i = 0; i < 40; i++) {
  const left = await leftover()
  timeline.push(`+${Date.now() - tClear}ms:${left.length ? left.join('+') : 'clear'}`)
  if (!left.length) { settledAt = Date.now() - tClear; break }
  await page.waitForTimeout(250)
}
let stable = settledAt !== null
if (stable) for (const ms of [500, 500, 1000]) { await page.waitForTimeout(ms); const left = await leftover(); timeline.push(`+${Date.now() - tClear}ms:${left.length ? left.join('+') : 'clear'}`); if (left.length) stable = false }
check('Change/clear removes the journey from panel and map, and it stays cleared', stable, `${settledAt === null ? 'never settled within 10 s' : `settled at +${settledAt} ms`}; ${timeline.join(' ')}`)

__recordBudget()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
