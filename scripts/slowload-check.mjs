// A first load on a slow forecast service, mocked only — Open-Meteo's answer is held 14 s: the conditions card
// shows its skeletons, and about 10 s after the page opened says it is still waiting for Open-Meteo with a Retry; once the answer lands
// the card renders and the note goes.
//   node scripts/slowload-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  slowload-check.mjs: mocked only (a held forecast answer)')
  process.exit(3)
}
assertBudget('slowload-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/slowload'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const HOLD = 14_000
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
const page = await ctx.newPage()
const done = trackTraffic(page, 'slowload-check.mjs (mock)')
await installMocks(ctx, { delayHosts: { 'api.open-meteo.com': HOLD } })
const t0 = Date.now()
await page.goto(BASE, { waitUntil: 'load' })
// The grant is not awaited: the poll below must already be running when the card first appears.
const granted = allowLocation(page)
const until = async (fn, ms) => { const s = Date.now(); while (Date.now() - s < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(150) } return false }
const note = () => page.locator('.conditions .slow-note').innerText().catch(() => '')
// Poll from the page open: skeletons without a note first, the note at about 10 s.
// The 10 s count from the moment the card starts waiting (its skeletons appear), not from the navigation: on a
// deployed preview the page itself takes a few seconds longer to open than locally.
let tSkel = null
let shown = false
let tNote = 0
while (Date.now() - t0 < 20000) {
  const s = await page.evaluate(() => ({ skel: document.querySelectorAll('.conditions .skeleton').length, note: !!document.querySelector('.conditions .slow-note') })).catch(() => ({ skel: 0, note: false }))
  if (s.note) { shown = true; tNote = Date.now() - t0; break }
  if (s.skel > 0 && tSkel == null) tSkel = Date.now() - t0
  await page.waitForTimeout(150)
}
await granted
check('Skeletons show first, without the note', tSkel != null, tSkel != null ? `skeletons at ${(tSkel / 1000).toFixed(1)} s` : 'no skeletons seen')
// Redesign 10: every skeleton says what it is loading.
const labels = await page.evaluate(() => [...document.querySelectorAll('.screen.now .loading-label')].map((el) => el.textContent.trim()))
const aqDone = await page.evaluate(() => !!document.querySelector('.airnow .aq-value, .airnow .aqi-rows, .airnow li'))
check('The loading states are labelled: conditions, hourly and 7-day say what is loading (air quality too, unless its monitors already answered)', ['Loading current conditions…', 'Loading the hourly forecast…', 'Loading the 7-day forecast…'].every((l) => labels.includes(l)) && (labels.includes('Loading air quality…') || aqDone), `${labels.join(' | ')}; air quality loaded ${aqDone}`)
const sinceSkel = tNote - (tSkel ?? 0)
check(`About 10 s after it started waiting the card says it is still waiting for Open-Meteo, with a Retry (${(sinceSkel / 1000).toFixed(1)} s after the skeletons)`, shown && /Still waiting for the forecast service \(Open-Meteo\)/.test(await note()) && (await page.locator('.conditions .slow-note button', { hasText: 'Retry' }).count()) === 1 && sinceSkel >= 9000 && sinceSkel <= 13000, `"${await note()}"`)
await page.screenshot({ path: `${OUT}/waiting.png` })
const landed = await until(() => window.__store.get().conditions.state === 'ready', HOLD + 10000)
await page.waitForTimeout(300)
check('Once the forecast lands the card renders the temperature and the note goes', landed && (await page.locator('.conditions .cond-temp').count()) === 1 && (await note()) === '', `temp "${await page.locator('.conditions .cond-temp').innerText().catch(() => '')}"`)
await page.screenshot({ path: `${OUT}/landed.png` })
done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
