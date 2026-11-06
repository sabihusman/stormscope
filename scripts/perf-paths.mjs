// The four slow paths from the Nov 6, 2026 mobile audit (search ~10–12 s, river gauges ~12–15 s, satellite ~15 s with
// playback disabled, first map ~15 s blank), measured the same way on any build, mocked only (no live calls):
// every API answers locally, held for the upstream latency given in DELAYS (a slow day, not the audit's network).
// Headed Chrome when available (the valid profile on this machine; headless here is emulated and unthrottled), CPU
// throttled 4× over CDP, 390 × 844. Each path runs on a first visit and again on a repeat visit (same browser
// profile, after a reload: what the app keeps between visits). No assertions: prints a table and writes JSON.
//   node scripts/perf-paths.mjs [base-url] [out-dir] --mock [--label=name] [--headless]
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap, openMore, openNow } from './lib/ui.mjs'

const argv = process.argv.slice(2)
if (!argv.includes('--mock')) {
  console.log('SKIP  perf-paths.mjs: mocked only')
  process.exit(3)
}
assertBudget('perf-paths.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/perf-paths'
const LABEL = argv.find((a) => a.startsWith('--label='))?.slice(8) ?? ''
// --only=map,satellite,search,rivers: run just those paths (the rest are skipped).
const ONLY = argv.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? null
const want = (p) => !ONLY || ONLY.includes(p)
mkdirSync(OUT, { recursive: true })
// Upstream latency per host (ms) — a slow but working day; the same for every build measured.
const DELAYS = {
  'photon.komoot.io': 2500,
  'api.water.noaa.gov': 1500,
  'api.waterdata.usgs.gov': 3000,
  'gibs.earthdata.nasa.gov': 6000,
  'tiles.openfreemap.org': 1500,
}

const headless = argv.includes('--headless')
const browser = await chromium
  .launch({ headless, channel: 'chrome', args: ['--window-size=430,900'] })
  .catch(() => chromium.launch({ headless, args: ['--window-size=430,900'] }))
const profile = { browser: browser.version(), headless, cpuThrottle: 4, delays: DELAYS }
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'], locale: 'en-US', serviceWorkers: 'block' })
// The guard first, then the mocks: the handler registered last runs first, so the mocks answer before the guard
// would let a request through (installed the other way round, Nov 6, the guard sent ~95 requests live).
const page = await ctx.newPage()
const done = trackTraffic(page, 'perf-paths.mjs (mock)')
await installMocks(ctx, { delayHosts: DELAYS })
const cdp = await ctx.newCDPSession(page)
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
const until = async (fn, ms = 40000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn, arg).catch(() => false)) return Date.now() - t0; await page.waitForTimeout(50) } return null }
const rows = []
const rec = (path, visit, metric, ms, note = '') => rows.push({ path, visit, metric, ms, note })

