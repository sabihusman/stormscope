// The playback horizon (6 / 12 / 24 / 48 h) when zoomed out, mocked only, on a 390 px phone: with the rain overlay on
// and the map at a state-wide zoom (no forecast blocks of its own), the slider still plays the place's forecast to the
// chosen horizon — the last frame is about 48 h ahead with 48 h picked, 6 h with 6 h — and the note says the forecast
// is for the place only. While the forecast is still loading the hour buttons are marked pending and the note says so.
//   node scripts/horizon-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, expandPlayback, openMap } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  horizon-check.mjs: mocked only')
  process.exit(3)
}
assertBudget('horizon-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/horizon'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const HOUR = 3_600_000
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
await ctx.addInitScript(() => { try { localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: true, flood: false, rivers: true, station: true, nowcast: false })) } catch {} })
const page = await ctx.newPage()
const done = trackTraffic(page, 'horizon-check.mjs (mock)')
// Hold the forecast a moment so the pending state is observable.
await installMocks(ctx, { delayHosts: { 'api.open-meteo.com': 2500 } })
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(150) } return false }
await until(() => !!window.__map?.loaded() && !!window.__store?.get().radar.data)
await openMap(page)
// Zoom out to a state-wide view, as in the report (the 100 km scale): no forecast blocks of the map's own.
await page.evaluate(() => window.__map.jumpTo({ center: [-93.6, 41.6], zoom: 5 }))
await expandPlayback(page)
await page.waitForTimeout(300)
const pending = await page.evaluate(() => ({ visible: window.__store.get().visibleBlocks.length, pending: document.querySelectorAll('.playbar .horizon button.pending').length, note: document.querySelector('.playbar-note')?.innerText ?? '' }))
check('Zoomed out with rain on: the map has no forecast blocks of its own', pending.visible === 0, `${pending.visible} visible blocks`)
check('While the forecast loads the hour buttons are marked pending and the note says the slider covers radar only', pending.pending === 4 || /Loading the rain forecast/.test(pending.note) || (await page.evaluate(() => { const s = window.__store.get(); return s.place && Object.values(s.blocks).some((b) => b.rainCells.state === 'ready') })), `${pending.pending} pending buttons; "${pending.note}"`)
// The place's own block loads anyway; the slider then reaches the horizon.
const ready = await until(() => Object.values(window.__store.get().blocks).some((b) => b.rainCells.state === 'ready'), 40000)
await page.waitForTimeout(500)
const lastFrame = async () => {
  const scrub = page.locator('.playbar .scrubber')
  await scrub.focus()
  // Home first: after a horizon change the slider may already sit at its last index, where End fires no change.
  await page.keyboard.press('Home')
  await page.waitForTimeout(150)
  await page.keyboard.press('End')
  await page.waitForTimeout(250)
  return page.evaluate(() => ({ ahead: (window.__store.get().playTime - Date.now()) / 3_600_000, label: document.querySelector('.playbar-time')?.innerText.replace(/\n/g, ' '), note: document.querySelector('.playbar-note')?.innerText.replace(/\n/g, ' | ') ?? '', pending: document.querySelectorAll('.playbar .horizon button.pending').length }))
}
await page.getByRole('radio', { name: '48 h' }).click()
await page.waitForTimeout(600)
const f48 = await lastFrame()
check('Zoomed out, 48 h picked: the slider\'s last frame is about 48 h ahead (the place\'s forecast), not the end of radar', ready && f48.ahead > 46 && f48.ahead <= 49, `${f48.ahead.toFixed(1)} h ahead, "${f48.label}"`)
check('The note says the forecast playback is for the place only and to zoom in for the map; no button is pending any more', /Forecast playback is for .+ only — zoom in to see it across the map/.test(f48.note) && f48.pending === 0, `"${f48.note}"`)
await page.screenshot({ path: `${OUT}/zoomed-out-48h.png` })
await page.getByRole('radio', { name: '6 h' }).click()
await page.waitForTimeout(600)
const f6 = await lastFrame()
check('6 h picked: the last frame is about 6 h ahead', f6.ahead > 4.5 && f6.ahead <= 7, `${f6.ahead.toFixed(1)} h ahead`)
done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
