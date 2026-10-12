// Air quality, phase 1 (modeled, Open-Meteo / CAMS), mocked:
//   1. the Now tile per EPA category — number, category name, the EPA standard colour (EPA-403/B-26-003 Table 2)
//      as the badge background, the dominant pollutant, "Estimate (model)" and the attribution;
//   2. the map overlay: one request per view of ≤ 64 locations on the model's ~0.4° grid (coarser when the view
//      is wide), the legend's six swatches in the EPA colours with the attribution, one overlay at a time;
//   3. the error state: the air-quality host down → the tile's own unavailable text while the conditions card stands.
//   node scripts/aqi-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap, setLayers } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  aqi-check.mjs: mocked only (forced AQI values per category, a failing host)')
  process.exit(3)
}
assertBudget('aqi-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/aqi'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

// EPA standard AQI colours (RGB), Table 2 of EPA-403/B-26-003 (May 2026).
const EPA = [
  { key: 'good', name: 'Good', aqi: 30, rgb: 'rgb(0, 228, 0)' },
  { key: 'moderate', name: 'Moderate', aqi: 75, rgb: 'rgb(255, 255, 0)' },
  { key: 'usg', name: 'Unhealthy for Sensitive Groups', aqi: 125, rgb: 'rgb(255, 126, 0)' },
  { key: 'unhealthy', name: 'Unhealthy', aqi: 175, rgb: 'rgb(255, 0, 0)' },
  { key: 'very-unhealthy', name: 'Very Unhealthy', aqi: 250, rgb: 'rgb(143, 63, 151)' },
  { key: 'hazardous', name: 'Hazardous', aqi: 350, rgb: 'rgb(126, 0, 35)' },
]

async function session(opts = {}, viewport = { width: 390, height: 844 }) {
  const mobile = viewport.width < 768
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'aqi-check.mjs (mock)')
  const aqCalls = []
  globalThis.__qaMockedRequest = (url) => { if (/air-quality-api\.open-meteo\.com/.test(url)) aqCalls.push(url) }
  await installMocks(ctx, opts)
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(200) } return false }
  await until(() => ['ready', 'error'].includes(window.__store?.get().airQuality.state) && ['ready', 'error'].includes(window.__store?.get().conditions.state))
  await page.waitForTimeout(300)
  return { ctx, page, done, aqCalls, until }
}
const tile = (page) =>
  page.evaluate(() => {
    const t = document.querySelector('.tile.aqi')
    if (!t) return null
    const badge = t.querySelector('.aqi-badge')
    return { cat: t.dataset.aqi, text: t.innerText, badge: badge?.textContent?.trim() ?? null, bg: badge ? getComputedStyle(badge).backgroundColor : null, err: !!t.querySelector('.err-text') }
  })

// ---- 1. The Now tile per category.
for (const c of EPA) {
  const { ctx, page, done, aqCalls } = await session({ aqi: c.aqi })
  const t = await tile(page)
  check(`Tile at AQI ${c.aqi}: "${c.name}" in the EPA colour ${c.rgb}, with the number, PM2.5 dominant, "Estimate (model)"`, !!t && t.cat === c.key && t.badge === String(c.aqi) && t.bg === c.rgb && t.text.includes(c.name) && /PM2\.5 dominant/.test(t.text) && /Estimate \(model\)/.test(t.text), t ? `${t.cat} · ${t.badge} · ${t.bg} · ${t.text.replace(/\n/g, ' | ').slice(0, 90)}` : 'no tile')
  if (c.key === 'good') {
    check('Tile carries the attribution (Open-Meteo · CAMS)', /Open-Meteo\.com/.test(t?.text ?? '') && /Copernicus Atmosphere Monitoring Service \(CAMS\)/.test(t?.text ?? ''), t?.text.split('\n').at(-1))
    check('The tile cost one air-quality location (one request, one coordinate)', aqCalls.length === 1 && !/latitude=[^&]*,/.test(aqCalls[0]), `${aqCalls.length} request(s)`)
    await page.screenshot({ path: `${OUT}/tile-${c.key}.png`, fullPage: true })
  }
  done()
  await ctx.close()
}

