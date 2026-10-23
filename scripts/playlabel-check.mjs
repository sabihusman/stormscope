// Playback time labels on a small phone (375 × 667), mocked only, by walking the scrubber frame by frame with the
// keyboard (radar + the rain overlay): every hourly forecast frame reads a whole number of hours ("+10 h", never
// "+9 h 44 min"); the radar nowcast frames inside the hour keep their minutes; the clock frame reads "Now".
//   node scripts/playlabel-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, expandPlayback, openMap } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  playlabel-check.mjs: mocked only')
  process.exit(3)
}
assertBudget('playlabel-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/playlabel'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
await ctx.addInitScript(() => { try { localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: true, flood: false, rivers: true, station: true, nowcast: false })) } catch {} })
const page = await ctx.newPage()
const done = trackTraffic(page, 'playlabel-check.mjs (mock)')
await installMocks(ctx, {})
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(200) } return false }
await until(() => !!window.__map?.loaded() && !!window.__store?.get().radar.data)
await openMap(page)
await page.waitForTimeout(1200)
await expandPlayback(page)
// The rain overlay's hourly frames exist once the place's block has its rain cells.
await until(() => { const s = window.__store.get(); return s.visibleBlocks.length > 0 && s.blocks[s.visibleBlocks[0]]?.rainCells.state === 'ready' }, 60000)
await page.waitForTimeout(500)

/** Walk the scrubber from its first frame to its last, reading the label and the frame time (ms) at each step. */
const walk = async () => {
  const scrub = page.locator('.playbar .scrubber')
  await scrub.focus()
  await page.keyboard.press('Home')
  const frames = []
  let last = null
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(60)
    const v = await scrub.inputValue()
    if (v === last) break
    last = v
    frames.push({ i: Number(v), label: await page.locator('.playbar-time').innerText(), time: await page.evaluate(() => window.__store.get().playTime), now: await page.evaluate(() => Date.now()) })
    await page.keyboard.press('ArrowRight')
  }
  return frames
}
const frames = await walk()
const HOUR = 3_600_000
const future = frames.filter((f) => f.time != null && f.time - f.now >= 5 * 60_000)
const hourly = future.filter((f) => f.time % HOUR === 0)
const nowcast = future.filter((f) => f.time % HOUR !== 0)
check('The scrubber walks a full timeline: past radar frames, Now, then the rain overlay\'s hourly frames', frames.length >= 20 && hourly.length >= 12 && frames.some((f) => f.label === 'Now'), `${frames.length} frames: ${frames.map((f) => f.label).join(' · ')}`)
const badHour = hourly.filter((f) => !/^\+\d+ h$/.test(f.label))
check('Every hourly forecast frame reads a whole number of hours ("+10 h"), never hours and minutes', hourly.length > 0 && badHour.length === 0, badHour.length ? badHour.map((f) => f.label).join(' · ') : hourly.map((f) => f.label).join(' · '))
// The whole hours count from the current hour: the k-th hourly frame after the current hour reads "+k h".
const wrongCount = hourly.filter((f) => f.label !== `+${Math.ceil((f.time - f.now) / HOUR)} h`)
check('The hour count is the number of the frame\'s hour after the current one (+1 h for the next hour, "+10 h" for 9 h 44 min ahead)', wrongCount.length === 0, wrongCount.map((f) => `${f.label} for ${Math.round((f.time - f.now) / 60_000)} min ahead`).join(' · ') || 'all consistent')
check('Radar nowcast frames inside the hour keep their minutes ("+10 min")', nowcast.every((f) => /^\+\d+ min$/.test(f.label)), nowcast.map((f) => f.label).join(' · '))
await page.screenshot({ path: `${OUT}/bar-last-frame.png` })

// ---- Past frames and the buttons (audit r2 #9) ----
const past = frames.filter((f) => f.time != null && f.now - f.time >= 5 * 60_000)
const AGO = /^\d+ min ago$|^\d+ h( \d+ min)? ago$/
check('Past frames read how long ago ("25 min ago"), never a clock time', past.length >= 5 && past.every((f) => AGO.test(f.label)), past.map((f) => f.label).join(' · '))
const size = async (sel) => { const b = await page.locator(sel).boundingBox(); return b ? { w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.x + b.width) } : null }
const play = await size('.playbar .play')
const close = await size('.playbar .playbar-close')
check('In the expanded bar on a phone ▶ renders at 40 × 40 px and ✕ at 32 × 32 px', play?.w === 40 && play?.h === 40 && close?.w === 32 && close?.h === 32, `▶ ${JSON.stringify(play)} ✕ ${JSON.stringify(close)}`)
// The longest label: satellite frames reach back over three hours ("4 h 10 min ago" in the mock).
await page.evaluate(() => window.__store.set((s) => ({ layers: { ...s.layers, satellite: true, radar: false }, animLayer: 'satellite' })))
await until(() => window.__store.get().satellite.data?.times.length > 10, 30000)
await page.waitForTimeout(500)
const scrub = page.locator('.playbar .scrubber')
await scrub.focus()
await page.keyboard.press('Home')
await page.waitForTimeout(300)
const longest = await page.locator('.playbar-time').innerText()
const close2 = await size('.playbar .playbar-close')
const rowFits = await page.evaluate(() => [...document.querySelectorAll('.playbar-row > *')].every((el) => { const r = el.getBoundingClientRect(); return r.right <= window.innerWidth + 0.5 && r.left >= -0.5 }))
const timeFits = await page.evaluate(() => { const el = document.querySelector('.playbar-time'); return el.scrollWidth <= el.clientWidth + 1 })
check(`The longest label ("${longest}") fits the expanded bar at 375 px: every control inside the viewport, ✕ fully visible, the label not clipped`, /h \d+ min ago/.test(longest) && rowFits && timeFits && close2 && close2.right <= 375, `✕ ${JSON.stringify(close2)}, row fits ${rowFits}, label fits ${timeFits}`)
await page.screenshot({ path: `${OUT}/bar-longest-label.png` })
await page.locator('.playbar .playbar-close').click()
await page.waitForTimeout(400)
const pill = await size('.playpill')
const pillPlay = await size('.playpill .play')
const pillLabel = await page.evaluate(() => { const el = document.querySelector('.playpill .pill-label'); return { text: el.innerText, fits: el.scrollWidth <= el.clientWidth + 1 } })
const fab = await size('.fab-main')
check('The longest label fits the pill at 375 px (pill inside the viewport, label not clipped, clear of ☰; ▶ 44 px)', !!pill && pill.right <= 375 && pillLabel.fits && /ago/.test(pillLabel.text) && pillPlay?.w === 44 && (!fab || pill.right <= 375 - fab.w - 8), `pill ${JSON.stringify(pill)} label "${pillLabel.text}" fits ${pillLabel.fits} ▶ ${JSON.stringify(pillPlay)} fab ${JSON.stringify(fab)}`)
await page.screenshot({ path: `${OUT}/pill-longest-label.png` })
done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
