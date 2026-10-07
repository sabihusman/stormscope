// Scripted QA pass. Each check logs PASS/FAIL with evidence; screenshots go to OUT.
import { chromium } from 'playwright'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
import { openMap, openMore, pageText, setSheet, setUnits, sheetText, searchPlace } from './lib/ui.mjs'
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
  const dlg = page.getByRole('dialog')
  check('First-run prompt shown before browser dialog', await dlg.getByRole('heading', { name: 'Where are you?' }).isVisible())
  await dlg.getByRole('button', { name: 'Use my location' }).click()
  await settle(page, 2500)
  const denied = await page.getByRole('heading', { name: "Couldn't get your location" }).isVisible()
  check('Denied permission → friendly recovery card', denied)
  await page.screenshot({ path: `${OUT}/denied.png` })
  await dlg.getByRole('button', { name: 'Search for a place' }).click()
  await settle(page, 400)
  check('Recovery card → the place picker opens with the search focused', await page.getByRole('dialog').getByRole('searchbox').evaluate((el) => el === document.activeElement))
  await page.getByRole('button', { name: 'Close' }).click()
  await settle(page, 300)
  const promptGone = !(await page.getByRole('heading', { name: "Couldn't get your location" }).isVisible().catch(() => false))
  check('Closing the picker does not re-show the prompt (Now shows its own picker card)', promptGone && (await page.getByRole('button', { name: /Pick a point on the map/ }).count()) >= 1)
  const mapInteractive = await page.evaluate(() => {
    const m = window.__map
    const before = m.getZoom()
    m.zoomIn({ duration: 0 })
    return m.getZoom() > before
  })
  check('Map is mounted and interactive with no location', mapInteractive)
  __recordDenied()
  await ctx.close()
}

// ---------------------------------------------------------------- 2. Main flow (granted)
const ctx = await browser.newContext(mobile({ geolocation: PHL, permissions: ['geolocation'] }))
const page = await ctx.newPage()
const __recordBudget = trackOpenMeteo(page, 'qa.mjs')
const errs = errorsOf(page)
const t0 = Date.now()
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
let firstConditions = null
for (let i = 0; i < 60; i++) {
  if (await page.evaluate(() => window.__store?.get().conditions.state === 'ready')) { firstConditions = Date.now() - t0; break }
  await settle(page, 250)
}
await settle(page, 2500)
await page.waitForFunction(() => window.__map?.loaded(), null, { timeout: 20000 }).catch(() => {})
check('Geolocation → place label resolved on Now', (await page.locator('.chip-text').first().textContent())?.includes('Philadelphia'), await page.locator('.chip-text').first().textContent())
check('Now shows current conditions within 15 s of the grant', firstConditions != null && firstConditions < 15000 && (await page.locator('.cond-temp').count()) === 1, `${firstConditions} ms`)
const nowText = await page.locator('.screen.now').innerText()
check('Now: alerts line, conditions, next 12 h and a map window', /NWS/.test(nowText) && /Feels like/.test(nowText) && /NEXT 12 HOURS/i.test(nowText) && (await page.locator('.now-map-window').count()) === 1)
await page.screenshot({ path: `${OUT}/now.png` })

// Units: default for en-US is imperial in the real browser; here locale is en-US too.
await openMore(page, 'Station observations')
await settle(page, 2000)
const stationText = await pageText(page)
check('Station page shows pressure/humidity/wind/precip', /PRESSURE[\s\S]*HUMIDITY[\s\S]*WIND[\s\S]*PRECIPITATION/i.test(stationText))
await setUnits(page, 'Metric')
await openMore(page, 'Station observations')
await settle(page)
const metric = await pageText(page)
check(
  'Metric units: °C, km/h, hPa, mm',
  /°C/.test(metric) && (/km\/h/.test(metric) || /Calm/.test(metric)) && /hPa/.test(metric) && (/\bmm\b/.test(metric) || /Not reported/.test(metric)),
  metric.match(/[\d.]+ °C|\d+ km\/h|Calm|hPa|[\d.]+ mm|Not reported/g)?.slice(0, 5).join(' · '),
)
await setUnits(page, 'Imperial')
await openMore(page, 'Station observations')
await settle(page)
const imperial = await pageText(page)
check(
  'Imperial units: °F, mph, inHg, in',
  /°F/.test(imperial) && (/mph/.test(imperial) || /Calm/.test(imperial)) && /inHg/.test(imperial) && (/[\d.]+ in\b/.test(imperial) || /Not reported/.test(imperial)),
  imperial.match(/[\d.]+ °F|\d+ mph|Calm|[\d.]+ inHg|[\d.]+ in\b|Not reported/g)?.slice(0, 5).join(' · '),
)
await page.screenshot({ path: `${OUT}/station-imperial.png` })

