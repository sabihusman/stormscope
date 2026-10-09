// Trip routing fallbacks, the 24 h cap and the rain overlay label — mocked (the mock's Valhalla answers the
// recorded Iowa route, refuses paths over 1 500 km like the FOSSGIS demo, and can be made to fail; its OSRM
// synthesizes a straight-line route at 90 km/h).
//   1. Valhalla down → "Using backup routing (OSRM)" in the panel, no URL or raw error text; detail on the console.
//   2. Urbandale → Miami (> 1 500 km straight line) → Valhalla is not asked, OSRM routes it, the note says so.
//   3. That trip is > 24 h → a warning near the top of Trip, the strip capped at 24 h, the arrival card = the 24 h mark.
//   4. Choosing 48 h in the playback bar → the layer menu says "Rain next 48 h" and so does the legend.
//   node scripts/trip-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, expandPlayback, openMap, openNow, openTrip, tripText } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  trip-check.mjs: mocked only (it forces a Valhalla failure and a 2 500 km trip)')
  process.exit(3)
}
assertBudget('trip-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/trip'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

async function session({ failHosts = [], delayHosts = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.6267, longitude: -93.7122 }, permissions: ['geolocation'] })
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'trip-check.mjs (mock)')
  const hosts = {}
  globalThis.__qaMockedRequest = (url) => { try { const h = new URL(url).host; hosts[h] = (hosts[h] ?? 0) + 1 } catch {} }
  await installMocks(ctx, { failHosts, delayHosts })
  const warnings = []
  page.on('console', (m) => m.type() === 'warning' && warnings.push(m.text()))
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  const until = async (fn, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(250) } return false }
  await until(() => window.__store?.get().conditions.state === 'ready')
  return { ctx, page, done, hosts, warnings, until }
}
const plan = async (page, until, dest) => {
  await openTrip(page)
  await page.getByRole('searchbox', { name: 'Destination' }).fill(dest)
  await page.waitForTimeout(800)
  await page.getByRole('dialog').getByRole('option').first().click().catch(async () => page.getByRole('option').first().click())
  await until(() => { const j = window.__store.get().journey; return j.routes.state === 'ready' && j.weather.state === 'ready' }, 120000)
  await page.waitForTimeout(500)
}

// ---- 1. Valhalla down → backup note, no raw error text.
{
  const { ctx, page, done, warnings, until } = await session({ failHosts: ['valhalla1.openstreetmap.de'] })
  await plan(page, until, 'Iowa City')
  const summary = await page.locator('.route-summary').innerText().catch(() => '')
  const errs = await page.locator('.screen.trip .err-text').allInnerTexts().catch(() => [])
  check('Valhalla down: panel says "Using backup routing (OSRM)"', /Using backup routing \(OSRM\)/.test(summary), summary.split('\n').slice(0, 2).join(' | '))
  const raw = (summary + '\n' + errs.join('\n')).match(/https?:\/\/\S+|valhalla1\S*|Minutely[^\n]*|HTTP 429|rate-limited[^\n]*/i)?.[0]
  check('Valhalla down: no URL or raw error in the route summary or an error line', !raw, raw ?? 'clean')
  void tripText
  check('Valhalla down: the failure detail went to the console', warnings.some((w) => /\[routing\] Valhalla failed/.test(w)), warnings.find((w) => /routing/.test(w))?.slice(0, 80) ?? 'no warning')
  const wide = await page.evaluate(() => { const el = document.querySelector('.route-summary'); return el ? el.scrollWidth <= el.clientWidth + 1 : true })
  check('Valhalla down: route summary does not overflow the panel', wide)
  await page.screenshot({ path: `${OUT}/valhalla-down.png` })
  done()
  await ctx.close()
}

// ---- 2 + 3. Urbandale → Miami: no Valhalla request, OSRM routes it, > 24 h → warning + cap.
{
  const { ctx, page, done, hosts, until } = await session()
  await plan(page, until, 'Miami')
  const summary = await page.locator('.route-summary').innerText().catch(() => '')
  const j = await page.evaluate(() => { const j = window.__store.get().journey; const r = j.routes.data?.routes[j.selected]; const w = j.weather.data; return { engine: j.routes.data?.engine, durationS: r?.durationS, lastEta: w?.samples.at(-1)?.eta, firstEta: w?.samples[0]?.eta, departure: j.departure, n: w?.samples.length } })
  check('Long trip: Valhalla not asked (straight line > 1 400 km), OSRM used', (hosts['valhalla1.openstreetmap.de'] ?? 0) === 0 && (hosts['router.project-osrm.org'] ?? 0) >= 1 && j.engine === 'osrm', `valhalla ${hosts['valhalla1.openstreetmap.de'] ?? 0}, osrm ${hosts['router.project-osrm.org'] ?? 0}`)
  check('Long trip: the note says why', /Long trip: routed by OSRM/.test(summary) && /1,500 km/.test(summary), summary.split('\n').slice(0, 2).join(' | '))
  const warn = page.locator('.trip-cap-warning')
  const warnBox = await warn.boundingBox().catch(() => null)
  const routeBox = await page.locator('.route-summary').boundingBox().catch(() => null)
  check(`Over 24 h (${j.durationS ? Math.round(j.durationS / 3600) : '?'} h): a visible warning near the top of Trip, above the route`, !!warnBox && warnBox.y < 300 && !!routeBox && warnBox.y < routeBox.y && /Over 24 h of driving/.test(await warn.innerText().catch(() => '')), warnBox ? `warning at y ${Math.round(warnBox.y)}, route at ${Math.round(routeBox?.y ?? -1)}` : 'no warning')
  check('Over 24 h: the strip is capped at the 24 h mark', j.lastEta != null && j.lastEta - j.departure <= 24 * 3600_000 + 60_000 && j.lastEta - j.departure >= 20 * 3600_000, `last sample +${j.lastEta ? ((j.lastEta - j.departure) / 3600_000).toFixed(1) : '?'} h, ${j.n} samples`)
  const arrival = await page.locator('.arrival-card').innerText().catch(() => '')
  check('Over 24 h: the arrival card is labelled as the 24 h mark', /At the 24 h mark/.test(arrival), arrival.split('\n')[0])
  await page.screenshot({ path: `${OUT}/miami-capped.png` })
  done()
  await ctx.close()
}

