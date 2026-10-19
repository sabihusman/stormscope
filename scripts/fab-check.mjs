// Verifies the movable layer button (drag to every corner, persistence) and grabs wind-tail shots at two zooms.
import { chromium } from 'playwright'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
// --mock answers every API locally (zero live calls, scripts/lib/mock-server.mjs); live-only checks are skipped and said so.
const MOCK = process.argv.includes('--mock')
assertBudget(MOCK ? 'fab-check.mjs (mock)' : 'fab-check.mjs')
import { mkdirSync } from 'node:fs'
import { allowLocation, openMap, openMore, openTrip, pageText, setLayers, setSheet, setUnits, sheetText, tripText, searchPlace, openNow } from './lib/ui.mjs'

const BASE = process.argv[2] || 'http://localhost:5173/'
const OUT = process.argv[3] || 'e2e-shots/fab'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 39.9526, longitude: -75.1652 }, permissions: ['geolocation'] })
await ctx.addInitScript(() => { try { if (!localStorage.getItem('stormscope.layers')) localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: false, station: false, nowcast: false })) } catch {} }) // not under test here: keep gauge/NWS traffic off the shared IP
const page = await ctx.newPage()
const __recordBudget = trackOpenMeteo(page, MOCK ? 'fab-check.mjs (mock)' : 'fab-check.mjs')
if (MOCK) await installMocks(ctx, { focus: { lat: 39.9526, lng: -75.1652 } })
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
await page.waitForTimeout(6000)
await openMap(page)

const fab = () => page.getByRole('button', { name: /layer menu/ })
const box = async () => fab().boundingBox()
const corner = async () => (await page.locator('.app').getAttribute('class')).match(/fab-(\w\w)/)?.[1]

const b0 = await box()
check('Default corner is bottom-right', (await corner()) === 'br' && b0.x > 300 && b0.y > 600, `${await corner()} @ ${Math.round(b0.x)},${Math.round(b0.y)}`)

// Drag to top-left.
await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2)
await page.mouse.down()
for (let i = 1; i <= 10; i++) await page.mouse.move(b0.x + (40 - b0.x) * (i / 10), b0.y + (150 - b0.y) * (i / 10))
await page.mouse.up()
await page.waitForTimeout(400)
const b1 = await box()
check('Drag snaps the button to the top-left corner', (await corner()) === 'tl' && b1.x < 60 && b1.y < 200, `${await corner()} @ ${Math.round(b1.x)},${Math.round(b1.y)}`)
check('Drag did not open the menu', !(await page.locator('.fab-menu').isVisible()))
check('Nothing floats under the top-left button: the legend lives inside the layer menu', (await page.locator('.legend-chip, .legend').count()) === 0)
await page.screenshot({ path: `${OUT}/fab-top-left.png` })

// Tap still opens the menu; the menu opens downward and stays on-screen.
await fab().click()
await page.waitForTimeout(300)
const menu = await page.locator('.fab-menu').boundingBox()
check('Tap opens the menu below a top-corner button, on-screen', menu && menu.y > b1.y && menu.y + menu.height <= 844, `menu ${Math.round(menu?.y)}–${Math.round(menu?.y + menu?.height)}`)
await fab().click() // close the menu
const dragTo = async (x, y) => { const b = await box(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + (x - b.x) * (i / 10), b.y + (y - b.y) * (i / 10)); await page.mouse.up(); await page.waitForTimeout(400) }
await dragTo(350, 150)
check('Drag to the top-right corner', (await corner()) === 'tr', await corner())
await page.screenshot({ path: `${OUT}/fab-top-right.png` })
const nav = await page.locator('.maplibregl-ctrl-top-right').boundingBox()
const b2 = await box()
check('Zoom controls pushed below a top-right button', nav.y >= b2.y + b2.height - 2, `nav y ${Math.round(nav.y)} vs fab bottom ${Math.round(b2.y + b2.height)}`)
await dragTo(350, 700)
check('Drag to the bottom-right corner', (await corner()) === 'br', await corner())
await dragTo(40, 700)
check('Drag to the bottom-left corner', (await corner()) === 'bl', await corner())
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(3000)
await openMap(page)
check('Corner persists across reload', (await corner()) === 'bl', await corner())

// Wind tails at two zooms.
await page.getByRole('button', { name: /layer menu/ }).click()
await page.getByRole('radio', { name: 'Next 2 h wind & cloud' }).click()
await page.getByRole('button', { name: /layer menu/ }).click()
await page.waitForTimeout(12000)
await page.evaluate(() => window.__map.jumpTo({ zoom: 9 }))
await page.waitForTimeout(6000)
await page.screenshot({ path: `${OUT}/wind-z9.png` })
await page.evaluate(() => window.__map.jumpTo({ zoom: 11.5 }))
await page.waitForTimeout(6000)
await page.screenshot({ path: `${OUT}/wind-z11.png` })

