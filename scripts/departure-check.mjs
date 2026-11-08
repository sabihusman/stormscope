// Trip departure (H5) and night icons on a trip (M2) and road-sensor units (M10), mocked, under a fixed clock:
// the app is opened at 21:00, eleven minutes pass (the page clock, not the state), then a trip Johnston → Ames is
// planned through the UI without touching the departure options — it must leave now (21:11), not at 21:00.
//   node scripts/departure-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openTrip, setUnits } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  departure-check.mjs: mocked only (fixed clock; routing is mocked)')
  process.exit(3)
}
assertBudget('departure-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/departure'
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
const T0 = (() => { const d = new Date(); d.setHours(21, 0, 0, 0); return d.getTime() })()
await page.clock.install({ time: T0 })
const done = trackTraffic(page, 'departure-check.mjs (mock)')
await installMocks(ctx, { now: T0 })
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(150) } return false }
await until(() => window.__store?.get().conditions.state === 'ready')
// Eleven minutes pass with the app open.
await page.clock.runFor(11 * 60_000)
await page.waitForTimeout(300)
const nowMs = await page.evaluate(() => Date.now())
// (The installed clock also runs with real time while the app loads — a slow preview adds a few seconds — so a minute's tolerance.)
check('The page clock is about 21:11 (eleven minutes after the app was opened)', Math.abs(nowMs - (T0 + 11 * 60_000)) < 60_000, new Date(nowMs).toTimeString().slice(0, 8))
// Plan a trip through the UI, departure options untouched.
await openTrip(page)
await page.getByRole('searchbox', { name: 'Destination' }).fill('Ames')
await page.waitForTimeout(700)
await page.getByRole('option').first().tap()
await until(() => window.__store.get().journey.weather.state === 'ready', 40000)
await page.waitForTimeout(500)
const trip = await page.evaluate(() => {
  const j = window.__store.get().journey
  const chips = [...document.querySelectorAll('.journey [role="radio"], .screen.trip [role="radio"]')].map((b) => ({ label: b.textContent.trim(), on: b.getAttribute('aria-checked') }))
  const first = j.weather.data?.samples[0]
  const route = j.routes.data?.routes[j.selected]
  const last = j.weather.data?.samples[j.weather.data.samples.length - 1]
  return { departure: j.departure, chips, firstEta: first?.eta ?? null, lastEta: last?.eta ?? null, durationS: route?.durationS ?? null, arrivalCard: document.querySelector('.arrival-card')?.textContent ?? '', text: document.querySelector('.screen.trip')?.innerText.replace(/\n/g, ' | ').slice(0, 400) ?? '' }
})
const nowChip = trip.chips.find((c) => c.label === 'Now')
check('The departure is "now" at planning time: the Now chip is selected and the first stop\'s ETA is 21:11 (±2 min), not the 21:00 the app was opened at', nowChip?.on === 'true' && trip.firstEta != null && Math.abs(trip.firstEta - nowMs) < 2 * 60_000, `Now chip ${nowChip?.on}; first ETA ${trip.firstEta ? new Date(trip.firstEta).toTimeString().slice(0, 5) : 'none'} vs now ${new Date(nowMs).toTimeString().slice(0, 5)}`)
check('The arrival (the last stop\'s ETA on the arrival card) is now + the route duration (within 2 min)', !!trip.durationS && trip.lastEta != null && Math.abs(trip.lastEta - (nowMs + trip.durationS * 1000)) < 2 * 60_000 && /Arrive/.test(trip.arrivalCard), `last ETA ${trip.lastEta ? new Date(trip.lastEta).toTimeString().slice(0, 5) : 'none'}, now + ${Math.round((trip.durationS ?? 0) / 60)} min = ${new Date(nowMs + (trip.durationS ?? 0) * 1000).toTimeString().slice(0, 5)}; card "${trip.arrivalCard.slice(0, 30)}"`)
// Redesign 9: the timeline is anchored to the departure. Pick +1 h: at once (before the forecast refetch lands) and
// after it, the first stop reads the departure time and the last stop the arrival card's time; the footer counts honestly;
// sensors without a reading collapse into one line.
await page.getByRole('radio', { name: '+1 h' }).tap()
await page.waitForTimeout(250)
const stripTimes = () => page.evaluate(() => ({ strip: [...document.querySelectorAll('.journey-strip .strip-time')].map((el) => el.textContent.trim()), arrival: document.querySelector('.arrival-card strong')?.textContent.trim() ?? '', departure: window.__store.get().journey.departure, loading: window.__store.get().journey.weather.state === 'loading', note: document.querySelector('.trip-refreshing')?.textContent ?? '' }))
const clockOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const t1 = await stripTimes()
const dep1 = t1.departure
check(`+1 h picked: the first stop reads the departure time (${clockOf(dep1)}) and the last stop the arrival card's time, straight away${t1.loading ? ' (forecast still refreshing, note shown)' : ''}`, t1.strip[0] === clockOf(dep1) && t1.arrival.endsWith(t1.strip[t1.strip.length - 1]) && (!t1.loading || /Updating the forecast for the new departure/.test(t1.note)), `strip ${t1.strip[0]} … ${t1.strip.at(-1)}, card "${t1.arrival}", loading ${t1.loading}`)
await until(() => window.__store.get().journey.weather.state === 'ready' && window.__store.get().journey.weather.data?.departureMs === window.__store.get().journey.departure, 40000)
await page.waitForTimeout(400)
const t2 = await stripTimes()
// Mockup A8: the resolved departure is written out beside the chips.
const leave = await page.locator('.leave-line').innerText()
check('The trip states its departure: "Leave · +1 h · <day clock>"', /^Leave · \+1 h · /.test(leave) && leave.includes(new Date(dep1).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), `"${leave}"`)
check('Once the refreshed forecast lands the timeline still runs departure → arrival and the note is gone', t2.strip[0] === clockOf(dep1) && t2.arrival.endsWith(t2.strip[t2.strip.length - 1]) && t2.note === '', `strip ${t2.strip[0]} … ${t2.strip.at(-1)}, card "${t2.arrival}"`)
const foot = await page.locator('.trip-foot').innerText()
const counts = await page.evaluate(() => ({ samples: window.__store.get().journey.weather.data.samples.length, shown: document.querySelectorAll('.journey-strip li').length }))
check('The footer counts honestly: "N sampled stops from M forecast points" when thinned, or "N stops, one forecast point each"', counts.samples > 14 ? new RegExp(`^${counts.shown} sampled stops from ${counts.samples} forecast points`).test(foot) : new RegExp(`^${counts.samples} stops, one forecast point each`).test(foot), `"${foot.slice(0, 80)}" (shown ${counts.shown}, points ${counts.samples})`)
const sensors = await page.evaluate(() => { const st = window.__store.get().journey.road.data?.stations ?? []; return { noObs: st.filter((x) => x.obsTime == null).length, chips: [...document.querySelectorAll('.station-chips li:not(.no-reading-line)')].map((li) => li.innerText.replace(/\n/g, ' ')), line: document.querySelector('.no-reading-line')?.innerText.replace(/\n/g, ' ') ?? '' } })
check('Sensors without a reading are one line, never chips alongside live readings; every chip has a reading', sensors.chips.every((c) => !/no observation/.test(c)) && (sensors.noObs === 0 ? sensors.line === '' : new RegExp(`^${sensors.noObs} sensors? without a reading`).test(sensors.line)), `${sensors.noObs} without a reading; line "${sensors.line.slice(0, 80)}"; ${sensors.chips.length} chips`)
// Keyboard: a forecast row opens from a real <button>; Enter on it opens that stop's details.
const rowBtn = await page.evaluate(() => { const b = document.querySelector('.journey-strip li .row-open'); return { tag: b?.tagName ?? '', label: b?.getAttribute('aria-label') ?? '' } })
await page.evaluate(() => window.__store.set({ selection: null }))
await page.locator('.journey-strip li .row-open').first().focus()
await page.keyboard.press('Enter')
await page.waitForTimeout(200)
const kbSel = await page.evaluate(() => window.__store.get().selection)
check('A forecast row is a <button>, and Enter on it opens that stop\'s details', rowBtn.tag === 'BUTTON' && /^Details at /.test(rowBtn.label) && !!kbSel, `${rowBtn.tag || 'no button'} "${rowBtn.label}"; selection ${kbSel ? `"${kbSel.title ?? kbSel.kind}"` : 'none'}`)
await page.evaluate(() => window.__store.set({ selection: null }))
await page.getByRole('radio', { name: 'Now' }).tap()
await until(() => window.__store.get().journey.weather.state === 'ready' && window.__store.get().journey.departure === null, 40000)
await page.waitForTimeout(300)
// M2 on the trip: at 21:11 the stops are at night — a clear stop shows a moon, never a sun.
const icons = await page.evaluate(() => [...document.querySelectorAll('.screen.trip li, .screen.trip .stop')].map((el) => el.textContent).filter((t) => /☀️|🌙/.test(t)))
check('Trip stops at night show 🌙 for clear skies, never ☀️', icons.length > 0 && icons.every((t) => !t.includes('☀️')) && icons.some((t) => t.includes('🌙')), `${icons.length} stop(s) with a sky icon; suns: ${icons.filter((t) => t.includes('☀️')).length}`)
// M10: road sensors in the app's units.
const roadF = await page.locator('.screen.trip').innerText().catch(() => '')
check('Imperial (default): pavement temperatures in °F', /pavement \d+ °F/.test(roadF), (roadF.match(/pavement [^,]*/) ?? ['no pavement line'])[0])
await setUnits(page, 'Metric')
await openTrip(page)
await page.waitForTimeout(500)
const roadC = await page.locator('.screen.trip').innerText().catch(() => '')
check('Metric: pavement temperatures in °C, no °F anywhere on the trip', /pavement -?\d+ °C/.test(roadC) && !/°F/.test(roadC), (roadC.match(/pavement [^,]*/) ?? ['no pavement line'])[0])
await page.screenshot({ path: `${OUT}/trip-metric.png` })
done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
