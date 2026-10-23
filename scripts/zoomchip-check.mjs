// The playback bar's "Zoom to <place>" chip, mocked only: after a reload with Chicago saved and the rain overlay on,
// the chip never appears while the map lands on Chicago (a MutationObserver armed before the page's scripts records
// every insertion); panning away from the place shows it; tapping it brings the map back and the chip goes.
// Desktop (the bar is always expanded) and phone (the pill expanded first).
//   node scripts/zoomchip-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { expandPlayback, openMap } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  zoomchip-check.mjs: mocked only')
  process.exit(3)
}
assertBudget('zoomchip-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/zoomchip'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const CHICAGO = { lng: -87.6298, lat: 41.8781 }
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
for (const [name, vp] of [['desktop', { width: 1366, height: 800, isMobile: false, hasTouch: false }], ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true }]]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch })
  await ctx.addInitScript((c) => {
    try {
      localStorage.setItem('stormscope.place', JSON.stringify({ name: 'Chicago, Illinois, United States', lngLat: c, source: 'search', label: 'Chicago, Illinois, United States' }))
      localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: true, flood: false, rivers: true, station: true, nowcast: false }))
      localStorage.setItem('stormscope.geo.asked', '1')
    } catch {}
    // Every insertion of a "Zoom to …" button, with the time since navigation.
    window.__zoomChip = []
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) for (const b of [n, ...n.querySelectorAll('button')]) if (b.tagName === 'BUTTON' && /^Zoom to /.test(b.textContent)) window.__zoomChip.push({ t: Math.round(performance.now()), text: b.textContent })
    }).observe(document, { childList: true, subtree: true })
  }, CHICAGO)
  const page = await ctx.newPage()
  const done = trackTraffic(page, `zoomchip-check.mjs ${name} (mock)`)
  await installMocks(ctx, {})
  const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(150) } return false }
  const chipCount = () => page.getByRole('button', { name: /^Zoom to / }).count()
  const view = () => page.evaluate(() => { const m = window.__map; const c = m.getCenter(); return { lng: +c.lng.toFixed(3), lat: +c.lat.toFixed(3), zoom: +m.getZoom().toFixed(2) } })

  await page.goto(BASE, { waitUntil: 'load' })
  if (name === 'phone') {
    await openMap(page)
    await expandPlayback(page)
  }
  // Let the map land on Chicago and its blocks load.
  await until(() => window.__map?.loaded() && window.__store.get().visibleBlocks.length > 0, 30000)
  await page.waitForTimeout(2500)
  const landed = await view()
  const inserted = await page.evaluate(() => window.__zoomChip)
  check(`[${name}] reload with Chicago selected: the map lands on Chicago and no "Zoom to Chicago" chip ever appeared`, Math.abs(landed.lng - CHICAGO.lng) < 0.01 && Math.abs(landed.lat - CHICAGO.lat) < 0.01 && inserted.length === 0 && (await chipCount()) === 0, `view ${JSON.stringify(landed)}; chip insertions ${JSON.stringify(inserted)}`)
  await page.screenshot({ path: `${OUT}/${name}-landed.png` })

  // Pan away (Indianapolis, ~260 km): Chicago leaves the view, the chip appears.
  await page.evaluate(() => window.__map.jumpTo({ center: [-86.158, 39.768], zoom: 9.5 }))
  await until(async () => (await chipCount()) === 1, 4000)
  check(`[${name}] panning away from Chicago shows the chip`, (await chipCount()) === 1, `view ${JSON.stringify(await view())}`)
  await page.screenshot({ path: `${OUT}/${name}-away.png` })

  // Tap it: the map returns to Chicago and the chip goes.
  await page.getByRole('button', { name: /^Zoom to / }).click()
  await until(async () => { const v = await view(); return Math.abs(v.lng - CHICAGO.lng) < 0.01 && Math.abs(v.lat - CHICAGO.lat) < 0.01 && (await chipCount()) === 0 }, 5000)
  const back = await view()
  check(`[${name}] tapping it brings the map back to Chicago and the chip disappears`, Math.abs(back.lng - CHICAGO.lng) < 0.01 && Math.abs(back.lat - CHICAGO.lat) < 0.01 && back.zoom >= 8.5 && (await chipCount()) === 0, `view ${JSON.stringify(back)}, chips ${await chipCount()}`)
  await page.screenshot({ path: `${OUT}/${name}-back.png` })
  done()
  await ctx.close()
}
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
