// More › Rivers & gauges, as a user reaches it (real taps), mocked: every gauge row shows a name rather than a
// bare USGS id, no reading older than the limit (7 days) is shown — a discontinued series' 1996 value reads
// "No recent readings" instead of "10897 d ago" — and the Now tile's count agrees with the list.
//   node scripts/gauges-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMore } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  gauges-check.mjs: mocked only (a discontinued USGS series and the names endpoint as it really answers are in the mock)')
  process.exit(3)
}
assertBudget('gauges-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/gauges'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const FOCUS = { lat: 41.673, lng: -93.698 }
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: FOCUS.lat, longitude: FOCUS.lng }, permissions: ['geolocation'] })
const page = await ctx.newPage()
const done = trackTraffic(page, 'gauges-check.mjs (mock)')
await installMocks(ctx, {})
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(200) } return false }
await until(() => window.__store?.get().conditions.state === 'ready')
// As a user: More → Rivers & gauges (real taps), the full tier.
await openMore(page, 'Rivers & gauges')
await until(() => window.__store.get().rivers.state === 'ready' && window.__store.get().riversTier === 'full', 30000)
await page.waitForTimeout(500)
const rows = await page.evaluate(() => [...document.querySelectorAll('.gauge-list li')].map((li) => ({ name: li.querySelector('.gauge-main > span')?.textContent ?? '', text: li.innerText.replace(/\n/g, ' | ') })))
check('The gauges page lists gauges (full tier: NWPS + USGS)', rows.length >= 5, `${rows.length} rows`)
const idNames = rows.filter((r) => /^USGS-\d+$/.test(r.name.trim()))
check('Every gauge shows a name, none is a bare USGS id (the names endpoint is asked without the site-type filter it answers empty to)', idNames.length === 0, idNames.map((r) => r.name).join(', ') || 'none')
const oldAges = rows.filter((r) => /\b(\d+) d ago/.test(r.text) && Number(r.text.match(/\b(\d+) d ago/)[1]) >= 7)
check('No row shows a reading older than 7 days (no "10897 d ago")', oldAges.length === 0, oldAges.map((r) => r.text.slice(0, 80)).join(' || ') || 'none')
// A USGS-only site whose only value is from 1996 is a discontinued series, not a live gauge: it is left out of the list
// (an NWPS gauge without a recent reading still shows "No recent readings", since it is a live forecast point).
const old = rows.find((r) => /Old Creek near Nowhere|USGS-05499999/.test(r.text))
check('The discontinued series (last value 1996) is not listed as a gauge at all — neither by name nor as an id with "10976 d ago"', !old, old?.text.slice(0, 120) ?? 'absent, as intended')
const anyAge = rows.filter((r) => /(min|h) ago/.test(r.text)).length
check('Fresh readings still show their stage or flow with an age in minutes or hours', anyAge >= 3, `${anyAge} rows with a recent age`)
await page.screenshot({ path: `${OUT}/gauges.png` })
done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
