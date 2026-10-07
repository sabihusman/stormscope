// The docked playback bar, on phone / tablet / desktop: fully in view, never overlapping the layer
// menu (open), the legend (open), the ☰ button or the zoom buttons; the layer menu anchored to its
// button; nothing clipped at the viewport edge; ▶ advances the time label; the below-forecast-zoom
// note with its zoom-to-place button. One screenshot per layout. --mock answers every API locally.
//   node scripts/playbar-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap, openNow, setLayers } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
assertBudget(`playbar-check.mjs${MOCK ? ' (mock)' : ''}`, { openMeteo: !MOCK })
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/playbar'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const VIEWPORTS = {
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true },
  tablet: { width: 800, height: 1280, isMobile: true, hasTouch: true },
  desktop: { width: 1366, height: 800, isMobile: false, hasTouch: false },
}
const inside = (b, vw, vh) => !!b && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= vw + 0.5 && b.y + b.height <= vh + 0.5
const overlap = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const fmt = (b) => (b ? `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}×${Math.round(b.height)}` : 'none')

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
for (const [name, vp] of Object.entries(VIEWPORTS)) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
  await ctx.addInitScript(() => { try { localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: true, station: true, nowcast: false })) } catch {} })
  const page = await ctx.newPage()
  const done = trackTraffic(page, `playbar-check.mjs ${name}${MOCK ? ' (mock)' : ''}`)
  if (MOCK) await installMocks(ctx, {})
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(250) } return false }
  await until(() => !!window.__map?.loaded() && !!window.__store?.get().radar.data)
  const wide = vp.width >= 768
  const box = (sel) => page.locator(sel).first().boundingBox().catch(() => null)

  // The bar is on screen on the Map (every layout) and, on wide layouts, on Now too.
  if (wide) {
    await openNow(page)
    check(`[${name}] bar is present while Now is open (map always visible)`, !!(await box('.playbar')), fmt(await box('.playbar')))
  }
  await openMap(page)
  await page.waitForTimeout(600)
  const bar = await box('.playbar')
  check(`[${name}] bar docked along the bottom edge, full map width, fully in view`, inside(bar, vp.width, vp.height) && bar.width >= (wide ? vp.width - 64 - 1 : vp.width - 1) && (await page.evaluate(() => { const b = document.querySelector('.playbar').getBoundingClientRect(); const nav = document.querySelector('.nav')?.getBoundingClientRect(); const bottom = nav && nav.top > b.top ? nav.top : window.innerHeight; return Math.abs(b.bottom - bottom) <= 1 })), fmt(bar))
  check(`[${name}] bar is one row: play, time, scrubber, horizon`, (await page.locator('.playbar .play').count()) === 1 && (await page.locator('.playbar-time').count()) === 1 && (await page.locator('.playbar .scrubber').count()) === 1 && (await page.locator('.playbar .horizon button').count()) === 4)

  // Floating controls: ☰, its menu (open), the legend (open), the zoom buttons — none overlaps the bar, all in view.
  await page.locator('.fab-main').click()
  await page.waitForTimeout(400)
  await page.locator('.legend-chip').click().catch(() => {})
  await page.waitForTimeout(300)
  const fab = await box('.fab-main')
  const menu = await box('.fab-menu')
  const legend = await box('.legend')
  const zoom = await box('.maplibregl-ctrl-top-right')
  check(`[${name}] ☰ fully on screen and clear of the bar`, inside(fab, vp.width, vp.height) && !overlap(fab, bar), `fab ${fmt(fab)} bar ${fmt(bar)}`)
  check(`[${name}] layer menu anchored to ☰ (same edge), fully on screen, clear of the bar`, !!menu && inside(menu, vp.width, vp.height) && !overlap(menu, bar) && Math.abs(menu.x + menu.width - (fab.x + fab.width)) <= 24, `menu ${fmt(menu)}`)
  check(`[${name}] legend open, in view, clear of the bar`, !!legend && inside(legend, vp.width, vp.height) && !overlap(legend, bar), fmt(legend))
  check(`[${name}] zoom buttons in view, clear of the bar`, inside(zoom, vp.width, vp.height) && !overlap(zoom, bar), fmt(zoom))
  const clipped = await page.evaluate(() => [...document.querySelectorAll('.app button, .app .pill, .app .legend-chip, .app .maplibregl-ctrl')].filter((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && cs.visibility !== 'hidden' && (r.right > window.innerWidth + 1 || r.left < -1 || r.bottom > window.innerHeight + 1 || r.top < -1) }).map((el) => `${el.className || el.tagName}@${Math.round(el.getBoundingClientRect().left)},${Math.round(el.getBoundingClientRect().top)}`))
  check(`[${name}] no control is clipped by the viewport edge`, clipped.length === 0, clipped.join(' | ') || 'none')
  const chips = await page.evaluate(() => [...document.querySelectorAll('.playbar-status .pill')].map((el) => ({ w: el.scrollWidth, cw: el.clientWidth, r: el.getBoundingClientRect().right })))
  check(`[${name}] status chips are not cut off`, chips.every((c) => c.w <= c.cw + 1 && c.r <= vp.width + 1), `${chips.length} chips`)
  await page.screenshot({ path: `${OUT}/${name}-map-menu-legend.png` })
  await page.locator('.fab-main').click()
  await page.locator('.legend .icon-btn').click().catch(() => {})

  // A tapped point's chip sits above the bar and never covers ☰.
  await page.evaluate(() => { window.__store.set({ selection: null, sheet: 'peek' }); window.__map.jumpTo({ center: [-93.6, 41.6], zoom: 10 }) })
  await page.waitForTimeout(800)
  const mapBox = await box('.map-root')
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2)
  await until(() => !!document.querySelector('.point-chip'), 10000)
  const chip = await box('.point-chip')
  const fab2 = await box('.fab-main')
  check(`[${name}] point chip in view, clear of the bar and of ☰`, !!chip && inside(chip, vp.width, vp.height) && !overlap(chip, bar) && !overlap(chip, fab2), `chip ${fmt(chip)} fab ${fmt(fab2)}`)
  await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' }))

  // ▶ advances the time label (radar frames step every ~450 ms).
  const t0 = await page.locator('.playbar-time').innerText()
  await page.locator('.playbar .play').click()
  await page.waitForTimeout(1600)
  const t1 = await page.locator('.playbar-time').innerText()
  const playing = await page.evaluate(() => window.__store.get().playing)
  check(`[${name}] ▶ starts playback and the time label advances`, playing && t1 !== t0, `${t0} → ${t1}`)
  await page.locator('.playbar .play').click()
  check(`[${name}] ❚❚ pauses`, !(await page.evaluate(() => window.__store.get().playing)))

  // Below forecast zoom with the rain overlay on: plain words and a button that zooms to the place.
  await setLayers(page, { rainfall: true })
  await page.evaluate(() => window.__map.jumpTo({ center: [-93.6, 41.6], zoom: 4 }))
  await page.waitForTimeout(900)
  const note = await page.locator('.playbar-note').innerText().catch(() => '')
  check(`[${name}] below forecast zoom: "Zoom in to see the forecast" + zoom-to-place button, no jargon`, /Zoom in to see the forecast/.test(note) && !/5\.5|blocks/.test(note) && (await page.getByRole('button', { name: /^Zoom to / }).count()) === 1, note.replace(/\n/g, ' | '))
  await page.getByRole('button', { name: /^Zoom to / }).click()
  await page.waitForTimeout(1200)
  const z = await page.evaluate(() => window.__map.getZoom())
  check(`[${name}] the button zooms the map to the place`, z >= 8, `zoom ${z.toFixed(1)}`)
  await page.screenshot({ path: `${OUT}/${name}-map-rain.png` })
  done()
  await ctx.close()
}
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
