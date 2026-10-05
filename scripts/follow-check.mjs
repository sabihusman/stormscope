// Verifies that the data window follows the map when panning, and snaps back on demand.
import { chromium } from 'playwright'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
assertBudget('follow-check.mjs')
import { mkdirSync } from 'node:fs'

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
const __recordBudget = trackOpenMeteo(page, 'follow-check.mjs')
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {})
await page.waitForTimeout(7000)
await page.getByRole('tab', { name: 'Rivers' }).click()
await page.waitForTimeout(1500)
const before = await page.locator('.gauge-list li').first().innerText().catch(() => '')
check('Rivers loaded for the user location', /Schuylkill|Delaware|Creek|River/.test(before), before.split('\n')[0])

// Pan ~150 km south-west to Baltimore.
await page.evaluate(() => window.__map.jumpTo({ center: [-76.6122, 39.2904], zoom: 10 }))
await page.waitForTimeout(9000)
const pill = await page.getByRole('button', { name: /Showing map area/ }).isVisible()
check('Follow pill appears after panning away', pill)
const after = await page.locator('.gauge-list li').first().innerText().catch(() => '')
check('River gauges refetched for the new area', after && after !== before && !/Schuylkill/.test(after), after.split('\n')[0])
await page.getByRole('tab', { name: 'Station' }).click()
await page.waitForTimeout(3000)
const st = await page.locator('.sheet-body').innerText()
check('Station now nearest to the map centre (Baltimore)', /Baltimore|BWI|Martin State/.test(st) && /map centre/.test(st), st.split('\n')[0])
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
const st2 = await page.locator('.sheet-body').innerText()
check('Continental zoom does not move the data window', /Baltimore|BWI|Martin State/.test(st2))

// Back to my spot.
await page.getByRole('button', { name: /Showing map area/ }).click()
await page.waitForTimeout(6000)
const st3 = await page.locator('.sheet-body').innerText()
const center = await page.evaluate(() => window.__map.getCenter())
check('"Back to my spot" recenters map and data', Math.abs(center.lat - 39.9526) < 0.05 && /Philadelphia/.test(st3), `${center.lat.toFixed(3)},${center.lng.toFixed(3)} · ${st3.split('\n')[0]}`)
check('Follow pill gone after recentering', !(await page.getByRole('button', { name: /Showing map area/ }).isVisible()))

// Wind tails screenshot with nowcast on.
await page.getByRole('button', { name: 'Open layer menu' }).click()
await page.getByRole('button', { name: 'Nowcast' }).click()
await page.getByRole('button', { name: 'Close layer menu' }).click()
await page.getByRole('button', { name: 'Collapse panel' }).click()
await page.waitForTimeout(14000)
await page.screenshot({ path: `${OUT}/wind-tails.png` })

__recordBudget()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
