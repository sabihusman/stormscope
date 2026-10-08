// Units follow the Settings choice everywhere a number is shown: Now (temperature, wind, gusts, rain),
// the Map point chip + details, Trip (strip temperatures, gusts, distances, precipitation) and
// More (station pressure/wind/precip, river stage). Screenshots the Trip page in both systems.
// --mock answers every API locally (zero live calls).
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { openMap, openMore, openNow, openRivers, openTrip, pageText, setUnits, sheetText, tripText } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
assertBudget(`units-check.mjs${MOCK ? ' (mock)' : ''}`)
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/units'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
const page = await ctx.newPage()
const done = trackOpenMeteo(page, `units-check.mjs${MOCK ? ' (mock)' : ''}`)
if (MOCK) await installMocks(ctx, {})
await page.goto(BASE, { waitUntil: 'load' })
const until = async (fn, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(250) } return false }
await until(() => window.__store?.get().conditions.state === 'ready' && window.__store.get().station.state === 'ready')

// Set up a trip once; both unit passes read the same data.
await openTrip(page)
await page.getByRole('searchbox', { name: 'Destination' }).fill('Iowa City')
await page.waitForTimeout(MOCK ? 1000 : 2500)
await page.getByRole('dialog').getByRole('option').first().click().catch(async () => page.getByRole('option').first().click())
await until(() => { const j = window.__store.get().journey; return j.weather.state === 'ready' && j.road.state === 'ready' }, 120000)

const SYSTEMS = {
  Imperial: { temp: /°F/, speed: /\bmph\b/, precip: /\bin\b/, dist: /\b(mi|ft)\b/, pressure: /inHg/, stage: /\bft\b/, wrong: /°C|km\/h|\bmm\b|\bkm\b|hPa/ },
  Metric: { temp: /°C/, speed: /km\/h/, precip: /\bmm\b/, dist: /\b(km|m)\b/, pressure: /hPa/, stage: /\bm\b/, wrong: /°F|\bmph\b|\bin\b|\bmi\b|inHg/ },
}
for (const [sys, u] of Object.entries(SYSTEMS)) {
  await setUnits(page, sys)
  // Now
  await openNow(page)
  await page.waitForTimeout(500)
  const now = await page.locator('.screen.now').innerText()
  const condText = await page.locator('.conditions').innerText()
  const hourly = await page.locator('.hourly').innerText()
  check(`[${sys}] Now: temperature, wind and rain in ${sys} units; nothing in the other system`, u.temp.test(condText) && u.speed.test(condText) && u.temp.test(hourly) && u.precip.test(hourly + now) && !u.wrong.test(condText) && !u.wrong.test(hourly), `${condText.split('\n').slice(0, 3).join(' | ')} · ${hourly.match(/Rain next 24 h[^\n]*/)?.[0] ?? ''}`)
  await page.screenshot({ path: `${OUT}/now-${sys.toLowerCase()}.png` })
  // Map chip + details
  await openMap(page)
  await page.evaluate(() => { window.__store.set({ selection: null, sheet: 'peek' }); window.__map.jumpTo({ center: [-93.6, 41.6], zoom: 10 }) })
  await page.waitForTimeout(1200)
  await page.mouse.click(195, 300)
  await until(() => /°/.test(document.querySelector('.point-chip')?.innerText ?? ''), 20000)
  const chip = await page.locator('.point-chip').innerText()
  await page.getByRole('button', { name: 'Details' }).click()
  await until(() => /next 24 h/i.test(document.querySelector('.sheet-body')?.innerText ?? ''), 15000)
  const details = await sheetText(page)
  check(`[${sys}] Map chip + details: temperature, wind, rain and distance in ${sys} units`, u.temp.test(chip) && u.speed.test(chip) && u.precip.test(chip) && u.dist.test(chip) && !u.wrong.test(chip) && u.temp.test(details) && !u.wrong.test(details), chip.replace(/\n/g, ' | '))
  await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' }))
  // Trip
  await openTrip(page)
  await page.waitForTimeout(600)
  const trip = await tripText(page)
  const strip = await page.locator('.journey-strip').innerText().catch(() => '')
  const summary = await page.locator('.route-summary').innerText().catch(() => '')
  const arrival = await page.locator('.arrival-card').innerText().catch(() => '')
  check(`[${sys}] Trip: route distance, strip temperatures/gusts/precip, arrival card in ${sys} units; no km/h or °C mix`, u.dist.test(summary) && u.temp.test(strip) && u.temp.test(arrival) && u.dist.test(strip) && !u.wrong.test(strip) && !u.wrong.test(arrival) && !u.wrong.test(summary), `${summary.split('\n')[0]} · ${arrival.replace(/\n/g, ' | ')} · ${strip.split('\n').slice(0, 2).join(' | ')}`)
  // Lines that carry a gust *value*; the unit-free hazard label "Damaging gusts" / "Gusty" has none by design.
  const gustLines = trip.split('\n').filter((l) => /gusts\s*\d/i.test(l))
  check(`[${sys}] Trip: every gust value uses ${sys} units`, gustLines.length === 0 || gustLines.every((l) => u.speed.test(l) && !u.wrong.test(l)), gustLines.slice(0, 2).join(' | ') || 'no gust lines on this trip')
  await page.locator('.screen.trip').evaluate((el) => el.scrollTo(0, 0))
  await page.screenshot({ path: `${OUT}/trip-${sys.toLowerCase()}.png`, fullPage: false })
  // More: station + rivers
  await openMore(page, 'Station observations')
  await page.waitForTimeout(400)
  const station = await pageText(page)
  check(`[${sys}] Station: pressure, temperature, wind and precip totals in ${sys} units`, u.pressure.test(station) && u.temp.test(station) && (u.speed.test(station) || /Calm/.test(station)) && !u.wrong.test(station), station.match(/[\d.]+ (°F|°C|mph|km\/h|inHg|hPa|in|mm)\b/g)?.slice(0, 6).join(' · '))
  await openRivers(page)
  const rivers = await pageText(page)
  check(`[${sys}] Rivers: stage and distance in ${sys} units`, u.stage.test(rivers.match(/Stage [\d.]+ \S+/)?.[0] ?? '') && u.dist.test(rivers) && !new RegExp(sys === 'Imperial' ? 'Stage [\\d.]+ m\\b' : 'Stage [\\d.]+ ft').test(rivers), rivers.match(/Stage [^\n]*/)?.[0])
}
done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