__recordBudget()
// ---- Desktop (Oct 19): the button is 20 % larger than the map's own buttons, sits under the zoom column by default,
// and can be dragged to any corner of the map area (a preference separate from the phone's); the panel opens fully
// inside the map area from every corner; the corner persists across a reload.
{
  const ctxW = await browser.newContext({ viewport: { width: 1280, height: 800 }, geolocation: { latitude: 39.9526, longitude: -75.1652 }, permissions: ['geolocation'] })
  await ctxW.addInitScript(() => { try { localStorage.setItem('stormscope.fabCorner', 'bl') } catch {} }) // the phone's corner, must stay untouched
  const pw = await ctxW.newPage()
  const __rb = trackOpenMeteo(pw, MOCK ? 'fab-check.mjs (mock)' : 'fab-check.mjs')
  if (MOCK) await installMocks(ctxW, { focus: { lat: 39.9526, lng: -75.1652 } })
  await pw.goto(BASE, { waitUntil: 'load' })
  await pw.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
  await pw.waitForTimeout(5000)
  const fabW = () => pw.getByRole('button', { name: /layer menu/ })
  const boxW = async () => fabW().boundingBox()
  const cornerW = async () => (await pw.locator('.app').getAttribute('class')).match(/fabw-(\w\w)/)?.[1]
  const mapArea = async () => pw.locator('.map-root').boundingBox()
  const ctrlBtn = await pw.locator('.maplibregl-ctrl-zoom-in').boundingBox()
  const area = await mapArea()
  const w0 = await boxW()
  const navW = await pw.locator('.maplibregl-ctrl-top-right').boundingBox()
  check('Desktop: the wide layout, the button under the zoom column by default (fabw-tr)', (await cornerW()) === 'tr' && w0.y >= navW.y + navW.height - 2 && w0.x + w0.width >= area.x + area.width - 20, `${await cornerW()} @ ${Math.round(w0.x)},${Math.round(w0.y)}; controls bottom ${Math.round(navW.y + navW.height)}`)
  check('Desktop: the button is 20 % larger than the map buttons (43 px vs 36 px)', Math.abs(w0.width - ctrlBtn.width * 1.2) <= 1.5 && Math.abs(w0.height - ctrlBtn.height * 1.2) <= 1.5, `${w0.width.toFixed(1)} px vs map button ${ctrlBtn.width.toFixed(1)} px`)
  const dragW = async (x, y) => { const b = await boxW(); await pw.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await pw.mouse.down(); for (let i = 1; i <= 10; i++) await pw.mouse.move(b.x + b.width / 2 + (x - b.x - b.width / 2) * (i / 10), b.y + b.height / 2 + (y - b.y - b.height / 2) * (i / 10)); await pw.mouse.up(); await pw.waitForTimeout(450) }
  const openPanel = async () => { await fabW().click(); await pw.waitForTimeout(400); const m = await pw.locator('.fab-menu').boundingBox(); await fabW().click(); await pw.waitForTimeout(300); return m }
  const inside = (m) => !!m && m.x >= area.x - 1 && m.x + m.width <= area.x + area.width + 1 && m.y >= 0 && m.y + m.height <= 800
  // Bottom-right of the map area.
  await dragW(area.x + area.width - 60, area.y + area.height - 60)
  const w1 = await boxW()
  check('Desktop: dragged to the bottom-right — the button moves there (its bottom in the lower half of the map, its right edge at the map\'s right edge)', (await cornerW()) === 'br' && w1.y > area.y + area.height / 2 && w1.x + w1.width >= area.x + area.width - 20, `${await cornerW()} @ ${Math.round(w1.x)},${Math.round(w1.y)} (map ${Math.round(area.x)}–${Math.round(area.x + area.width)} × ${Math.round(area.y)}–${Math.round(area.y + area.height)})`)
  const m1 = await openPanel()
  check('Desktop: from the bottom-right the panel opens fully inside the map area', inside(m1), m1 ? `${Math.round(m1.x)},${Math.round(m1.y)} ${Math.round(m1.width)}×${Math.round(m1.height)}` : 'no panel')
  // Bottom-left of the map area.
  await dragW(area.x + 60, area.y + area.height - 60)
  const w2 = await boxW()
  check('Desktop: dragged to the bottom-left of the map area (not under the side column)', (await cornerW()) === 'bl' && w2.x >= area.x && w2.x <= area.x + 40 && w2.y > area.y + area.height / 2, `${await cornerW()} @ ${Math.round(w2.x)},${Math.round(w2.y)}`)
  const m2 = await openPanel()
  check('Desktop: from the bottom-left the panel opens fully inside the map area', inside(m2), m2 ? `${Math.round(m2.x)},${Math.round(m2.y)} ${Math.round(m2.width)}×${Math.round(m2.height)}` : 'no panel')
  // Top-left of the map area.
  await dragW(area.x + 60, area.y + 120)
  const w3 = await boxW()
  check('Desktop: dragged to the top-left of the map area, below the location bar', (await cornerW()) === 'tl' && w3.x >= area.x && w3.x <= area.x + 40 && w3.y < area.y + area.height / 2 && w3.y > area.y + 40, `${await cornerW()} @ ${Math.round(w3.x)},${Math.round(w3.y)}`)
  const m3 = await openPanel()
  check('Desktop: from the top-left the panel opens fully inside the map area', inside(m3), m3 ? `${Math.round(m3.x)},${Math.round(m3.y)} ${Math.round(m3.width)}×${Math.round(m3.height)}` : 'no panel')
  // Back under the zoom column, and persistence.
  await dragW(area.x + area.width - 60, area.y + 120)
  check('Desktop: dragged back to the top-right it sits under the zoom column again', (await cornerW()) === 'tr' && (await boxW()).y >= navW.y + navW.height - 2, await cornerW())
  await dragW(area.x + 60, area.y + area.height - 60)
  await pw.reload({ waitUntil: 'load' })
  await pw.waitForTimeout(3000)
  const stored = await pw.evaluate(() => ({ wide: localStorage.getItem('stormscope.fabCornerWide'), phone: localStorage.getItem('stormscope.fabCorner') }))
  check('Desktop: the corner persists across a reload, as its own preference (the phone\'s corner untouched)', (await cornerW()) === 'bl' && stored.wide === 'bl' && stored.phone === 'bl', JSON.stringify({ corner: await cornerW(), ...stored }))
  await pw.screenshot({ path: `${OUT}/fab-desktop.png` })
  __rb()
  await ctxW.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
