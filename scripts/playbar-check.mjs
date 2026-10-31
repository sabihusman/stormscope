// The playback control on phone / tablet / desktop. Phones: a pill bottom-left (▶/❚❚ + time, a progress
// line with a "now" mark) with 44 px tap targets, clear of ☰; tapping its label expands the full bar
// (▶, time, scrubber, 6/12/24/48 h, colour scale, ✕) docked along the bottom edge, full map width; ✕
// collapses it; nothing at all when no layer animates. Tablet / desktop: the full bar, no ✕. The legend
// lives inside the ☰ layers panel (active layers only); there is no floating legend. The open layer
// menu, ☰ and the zoom buttons never overlap the control; the menu is anchored to ☰; nothing is clipped
// by the viewport; status chips are not cut off; ▶ advances the time label; below forecast zoom the
// plain note and its zoom-to-place button (pressed on the phone only — it loads ~340 Open-Meteo
// locations live). One screenshot per layout state. --mock answers every API locally.
//   node scripts/playbar-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap, openNow, setLayers } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
assertBudget(`playbar-check.mjs${MOCK ? ' (mock)' : ''}`)
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
  const count = (sel) => page.locator(sel).count()

  if (wide) {
    await openNow(page)
    check(`[${name}] full bar is present while Now is open (map always visible), never a pill`, (await count('.playbar')) === 1 && (await count('.playpill')) === 0, fmt(await box('.playbar')))
  }
  await openMap(page)
  await page.waitForTimeout(600)
  const navTop = await page.evaluate(() => { const nav = document.querySelector('.nav')?.getBoundingClientRect(); return nav && nav.top > 0 && nav.width > nav.height ? nav.top : window.innerHeight })

  if (!wide) {
    // Phone: the pill by default.
    const pill = await box('.playpill')
    const fab = await box('.fab-main')
    const play = await box('.playpill .play')
    const lbl = await box('.playpill .pill-label')
    check(`[${name}] phone default is a pill bottom-left above the nav, with ▶ and the time`, !!pill && inside(pill, vp.width, vp.height) && pill.x <= 16 && Math.abs(pill.y + pill.height - navTop) <= 14 && (await count('.playbar')) === 0, `pill ${fmt(pill)} nav top ${Math.round(navTop)}`)
    check(`[${name}] pill tap targets ≥ 44 px (▶ and the label)`, !!play && play.width >= 44 && play.height >= 44 && !!lbl && lbl.height >= 44 && lbl.width >= 44, `play ${fmt(play)} label ${fmt(lbl)}`)
    check(`[${name}] pill clear of ☰`, !overlap(pill, fab), `fab ${fmt(fab)}`)
    check(`[${name}] pill shows a progress line with a "now" mark`, (await count('.playpill .pill-progress .pill-now')) === 1 && (await count('.playpill .pill-progress .pill-pos')) === 1)
    await page.screenshot({ path: `${OUT}/${name}-map-pill.png` })
    // Nothing animates → nothing shown.
    await setLayers(page, { radar: false, satellite: false, rainfall: false, nowcast: false })
    await page.waitForTimeout(400)
    check(`[${name}] hidden entirely when nothing animates (background None, no overlay)`, (await count('.playpill')) === 0 && (await count('.playbar')) === 0)
    await setLayers(page, { radar: true })
    await page.waitForTimeout(400)
    // Tap the label → the full bar.
    await page.locator('.playpill .pill-label').click()
    await page.waitForTimeout(400)
    check(`[${name}] tapping the label expands into the full bar with ✕`, (await count('.playbar')) === 1 && (await count('.playpill')) === 0 && (await count('.playbar .playbar-close')) === 1)
  } else {
    check(`[${name}] full bar, no pill, no ✕`, (await count('.playbar')) === 1 && (await count('.playpill')) === 0 && (await count('.playbar .playbar-close')) === 0)
  }

  const bar = await box('.playbar')
  // Wide layouts: the bar spans the map area (on desktop the Now column stays beside the map, so that is less than the viewport minus the rail).
  const mapArea = await box('.map-root')
  check(`[${name}] bar docked along the bottom edge, full map width, fully in view`, inside(bar, vp.width, vp.height) && bar.width >= (wide ? mapArea.width - 1 : vp.width - 1) && Math.abs(bar.x - (wide ? mapArea.x : 0)) <= 1 && Math.abs(bar.y + bar.height - navTop) <= 1, `${fmt(bar)} map ${fmt(mapArea)}`)
  check(`[${name}] bar row: play, time, scrubber, horizon; plus a colour scale for the scrubbed layer`, (await count('.playbar .play')) === 1 && (await count('.playbar-time')) === 1 && (await count('.playbar .scrubber')) === 1 && (await count('.playbar .horizon button')) === 4 && (await count('.playbar .playbar-scale')) === 1)

  // Floating controls: ☰, its menu (open, with the legend inside), the zoom buttons — none overlaps the bar, all in view.
  // (Desktop docks the panel open by default since the redesign; phones and tablets open it from ☰.)
  if (!(await count('.fab-menu'))) await page.locator('.fab-main').click()
  await page.waitForTimeout(400)
  const fab = await box('.fab-main')
  const menu = await box('.fab-menu')
  const zoom = await box('.maplibregl-ctrl-top-right')
  const legendText = await page.locator('.fab-menu .legend-rows').innerText().catch(() => '')
  check(`[${name}] ☰ fully on screen and clear of the bar`, inside(fab, vp.width, vp.height) && !overlap(fab, bar), `fab ${fmt(fab)} bar ${fmt(bar)}`)
  // Phones: the menu rises from ☰ on the same edge. Wide layouts (Oct 9): ☰ sits under the zoom column and the menu opens beside that column.
  check(`[${name}] layer menu ${wide ? 'beside the zoom column' : 'anchored to ☰ (same edge)'}, fully on screen, clear of the bar`, !!menu && inside(menu, vp.width, vp.height) && !overlap(menu, bar) && (wide ? menu.x + menu.width <= zoom.x + 1 && !overlap(menu, zoom) : Math.abs(menu.x + menu.width - (fab.x + fab.width)) <= 24), `menu ${fmt(menu)}`)
  check(`[${name}] legend inside the layer menu, active layers only (radar + rivers, no rain)`, /Radar \(RainViewer\)/.test(legendText) && /River gauges/.test(legendText) && !/Rain next/.test(legendText) && (await count('.legend-chip, .legend')) === 0, legendText.split('\n').slice(0, 2).join(' | '))
  check(`[${name}] zoom buttons in view, clear of the bar`, inside(zoom, vp.width, vp.height) && !overlap(zoom, bar), fmt(zoom))
  // Controls inside a scrolling content column (the Now column on desktop) are reachable by scrolling, not clipped.
  const clipped = await page.evaluate(() => [...document.querySelectorAll('.app button, .app .pill, .app .maplibregl-ctrl')].filter((el) => !el.closest('.screen')).filter((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && cs.visibility !== 'hidden' && (r.right > window.innerWidth + 1 || r.left < -1 || r.bottom > window.innerHeight + 1 || r.top < -1) }).map((el) => `${el.className || el.tagName}@${Math.round(el.getBoundingClientRect().left)},${Math.round(el.getBoundingClientRect().top)}`))
  check(`[${name}] no control is clipped by the viewport edge`, clipped.length === 0, clipped.join(' | ') || 'none')
  const chips = await page.evaluate(() => [...document.querySelectorAll('.playbar-status .pill')].map((el) => ({ w: el.scrollWidth, cw: el.clientWidth, r: el.getBoundingClientRect().right })))
  check(`[${name}] status chips are not cut off`, chips.every((c) => c.w <= c.cw + 1 && c.r <= vp.width + 1), `${chips.length} chips`)
  await page.screenshot({ path: `${OUT}/${name}-map-menu-legend.png` })
  await page.locator('.fab-main').click()

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
  check(`[${name}] below forecast zoom over the place: "Zoom in to see the forecast", no jargon, no zoom-to-place button (the place is in view)`, /Zoom in to see the forecast/.test(note) && !/5\.5|blocks/.test(note) && (await page.getByRole('button', { name: /^Zoom to / }).count()) === 0, note.replace(/\n/g, ' | '))
  check(`[${name}] colour scale follows the scrubbed layer (rain scale with the rain overlay on)`, /Rain/.test(await page.locator('.playbar-scale').innerText().catch(() => '')))
  // Moved away from the place (still below forecast zoom): the note keeps its words and the zoom-to-place button appears.
  await page.evaluate(() => window.__map.jumpTo({ center: [-20, 35], zoom: 4 }))
  await page.waitForTimeout(900)
  const away = await page.locator('.playbar-note').innerText().catch(() => '')
  check(`[${name}] moved away from the place: the note plus the zoom-to-place button`, /Zoom in to see the forecast/.test(away) && (await page.getByRole('button', { name: /^Zoom to / }).count()) === 1, away.replace(/\n/g, ' | '))
  if (name === 'phone') {
    await page.getByRole('button', { name: /^Zoom to / }).click()
    await page.waitForTimeout(1200)
    const z = await page.evaluate(() => window.__map.getZoom())
    check(`[${name}] the button zooms the map to the place`, z >= 8, `zoom ${z.toFixed(1)}`)
  }
  await page.screenshot({ path: `${OUT}/${name}-map-rain.png` })
  await setLayers(page, { rainfall: false })

  if (!wide) {
    await page.locator('.playbar .playbar-close').click()
    await page.waitForTimeout(400)
    check(`[${name}] ✕ collapses back to the pill`, (await count('.playpill')) === 1 && (await count('.playbar')) === 0)
  }
  done()
  await ctx.close()
}
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
