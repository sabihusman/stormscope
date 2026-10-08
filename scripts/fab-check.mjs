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
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
