// The Now tab's "Next 12 / 24 / 48 hours" switch (Oct 18): the right number of cards per choice (every hour for
// 12 and 24, every third hour for 48), the header and the rain line following the choice, the choice remembered
// across a reload, no extra forecast request when switching (the one request already carries 48 h), units
// following the app setting, and the day shown on cards past midnight ("Tue 3 AM") under a fixed clock.
//   node scripts/hourly-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openNow, setUnits } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  hourly-check.mjs: mocked only (fixed clock, counted requests)')
  process.exit(3)
}
assertBudget('hourly-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/hourly'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const FOCUS = { lat: 41.673, lng: -93.698 }
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

async function session({ now = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: FOCUS.lat, longitude: FOCUS.lng }, permissions: ['geolocation'] })
  const page = await ctx.newPage()
  if (now != null) await page.clock.setFixedTime(new Date(now))
  const done = trackTraffic(page, 'hourly-check.mjs (mock)')
  const om = []
  globalThis.__qaMockedRequest = (url) => { if (/open-meteo\.com\/v1\/forecast/.test(url)) om.push(url) }
  await installMocks(ctx, { now })
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(150) } return false }
  await until(() => window.__store?.get().conditions.state === 'ready')
  await page.waitForTimeout(300)
  return { ctx, page, done, om, until }
}
/** The card as rendered: header, switch state, card count and times, the rain line, and the data behind it. */
const read = (page) => page.evaluate(() => {
  const card = document.querySelector('.now-card.hourly')
  const cards = [...card.querySelectorAll('.hour-strip li')]
  const h = window.__store.get().conditions.data.hourly
  return {
    header: card.querySelector('h4')?.textContent ?? '',
    checked: card.querySelector('.span-switch [aria-checked="true"]')?.dataset.span ?? null,
    n: cards.length,
    times: cards.map((li) => Number(li.dataset.time)),
    labels: cards.map((li) => li.querySelector('.hour-t').textContent),
    days: cards.map((li) => li.dataset.day ?? null),
    rain: card.querySelector('.link-row')?.textContent ?? '',
    rainSpan: card.querySelector('.link-row')?.dataset.rainSpan ?? null,
    sum: (n) => h.slice(0, n).reduce((a, x) => a + (x.precipMm ?? 0), 0),
    sums: { 12: h.slice(0, 12).reduce((a, x) => a + (x.precipMm ?? 0), 0), 24: h.slice(0, 24).reduce((a, x) => a + (x.precipMm ?? 0), 0), 48: h.slice(0, 48).reduce((a, x) => a + (x.precipMm ?? 0), 0) },
    hourlyLen: h.length,
    firstTime: h[0]?.time,
  }
})
const pick = async (page, n) => { await page.locator(`.span-switch [data-span="${n}"]`).tap(); await page.waitForTimeout(250) }
const mmToIn = (mm) => mm / 25.4

