// Verifies block tiling: blocks persist across pans, only missing neighbours load,
// the loaded area covers the viewport, and small pans cause no refetch.
import { chromium } from 'playwright'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
// --mock answers every API locally (zero live calls, scripts/lib/mock-server.mjs); live-only checks are skipped and said so.
const MOCK = process.argv.includes('--mock')
assertBudget(MOCK ? 'blocks-check.mjs (mock)' : 'blocks-check.mjs', { openMeteo: !MOCK })
import { mkdirSync } from 'node:fs'
import { allowLocation, openMap, openMore, openTrip, pageText, setLayers, setSheet, setUnits, sheetText, tripText, searchPlace, openNow } from './lib/ui.mjs'

const BASE = process.argv[2] || 'http://localhost:5174/'
const OUT = process.argv[3] || 'e2e-shots/blocks'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, geolocation: { latitude: 41.67, longitude: -93.7 }, permissions: ['geolocation'] })
await ctx.addInitScript(() => { try { if (!localStorage.getItem('stormscope.layers')) localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: false, station: false, nowcast: false })) } catch {} })
const page = await ctx.newPage()
const __recordBudget = trackOpenMeteo(page, MOCK ? 'blocks-check.mjs (mock)' : 'blocks-check.mjs')
if (MOCK) await installMocks(ctx, { focus: { lat: 41.67, lng: -93.7 } })
const omRequests = []
page.on('request', (r) => /api\.open-meteo\.com\/v1\/forecast/.test(r.url()) && /hourly=precipitation/.test(r.url()) && omRequests.push(r.url()))
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
await page.waitForTimeout(5000)
await openMap(page)
await setLayers(page, { rainfall: true, flood: true })

const settle = async (ms = 45000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const s = await state()
    if (s.visible > 0 && s.loaded === s.visible && s.flood === s.visible) return s
    await page.waitForTimeout(500)
  }
  return state()
}
const state = () =>
  page.evaluate(() => {
    const s = window.__store.get()
    const vis = s.visibleBlocks
    const loaded = vis.filter((k) => s.blocks[k]?.grid.data).length
    const flood = vis.filter((k) => s.blocks[k]?.flood.data).length
    const errors = vis.map((k) => s.blocks[k]).flatMap((b) => (b ? [b.grid.error, b.flood.error, b.rainCells.error].filter(Boolean) : []))
    return { level: s.blockLevel, visible: vis.length, loaded, flood, cached: Object.keys(s.blocks).length, zoom: window.__map.getZoom(), keys: vis, errors }
  })
let st = await settle()
check('Viewport is covered by several fixed blocks', st.visible >= 2 && st.loaded === st.visible, `level ${st.level}, ${st.loaded}/${st.visible} loaded, zoom ${st.zoom.toFixed(1)}`)
check('Flood risk computed per block (≥ half within the wait, no errors)', st.flood >= st.visible / 2 && st.errors.length === 0, `${st.flood}/${st.visible}; errors: ${st.errors.join(' | ') || 'none'}`)
const n0 = omRequests.length
await page.screenshot({ path: `${OUT}/blocks-initial.png` })

// Small pan (< one block): same blocks, no new fetches.
await page.evaluate(() => window.__map.panBy([120, 60], { duration: 0 }))
await page.waitForTimeout(2500)
const st1 = await state()
check('Small pan keeps the same blocks and fetches nothing', st1.keys.join() === st.keys.join() && omRequests.length === n0, `${omRequests.length - n0} new requests`)

// Larger pan: some blocks stay, only new neighbours are fetched.
const before = new Set(st1.keys)
await page.evaluate(() => window.__map.panBy([900, 0], { duration: 0 }))
await page.waitForTimeout(800)
const st2 = await settle()
const kept = st2.keys.filter((k) => before.has(k)).length
const added = st2.keys.filter((k) => !before.has(k)).length
check('Pan east: overlapping blocks kept, only new ones fetched', kept >= 1 && added >= 1 && omRequests.length - n0 === added, `kept ${kept}, added ${added}, fetched ${omRequests.length - n0}`)
check('Previously loaded blocks still cached after panning', st2.cached >= st2.visible + 1, `cache ${st2.cached}`)
await page.screenshot({ path: `${OUT}/blocks-panned.png` })

// Pan back: nothing refetched (served from the block cache).
const n2 = omRequests.length
await page.evaluate(() => window.__map.panBy([-900, 0], { duration: 0 }))
await page.waitForTimeout(3000)
check('Pan back: blocks come from cache, no refetch', omRequests.length === n2, `${omRequests.length - n2} new requests`)

// Zoom out to continental: blocks cleared with a hint; zoom in: level changes.
await page.evaluate(() => window.__map.jumpTo({ zoom: 4 }))
await page.waitForTimeout(1500)
const st3 = await state()
check('Continental zoom loads no blocks', st3.visible === 0)
await page.evaluate(() => window.__map.jumpTo({ zoom: 11 }))
await page.waitForTimeout(800)
const st4 = await settle()
check('Close zoom uses the finest block level', st4.level === 0 && st4.loaded >= 1, `level ${st4.level}, ${st4.loaded}/${st4.visible}`)
await page.screenshot({ path: `${OUT}/blocks-zoomed.png` })

// ---- Budget-limiter regressions ----
await openMore(page, 'Sources, freshness & settings')
await page.waitForTimeout(500)
const src = await pageText(page)
await openMap(page)
const m = src.match(/(\d[\d,]*) \/ 10 000 calls today/)
check('Sources panel shows the per-browser Open-Meteo daily counter', !!m && Number(m[1].replace(/,/g, '')) >= 49, m?.[0])
const ptsPerBlock = await page.evaluate(() => { const s = window.__store.get(); const b = s.blocks[s.visibleBlocks[0]]; return b?.grid.data?.spec.points.length })
check('Tiles use 49 sample points (7×7) at every level', ptsPerBlock === 49, `${ptsPerBlock} points`)
// Hidden tab: age the visible grids past the refresh interval, fire a visibilitychange while hidden → no fetch;
// then unhide → refetch happens.
const nBefore = omRequests.length
await page.evaluate(() => {
  const s = window.__store.get()
  const blocks = { ...s.blocks }
  for (const k of s.visibleBlocks) if (blocks[k]?.grid.freshness) blocks[k] = { ...blocks[k], grid: { ...blocks[k].grid, freshness: { ...blocks[k].grid.freshness, fetchedAt: Date.now() - 31 * 60000 } } }
  window.__store.set({ blocks })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
})
await page.waitForTimeout(3000)
check('Hidden tab: stale tiles are NOT refetched', omRequests.length === nBefore, `${omRequests.length - nBefore} requests while hidden`)
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
})
await page.waitForTimeout(6000)
check('Visible again: stale tiles refetch', omRequests.length > nBefore, `${omRequests.length - nBefore} requests after unhide`)
check('No page errors', errs.length === 0, errs[0])
__recordBudget()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