// ---- 4. 48 h in the playback bar → the overlay label and the legend agree.
{
  const { ctx, page, done, until } = await session()
  await openMap(page)
  await page.waitForTimeout(600)
  await expandPlayback(page)
  await page.getByRole('radio', { name: '48 h' }).click()
  await until(() => window.__store.get().layers.rainfall && window.__store.get().rainHorizon === 48, 10000)
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Open layer menu' }).click()
  await page.waitForTimeout(400)
  const menu = await page.locator('.fab-menu').innerText()
  check('48 h chosen: the layer menu says "Rain next 48 h"', /Rain next 48 h/.test(menu) && !/Rain next 24 h/.test(menu), menu.match(/Rain next [^\n]*/g)?.join(' | '))
  check('48 h chosen: the legend (in the menu) says "Rain next 48 h" too', (menu.match(/Rain next 48 h/g) ?? []).length >= 2, `${(menu.match(/Rain next 48 h/g) ?? []).length} mentions`)
  await page.screenshot({ path: `${OUT}/legend-48h.png` })
  await openNow(page)
  done()
  await ctx.close()
}

// ---- 5. Change while fetches are in flight (live latency, Oct 9): nothing lands after the clear.
// (a) the hazards / road hosts answer 2.5 s late; Change is tapped once the forecast is ready.
// (b) Open-Meteo answers 2.5 s late; Change is tapped while the journey forecast itself is in flight.
const journeyNow = () => page => page.evaluate(() => { const j = window.__store.get().journey; return { to: !!j.to, routes: !!j.routes.data, weather: !!j.weather.data, hazards: !!j.hazards.data, road: !!j.road.data, hs: j.hazards.state, rs: j.road.state, ws: j.weather.state, gen: j.gen } })
const leftovers = (j) => Object.entries(j).filter(([k, v]) => ['to', 'routes', 'weather', 'hazards', 'road'].includes(k) && v).map(([k]) => k)
{
  const { ctx, page, done, until } = await session({ delayHosts: { 'api.weather.gov': 2500, 'mapservices.weather.noaa.gov': 2500, 'mesonet.agron.iastate.edu': 2500 } })
  await openTrip(page)
  await page.getByRole('searchbox', { name: 'Destination' }).fill('Iowa City')
  await page.waitForTimeout(800)
  await page.getByRole('dialog').getByRole('option').first().click().catch(async () => page.getByRole('option').first().click())
  await until(() => { const j = window.__store.get().journey; return j.weather.state === 'ready' && j.hazards.state === 'loading' }, 60000)
  const before = await journeyNow()(page)
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await page.waitForTimeout(4000)
  const after = await journeyNow()(page)
  check('Change while hazards + road are in flight: 4 s later nothing is back (panel and store stay cleared)', before.hazards === false && before.hs === 'loading' && leftovers(after).length === 0 && after.hs === 'idle' && after.rs === 'idle', `before: hazards ${before.hs}, road ${before.rs}; after: ${leftovers(after).join('+') || 'clear'} (hazards ${after.hs}, road ${after.rs}, gen ${before.gen} → ${after.gen})`)
  const panel = await tripText(page).catch(() => '')
  const searchBack = await page.getByRole('searchbox', { name: 'Destination' }).isVisible().catch(() => false)
  check('Change while in flight: the Trip panel shows the destination search again, no stale hazards or road section', searchBack && !/Hazards along the route|Road conditions/.test(panel), `${searchBack ? 'search visible' : 'no search box'}; ${panel.split('\n').slice(0, 2).join(' | ')}`)
  await page.screenshot({ path: `${OUT}/clear-while-in-flight.png` })
  done()
  await ctx.close()
}
{
  const { ctx, page, done, until } = await session({ delayHosts: { 'api.open-meteo.com': 2500 } })
  await openTrip(page)
  await page.getByRole('searchbox', { name: 'Destination' }).fill('Iowa City')
  await page.waitForTimeout(800)
  await page.getByRole('dialog').getByRole('option').first().click().catch(async () => page.getByRole('option').first().click())
  await until(() => { const j = window.__store.get().journey; return j.routes.state === 'ready' && j.weather.state === 'loading' }, 60000)
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await page.waitForTimeout(4000)
  const after = await journeyNow()(page)
  check('Change while the journey forecast is in flight: no forecast, hazards or road lands afterwards', leftovers(after).length === 0 && after.ws === 'idle' && after.hs === 'idle', `after: ${leftovers(after).join('+') || 'clear'} (weather ${after.ws}, hazards ${after.hs})`)
  done()
  await ctx.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