for (const visit of ['first', 'repeat']) {
  if (visit === 'first') {
    await page.goto(BASE, { waitUntil: 'load' })
    await allowLocation(page)
  } else {
    await page.reload({ waitUntil: 'load' })
  }
  await until(() => window.__store?.get().conditions.state === 'ready', 60000)

  // ---- First map: Map tab → the basemap painted; and what the screen shows meanwhile ----
  if (want('map')) {
  // Painted = a basemap vector tile has arrived after the tap and the map then reports itself loaded.
  let firstTileAt = null
  const onTile = (r) => { if (firstTileAt == null && /tiles\.openfreemap\.org\/(planet|natural_earth)/.test(r.url())) firstTileAt = Date.now() }
  page.on('response', onTile)
  const tMap = Date.now()
  await page.getByRole('button', { name: 'Map', exact: true }).click()
  await page.waitForTimeout(150)
  const meanwhile = await page.evaluate(() => {
    const ph = document.querySelector('.map-loading')
    return ph && ph.getBoundingClientRect().height > 0 ? `placeholder: "${ph.textContent.trim().replace(/\s+/g, ' ')}"` : 'no placeholder (blank until tiles)'
  })
  const t1 = Date.now()
  while (Date.now() - t1 < 40000) {
    if (firstTileAt != null && (await page.evaluate(() => !!window.__map?.loaded()).catch(() => false))) break
    await page.waitForTimeout(50)
  }
  page.off('response', onTile)
  rec('first map', visit, 'basemap painted (first tile + map loaded)', firstTileAt == null ? null : Date.now() - tMap, meanwhile)
  }

  // ---- Satellite: switch it on → play enabled; → newest frame on the map ----
  if (want('satellite')) {
  if (!want('map')) await page.getByRole('button', { name: 'Map', exact: true }).click()
  const tSat = await page.evaluate(() => Date.now())
  await page.evaluate(() => window.__store.set((s) => ({ layers: { ...s.layers, radar: false, satellite: true } })))
  const sinceSat = async (cond) => ((await until(cond, 40000, tSat)) == null ? null : await page.evaluate((t) => Date.now() - t, tSat))
  const tPlay = await sinceSat(() => { const b = document.querySelector('.playdock button.play, .playbar button.play'); return !!b && !b.disabled })
  const tFrames = await sinceSat((t) => (window.__store.get().satellite.freshness?.fetchedAt ?? 0) >= t)
  rec('satellite', visit, 'play button enabled', tPlay)
  rec('satellite', visit, 'frame list loaded (fetched after the switch)', tFrames)
  await page.evaluate(() => window.__store.set((s) => ({ layers: { ...s.layers, radar: true, satellite: false } })))
  }

  // ---- Search: type "Des Moines" in the place picker → the first result row ----
  if (want('search')) {
  await openNow(page)
  await page.evaluate(() => window.__store.set({ pickerOpen: true, pickerMode: 'search' }))
  const box = page.getByRole('dialog').getByRole('searchbox').first()
  await box.waitFor({ timeout: 5000 })
  await box.fill('')
  await box.pressSequentially('Des Moines', { delay: 90 })
  const tSearch = await until(() => [...document.querySelectorAll('.search-results [role="option"]')].some((o) => /Des Moines/.test(o.textContent)), 30000)
  const busyShown = await page.evaluate(() => document.querySelector('.search-results')?.textContent.slice(0, 80) ?? '')
  rec('search', visit, '"Des Moines" first result (after last key)', tSearch, busyShown)
  await page.evaluate(() => window.__store.set({ pickerOpen: false, pickerMode: 'menu' }))
  }

  // ---- Rivers: More → Rivers & gauges → the first gauge row; → the full list (USGS + NOAA) ----
  if (want('rivers')) {
  const tRiv = await page.evaluate(() => Date.now())
  await openMore(page, 'Rivers & gauges')
  const sinceRiv = async (cond) => ((await until(cond, 40000)) == null ? null : await page.evaluate((t) => Date.now() - t, tRiv))
  const tRow = await sinceRiv(() => !!document.querySelector('.gauge-list .gauge-row'))
  const tFull = await sinceRiv(() => window.__store.get().riversTier === 'full' && window.__store.get().rivers.state === 'ready' && window.__store.get().rivers.data?.some((g) => g.sources.includes('USGS')) && (window.__store.get().rivers.freshness?.fetchedAt ?? 0) > performance.timeOrigin)
  const cachedNote = await page.evaluate(() => document.querySelector('.page-body')?.innerText.match(/(as of|cached|saved|last visit)[^\n]*/i)?.[0] ?? '')
  rec('rivers', visit, 'first gauge row', tRow, cachedNote)
  rec('rivers', visit, 'full list (USGS + NOAA)', tFull)
  await page.screenshot({ path: `${OUT}/rivers-${visit}.png` })
  }
  await openNow(page)
}

done()
await browser.close()
const fmt = (ms) => (ms == null ? 'timeout' : `${(ms / 1000).toFixed(1)} s`)
console.log(`perf-paths ${LABEL} · ${profile.browser}${headless ? ' (headless)' : ''} · CPU 4× · delays ${Object.entries(DELAYS).map(([h, ms]) => `${h.split('.')[0]} ${ms / 1000}s`).join(', ')}`)
for (const r of rows) console.log(`${r.path.padEnd(10)} ${r.visit.padEnd(7)} ${r.metric.padEnd(44)} ${fmt(r.ms).padStart(8)}  ${r.note}`)
writeFileSync(`${OUT}/perf-paths${LABEL ? '-' + LABEL : ''}.json`, JSON.stringify({ base: BASE, label: LABEL, at: new Date().toISOString(), profile, rows }, null, 2))
