// Place search as a user types it (Change place › Search), mocked only, with the geocoders answering as the live
// ones did on Oct 22, 2026: "Chicago" offers Chicago, Illinois first and no unrelated town (Willard OH, Craigmont ID,
// Saint Francis KY came from Open-Meteo's alternate names); "Des Monies" still offers Des Moines, Iowa (Nominatim
// answered only a hotel); a nonsense string says "No places found"; no hotel, business or street address anywhere.
//   node scripts/search-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, searchPlace } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  search-check.mjs: mocked only (the geocoders answer as they did live on Oct 22, 2026)')
  process.exit(3)
}
assertBudget('search-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/search'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
const page = await ctx.newPage()
const done = trackTraffic(page, 'search-check.mjs (mock)')
await installMocks(ctx, {})
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(150) } return false }
await until(() => window.__store?.get().conditions.state === 'ready')
/** Type a query into the picker's search box and read what it offers (options, or the message). */
const search = async (q) => {
  const box = page.getByRole('dialog').getByRole('searchbox')
  if (await box.count()) {
    // Clear the previous query first: under two characters the list empties, so nothing stale is read.
    await box.fill('')
    await until(() => !document.querySelector('[role=dialog] [role=listbox][aria-label="Search results"]'), 3000)
    await box.fill(q)
  } else await searchPlace(page, q)
  await until(() => { const d = document.querySelector('[role=dialog]'); const t = d?.innerText ?? ''; return !/Searching…/.test(t) && (d?.querySelectorAll('[role=listbox][aria-label="Search results"] [role=option]').length > 0 || /No places found|Search failed/.test(t)) }, 10000)
  await page.waitForTimeout(200)
  // The row's text without its "Best match" tag (the tag is read separately).
  const options = await page.evaluate(() => [...document.querySelectorAll('[role=dialog] [role=listbox][aria-label="Search results"] [role=option]')].map((li) => { const tag = li.querySelector('.tag'); const txt = tag ? li.innerText.replace(tag.innerText, '') : li.innerText; return txt.replace(/\n+/g, ', ').replace(/, ,/g, ',').trim() }))
  const msg = await page.evaluate(() => document.querySelector('[role=dialog] [role=listbox][aria-label="Search results"] li.muted')?.innerText ?? '')
  return { options, msg }
}
const chicago = await search('Chicago')
check('"Chicago": Chicago, Illinois is the first result', /^Chicago, Illinois/.test(chicago.options[0] ?? ''), chicago.options.join(' | ') || chicago.msg)
check('"Chicago": no unrelated town (Willard OH, Craigmont ID, Saint Francis KY)', chicago.options.length > 0 && !chicago.options.some((o) => /Willard|Craigmont|Saint Francis/.test(o)), chicago.options.join(' | '))
// Redesign 4: exact-name matches first (Chicago, Illinois then Chicago, Guatemala), then the other names (Chicago Heights, North Chicago); every row carries state or region and country.
const exactFirst = chicago.options.map((o) => o.split(', ')[0])
check('"Chicago": the places named exactly Chicago come first, biggest first, then the other names', exactFirst.slice(0, 2).every((n) => n === 'Chicago') && /^Chicago, Illinois/.test(chicago.options[0]) && /Guatemala/.test(chicago.options[1]) && exactFirst.slice(2).every((n) => n !== 'Chicago'), chicago.options.join(' | '))
check('Every result row shows a state or region and a country', chicago.options.every((o) => o.split(', ').length >= 3), chicago.options.join(' | '))
await page.screenshot({ path: `${OUT}/chicago.png` })
const des = await search('Des Monies')
check('"Des Monies" (misspelt) offers Des Moines, Iowa', des.options.some((o) => /^Des Moines, Iowa/.test(o)), des.options.join(' | ') || des.msg)
const dsm = await search('Des Moines')
check('"Des Moines": the exact match first, West Des Moines after it, every row with state and country', /^Des Moines, Iowa, United States/.test(dsm.options[0] ?? '') && dsm.options.some((o) => /^West Des Moines/.test(o)) && dsm.options.every((o) => o.split(', ').length >= 3), dsm.options.join(' | '))
check('"Des Monies": no hotel, business or street address among the results', des.options.length > 0 && !des.options.some((o) => /Hotel|Suites|Drive|Street|Road|\d{3,}/i.test(o)), des.options.join(' | '))
await page.screenshot({ path: `${OUT}/des-monies.png` })
const none = await search('xqzv plork')
check('A nonsense string gets an honest empty state ("No exact match for “…”. Try a city or town name — this list is never filled with unrelated places.")', none.options.length === 0 && /^No exact match for “xqzv plork”\. Try a city or town name/.test(none.msg), none.msg || none.options.join(' | '))
// Mockup A3: the exact first match carries a "Best match" tag and the list says exact matches come first.
const tagged = await search('Chicago')
const tagInfo = await page.evaluate(() => ({ tags: [...document.querySelectorAll('[role=dialog] [role=listbox][aria-label="Search results"] .tag.best')].map((t) => t.closest('[role=option]').innerText.split('\n')[0]), head: document.querySelector('[role=dialog] .results-head')?.textContent ?? ''}))
check('"Chicago": the first result carries a "Best match" tag and only it; the list is headed "Exact matches for “Chicago” first"', tagInfo.tags.length === 1 && /^Chicago/.test(tagInfo.tags[0]) && /^Exact matches for “Chicago” first$/.test(tagInfo.head) && tagged.options.length > 1, `tags ${JSON.stringify(tagInfo.tags)}, head "${tagInfo.head}"`)
done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
