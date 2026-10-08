// The Now flood tile computes on demand. A fresh open makes no flood request at all (no 49-location
// Open-Meteo block, no terrain tile, no NHD query) even though the tiles row touches the bottom edge of a
// 390 × 844 phone; scrolling the Now screen with the tile on screen computes it once; opening the Flood
// page then reuses the cached block (no second block request); the tile keeps the level.
//   node scripts/flood-tile-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMore, openNow } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
assertBudget(`flood-tile-check.mjs${MOCK ? ' (mock)' : ''}`)
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/flood-tile'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
// Flood requests: a multi-location Open-Meteo block, a terrain tile, an NHD query.
const flood = { blocks: 0, terrain: 0, nhd: 0 }
const count = (url) => {
  if (/open-meteo\.com\/v1\/forecast/.test(url) && (url.match(/[?&]latitude=([^&]*)/)?.[1].split(',').length ?? 1) > 1) flood.blocks++
  if (/s3\.amazonaws\.com\/elevation-tiles/.test(url)) flood.terrain++
  if (/hydro\.nationalmap\.gov/.test(url)) flood.nhd++
}
const snapshot = () => ({ ...flood })
const since = (a) => ({ blocks: flood.blocks - a.blocks, terrain: flood.terrain - a.terrain, nhd: flood.nhd - a.nhd })
const fmt = (d) => `blocks ${d.blocks}, terrain tiles ${d.terrain}, NHD ${d.nhd}`

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
const page = await ctx.newPage()
const done = trackTraffic(page, `flood-tile-check.mjs${MOCK ? ' (mock)' : ''}`)
// Count each request once: the mock hook under --mock (the page's request event fires for those too), the page event live.
if (MOCK) {
  globalThis.__qaMockedRequest = count
  await installMocks(ctx, {})
} else page.on('request', (r) => count(r.url()))
const until = async (fn, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(250) } return false }
const tileText = () => page.locator('.tiles .tile').nth(1).innerText()

// 1. Fresh open, no interaction: everything else loads, no flood request.
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
await until(() => { const s = window.__store.get(); return s.conditions.state === 'ready' && s.station.state === 'ready' && s.alerts.state === 'ready' })
await page.waitForTimeout(4000)
const tileBox = await page.locator('.tiles').boundingBox()
check('Fresh open (390 × 844, no scroll): zero flood requests', flood.blocks === 0 && flood.terrain === 0 && flood.nhd === 0, `${fmt(flood)}; tiles row top at ${Math.round(tileBox?.y ?? -1)} px`)
check('Tile invites instead of computing: "Check flood risk ›"', /Check flood risk/.test(await tileText()), await tileText())
await page.screenshot({ path: `${OUT}/fresh-open.png` })

// 2. Scroll the Now screen with the tile on screen: one block, terrain, one NHD; the level appears.
const a = snapshot()
await page.locator('.tiles').scrollIntoViewIfNeeded()
await page.evaluate(() => document.querySelector('.screen.now').scrollBy(0, 40))
await until(() => /at /.test(document.querySelectorAll('.tiles .tile')[1]?.innerText ?? ''), 90000)
const d2 = since(a)
check('Scrolling to the tile computes the place block once', d2.blocks === 1 && d2.terrain > 0 && d2.nhd === 1, fmt(d2))
check('Tile shows the level for the place', /^(Low|Elevated|Moderate|High|Severe) at /.test((await tileText()).split('\n').at(-1) ?? ''), await tileText())
await page.screenshot({ path: `${OUT}/after-scroll.png` })

// 3. The Flood page reuses the cached block; back on Now the level is still there.
const b = snapshot()
await openMore(page, 'Flood risk')
await until(() => !!document.querySelector('.flood-here'), 30000)
const d3 = since(b)
check('Flood page reuses the cached block (no second block request)', d3.blocks === 0 && d3.nhd === 0, fmt(d3))
await openNow(page)
await page.waitForTimeout(500)
check('Back on Now, the tile keeps the cached level', /^(Low|Elevated|Moderate|High|Severe) at /.test((await tileText()).split('\n').at(-1) ?? ''), await tileText())

done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
