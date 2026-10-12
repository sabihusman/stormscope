// The 7-day forecast card on Now (mocked):
//   1. seven rows (day, icon, high / low, chance) from the SAME Open-Meteo call as the conditions — one
//      forecast request on load, two after a place change (no second request per place);
//   2. day labels across midnight in the place's zone: a zone whose local date differs from UTC's right now
//      gets Today = its local date, then Tomorrow, then the weekday;
//   3. units follow the setting (°F / in ↔ °C / mm);
//   4. error states: a response without the daily block → the card says so while the conditions card still
//      shows a temperature; Open-Meteo down → the card's own error with Retry while the alerts card still renders.
//   node scripts/daily-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openNow, searchPlace, setUnits } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  daily-check.mjs: mocked only (zones, missing-daily and 429 answers are the mock\'s)')
  process.exit(3)
}
assertBudget('daily-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/daily'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

async function session(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'], locale: 'en-US' })
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'daily-check.mjs (mock)')
  const forecastCalls = []
  globalThis.__qaMockedRequest = (url) => { if (/api\.open-meteo\.com\/v1\/forecast/.test(url)) forecastCalls.push(url) }
  await installMocks(ctx, opts)
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(200) } return false }
  await until(() => ['ready', 'error'].includes(window.__store?.get().conditions.state))
  await page.waitForTimeout(400)
  return { ctx, page, done, forecastCalls, until }
}
const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.now-card.daily .day-rows li')].map((li) => ({
      date: li.dataset.date,
      name: li.querySelector('.day-name')?.textContent ?? '',
      icon: li.querySelector('.day-i')?.textContent?.trim() ?? '',
      hl: li.querySelector('.day-hl')?.textContent ?? '',
      p: li.querySelector('.day-p')?.textContent ?? '',
      amt: li.querySelector('.day-amt')?.textContent ?? '',
      h: Math.round(li.getBoundingClientRect().height),
    })),
  )
const localDate = (tz, at = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10) }
const weekday = (ymd) => new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(new Date(ymd + 'T00:00:00Z'))

// ---- 1. Seven rows from one call; a place change refreshes them with one more call.
{
  const { ctx, page, done, forecastCalls, until } = await session()
  const r = await rows(page)
  check('Now shows a "Next 7 days" card with 7 rows', r.length === 7, `${r.length} rows`)
  check('Every row has a day name, an icon, a high / low and a chance', r.every((x) => x.name && x.icon && /°/.test(x.hl) && /%/.test(x.p)), r.slice(0, 2).map((x) => `${x.name} ${x.icon} ${x.hl} ${x.p} ${x.amt}`).join(' | '))
  check('Rows are compact (≤ 40 px each on a phone)', r.every((x) => x.h <= 40), `heights ${r.map((x) => x.h).join(',')}`)
  const dailyUrl = forecastCalls.find((u) => /daily=/.test(u))
  check('The daily block rides on the conditions request: exactly one Open-Meteo forecast call on load, and it carries daily= with forecast_days=7 and timezone=auto', forecastCalls.length === 1 && !!dailyUrl && /forecast_days=7/.test(dailyUrl) && /timezone=auto/.test(dailyUrl), `${forecastCalls.length} call(s)`)
  const vars = dailyUrl?.match(/daily=([^&]+)/)?.[1].split(',') ?? []
  check('Daily variables are the documented names', ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'precipitation_probability_max'].every((v) => vars.includes(v)), vars.join(','))
  await page.screenshot({ path: `${OUT}/seven-days.png`, fullPage: true })
  const before = await page.evaluate(() => window.__store.get().place?.name)
  await searchPlace(page, 'Iowa City')
  await page.waitForTimeout(800)
  await page.getByRole('dialog').getByRole('option').first().click()
  await until(() => { const s = window.__store.get(); return s.place?.name !== undefined && s.conditions.state === 'ready' && s.conditions.data && Math.abs(s.conditions.data.lngLat.lat - 41.66) < 0.2 }, 15000)
  await page.waitForTimeout(400)
  const r2 = await rows(page)
  const after = await page.evaluate(() => ({ name: window.__store.get().place?.name, state: window.__store.get().conditions.state }))
  check('Place change: the card refreshes for the new place with one more forecast call (still no separate daily request)', r2.length === 7 && forecastCalls.length === 2, `${before} → ${after.name} (${after.state}): ${forecastCalls.length} calls, ${r2.length} rows`)
  done()
  await ctx.close()
}