// ---- 2. The map overlay, the legend, exclusivity.
for (const vp of [{ width: 390, height: 844, name: 'phone' }, { width: 1366, height: 800, name: 'desktop' }]) {
  const { ctx, page, done, aqCalls, until } = await session({}, vp)
  await openMap(page)
  await setLayers(page, { rainfall: true })
  await page.waitForTimeout(300)
  // Turn the overlay on through the menu (like a user) so the one-at-a-time rule is exercised. The request
  // baseline is taken first: on wide layouts the map is visible on Now and the grid loads at once.
  const before = aqCalls.length
  await page.getByRole('button', { name: 'Open layer menu' }).click()
  await page.getByRole('radio', { name: /Air quality/ }).click()
  await page.waitForTimeout(300)
  const layers = await page.evaluate(() => window.__store.get().layers)
  check(`[${vp.name}] Air quality is in the forecast-overlay group and turning it on turns Rain off`, layers.airquality === true && layers.rainfall === false, JSON.stringify({ airquality: layers.airquality, rainfall: layers.rainfall }))
  const menu = await page.evaluate(() => {
    const sw = [...document.querySelectorAll('.aqi-legend .legend-swatch')].map((s) => ({ key: s.dataset.aqi, bg: getComputedStyle(s.querySelector('i')).backgroundColor, label: s.textContent.trim() }))
    return { sw, text: document.querySelector('.fab-menu')?.innerText ?? '' }
  })
  check(`[${vp.name}] Legend: six swatches in the EPA colours, labelled with the category breakpoints`, menu.sw.length === 6 && menu.sw.every((s, i) => s.key === EPA[i].key && s.bg === EPA[i].rgb) && menu.sw.map((s) => s.label).join(' ') === '0 51 101 151 201 301+', menu.sw.map((s) => `${s.key}:${s.bg}:${s.label}`).join(' '))
  check(`[${vp.name}] Legend names the six categories and carries the attribution and the grid note`, /Good · Moderate · Unhealthy for Sensitive Groups · Unhealthy · Very Unhealthy · Hazardous/.test(menu.text) && /Copernicus Atmosphere Monitoring Service \(CAMS\)/.test(menu.text) && /~45 km grid/.test(menu.text))
  await page.getByRole('button', { name: 'Close layer menu' }).click()
  await until(() => !!window.__aqGrid, 20000)
  await page.waitForTimeout(500)
  const g = await page.evaluate(() => window.__aqGrid ?? null)
  const gridCalls = aqCalls.slice(before)
  const locs = gridCalls.map((u) => (u.match(/latitude=([^&]*)/)?.[1].split(',').length ?? 0))
  check(`[${vp.name}] Overlay: one request for the view, ≤ 64 locations, on the model's ≥ 0.4° grid`, gridCalls.length === 1 && locs[0] === g?.points && g.points <= 64 && g.spacing >= 0.4, `${gridCalls.length} request(s) · ${g?.points} locations · spacing ${g?.spacing}°`)
  const z0 = (await page.evaluate(() => window.__map.getZoom())).toFixed(1)
  console.log(`INFO  [${vp.name}] one map load of the Air quality overlay costs ${g?.points} Open-Meteo locations at ${g?.spacing}° spacing (place view, zoom ${z0})`)
  // A small pan inside the same sampled area reuses the cache: no new request.
  await page.evaluate(() => window.__map.panBy([30, 20], { duration: 0 }))
  await page.waitForTimeout(900)
  check(`[${vp.name}] A small pan within the sampled area makes no new request (30 min cache per view)`, aqCalls.length === before + 1, `${aqCalls.length - before} request(s) after the pan`)
  // Zoomed out (a region, then the continent): more cells, several categories, the 64-location cap holds by
  // widening the spacing. The cost per map load is reported for each.
  for (const z of [6, 4]) {
    const prevKey = g?.key
    const n0 = aqCalls.length
    await page.evaluate((zoom) => window.__map.jumpTo({ zoom }), z)
    { const t0 = Date.now(); while (Date.now() - t0 < 20000 && (await page.evaluate((k) => !window.__aqGrid || window.__aqGrid.key === k, prevKey))) await page.waitForTimeout(200) }
    await page.waitForTimeout(600)
    const gz = await page.evaluate(() => window.__aqGrid ?? null)
    const callsZ = aqCalls.slice(n0)
    const locsZ = callsZ.map((u) => (u.match(/latitude=([^&]*)/)?.[1].split(',').length ?? 0))
    const drawn = await page.evaluate(() => { const f = window.__map.querySourceFeatures('aqi-cells'); return { n: f.length, cats: [...new Set(f.map((x) => x.properties.cat))].sort() } })
    check(`[${vp.name}] zoom ${z}: one request, ≤ 64 locations, spacing a multiple of 0.4° (${gz?.spacing}°)`, callsZ.length === 1 && locsZ[0] === gz?.points && gz.points <= 64 && gz.spacing >= 0.4 && Math.abs(gz.spacing / 0.4 - Math.round(gz.spacing / 0.4)) < 1e-9 && gz.key !== prevKey, `${callsZ.length} request(s) · ${gz?.points} locations · spacing ${gz?.spacing}°`)
    check(`[${vp.name}] zoom ${z}: cells drawn in several EPA categories`, drawn.n >= 6 && drawn.cats.length >= 3, `${drawn.n} features · ${drawn.cats.join(',')}`)
    console.log(`INFO  [${vp.name}] one map load of the Air quality overlay costs ${gz?.points} Open-Meteo locations at ${gz?.spacing}° spacing (zoom ${z})`)
    g.key = gz?.key
  }
  await page.screenshot({ path: `${OUT}/overlay-${vp.name}.png` })
  done()
  await ctx.close()
}

// ---- 3. Error state.
{
  const { ctx, page, done } = await session({ failHosts: ['air-quality-api.open-meteo.com'], failStatus: 500 })
  const t = await tile(page)
  const cond = await page.locator('.now-card.conditions').innerText().catch(() => '')
  check('Air-quality host failing (500): the tile shows its own unavailable text', !!t && t.err && /unavailable/.test(t.text), t?.text.replace(/\n/g, ' | ').slice(0, 100))
  check('…while the conditions card still shows a temperature', /°/.test(cond), cond.split('\n').slice(0, 2).join(' | '))
  await page.screenshot({ path: `${OUT}/tile-error.png`, fullPage: true })
  done()
  await ctx.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
