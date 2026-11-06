// Playback time labels on a small phone (375 × 667), mocked only, by walking the scrubber frame by frame with the
// keyboard (radar + the rain overlay): every frame, past radar and forecast alike, reads a clock time; the Now
// boundary between them is marked and labelled "radar up to now, forecast after"; forecast frames say so.
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
const past = frames.filter((f) => f.time != null && f.now - f.time >= 5 * 60_000)
const CLOCK = /^\d{1,2}:\d{2}( ?[AP]M)?(\n(forecast|radar))?$/
check('The scrubber walks a full timeline: past radar frames, the current one, then forecast frames', frames.length >= 20 && future.length >= 12 && past.length >= 5, `${frames.length} frames: ${frames.map((f) => f.label.replace(/\n/g, ' ')).join(' · ')}`)
const notClock = frames.filter((f) => !CLOCK.test(f.label))
check('Every frame reads a clock time, past and forecast alike (no "+2 h 18 min", no "25 min ago", no "Now")', notClock.length === 0, notClock.map((f) => f.label).join(' · ') || frames.map((f) => f.label.split('\n')[0]).join(' · '))
const expected = (f) => new Date(f.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const wrongClock = frames.filter((f) => f.label.split('\n')[0] !== expected(f))
check('Each label is the clock time of that frame', wrongClock.length === 0, wrongClock.map((f) => `${f.label} vs ${expected(f)}`).join(' · ') || 'all match')
check('Forecast frames say "forecast" under their time; past frames say "radar" (one line always, so the bar keeps its height)', future.every((f) => /\nforecast$/.test(f.label)) && past.every((f) => /\nradar$/.test(f.label)), `future ${future.length}, past ${past.length}`)
const boundaryText = await page.locator('.playbar-boundary').innerText().catch(() => '')
check('The Now boundary row reads "← Past radar · Now 7:52 PM · Forecast →" with the marker', /Past radar[\s\S]*Now \d{1,2}:\d{2}( ?[AP]M)?[\s\S]*Forecast →/.test(boundaryText) && (await page.locator('.playbar-boundary .boundary-mark').count()) === 1, `"${boundaryText.replace(/\n/g, ' ')}"`)
// Mockup A4: the track is two colours — the accent up to Now, amber after it (the pill's progress line too).
const trackBg = await page.evaluate(() => getComputedStyle(document.querySelector('.playbar .scrubber')).backgroundImage)
check('The playback track is two colours: recorded radar up to Now, amber (rgb(245, 158, 11)) for the forecast', /linear-gradient/.test(trackBg) && /rgb\(245, 158, 11\)/.test(trackBg), trackBg.slice(0, 120))
await page.screenshot({ path: `${OUT}/bar-last-frame.png` })

// ---- Past frames and the buttons (audit r2 #9) ----
const size = async (sel) => { const b = await page.locator(sel).boundingBox(); return b ? { w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.x + b.width) } : null }
const play = await size('.playbar .play')
const close = await size('.playbar .playbar-close')
// Nov 6, 2026: every phone control is a 44 × 44 px tap target (it was ▶ 40 px and ✕ 32 px), and both stay on screen.
check('In the expanded bar on a phone ▶ and ✕ render at 44 × 44 px, both inside the screen', play?.w === 44 && play?.h === 44 && close?.w === 44 && close?.h === 44 && close.right <= 390, `▶ ${JSON.stringify(play)} ✕ ${JSON.stringify(close)}`)
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
check(`The oldest satellite frame's label ("${longest.replace(/\n/g, ' ')}") fits the expanded bar at 375 px: every control inside the viewport, ✕ fully visible, the label not clipped`, CLOCK.test(longest) && rowFits && timeFits && close2 && close2.right <= 375, `✕ ${JSON.stringify(close2)}, row fits ${rowFits}, label fits ${timeFits}`)
await page.screenshot({ path: `${OUT}/bar-longest-label.png` })
await page.locator('.playbar .playbar-close').click()
await page.waitForTimeout(400)
const pill = await size('.playpill')
const pillPlay = await size('.playpill .play')
const pillLabel = await page.evaluate(() => { const el = document.querySelector('.playpill .pill-label'); return { text: el.innerText, fits: el.scrollWidth <= el.clientWidth + 1 } })
const fab = await size('.fab-main')
check('That label fits the pill at 375 px (pill inside the viewport, label not clipped, clear of ☰; ▶ 44 px)', !!pill && pill.right <= 375 && pillLabel.fits && CLOCK.test(pillLabel.text) && pillPlay?.w === 44 && (!fab || pill.right <= 375 - fab.w - 8), `pill ${JSON.stringify(pill)} label "${pillLabel.text}" fits ${pillLabel.fits} ▶ ${JSON.stringify(pillPlay)} fab ${JSON.stringify(fab)}`)
await page.screenshot({ path: `${OUT}/pill-longest-label.png` })
done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
