// The desktop layout at 1280 and 1600 px (mocked only), and the tablet and phone edges of the 768 px breakpoint:
// the rail, the Now column and a wide map on screen together; the layers panel docked open by default on desktop
// (Background, forecast overlay, air quality, points) and collapsible from ☰; the detail pages (Station, Rivers,
// Flood, Trip) beside the map; the playback bar full-width under the map with clock times and the labelled Now
// boundary; the units chip and the forget control present; no horizontal overflow. At 800 px the panel starts
// closed; at 390 px the phone layout is unchanged (bottom tabs, the pill, no docked panel).
//   node scripts/desktop-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMore } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  desktop-check.mjs: mocked only')
  process.exit(3)
}
assertBudget('desktop-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/desktop'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const box = async (page, sel) => { const b = await page.locator(sel).first().boundingBox().catch(() => null); return b }
const visible = (b, w, h) => !!b && b.width > 0 && b.height > 0 && b.x < w && b.y < h && b.x + b.width > 0
const overflow = (page) => page.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth, controls: [...document.querySelectorAll('.app button, .app .pill, .app .maplibregl-ctrl')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && getComputedStyle(el).visibility !== 'hidden' && r.right > window.innerWidth + 1 }).map((el) => el.className || el.tagName).slice(0, 4) }))
const until = async (page, fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(200) } return false }