// Rivers in imperial: ft & ft³/s
await openMore(page, 'Rivers & gauges')
await settle(page, 4000)
const rivers = await pageText(page)
check('Rivers list populated with stage in ft (imperial)', /Stage [\d.]+ ft/.test(rivers), rivers.split('\n').slice(0, 6).join(' | '))
await setUnits(page, 'Metric')
await openMore(page, 'Rivers & gauges')
await settle(page)
check('Rivers stage converts to m (metric)', /Stage [\d.]+ m\b/.test(await pageText(page)))

// Map screen: sheet modes & FAB reachability
await openMap(page)
await setSheet(page, 'half')
const fabBox = async () => page.getByRole('button', { name: /layer menu/ }).boundingBox()
const sheetTop = async () => (await page.locator('.sheet').boundingBox()).y
check('Half sheet: FAB sits above the sheet', (await fabBox()).y + (await fabBox()).height < (await sheetTop()), `fab bottom ${Math.round((await fabBox()).y + (await fabBox()).height)} < sheet top ${Math.round(await sheetTop())}`)
await page.getByRole('button', { name: 'Resize panel' }).focus()
await page.keyboard.press('ArrowUp')
await settle(page)
check('Full sheet: map strip still visible at top', (await sheetTop()) > 40, `sheet top ${Math.round(await sheetTop())}`)
check('Full sheet: FAB hidden (not blocking)', !(await page.getByRole('button', { name: /layer menu/ }).isVisible()))
await page.getByRole('button', { name: 'Collapse panel' }).click()
await settle(page)
check('Collapse → peek mode', (await page.locator('.sheet').getAttribute('class'))?.includes('peek'))
check('Peek: FAB visible again', await page.getByRole('button', { name: /layer menu/ }).isVisible())

// Legend chip → open → hide
await page.getByRole('button', { name: 'Show legend' }).click()
check('Legend chip opens the legend', await page.locator('.legend').isVisible())
await page.getByRole('button', { name: 'Hide legend' }).click()
check('Legend hides back to a small chip', await page.getByRole('button', { name: 'Show legend' }).isVisible())

// Map tap → chip (never a dialog), at 4 corners + centre, chip on-screen
const W = 390
const H = 844
const corners = [
  [6, 100],
  [W - 6, 100],
  [6, H - 170],
  [W - 6, H - 170],
  [W / 2, H / 2],
]
let allInside = true
let anyDialog = false
for (const [x, y] of corners) {
  await page.mouse.click(x, y)
  await settle(page, 500)
  const box = await page.locator('.point-chip').boundingBox().catch(() => null)
  if (!box) {
    allInside = false
    continue
  }
  if ((await page.locator('[role=dialog]').count()) > 0) anyDialog = true
  const inside = box.x >= 0 && box.y >= 0 && box.x + box.width <= W && box.y + box.height <= H
  if (!inside) allInside = false
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await settle(page, 200)
}
check('Map tap shows a point chip (no dialog) that stays on-screen at every corner', allInside && !anyDialog)
await page.mouse.click(W / 2, H / 2)
await settle(page, 2500)
const chipText = await page.locator('.point-chip').innerText().catch(() => '')
check('Point chip states conditions at the point (temperature or loading state) and its relation to the place', /°|Loading conditions|unavailable/.test(chipText) && /of Philadelphia|mi |km /.test(chipText), chipText.replace(/\n/g, ' | '))
await page.getByRole('button', { name: 'Details' }).click()
await settle(page, 600)
const details = await sheetText(page)
check('Details sheet: point conditions, 24 h strip, actions', /This point/.test(details) && /Next 24 h|Rain, next 24 h/.test(details) && /Use as my place/.test(details) && /Trip here/.test(details), details.split('\n').slice(0, 2).join(' | '))
await page.screenshot({ path: `${OUT}/point-details.png` })
await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' }))

// Gauge chip + details content
const g = await page.evaluate(() => {
  const m = window.__map
  for (const f of m.queryRenderedFeatures({ layers: ['river-gauges'] })) {
    const p = m.project(f.geometry.coordinates)
    if (p.x > 40 && p.x < 340 && p.y > 200 && p.y < 600) return { x: p.x, y: p.y }
  }
  return null
})
if (g) {
  await page.mouse.click(g.x, g.y)
  await settle(page, 500)
  const t = await page.locator('.point-chip').innerText().catch(() => '')
  await page.getByRole('button', { name: 'Details' }).click()
  await settle(page, 500)
  const d = await sheetText(page)
  check('Gauge chip: category + risk; details: stage, source, freshness', /risk:/.test(t) && /Stage|Flow/.test(d) && /Source:/.test(d) && /updated/.test(d), t.split('\n')[0])
  await page.screenshot({ path: `${OUT}/gauge-details.png` })
  await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' }))
} else check('Gauge chip: a gauge was tappable', false, 'no gauge in the tappable area')

