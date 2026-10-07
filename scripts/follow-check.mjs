// Verifies the map's follow mode (the forecast window follows the map when panning, with a chip to come
// back) while the reference views stay bound to the place — rivers and station must NOT change when you pan.
import { chromium } from 'playwright'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
// --mock answers every API locally (zero live calls, scripts/lib/mock-server.mjs); live-only checks are skipped and said so.
const MOCK = process.argv.includes('--mock')
assertBudget(MOCK ? 'follow-check.mjs (mock)' : 'follow-check.mjs', { openMeteo: !MOCK })
import { mkdirSync } from 'node:fs'
import { allowLocation, openMap, openMore, openRivers, openTrip, pageText, setLayers, setSheet, setUnits, sheetText, tripText, searchPlace, openNow } from './lib/ui.mjs'

const BASE = process.argv[2] || 'http://localhost:5173/'
const OUT = process.argv[3] || 'e2e-shots/follow'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 39.9526, longitude: -75.1652 }, permissions: ['geolocation'] })
const page = await ctx.newPage()
const __recordBudget = trackOpenMeteo(page, MOCK ? 'follow-check.mjs (mock)' : 'follow-check.mjs')
if (MOCK) await installMocks(ctx, { focus: { lat: 39.9526, lng: -75.1652 } })
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
await page.waitForTimeout(7000)
await openRivers(page)
const before = await page.locator('.gauge-list li').first().innerText().catch(() => '')
check('Rivers loaded for the user location', MOCK ? before.length > 0 : /Schuylkill|Delaware|Creek|River/.test(before), before.split('\n')[0])

// Pan ~150 km south-west to Baltimore on the Map.
await openMap(page)
await page.evaluate(() => window.__map.jumpTo({ center: [-76.6122, 39.2904], zoom: 10 }))
await page.waitForTimeout(9000)
const pill = await page.getByRole('button', { name: /Showing map area/ }).isVisible()
check('Follow chip appears on the map after panning away', pill)
await openRivers(page)
const after = await page.locator('.gauge-list li').first().innerText().catch(() => '')
check('River gauges stay bound to the place (not the map centre)', after && after === before, after.split('\n')[0])
await openMore(page, 'Station observations')
await page.waitForTimeout(1500)
const st = await pageText(page)
check('Station stays the one nearest the place (Philadelphia)', (MOCK || /Philadelphia|PHL|Northeast Philadelphia/.test(st)) && /your place/.test(st), st.split('\n')[0])
await openMap(page)
await page.screenshot({ path: `${OUT}/followed-baltimore.png` })

// Small pan (< 25 km) must NOT refetch.
const key0 = await page.evaluate(() => JSON.stringify(Object.values(window.__store?.get?.()?.focus ?? {})))
await page.evaluate(() => window.__map.panBy([80, 0], { duration: 0 }))
await page.waitForTimeout(2000)
const key1 = await page.evaluate(() => JSON.stringify(Object.values(window.__store?.get?.()?.focus ?? {})))
check('Small pan keeps the same data window', key0 === key1)

// Zoomed out: no refetch.
await page.evaluate(() => window.__map.jumpTo({ center: [-95, 38], zoom: 4 }))
await page.waitForTimeout(2500)
const key2 = await page.evaluate(() => JSON.stringify(Object.values(window.__store?.get?.()?.focus ?? {})))
check('Continental zoom does not move the data window', key1 === key2)

// Back to my spot.
await page.getByRole('button', { name: /Showing map area/ }).click()
await page.waitForTimeout(6000)
const center = await page.evaluate(() => window.__map.getCenter())
const focus = await page.evaluate(() => window.__store.get().focus)
check('"Back to my place" recenters the map and the data window', Math.abs(center.lat - 39.9526) < 0.05 && Math.abs(focus.lat - 39.9526) < 0.01, `${center.lat.toFixed(3)},${center.lng.toFixed(3)}`)
check('Follow pill gone after recentering', !(await page.getByRole('button', { name: /Showing map area/ }).isVisible()))

// Wind tails screenshot with nowcast on.
await page.getByRole('button', { name: 'Open layer menu' }).click()
await page.getByRole('radio', { name: 'Next 2 h wind & cloud' }).click()
await page.getByRole('button', { name: 'Close layer menu' }).click()
await page.waitForTimeout(14000)
await page.screenshot({ path: `${OUT}/wind-tails.png` })

__recordBudget()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
