// The Now tab's "Observed X° at <station>" line under a fixed clock, mocked only: a 50-minute-old station
// reading shows; at 61 minutes it is hidden; it returns once a reading under an hour old arrives; nothing else
// on the conditions card moves or changes while it comes and goes.
//   node scripts/observed-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  observed-check.mjs: mocked only (fixed clock)')
  process.exit(3)
}
assertBudget('observed-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/observed'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
const page = await ctx.newPage()
const done = trackTraffic(page, 'observed-check.mjs (mock)')
await page.clock.install()
await installMocks(ctx, {})
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(200) } return false }
await until(() => window.__store?.get().conditions.state === 'ready' && window.__store.get().station.state === 'ready')
const line = () => page.locator('.cond-observed').innerText().catch(() => '')
const ageMin = () => page.evaluate(() => Math.round((Date.now() - window.__store.get().station.data.observedAt) / 60000))
/** The card's text and geometry apart from the observed line. */
const rest = () => page.evaluate(() => { const card = document.querySelector('.card.conditions'); const r = card.getBoundingClientRect(); const main = card.querySelector('.cond-main').getBoundingClientRect(); return { text: [...card.children].filter((c) => !c.classList.contains('cond-observed')).map((c) => c.innerText.replace(/updated .*$/, 'updated …')).join(' | '), top: Math.round(r.top), width: Math.round(r.width), mainH: Math.round(main.height) } })
/** The station poller answers with a reading of this age (as the live NWS feed would), by the same store write it makes. */
const setReadingAge = (min) => page.evaluate((m) => { const s = window.__store.get(); window.__store.set({ station: { ...s.station, data: { ...s.station.data, observedAt: Date.now() - m * 60000 } } }) }, min)
// A reading 12 min old at load (the mock's); the page clock then moves on.
check('A fresh reading shows the observed line', /Observed .*°F? at .*, \d+ min ago/.test(await line()), `${await ageMin()} min old: "${await line()}"`)
const before = await rest()
await setReadingAge(50)
await page.clock.runFor(16_000)
await page.waitForTimeout(300)
check('A 50-minute-old reading still shows', /Observed .*°F? at .*, 50 min ago/.test(await line()), `${await ageMin()} min old: "${await line()}"`)
await setReadingAge(61)
await page.clock.runFor(16_000)
await page.waitForTimeout(300)
check('At 61 minutes the observed line is hidden', (await line()) === '', `${await ageMin()} min old: "${await line()}"`)
const hidden = await rest()
check('Nothing else on the conditions card changed when the line went (same text apart from the ticking "updated" age, same top and width, same headline height)', JSON.stringify(hidden) === JSON.stringify(before), `${JSON.stringify(hidden)} vs ${JSON.stringify(before)}`)
await page.screenshot({ path: `${OUT}/hidden.png` })
// A newer reading arrives (the 10-minute poll): the line comes back.
await setReadingAge(8)
await page.clock.runFor(16_000)
await page.waitForTimeout(300)
check('The line returns once a reading under an hour old arrives', /Observed .*°F? at .*, 8 min ago/.test(await line()), `"${await line()}"`)
// The wording matches the sources: the station is checked every 10 min but reports about hourly; monitors report hourly averages.
await page.getByRole('button', { name: 'More', exact: true }).click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: /^Station observations/ }).click()
await page.waitForTimeout(500)
const stationText = await page.locator('.page-body').innerText()
check('The station page says it is checked every 10 min and that airport stations report about hourly (a reading can be close to an hour old)', /Checked every 10 min/.test(stationText) && /report about once an hour/.test(stationText) && !/Auto-refreshes/.test(stationText), stationText.match(/Checked[^\n]*|Auto-refreshes[^\n]*/)?.[0] ?? '(no cadence line)')
await page.getByRole('button', { name: /^Now/ }).click()
await page.waitForTimeout(400)
const aqText = await page.locator('.airnow, .aqi-attrib').first().innerText().catch(() => '')
check('The air-quality card says monitors report hourly averages once the hour ends', /monitors report hourly averages once the hour ends/.test(aqText), aqText.slice(0, 160))
done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