// Forecast overlays are one at a time; timeline behaviour
await page.getByRole('button', { name: 'Open layer menu' }).click()
await page.getByRole('radio', { name: 'Rain next 24 h' }).click()
await settle(page, 400)
await page.getByRole('radio', { name: 'Flood risk' }).click()
await settle(page, 400)
const layersNow = await page.evaluate(() => window.__store.get().layers)
check('Forecast overlays are mutually exclusive (flood on turns rain off)', layersNow.flood === true && layersNow.rainfall === false, JSON.stringify({ rainfall: layersNow.rainfall, flood: layersNow.flood }))
await page.getByRole('radio', { name: 'Next 2 h wind & cloud' }).click()
await page.getByRole('button', { name: 'Close layer menu' }).click()
await settle(page, 12000)
await setSheet(page, 'half')
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

// Frame-rate with nowcast playing
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
check('Main thread not frozen with radar + nowcast playing (headless software GL; real devices use the GPU)', fps >= 1, `${fps.toFixed(0)} fps`)
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
check('No long main-thread tasks (>200 ms) while idle with the nowcast overlay', !longTasks.some((d) => d > 200), `long tasks: ${longTasks.join(',') || 'none'}`)
await page.screenshot({ path: `${OUT}/map-nowcast.png` })

// Place persistence across reload
await page.reload({ waitUntil: 'load' })
await settle(page, 3000)
check('Reload restores the last place on Now (no prompt)', (await page.locator('.chip-text').first().textContent())?.includes('Philadelphia'), await page.locator('.chip-text').first().textContent())
check('Reload restores enabled layers', await page.evaluate(() => JSON.parse(localStorage.getItem('stormscope.layers')).nowcast === true))

// Search: postcode + city, choose, non-US states
await searchPlace(page, 'SW1A 1AA')
await settle(page, 3000)
const opts = await page.getByRole('dialog').getByRole('option').count()
check('Postcode search returns results (Nominatim)', opts > 0, `${opts} results`)
await page.getByRole('dialog').getByRole('option').first().click()
await settle(page, 6000)
const nowLondon = await page.locator('.screen.now').innerText()
check('Non-US: Now says alerts are unavailable outside the US', /Alerts unavailable outside the US/.test(nowLondon))
await openMore(page, 'Station observations')
await settle(page, 1500)
check('Non-US: Open-Meteo fallback labelled honestly', /Open-Meteo/.test(await pageText(page)))
await openMore(page, 'Rivers & gauges')
check('Non-US: rivers page explains US-only coverage', /only available in the US/.test(await pageText(page)))
await openMore(page, 'Flood risk')
// Blocks + flood worker jobs take a while (and the Open-Meteo budget may be cooling down); poll up to 90 s.
let floodText = ''
for (let i = 0; i < 90; i++) {
  floodText = await pageText(page)
  if (/terrain \+ rain only|not available here/.test(floodText)) break
  await settle(page, 1000)
}
check('Non-US: flood page computes for the place and falls back to terrain + rain', /terrain \+ rain only|not available here/.test(floodText) && /at London|at Westminster|at /.test(floodText), floodText.split('\n').slice(0, 2).join(' | '))
await page.screenshot({ path: `${OUT}/london-flood.png` })

check('No unexpected console/page errors in main flow', errs.length === 0, errs.slice(0, 3).join(' | '))
await ctx.close()

// ---------------------------------------------------------------- 3. Reduced motion
{
  const c = await browser.newContext(mobile({ geolocation: PHL, permissions: ['geolocation'], reducedMotion: 'reduce' }))
  const p = await c.newPage()
  await p.goto(BASE, { waitUntil: 'networkidle' })
  await settle(p, 4000)
  await openMap(p)
  await p.getByRole('button', { name: 'Open layer menu' }).click()
  await p.getByRole('radio', { name: 'Next 2 h wind & cloud' }).click()
  await p.getByRole('button', { name: 'Close layer menu' }).click()
  await settle(p, 10000)
  const rafRate = await p.evaluate(
    () =>
      new Promise((res) => {
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
  const layout = await p.evaluate(() => { const nav = document.querySelector('.nav').getBoundingClientRect(); const col = document.querySelector('.screen').getBoundingClientRect(); const map = document.querySelector('.map-root').getBoundingClientRect(); return { rail: nav.width < 100 && nav.height > 400, col: col.width < 500, mapRight: map.left >= col.right - 2 && map.width > 600 } })
  check('Desktop: left rail + content column + always-visible map', layout.rail && layout.col && layout.mapRight, JSON.stringify(layout))
  await p.getByRole('button', { name: 'Trip', exact: true }).click()
  await settle(p, 800)
  check('Desktop: Trip renders in the column, map stays', (await p.locator('.screen.trip').count()) === 1 && (await p.locator('.map-container').isVisible()))
  await p.screenshot({ path: `${OUT}/desktop.png` })
  await c.close()
}

__recordBudget()
await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
