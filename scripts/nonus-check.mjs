// Outside-US fallbacks, live only (the mock geocoder answers every query with Iowa City): a postcode
// search through Nominatim, then at the result — Now says alerts are unavailable outside the US, the
// Station page is labelled as Open-Meteo, the Rivers page says US-only, the Flood page computes with
// terrain + rain only. Extracted from qa.mjs so the release pass can run just this part live.
// Cost: one place (1 Open-Meteo location + 1 block for the Flood page), one geocoder query, a few NWS 404s.
//   node scripts/nonus-check.mjs [base-url] [shots-dir]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { openMore, openRivers, pageText, searchPlace, settle } from './lib/ui.mjs'

const argv = process.argv.slice(2)
if (argv.includes('--mock')) {
  console.log('SKIP  nonus-check.mjs: live only (the mock geocoder has no non-US places)')
  process.exit(3)
}
assertBudget('nonus-check.mjs')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/nonus'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
// No geolocation grant: the search is the first place, so nothing is fetched for a US place first.
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
const done = trackTraffic(page, 'nonus-check.mjs')
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('dialog').getByRole('button', { name: /Search for a place/ }).click({ timeout: 5000 }).catch(() => {})
const box = page.getByRole('dialog').getByRole('searchbox')
if (await box.count()) await box.fill('SW1A 1AA')
else await searchPlace(page, 'SW1A 1AA')
await settle(page, 3000)
const opts = await page.getByRole('dialog').getByRole('option').count()
check('Postcode search returns results (Nominatim)', opts > 0, `${opts} results`)
await page.getByRole('dialog').getByRole('option').first().click()
await settle(page, 6000)
const nowLondon = await page.locator('.screen.now').innerText()
check('Non-US: Now says alerts are unavailable outside the US', /Alerts unavailable outside the US/.test(nowLondon))
await openMore(page, 'Station observations')
await settle(page, 1500)
check('Non-US: Open-Meteo fallback labelled honestly', /Open-Meteo/.test(await pageText(page)))
await openRivers(page)
check('Non-US: rivers page explains US-only coverage', /only available in the US/.test(await pageText(page)))
await openMore(page, 'Flood risk')
let floodText = ''
for (let i = 0; i < 90; i++) {
  floodText = await pageText(page)
  if (/terrain \+ rain only|not available here/.test(floodText)) break
  await settle(page, 1000)
}
check('Non-US: flood page computes for the place and falls back to terrain + rain', /terrain \+ rain only|not available here/.test(floodText) && /(^|\s)at /m.test(floodText), floodText.split('\n').slice(0, 3).join(' | '))
await page.screenshot({ path: `${OUT}/london-flood.png` })
done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
