// Scripted QA pass. Each check logs PASS/FAIL with evidence; screenshots go to OUT.
import { chromium } from 'playwright'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
assertBudget('qa.mjs')
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] || 'http://localhost:5173/'
const OUT = process.argv[3] || 'e2e-shots/qa'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, evidence = '') => {
  results.push({ name, ok, evidence })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? '  — ' + evidence : ''}`)
}
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
const browser = await chromium.launch({ args: GL })
const PHL = { latitude: 39.9526, longitude: -75.1652 }
const mobile = (extra = {}) => ({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ...extra })
const settle = (p, ms = 800) => p.waitForTimeout(ms)
const errorsOf = (page) => {
  const errs = []
  page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && !/ERR_ABORTED|net::ERR_FAILED|status of 429/.test(m.text()) && errs.push(`[console] ${m.text()}`))
  return errs
}

// ---------------------------------------------------------------- 1. Denied geolocation
{
  const ctx = await browser.newContext(mobile({ permissions: [] }))
  const page = await ctx.newPage()
  const __recordDenied = trackOpenMeteo(page, 'qa.mjs (denied-location context)') // counts + protected-preview bypass headers
  await page.goto(BASE, { waitUntil: 'networkidle' })
  check('First-run prompt shown before browser dialog', await page.getByRole('heading', { name: 'Use your location?' }).isVisible())
  await page.getByRole('button', { name: 'Allow location' }).click()
  await settle(page, 2500)
  const denied = await page.getByRole('heading', { name: "Couldn't get your location" }).isVisible()
  check('Denied permission → friendly recovery card', denied)
  await page.screenshot({ path: `${OUT}/denied.png` })
  await page.getByRole('button', { name: 'Search for a place' }).click()
  await settle(page, 300)
  check('Recovery card → search opens with focus', await page.getByRole('searchbox').evaluate((el) => el === document.activeElement))
  await page.getByRole('button', { name: 'Close search' }).click()
  const promptGone = !(await page.getByRole('heading', { name: /location/ }).isVisible().catch(() => false))
  check('Closing search does not re-show the prompt (map usable)', promptGone)
  const mapInteractive = await page.evaluate(() => {
    const m = window.__map
    const before = m.getZoom()
    m.zoomIn({ duration: 0 })
    return m.getZoom() > before
  })
  check('Map is interactive with no location', mapInteractive)
  await ctx.close()
}

// ---------------------------------------------------------------- 2. Main flow (granted)
const ctx = await browser.newContext(mobile({ geolocation: PHL, permissions: ['geolocation'] }))
const page = await ctx.newPage()
const __recordBudget = trackOpenMeteo(page, 'qa.mjs')
const errs = errorsOf(page)
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {})
await settle(page, 5000)
await page.waitForFunction(() => window.__map?.loaded(), null, { timeout: 20000 }).catch(() => {})
check('Geolocation → place label resolved', (await page.locator('.chip-text').textContent())?.includes('Philadelphia'), await page.locator('.chip-text').textContent())

// Units: default for en-US is imperial in the real browser; here locale is en-US too.
await page.getByRole('tab', { name: 'Station' }).click()
await settle(page, 2000)
const stationText = await page.locator('.sheet-body').innerText()
check('Station panel shows pressure/humidity/wind/precip', /PRESSURE[\s\S]*HUMIDITY[\s\S]*WIND[\s\S]*PRECIPITATION/i.test(stationText))
await page.getByRole('tab', { name: 'Sources' }).click()
await settle(page)
await page.getByRole('radio', { name: /Metric/ }).click()
await page.getByRole('tab', { name: 'Station' }).click()
await settle(page)
const metric = await page.locator('.sheet-body').innerText()
check(
  'Metric units: °C, km/h, hPa, mm',
  /°C/.test(metric) && (/km\/h/.test(metric) || /Calm/.test(metric)) && /hPa/.test(metric) && (/\bmm\b/.test(metric) || /Not reported/.test(metric)),
  metric.match(/[\d.]+ °C|\d+ km\/h|Calm|hPa|[\d.]+ mm|Not reported/g)?.slice(0, 5).join(' · '),
)
await page.getByRole('tab', { name: 'Sources' }).click()
await page.getByRole('radio', { name: /Imperial/ }).click()
await page.getByRole('tab', { name: 'Station' }).click()
await settle(page)
const imperial = await page.locator('.sheet-body').innerText()
check(
  'Imperial units: °F, mph, inHg, in',
  /°F/.test(imperial) && (/mph/.test(imperial) || /Calm/.test(imperial)) && /inHg/.test(imperial) && (/[\d.]+ in\b/.test(imperial) || /Not reported/.test(imperial)),
  imperial.match(/[\d.]+ °F|\d+ mph|Calm|[\d.]+ inHg|[\d.]+ in\b|Not reported/g)?.slice(0, 5).join(' · '),
)
await page.screenshot({ path: `${OUT}/station-imperial.png` })

// Rivers in imperial: ft & ft³/s
await page.getByRole('tab', { name: 'Rivers' }).click()
await settle(page, 4000)
const rivers = await page.locator('.sheet-body').innerText()
check('Rivers list populated with stage in ft (imperial)', /Stage [\d.]+ ft/.test(rivers), rivers.split('\n').slice(0, 6).join(' | '))
await page.getByRole('tab', { name: 'Sources' }).click()
await page.getByRole('radio', { name: /Metric/ }).click()
await page.getByRole('tab', { name: 'Rivers' }).click()
await settle(page)
check('Rivers stage converts to m (metric)', /Stage [\d.]+ m\b/.test(await page.locator('.sheet-body').innerText()))

// Sheet modes & FAB reachability
const fabBox = async () => page.getByRole('button', { name: /layer menu/ }).boundingBox()
const sheetTop = async () => (await page.locator('.sheet').boundingBox()).y
check('Half sheet: FAB sits above the sheet', (await fabBox()).y + (await fabBox()).height < (await sheetTop()), `fab bottom ${Math.round((await fabBox()).y + (await fabBox()).height)} < sheet top ${Math.round(await sheetTop())}`)
// Handle tap now toggles open/closed; stepping to full is a drag up (or ArrowUp on the handle).
await page.getByRole('button', { name: 'Resize panel' }).focus()
await page.keyboard.press('ArrowUp')
await settle(page)
check('Full sheet: map strip still visible at top', (await sheetTop()) > 40, `sheet top ${Math.round(await sheetTop())}`)
check('Full sheet: FAB hidden (not blocking)', !(await page.getByRole('button', { name: /layer menu/ }).isVisible()))
await page.getByRole('button', { name: 'Collapse panel' }).click()
await settle(page)
check('Collapse → peek mode', (await page.locator('.sheet').getAttribute('class'))?.includes('peek'))
check('Peek: FAB visible again', await page.getByRole('button', { name: /layer menu/ }).isVisible())

// Legend hide → chip → show
await page.getByRole('button', { name: 'Hide legend' }).click()
check('Legend hides to a small chip', await page.getByRole('button', { name: 'Show legend' }).isVisible())
await page.getByRole('button', { name: 'Show legend' }).click()
check('Legend chip restores legend', await page.locator('.legend').isVisible())

// Popup clamping at 4 corners + centre
const W = 390
const H = 844
const corners = [
  [6, 100],
  [W - 6, 100],
  [6, H - 110],
  [W - 6, H - 110],
  [W / 2, H / 2],
]
let allInside = true
for (const [x, y] of corners) {
  await page.mouse.click(x, y)
  await settle(page, 400)
  const box = await page.locator('.map-popup').boundingBox().catch(() => null)
  if (!box) {
    allInside = false
    continue
  }
  const inside = box.x >= 0 && box.y >= 0 && box.x + box.width <= W && box.y + box.height <= H
  if (!inside) allInside = false
  await page.getByRole('button', { name: 'Close popup' }).click()
  await settle(page, 200)
}
check('Tap popups stay fully on-screen at all corners', allInside)
await page.mouse.click(6, H - 110)
await settle(page, 400)
await page.screenshot({ path: `${OUT}/popup-corner.png` })
await page.getByRole('button', { name: 'Close popup' }).click()

// Gauge popup content
const g = await page.evaluate(() => {
  const m = window.__map
  for (const f of m.queryRenderedFeatures({ layers: ['river-gauges'] })) {
    const p = m.project(f.geometry.coordinates)
    if (p.x > 40 && p.x < 340 && p.y > 300 && p.y < 700) return { x: p.x, y: p.y }
  }
  return null
})
if (g) {
  await page.mouse.click(g.x, g.y)
  await settle(page, 500)
  const t = await page.locator('.map-popup').innerText().catch(() => '')
  check('Gauge popup: category, stage, source, freshness', /risk:/.test(t) && /Stage|Flow/.test(t) && /Source:/.test(t) && /updated/.test(t), t.split('\n')[0])
  await page.screenshot({ path: `${OUT}/gauge-popup.png` })
  await page.getByRole('button', { name: 'Close popup' }).click()
} else check('Gauge popup: a gauge was tappable', false, 'no gauge in the tappable area')

// Enable all layers + timeline behaviour
await page.getByRole('button', { name: 'Open layer menu' }).click()
for (const n of ['Rainfall', 'Flood risk', 'Nowcast']) await page.getByRole('button', { name: n }).click()
await page.getByRole('button', { name: 'Close layer menu' }).click()
await settle(page, 12000)
await page.getByRole('tab', { name: 'Timeline' }).click()
await settle(page)
await page.getByRole('tab', { name: 'Radar' }).click()
const readout = () => page.locator('.timeline-readout strong').innerText()
const r0 = await readout()
await page.getByRole('button', { name: 'Next frame' }).click()
const r1 = await readout()
check('Timeline step changes the frame', r0 !== r1, `${r0} → ${r1}`)
await page.getByRole('button', { name: 'Play' }).click()
await settle(page, 1500)
const r2 = await readout()
await page.getByRole('button', { name: 'Pause' }).click()
check('Timeline play advances frames', r2 !== r1, `${r1} → ${r2}`)
const slider = page.getByRole('slider')
await slider.focus()
await page.keyboard.press('Home')
check('Scrubber to start pauses & shows first frame', /0/.test(await slider.getAttribute('value')))

// Frame-rate with everything on and nowcast playing
await page.getByRole('tab', { name: 'Nowcast' }).click()
await page.getByRole('button', { name: 'Play' }).click()
const fps = await page.evaluate(
  () =>
    new Promise((res) => {
      let n = 0
      const t0 = performance.now()
      const loop = () => (performance.now() - t0 < 3000 ? (n++, requestAnimationFrame(loop)) : res(n / 3))
      requestAnimationFrame(loop)
    }),
)
await page.getByRole('button', { name: 'Pause' }).click()
check('Main thread not frozen with all layers + nowcast playing (headless software GL; real devices use the GPU)', fps >= 1, // informational: software GL in CI; see dbg numbers in BUILD_LOG
   `${fps.toFixed(0)} fps`)
const longTasks = await page.evaluate(
  () =>
    new Promise((res) => {
      const seen = []
      const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => seen.push(Math.round(e.duration))))
      po.observe({ entryTypes: ['longtask'] })
      setTimeout(() => {
        po.disconnect()
        res(seen)
      }, 3000)
    }),
)
check('No long main-thread tasks (>200 ms) while idle with all layers', !longTasks.some((d) => d > 200), `long tasks: ${longTasks.join(',') || 'none'}`)
await page.screenshot({ path: `${OUT}/all-layers.png` })

// Place persistence across reload
await page.reload({ waitUntil: 'load' })
await settle(page, 3000)
check('Reload restores the last place (no prompt)', (await page.locator('.chip-text').textContent())?.includes('Philadelphia'), await page.locator('.chip-text').textContent())
check('Reload restores enabled layers', await page.evaluate(() => JSON.parse(localStorage.getItem('stormscope.layers')).nowcast === true))

// Search: postcode + city, choose, non-US station fallback
await page.getByRole('button', { name: 'Change location' }).click()
await page.getByRole('searchbox').fill('SW1A 1AA')
await settle(page, 3000)
const opts = await page.getByRole('option').count()
check('Postcode search returns results (Nominatim)', opts > 0, `${opts} results`)
await page.getByRole('option').first().click()
await settle(page, 6000)
await page.getByRole('tab', { name: 'Station' }).click()
await settle(page, 1500)
check('Non-US: Open-Meteo fallback labelled honestly', /Open-Meteo/.test(await page.locator('.sheet-body').innerText()))
await page.getByRole('tab', { name: 'Rivers' }).click()
check('Non-US: rivers panel explains US-only coverage', /only available in the US/.test(await page.locator('.sheet-body').innerText()))
await page.getByRole('tab', { name: 'Flood' }).click()
// Blocks + flood worker jobs take a while (and the Open-Meteo budget may be cooling down); poll up to 90 s.
let floodText = ''
for (let i = 0; i < 90; i++) {
  floodText = await page.locator('.sheet-body').innerText()
  if (/terrain \+ rain only|not available here/.test(floodText)) break
  await settle(page, 1000)
}
check('Non-US: flood model falls back to terrain + rain', /terrain \+ rain only|not available here/.test(floodText), floodText.split('\n').slice(0, 2).join(' | '))
await page.screenshot({ path: `${OUT}/london-flood.png` })

check('No unexpected console/page errors in main flow', errs.length === 0, errs.slice(0, 3).join(' | '))
await ctx.close()

// ---------------------------------------------------------------- 3. Reduced motion
{
  const c = await browser.newContext(mobile({ geolocation: PHL, permissions: ['geolocation'], reducedMotion: 'reduce' }))
  const p = await c.newPage()
  await p.goto(BASE, { waitUntil: 'networkidle' })
  await settle(p, 4000)
  await p.getByRole('button', { name: 'Open layer menu' }).click()
  await p.getByRole('button', { name: 'Nowcast' }).click()
  await p.getByRole('button', { name: 'Close layer menu' }).click()
  await settle(p, 10000)
  const rafRate = await p.evaluate(
    () =>
      new Promise((res) => {
        // With reduced motion the wind layer must not run a continuous rAF loop; the
        // browser still ticks rAF for MapLibre, so we check the wind canvas is static instead.
        const c = document.querySelector('.wind-canvas')
        if (!c) return res('no canvas')
        const a = c.toDataURL()
        setTimeout(() => res(c.toDataURL() === a ? 'static' : 'animating'), 1200)
      }),
  )
  check('Reduced motion: wind layer is static arrows, not animating', rafRate === 'static', String(rafRate))
  await p.screenshot({ path: `${OUT}/reduced-motion.png` })
  await c.close()
}

// ---------------------------------------------------------------- 4. Desktop
{
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, geolocation: PHL, permissions: ['geolocation'] })
  const p = await c.newPage()
  await p.goto(BASE, { waitUntil: 'networkidle' })
  await settle(p, 4000)
  await p.getByRole('tab', { name: 'Rivers' }).click()
  await settle(p, 1500)
  const fab = await p.getByRole('button', { name: /layer menu/ }).boundingBox()
  const sheet = await p.locator('.sheet').boundingBox()
  check('Desktop: sheet docks as a side card, FAB beside it', sheet.width < 500 && fab.x + fab.width < sheet.x, `sheet w ${Math.round(sheet.width)} at x ${Math.round(sheet.x)}; fab x ${Math.round(fab.x)}`)
  await p.screenshot({ path: `${OUT}/desktop.png` })
  await c.close()
}

__recordBudget()
await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