// ---- 1. The three choices, their counts, headers and rain lines; no extra request; remembered; units.
{
  const { ctx, page, done, om } = await session()
  const r12 = await read(page)
  const reqBefore = om.length
  check('Default 12 h: the switch shows 12 h checked, the header "Next 12 hours", 12 cards one hour apart, the first "Now"', r12.checked === '12' && r12.header === 'Next 12 hours' && r12.n === 12 && r12.times.every((t, i) => i === 0 || t - r12.times[i - 1] === 3_600_000) && r12.labels[0] === 'Now', `${r12.header}, ${r12.n} cards`)
  check('The one forecast request already covers 48 hours (49 hourly points from the current hour)', r12.hourlyLen >= 48, `${r12.hourlyLen} hourly points`)
  check('Rain line for 12 h matches the header and sums the same 12 hours (imperial by default, inches)', r12.rainSpan === '12' && /^Rain next 12 h: /.test(r12.rain) && new RegExp(`${mmToIn(r12.sums[12]).toFixed(2)} in`).test(r12.rain), r12.rain)
  await pick(page, 24)
  const r24 = await read(page)
  check('24 h: header "Next 24 hours", 24 cards one hour apart, rain line "Rain next 24 h" summing 24 hours', r24.checked === '24' && r24.header === 'Next 24 hours' && r24.n === 24 && r24.times.every((t, i) => i === 0 || t - r24.times[i - 1] === 3_600_000) && r24.rainSpan === '24' && new RegExp(`^Rain next 24 h: ${mmToIn(r24.sums[24]).toFixed(2)} in`).test(r24.rain), `${r24.header}, ${r24.n} cards, ${r24.rain}`)
  await pick(page, 48)
  const r48 = await read(page)
  check('48 h: header "Next 48 hours", 16 cards three hours apart, rain line "Rain next 48 h" summing all 48 hours', r48.checked === '48' && r48.header === 'Next 48 hours' && r48.n === 16 && r48.times.every((t, i) => i === 0 || t - r48.times[i - 1] === 3 * 3_600_000) && r48.rainSpan === '48' && new RegExp(`^Rain next 48 h: ${mmToIn(r48.sums[48]).toFixed(2)} in`).test(r48.rain), `${r48.header}, ${r48.n} cards, ${r48.rain}`)
  check('Switching made no extra forecast request', om.length === reqBefore, `${om.length - reqBefore} new request(s)`)
  await page.screenshot({ path: `${OUT}/48h.png` })
  // Remembered across a reload.
  await page.reload({ waitUntil: 'load' })
  await allowLocation(page)
  const t0 = Date.now(); while (Date.now() - t0 < 30000) { if (await page.evaluate(() => window.__store?.get().conditions.state === 'ready').catch(() => false)) break; await page.waitForTimeout(150) }
  await page.waitForTimeout(300)
  const again = await read(page)
  check('The choice is remembered after a reload (48 h still selected, 16 cards)', again.checked === '48' && again.n === 16 && again.header === 'Next 48 hours', `${again.header}, ${again.n} cards`)
  // Metric: the rain line follows the unit setting.
  await setUnits(page, 'Metric')
  await openNow(page)
  const metric = await read(page)
  check('Metric: the rain line is in mm for the same 48 hours', new RegExp(`^Rain next 48 h: ${metric.sums[48].toFixed(1)} mm`).test(metric.rain), metric.rain)
  done()
  await ctx.close()
}

// ---- 2. Midnight labels under a fixed clock (21:00 local): cards past midnight carry the weekday.
{
  const FIXED = (() => { const d = new Date(); d.setHours(21, 0, 0, 0); return d.getTime() })()
  const { ctx, page, done } = await session({ now: FIXED })
  const r = await read(page)
  const tomorrow = new Date(FIXED + 24 * 3_600_000).toLocaleDateString([], { weekday: 'short' })
  const beforeMidnight = r.labels.slice(0, 3), afterMidnight = r.labels.slice(3)
  check('Fixed clock 21:00: the first card is "Now" and the next two have no day', r.labels[0] === 'Now' && beforeMidnight.slice(1).every((l) => !l.startsWith(tomorrow)), beforeMidnight.join(' | '))
  check(`Fixed clock 21:00: every card from midnight on shows the day ("${tomorrow} 12 AM", "${tomorrow} 1 AM", …)`, afterMidnight.length === 9 && afterMidnight.every((l) => l.startsWith(`${tomorrow} `)) && /12 AM$/.test(afterMidnight[0]) && /1 AM$/.test(afterMidnight[1]), afterMidnight.slice(0, 3).join(' | '))
  await pick(page, 48)
  const r48 = await read(page)
  const dayAfter = new Date(FIXED + 48 * 3_600_000).toLocaleDateString([], { weekday: 'short' })
  check(`48 h at 21:00: "Now", then eight 3-hourly cards with "${tomorrow}", then seven with "${dayAfter}" (the last ends at 6 PM the day after tomorrow)`, r48.n === 16 && r48.labels[0] === 'Now' && r48.labels.filter((l) => l.startsWith(`${tomorrow} `)).length === 8 && r48.labels.filter((l) => l.startsWith(`${dayAfter} `)).length === 7 && /6 PM$/.test(r48.labels[15]), r48.labels.join(' | '))
  await page.screenshot({ path: `${OUT}/midnight.png` })
  done()
  await ctx.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
