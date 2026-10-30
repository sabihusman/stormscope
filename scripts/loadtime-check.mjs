// Load behaviour and overflow per screen on a phone (390 × 844), mocked only — the redesign's guardrail: for Now, Map,
// Trip and More it records the time from navigation until the screen's data is in and the time until the network is
// quiet, and checks that nothing overflows horizontally (page, screen, no control past the right edge). Prints a table
// to compare builds; fails only on overflow or a load past the 8 s ceiling the audit measured.
//   node scripts/loadtime-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, expandPlayback } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  loadtime-check.mjs: mocked only (the same answers every run, so the times compare builds, not networks)')
  process.exit(3)
}
assertBudget('loadtime-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/loadtime'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const CEILING_MS = 8000
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const rows = []
const overflow = (page) => page.evaluate(() => {
  const w = window.innerWidth
  const bad = [...document.querySelectorAll('.app *')].filter((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && cs.position !== 'fixed' && cs.visibility !== 'hidden' && r.right > w + 1 && !el.closest('.hour-strip, .journey-strip, .maplibregl-canvas-container, .map-container, .now-map-still') })
  return { page: document.documentElement.scrollWidth - w, screens: [...document.querySelectorAll('.screen')].map((s) => s.scrollWidth - s.clientWidth).filter((d) => d > 1), controls: bad.slice(0, 5).map((el) => `${el.className || el.tagName}@${Math.round(el.getBoundingClientRect().right)}`) }
})
for (const screen of ['now', 'map', 'trip', 'more']) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
  const page = await ctx.newPage()
  const done = trackTraffic(page, `loadtime-check.mjs ${screen} (mock)`)
  let lastReq = Date.now()
  page.on('request', () => { lastReq = Date.now() })
  await installMocks(ctx, {})
  const t0 = Date.now()
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  if (screen !== 'now') await page.getByRole('button', { name: new RegExp(`^${screen[0].toUpperCase() + screen.slice(1)}`), exact: screen !== 'now' }).click()
  const readyFn = { now: () => { const s = window.__store.get(); return s.conditions.state === 'ready' && s.alerts.state === 'ready' && s.station.state === 'ready' }, map: () => !!window.__map?.loaded() && !!window.__store.get().radar.data, trip: () => !!document.querySelector('.screen.trip .trip-from'), more: () => document.querySelectorAll('.more-list .more-row').length >= 4 }[screen]
  let ready = null
  while (Date.now() - t0 < 30000) { if (await page.evaluate(readyFn).catch(() => false)) { ready = Date.now() - t0; break } await page.waitForTimeout(50) }
  // Settled: 1.5 s with no request.
  while (Date.now() - t0 < 40000 && Date.now() - lastReq < 1500) await page.waitForTimeout(100)
  const settled = Date.now() - t0
  if (screen === 'map') await expandPlayback(page)
  await page.waitForTimeout(300)
  const of = await overflow(page)
  rows.push({ screen, ready, settled, overflow: of })
  await page.screenshot({ path: `${OUT}/${screen}.png` })
  check(`[${screen}] data in by ${ready != null ? (ready / 1000).toFixed(1) + ' s' : 'never'} (ceiling ${CEILING_MS / 1000} s), network quiet by ${(settled / 1000).toFixed(1)} s`, ready != null && ready <= CEILING_MS)
  check(`[${screen}] no horizontal overflow (page, screen, controls)`, of.page <= 1 && of.screens.length === 0 && of.controls.length === 0, JSON.stringify(of))
  done()
  await ctx.close()
}
console.log('\nscreen  data-in  quiet  overflow')
for (const r of rows) console.log(`${r.screen.padEnd(7)} ${String(r.ready != null ? (r.ready / 1000).toFixed(1) + 's' : 'never').padEnd(8)} ${((r.settled / 1000).toFixed(1) + 's').padEnd(6)} ${r.overflow.page <= 1 && !r.overflow.screens.length && !r.overflow.controls.length ? 'none' : JSON.stringify(r.overflow)}`)
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
