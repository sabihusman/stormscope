// The Now tab's map window on a phone: a still of the live map in the page's own flow — it scrolls
// with the page, the live map is never repositioned into it, nothing runs per frame or per scroll
// event, and the still is redrawn only when the map renders something new (its idle event).
//   node scripts/nowmap-check.mjs [base-url] [shots-dir] [--mock]
// (A laptop cannot show the iPhone scroll lag this guards against; these checks pin the mechanism.)
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
assertBudget('nowmap-check.mjs')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/nowmap'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const FOCUS = { lat: 41.673, lng: -93.698 }
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, geolocation: { latitude: FOCUS.lat, longitude: FOCUS.lng }, permissions: ['geolocation'] })
const page = await ctx.newPage()
const done = trackTraffic(page, 'nowmap-check.mjs')
if (MOCK) await installMocks(ctx, {})
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(200) } return false }
await until(() => window.__store?.get().conditions.state === 'ready')
await until(() => (window.__mapWindow?.drawn ?? 0) > 0, 20000)
await page.waitForTimeout(500)

const state = () => page.evaluate(() => {
  const still = document.querySelector('.now-map-window .now-map-still')
  const win = document.querySelector('.now-map-window')
  const root = document.querySelector('.map-root')
  const screen = document.querySelector('.screen')
  const r = still?.getBoundingClientRect(), m = root?.getBoundingClientRect()
  return { drawn: window.__mapWindow?.drawn ?? 0, stillTop: r?.top ?? null, stillH: r?.height ?? null, mapTop: m?.top ?? null, mapH: m?.height ?? null, mapW: m?.width ?? null, scroll: screen?.scrollTop ?? null, winHasMapRoot: !!win?.querySelector('.map-root'), hasClass: document.querySelector('.app')?.classList.contains('has-map-window') ?? false, stillPx: still ? [still.width, still.height] : null }
})
const s0 = await state()
check('The Now window holds a still (a canvas in the page flow), not the live map; the live map stays full-size behind the screen', s0.stillPx && s0.stillPx[0] > 0 && !s0.winHasMapRoot && !s0.hasClass && s0.mapTop === 0 && s0.mapH >= 800, JSON.stringify(s0))
const pixels = await page.evaluate(() => {
  const c = document.querySelector('.now-map-window .now-map-still')
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let opaque = 0, colours = new Set()
  for (let i = 0; i < d.length; i += 4 * 97) { if (d[i + 3] > 200) opaque++; colours.add((d[i] >> 4) * 256 + (d[i + 1] >> 4) * 16 + (d[i + 2] >> 4)) }
  return { samples: Math.floor(d.length / (4 * 97)), opaque, colours: colours.size }
})
check('The still is a real picture (opaque pixels, more than a few colours) — the copy from the WebGL canvas worked', pixels.opaque > pixels.samples * 0.9 && pixels.colours >= 4, JSON.stringify(pixels))
const drawnBefore = s0.drawn
// Scroll the Now screen down and up: the still moves exactly with the page (its rect shifts by the scroll),
// the live map does not move, and nothing redraws the still.
await page.evaluate(() => { document.querySelector('.screen').scrollTop = 120 })
await page.waitForTimeout(400)
const s1 = await state()
await page.evaluate(() => { document.querySelector('.screen').scrollTop = 0 })
await page.waitForTimeout(400)
const s2 = await state()
check('Scrolled 120 px: the still is 120 px higher (it is in the page flow), the live map did not move', Math.round(s0.stillTop - s1.stillTop) === 120 && s1.mapTop === 0 && s1.scroll === 120, JSON.stringify({ before: s0.stillTop, after: s1.stillTop, mapTop: s1.mapTop }))
check('Scrolling redrew nothing (no idle, no draw: the still was not touched during or after the scroll)', s1.drawn === drawnBefore && s2.drawn === drawnBefore, `drawn ${drawnBefore} → ${s1.drawn} → ${s2.drawn}`)
// The map renders something new (a move) → its idle → one more still.
const before = (await state()).drawn
await page.evaluate(() => { window.__map.easeTo({ center: [-93.5, 41.8], duration: 0 }) })
for (let i = 0; i < 40; i++) { if ((await state()).drawn > before) break; await page.waitForTimeout(200) }
await page.waitForTimeout(300)
const s3 = await state()
check('When the map renders something new (a move), its idle event redraws the still once', s3.drawn > before && s3.drawn <= before + 3, `drawn ${before} → ${s3.drawn}`)
// Tap → Map.
await page.locator('.now-map-window').tap()
await page.waitForTimeout(500)
check('Tapping the window opens the Map', await page.evaluate(() => window.__store.get().screen === 'map'))
await page.screenshot({ path: `${OUT}/now-map-window.png` })
done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