// ---- 2. Day labels across midnight in the place's zone.
{
  const utcDate = new Date().toISOString().slice(0, 10)
  const tz = ['Pacific/Kiritimati', 'Pacific/Auckland', 'Asia/Tokyo', 'Pacific/Pago_Pago', 'America/Los_Angeles'].find((z) => localDate(z) !== utcDate)
  const { ctx, page, done } = await session({ timezone: tz })
  const r = await rows(page)
  const today = localDate(tz)
  check(`Zone ${tz} (local date ${today} ≠ UTC date ${utcDate}): first row is Today and is the LOCAL date`, r[0]?.name === 'Today' && r[0]?.date === today, `${r[0]?.name} ${r[0]?.date}`)
  check('Second row is Tomorrow (local date + 1)', r[1]?.name === 'Tomorrow' && r[1]?.date === addDays(today, 1), `${r[1]?.name} ${r[1]?.date}`)
  check('Third row is the weekday of local date + 2, rows continue daily', r[2]?.name === weekday(addDays(today, 2)) && r.every((x, i) => x.date === addDays(today, i)), `${r[2]?.name} ${r[2]?.date} (expected ${weekday(addDays(today, 2))})`)
  const note = await page.locator('.now-card.daily small').innerText().catch(() => '')
  check('The card says which zone the days are in', note.includes(tz.replace(/_/g, ' ')), note)
  await page.screenshot({ path: `${OUT}/across-midnight.png`, fullPage: true })
  done()
  await ctx.close()
}

// ---- 3. Units.
{
  const { ctx, page, done } = await session()
  await setUnits(page, 'Imperial')
  await openNow(page)
  await page.waitForTimeout(300)
  const imp = await rows(page)
  await setUnits(page, 'Metric')
  await openNow(page)
  await page.waitForTimeout(300)
  const met = await rows(page)
  const impAmt = imp.map((x) => x.amt).filter(Boolean)
  const metAmt = met.map((x) => x.amt).filter(Boolean)
  check('Imperial: highs / lows in °F; amounts in inches', imp.length === 7 && imp.every((x) => /°F/.test(x.hl)) && impAmt.every((a) => / in$/.test(a)), `${imp[0]?.hl} · amounts ${impAmt.join(', ') || 'none above a trace'}`)
  check('Metric: highs / lows in °C; amounts in mm', met.length === 7 && met.every((x) => /°C/.test(x.hl)) && metAmt.every((a) => / mm$/.test(a)), `${met[0]?.hl} · amounts ${metAmt.join(', ') || 'none above a trace'}`)
  check('Amounts appear only above a trace, and the same days show one in both unit systems', impAmt.length === metAmt.length, `${impAmt.length} vs ${metAmt.length} days with an amount`)
  done()
  await ctx.close()
}

// ---- 4. Error states.
{
  const { ctx, page, done } = await session({ omitDaily: true })
  const daily = await page.locator('.now-card.daily').innerText().catch(() => '')
  const cond = await page.locator('.now-card.conditions').innerText().catch(() => '')
  check('Response without a daily block: the 7-day card shows its own unavailable state with Retry', /7-day forecast unavailable/.test(daily) && /Retry/.test(daily) && (await page.locator('.now-card.daily .day-rows li').count()) === 0, daily.split('\n').slice(0, 2).join(' | '))
  check('…while the conditions card still shows a temperature (one failing tile does not break the others)', /°/.test(cond), cond.split('\n').slice(0, 2).join(' | '))
  await page.screenshot({ path: `${OUT}/no-daily.png`, fullPage: true })
  done()
  await ctx.close()
}
{
  const { ctx, page, done } = await session({ failHosts: ['api.open-meteo.com'] })
  const daily = await page.locator('.now-card.daily').innerText().catch(() => '')
  const alerts = await page.locator('.now-card.alerts').innerText().catch(() => '')
  // The card mirrors the conditions card: both retrying skeletons while a 429 is retried, or both error text with Retry.
  const st = await page.evaluate(() => {
    const kind = (sel) => { const el = document.querySelector(sel); return !el ? 'missing' : el.querySelector('.err-text') ? 'error' : el.querySelector('.skeleton') ? 'loading' : 'data' }
    return { cond: kind('.now-card.conditions'), daily: kind('.now-card.daily'), state: window.__store.get().conditions.state, err: window.__store.get().conditions.error }
  })
  check(`Open-Meteo down (429): the 7-day card is in the same state as the conditions card (${st.cond}; store ${st.state}${st.err ? ': ' + String(st.err).slice(0, 50) : ''})`, st.daily === st.cond && st.cond !== 'data' && (st.cond !== 'error' || (/7-day forecast unavailable/.test(daily) && /Retry/.test(daily))), `daily card: ${st.daily} · ${daily.split('\n').slice(0, 2).join(' | ')}`)
  check('…and the alerts card (NWS) still renders', alerts.length > 0 && !/unavailable —/.test(alerts), alerts.split('\n')[0])
  const errs = await page.evaluate(() => [...document.querySelectorAll('.error-boundary, .panel-error')].length)
  check('No error boundary tripped', errs === 0)
  await page.screenshot({ path: `${OUT}/open-meteo-down.png`, fullPage: true })
  done()
  await ctx.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
