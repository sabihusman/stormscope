// More › Rivers & gauges, as a user reaches it (real taps), mocked: every gauge row shows a name rather than a
// bare USGS id, no reading older than the limit (7 days) is shown — a discontinued series' 1996 value reads
// "No recent readings" instead of "10897 d ago" — and the Now tile's count agrees with the list.
//   node scripts/gauges-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMore, openNow } from './lib/ui.mjs'

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

// The Now tile's gauge count and wording: the same on every load of the same place (same mocked data), and the
// same before and after the Rivers page has been opened — never "1 of 20 NOAA gauges" on one load and "1 of 43 gauges" on another.
const tileText = async () => {
  await openNow(page)
  await page.locator('.tiles').scrollIntoViewIfNeeded()
  await until(() => { const s = window.__store.get(); return s.rivers.state === 'ready' || !!s.rivers.error }, 20000)
  await page.waitForTimeout(400)
  return (await page.locator('.tiles .tile').first().innerText()).replace(/\n/g, ' | ')
}
const moreRow = async () => {
  await openMore(page)
  return (await page.getByRole('button', { name: /^Rivers & gauges/ }).innerText()).replace(/\n/g, ' | ')
}
const seen = [{ when: 'load 1, after the Rivers page', tile: await tileText(), more: await moreRow() }]
for (let i = 2; i <= 3; i++) {
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  await until(() => window.__store?.get().conditions.state === 'ready')
  seen.push({ when: `load ${i}`, tile: await tileText(), more: await moreRow() })
  if (i === 2) {
    await openMore(page, 'Rivers & gauges')
    await until(() => window.__store.get().rivers.state === 'ready' && window.__store.get().riversTier === 'full', 30000)
    seen.push({ when: 'load 2, after the Rivers page', tile: await tileText(), more: await moreRow() })
  }
}
const tiles = new Set(seen.map((x) => x.tile))
const counts = seen.map((x) => ({ tile: x.tile.match(/(\d+) (?:NOAA )?gauges/)?.[1], more: x.more.match(/(\d+) (?:NOAA )?gauges/)?.[1] }))
check('Rivers tile: identical count and wording on three loads of the same place, before and after the Rivers page', tiles.size === 1, seen.map((x) => `${x.when}: "${x.tile}"`).join(' || '))
check('The More list\'s Rivers row counts the same gauges as the tile on every load', counts.every((c) => c.tile && c.tile === c.more), seen.map((x) => `${x.when}: "${x.more}"`).join(' || '))
done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
