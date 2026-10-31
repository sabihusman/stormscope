// The Now screen's one-line summary against three forecasts, mocked only (390 px phone): the mock's forecast is
// rewritten in flight so the place has (1) light drizzle right now and 0.4 mm over the day — the user's Oct 31 case,
// which read "All clear … No rain expected" — (2) a dry hour now and a 60 % chance of rain at a later hour, and
// (3) nothing at all. Only the last may say "All clear".
//   node scripts/summary-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  summary-check.mjs: mocked only (the forecast is rewritten per case)')
  process.exit(3)
}
assertBudget('summary-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/summary'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

/** Opens the app with the place's single-location forecast rewritten by `edit` (current + hourly arrays). */
async function run(name, edit) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
  const page = await ctx.newPage()
  const done = trackTraffic(page, `summary-check.mjs ${name} (mock)`)
  // The mock's own forecast answer for the place (one location, with `current`) is rewritten in place — no network fetch.
  // (The first version fetched the real Open-Meteo via route.fetch, a live call the traffic guard could not see.)
  await installMocks(ctx, { editForecast: (j, url) => { if (!/latitude=[^&]*,/.test(decodeURIComponent(url)) && /current=/.test(url) && j.current) edit(j) } })
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  const t0 = Date.now()
  while (Date.now() - t0 < 30000 && !(await page.evaluate(() => window.__store?.get().conditions.state === 'ready' && window.__store.get().alerts.state === 'ready').catch(() => false))) await page.waitForTimeout(200)
  // The summary replaces its placeholder once the forecast is in.
  while (Date.now() - t0 < 30000 && !(await page.evaluate(() => !!document.querySelector('.now-summary:not(.placeholder)')).catch(() => false))) await page.waitForTimeout(150)
  await page.waitForTimeout(300)
  const out = await page.evaluate(() => ({ text: document.querySelector('.now-summary')?.textContent ?? '', cls: document.querySelector('.now-summary')?.className ?? '', alerts: window.__store.get().alerts.data?.alerts.length ?? 0 }))
  await page.screenshot({ path: `${OUT}/${name}.png` })
  done()
  await ctx.close()
  return out
}
// Helpers on the Open-Meteo response shape: current.{precipitation, weather_code}, hourly.{precipitation, precipitation_probability, weather_code}.
const setAll = (arr, v) => arr && arr.fill(v)
const drizzleNow = (j) => {
  j.current.precipitation = 0.1
  j.current.weather_code = 51
  setAll(j.hourly.precipitation, 0)
  setAll(j.hourly.precipitation_probability, 10)
  setAll(j.hourly.weather_code, 3)
  j.hourly.precipitation[0] = 0.2
  j.hourly.precipitation[1] = 0.1
  j.hourly.precipitation[2] = 0.1
  j.hourly.weather_code[0] = 51
}
const laterChance = (j) => {
  j.current.precipitation = 0
  j.current.weather_code = 3
  setAll(j.hourly.precipitation, 0)
  setAll(j.hourly.precipitation_probability, 10)
  setAll(j.hourly.weather_code, 3)
  j.hourly.precipitation_probability[6] = 60
}
const dry = (j) => {
  j.current.precipitation = 0
  j.current.weather_code = 1
  setAll(j.hourly.precipitation, 0)
  setAll(j.hourly.precipitation_probability, 5)
  setAll(j.hourly.weather_code, 1)
}
const a = await run('drizzle-now', drizzleNow)
check('Drizzle now, 0.4 mm over the day (the Oct 31 case): the summary says light rain now — never "All clear" or "No rain expected"', a.alerts > 0 || (/Light rain now/.test(a.text) && /about [0-9.]+ (in|mm) over the next 24 h/.test(a.text) && !/All clear|No rain/.test(a.text) && /amber/.test(a.cls)), `"${a.text}"`)
const b = await run('later-chance', laterChance)
check('Dry now, a 60 % chance later: "Light rain likely from about <hour>", not all clear', b.alerts > 0 || (/Light rain likely from about \d{1,2} ?[AP]M/.test(b.text) && !/All clear/.test(b.text) && /amber/.test(b.cls)), `"${b.text}"`)
const c = await run('dry', dry)
check('Nothing now and nothing expected: "All clear for now. No rain now and none expected in the next 24 h"', c.alerts > 0 || (/All clear for now\. No rain now and none expected in the next 24 h/.test(c.text) && /green/.test(c.cls)), `"${c.text}"`)
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