for (const width of [1280, 1600]) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
  const page = await ctx.newPage()
  const done = trackTraffic(page, `desktop-check.mjs ${width} (mock)`)
  await installMocks(ctx, {})
  const t0 = Date.now()
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  await until(page, () => window.__store?.get().conditions.state === 'ready' && !!window.__map?.loaded())
  const dataIn = Date.now() - t0
  await page.waitForTimeout(800)
  check(`[${width}] data in by ${(dataIn / 1000).toFixed(1)} s (ceiling 8 s)`, dataIn <= 8000)
  const rail = await box(page, '.nav')
  const column = await box(page, '.screen.now')
  const map = await box(page, '.map-root')
  check(`[${width}] the rail, the Now column and the map are on screen together, the map taking most of the width`, visible(rail, width, 800) && visible(column, width, 800) && visible(map, width, 800) && map.width > width * 0.5 && column.x + column.width <= map.x + 1 && rail.width < rail.height, `rail ${Math.round(rail?.width)}×${Math.round(rail?.height)}, column ${Math.round(column?.width)}, map ${Math.round(map?.width)} of ${width}`)
  const menu = page.locator('.fab-menu')
  const menuText = (await menu.innerText().catch(() => '')).replace(/\n/g, ' | ')
  check(`[${width}] the layers panel is docked open by default with its four groups (Background · Forecast overlay · Air quality · Points)`, (await menu.count()) === 1 && (await menu.isVisible()) && /Background/i.test(menuText) && /Forecast overlay/i.test(menuText) && /Air quality/i.test(menuText) && /Points/i.test(menuText), menuText.slice(0, 120))
  const menuBox = await box(page, '.fab-menu')
  const bar = await box(page, '.playbar')
  check(`[${width}] the panel sits inside the map area, clear of the playback bar, which runs the full map width under the map`, !!menuBox && menuBox.x >= map.x - 1 && menuBox.x + menuBox.width <= map.x + map.width + 1 && !!bar && menuBox.y + menuBox.height <= bar.y + 1 && Math.abs(bar.width - map.width) <= 2, `panel ${Math.round(menuBox?.x)},${Math.round(menuBox?.y)} ${Math.round(menuBox?.width)}×${Math.round(menuBox?.height)}; bar ${Math.round(bar?.width)} wide at y ${Math.round(bar?.y)}`)
  const barText = (await page.locator('.playbar').innerText().catch(() => '')).replace(/\n/g, ' | ')
  check(`[${width}] the playback bar reads a clock time and carries the labelled Now boundary (Past radar · Now · Forecast)`, /\d{1,2}:\d{2}( ?[AP]M)?/.test(barText) && /Past radar[\s\S]*Now \d{1,2}:\d{2}( ?[AP]M)?[\s\S]*Forecast/.test(barText), barText.slice(0, 120))
  check(`[${width}] the units chip is in the Now column's header`, (await page.locator('.screen.now .units-chip').count()) === 1)
  // Collapse from ☰ and reopen.
  await page.locator('.fab-main').click()
  await page.waitForTimeout(400)
  const closed = (await menu.count()) === 0 || !(await menu.isVisible())
  await page.locator('.fab-main').click()
  await page.waitForTimeout(400)
  check(`[${width}] ☰ collapses the docked panel and opens it again`, closed && (await menu.isVisible()), `closed ${closed}`)
  await page.screenshot({ path: `${OUT}/${width}-now.png` })
  // Redesign 12: keyboard — Escape closes the open panels; the arrow keys scrub the playback slider.
  await page.locator('.playbar .scrubber').focus()
  const before = await page.evaluate(() => window.__store.get().playTime)
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(200)
  const afterKey = await page.evaluate(() => window.__store.get().playTime)
  check(`[${width}] ArrowLeft on the focused playback slider steps the clock back`, afterKey != null && afterKey !== before, `${before} → ${afterKey}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  check(`[${width}] Escape closes the docked layers panel`, (await menu.count()) === 0 || !(await menu.isVisible()))
  await page.locator('.fab-main').click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'Change place' }).first().click()
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check(`[${width}] Escape closes the place picker too`, (await page.getByRole('dialog').count()) === 0)
  // Hover tooltips on the map's points: a gauge dot names its gauge.
  await page.evaluate(() => { const s = window.__store.get(); const g = s.rivers.data?.[0]; if (g) window.__map.jumpTo({ center: [g.lngLat.lng, g.lngLat.lat], zoom: 11 }) })
  await page.waitForTimeout(1200)
  const dot = await page.evaluate(() => { const s = window.__store.get(); const g = s.rivers.data?.[0]; if (!g) return null; const p = window.__map.project([g.lngLat.lng, g.lngLat.lat]); const r = document.querySelector('.map-container').getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y, name: g.name } })
  if (dot) {
    await page.mouse.move(dot.x + 40, dot.y + 40)
    await page.mouse.move(dot.x, dot.y, { steps: 4 })
    await page.waitForTimeout(400)
  }
  const tip = await page.locator('.maplibregl-popup.map-tip').innerText().catch(() => '')
  check(`[${width}] hovering a gauge dot shows a tooltip with its name`, !!dot && tip.includes(dot.name), `"${tip}" for ${dot?.name}`)
  await page.mouse.move(10, 10)
  await page.waitForTimeout(300)
  check(`[${width}] the tooltip goes when the pointer leaves the dot`, (await page.locator('.maplibregl-popup.map-tip').count()) === 0)
  // The column collapses for a full-map view and comes back.
  await page.getByRole('button', { name: 'Hide the panel for a full-map view' }).click()
  await page.waitForTimeout(400)
  const fullMap = await box(page, '.map-root')
  const colGone = (await page.locator('.screen.now').count()) === 0 || !(await page.locator('.screen.now').isVisible())
  await page.getByRole('button', { name: 'Show the panel' }).click()
  await page.waitForTimeout(400)
  check(`[${width}] the column collapses to a full-map view (map from the rail's edge) and reopens`, colGone && fullMap.x <= rail.x + rail.width + 1 && fullMap.width > map.width && (await page.locator('.screen.now').isVisible()), `map ${Math.round(fullMap?.x)}+${Math.round(fullMap?.width)} collapsed vs ${Math.round(map?.width)} before`)
  await page.screenshot({ path: `${OUT}/${width}-fullmap.png` })
  // Detail pages beside the map: Station, Rivers, Flood, Trip — the map stays on screen.
  for (const [label, sel] of [['Station observations', '.obs-headline'], ['Rivers & gauges', '.gauge-list, .page-body'], ['Flood risk', '.flood-page']]) {
    await openMore(page, label)
    await page.waitForTimeout(400)
    const panel = await box(page, sel)
    const mapNow = await box(page, '.map-root')
    check(`[${width}] ${label} opens as a dock beside the map, the Now column still on the left`, visible(panel, width, 800) && visible(mapNow, width, 800) && mapNow.width > width * 0.3 && visible(await box(page, '.screen.now'), width, 800), `panel ${Math.round(panel?.x)}+${Math.round(panel?.width)}, map ${Math.round(mapNow?.width)}`)
  }
  await page.getByRole('button', { name: 'Trip', exact: true }).click()
  await page.waitForTimeout(400)
  // Mockup B: three columns — the Now column stays on the left, the map in the middle with the route drawn, Trip docked on the right.
  await page.getByRole('searchbox', { name: 'Destination' }).fill('Ames')
  await page.waitForTimeout(800)
  await page.getByRole('option').first().click()
  await until(page, () => window.__store.get().journey.routes.state === 'ready' && !!window.__map.getLayer('journey-line'), 30000)
  await page.waitForTimeout(400)
  const nowCol = await box(page, '.screen.now')
  const dock = await box(page, '.screen.trip')
  const mapMid = await box(page, '.map-root')
  const routeDrawn = await page.evaluate(() => !!window.__map.getLayer('journey-line') && window.__map.getLayoutProperty('journey-line', 'visibility') !== 'none')
  check(`[${width}] Trip open: the Now column (left), the map with the route (middle) and the Trip dock (right) are on screen together`, visible(nowCol, width, 800) && visible(dock, width, 800) && visible(mapMid, width, 800) && nowCol.x + nowCol.width <= mapMid.x + 1 && mapMid.x + mapMid.width <= dock.x + 1 && Math.abs(dock.x + dock.width - width) <= 1 && routeDrawn, `now ${Math.round(nowCol?.x)}+${Math.round(nowCol?.width)}, map ${Math.round(mapMid?.x)}+${Math.round(mapMid?.width)}, dock ${Math.round(dock?.x)}+${Math.round(dock?.width)}, route ${routeDrawn}`)
  await page.screenshot({ path: `${OUT}/${width}-trip-dock.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  check(`[${width}] Escape closes the Trip dock back to Now and the map widens again`, (await page.locator('.screen.trip').count()) === 0 && (await box(page, '.map-root')).width > mapMid.width)
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await openMore(page, 'Sources, freshness & settings')
  check(`[${width}] Settings carries the forget control and the units toggle`, (await page.getByRole('button', { name: 'Forget my location and recent places' }).count()) === 1 && (await page.getByRole('radiogroup', { name: 'Units', exact: true }).count()) === 1)
  const of = await overflow(page)
  check(`[${width}] no horizontal overflow`, of.page <= 1 && of.controls.length === 0, JSON.stringify(of))
  await page.screenshot({ path: `${OUT}/${width}-settings.png` })
  done()
  await ctx.close()
}

// The breakpoint edges: 800 px keeps the wide layout but the panel starts closed; 390 px is the phone layout.
{
  const ctx = await browser.newContext({ viewport: { width: 800, height: 1100 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'desktop-check.mjs 800 (mock)')
  await installMocks(ctx, {})
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  await until(page, () => window.__store?.get().conditions.state === 'ready' && !!window.__map?.loaded())
  await page.waitForTimeout(600)
  check('[800] tablet: the wide layout (rail + column + map), the layers panel closed until ☰ is tapped', visible(await box(page, '.nav'), 800, 1100) && visible(await box(page, '.map-root'), 800, 1100) && (await page.locator('.fab-menu').count()) === 0, `menu ${await page.locator('.fab-menu').count()}`)
  done()
  await ctx.close()
}
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'desktop-check.mjs 390 (mock)')
  await installMocks(ctx, {})
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  await until(page, () => window.__store?.get().conditions.state === 'ready')
  await page.getByRole('button', { name: 'Map', exact: true }).click()
  await page.waitForTimeout(800)
  const nav = await box(page, '.nav')
  check('[390] phone: bottom tabs, the playback pill, no docked panel', !!nav && nav.width > nav.height && nav.y > 600 && (await page.locator('.playpill').count()) === 1 && (await page.locator('.fab-menu').count()) === 0, `nav ${Math.round(nav?.width)}×${Math.round(nav?.height)} at y ${Math.round(nav?.y)}`)
  done()
  await ctx.close()
}
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
