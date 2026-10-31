// First visit (fresh profile: no saved place, empty storage, location not yet granted), mocked only:
// exactly one "Where are you?" prompt is visible on a phone and on a desktop (the dialog), the Now column's
// own card only after the dialog is dismissed; the default units follow the device's region (en-US → °F,
// en-CA → °C) and a Settings choice overrides that across a reload; More's "Forget my location and recent places"
// (with its confirm step) clears the saved place and the recents and brings the first-visit prompt back, leaving
// units and layers alone.
//   node scripts/firstrun-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, setUnits } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  firstrun-check.mjs: mocked only (fresh profiles, no live data needed)')
  process.exit(3)
}
assertBudget('firstrun-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/firstrun'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const VIEWPORTS = { phone: { width: 390, height: 844, isMobile: true, hasTouch: true }, desktop: { width: 1366, height: 800, isMobile: false, hasTouch: false } }
/** Visible "Where are you?" headings and where each one lives. */
const prompts = (page) => page.evaluate(() => [...document.querySelectorAll('h1, h2, h3')].filter((h) => h.textContent.trim() === 'Where are you?' && h.getClientRects().length > 0 && getComputedStyle(h).visibility !== 'hidden').map((h) => (h.closest('[role=dialog]') ? 'dialog' : h.closest('.screen.now') ? 'now-column' : 'elsewhere')))

// ---- 1. One prompt only on a first visit ----
for (const [name, vp] of Object.entries(VIEWPORTS)) {
  // A fresh browser profile: no storage, geolocation permission not yet decided (the browser would ask).
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch })
  const page = await ctx.newPage()
  const done = trackTraffic(page, `firstrun-check.mjs ${name} (mock)`)
  await installMocks(ctx, {})
  await page.goto(BASE, { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  const first = await prompts(page)
  check(`[${name}] first visit: exactly one "Where are you?" prompt is visible, and it is the dialog`, first.length === 1 && first[0] === 'dialog', `visible: ${JSON.stringify(first)}`)
  await page.screenshot({ path: `${OUT}/${name}-first-visit.png` })
  // Dismiss it by choosing Search, then close the picker: the Now column's own card is now the one prompt.
  await page.getByRole('dialog').getByRole('button', { name: 'Search for a place' }).click()
  await page.waitForTimeout(400)
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await page.waitForTimeout(400)
  const after = await prompts(page)
  check(`[${name}] after dismissing the dialog without a place: the Now column's card is the one prompt`, after.length === 1 && after[0] === 'now-column', `visible: ${JSON.stringify(after)}`)
  done()
  await ctx.close()
}

const untilReady = async (page) => { const t0 = Date.now(); while (Date.now() - t0 < 30000) { if (await page.evaluate(() => window.__store?.get().conditions.state === 'ready').catch(() => false)) return; await page.waitForTimeout(200) } }

// ---- Redesign 1. The first-run choice: a privacy sentence, "Save this place" off by default, close → empty state ----
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'firstrun-check.mjs first-run choice (mock)')
  await installMocks(ctx, {})
  await page.goto(BASE, { waitUntil: 'load' })
  await page.waitForTimeout(1200)
  const dlg = page.getByRole('dialog')
  const dlgText = await dlg.innerText()
  const toggle = dlg.getByRole('checkbox', { name: /Remember this place/ })
  check('[first-run] the choice screen offers the three ways in, says nothing is saved unless opted in, and its Save toggle is off', /Use my location/.test(dlgText) && /Search for a place/.test(dlgText) && /Pick a point on the map/.test(dlgText) && /Nothing is saved on this device unless you turn this on/.test(dlgText) && /No location access needed/.test(dlgText) && /Drop a pin anywhere/.test(dlgText) && (await toggle.count()) === 1 && !(await toggle.isChecked()), dlgText.replace(/\n/g, ' | ').slice(0, 200))
  await page.screenshot({ path: `${OUT}/first-run-choice.png` })
  // Close without choosing: the empty state with the same three options, no place, nothing stored.
  await dlg.getByRole('button', { name: 'Close' }).click()
  await page.waitForTimeout(400)
  const empty = await page.locator('.screen.now').innerText()
  const stored = await page.evaluate(() => ({ place: localStorage.getItem('stormscope.place'), storePlace: window.__store.get().place, temps: document.querySelectorAll('.cond-temp').length }))
  check('[first-run] closing it shows the empty state with the same three options — no default city, no place stored', (await page.getByRole('dialog').count()) === 0 && /Where are you\?/.test(empty) && /Use my location/.test(empty) && /Search for a place/.test(empty) && /Pick a point on the map/.test(empty) && stored.place === null && stored.storePlace === null && stored.temps === 0, `${JSON.stringify(stored)}; ${empty.replace(/\n/g, ' | ').slice(0, 120)}`)
  await page.screenshot({ path: `${OUT}/first-run-closed.png` })
  // Pick a place with the toggle off: shown now, not saved — a reload asks again.
  await page.getByRole('button', { name: /Search for a place/ }).click()
  await page.waitForTimeout(300)
  const pickerSearch = page.getByRole('dialog').getByRole('button', { name: /Search for a place/ })
  if (await pickerSearch.count()) await pickerSearch.click()
  await page.getByRole('dialog').getByRole('searchbox').fill('Ames')
  await page.waitForTimeout(800)
  await page.getByRole('dialog').getByRole('option').first().click()
  await untilReady(page)
  const notSaved = await page.evaluate(() => ({ place: window.__store.get().place?.name, key: localStorage.getItem('stormscope.place') }))
  check('[first-run] a place chosen with Save off is used now but not stored', /Ames/.test(notSaved.place ?? '') && notSaved.key === null, JSON.stringify(notSaved))
  await page.reload({ waitUntil: 'load' })
  await page.waitForTimeout(1200)
  check('[first-run] after a reload with Save off the app asks again (the choice screen), no remembered place', (await prompts(page)).length === 1 && (await page.evaluate(() => window.__store.get().place)) === null, `prompts ${JSON.stringify(await prompts(page))}`)
  // Turn Save on, choose again: stored, and back after a reload.
  await page.getByRole('dialog').getByRole('checkbox', { name: /Remember this place/ }).check()
  await page.getByRole('dialog').getByRole('button', { name: 'Search for a place' }).click()
  await page.getByRole('dialog').getByRole('searchbox').fill('Ames')
  await page.waitForTimeout(800)
  await page.getByRole('dialog').getByRole('option').first().click()
  await untilReady(page)
  await page.reload({ waitUntil: 'load' })
  await untilReady(page)
  check('[first-run] with Save on the chosen place is stored and back after a reload', /Ames/.test((await page.evaluate(() => window.__store.get().place?.name)) ?? '') && (await page.evaluate(() => localStorage.getItem('stormscope.savePlace'))) === '1', await page.evaluate(() => window.__store.get().place?.name ?? 'none'))
  done()
  await ctx.close()
}

// ---- 10. Default units follow the device's region; a Settings choice overrides it and is remembered ----
const GEO = { geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] }
for (const [locale, want] of [['en-US', { sym: '°F', units: 'imperial' }], ['en-CA', { sym: '°C', units: 'metric' }]]) {
  const ctx = await browser.newContext({ ...VIEWPORTS.phone, viewport: { width: 390, height: 844 }, ...GEO, locale })
  const page = await ctx.newPage()
  const done = trackTraffic(page, `firstrun-check.mjs units ${locale} (mock)`)
  await installMocks(ctx, {})
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  await untilReady(page)
  const temp = await page.locator('.cond-temp').innerText()
  const units = await page.evaluate(() => window.__store.get().units)
  check(`[${locale}] fresh profile: the temperature reads in ${want.sym} (${want.units})`, temp.includes(want.sym) && units === want.units, `"${temp}", units ${units}, navigator.language ${await page.evaluate(() => navigator.language)}`)
  if (locale === 'en-US') {
    // Mockup A1: the Now hero — a date stamp in the place's zone, a large temperature, and one summary line that follows the data.
    const hero = await page.evaluate(() => ({ stamp: document.querySelector('.cond-stamp')?.textContent ?? '', tempPx: parseFloat(getComputedStyle(document.querySelector('.cond-temp')).fontSize), summary: document.querySelector('.now-summary')?.textContent ?? '', cls: document.querySelector('.now-summary')?.className ?? '', rain24: window.__store.get().conditions.data.hourly.slice(0, 24).reduce((a, x) => a + (x.precipMm ?? 0), 0), alerts: window.__store.get().alerts.data?.alerts.length ?? 0 }))
    const expectAmber = hero.alerts > 0 || hero.rain24 >= 1
    check('[en-US] Now hero: "Now · <day, date, time>" stamp, the temperature at 56 px, and a summary line (alerts, else rain next 24 h, else all clear) matching the forecast', /^Now · \w{3},? /.test(hero.stamp) && hero.tempPx >= 56 && (expectAmber ? /amber/.test(hero.cls) && (hero.alerts > 0 ? /active NWS alert/.test(hero.summary) : /Rain coming/.test(hero.summary)) : /green/.test(hero.cls) && /All clear for now/.test(hero.summary)), `${hero.stamp} | ${hero.tempPx}px | "${hero.summary}" (rain24 ${hero.rain24.toFixed(1)} mm, alerts ${hero.alerts})`)
    // Redesign 10: clearly labelled entry points on Now (no generic "More"), and "Map layers" opens the Map with the panel open.
    const tileLabels = await page.evaluate(() => [...document.querySelectorAll('.tiles .tile > small:first-child')].map((el) => el.textContent.trim()))
    check('[en-US] the Now screen names its entry points: River gauges, Flood risk, Station observations, Map layers, Settings & data sources', tileLabels.join(' | ') === '📈 River gauges | 🌊 Flood risk | 🌡 Station observations | 🗺 Map layers | ⚙ Settings & data sources', tileLabels.join(' | '))
    await page.locator('.tiles').scrollIntoViewIfNeeded()
    await page.getByRole('button', { name: /Map layers/ }).click()
    await page.waitForTimeout(600)
    check('[en-US] "Map layers" opens the Map with the layers panel open', (await page.evaluate(() => window.__store.get().screen)) === 'map' && (await page.locator('.fab-menu').count()) === 1 && (await page.locator('.fab-menu').isVisible()), `screen ${await page.evaluate(() => window.__store.get().screen)}, menu ${await page.locator('.fab-menu').count()}`)
    await page.locator('.fab-main').click()
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: /^Now/ }).click()
    await page.waitForTimeout(300)
    // Redesign 3: one tap on the Now screen's °C / °F chip flips every number — conditions, the hourly rain line,
    // the rain legend scale and the map scale bar — with no new request; the choice survives a reload.
    const chip = page.locator('.screen.now .units-chip')
    check('[en-US] the Now screen carries a °C / °F chip with °F selected', (await chip.count()) === 1 && (await chip.getByRole('radio', { name: '°F' }).getAttribute('aria-checked')) === 'true')
    await chip.getByRole('radio', { name: '°C' }).click()
    await page.waitForTimeout(400)
    await page.evaluate(() => window.__store.set((s) => ({ layers: { ...s.layers, rainfall: true } })))
    await page.waitForTimeout(600)
    const after = await page.evaluate(() => ({ temp: document.querySelector('.cond-temp')?.innerText, rainLine: document.querySelector('.hourly')?.innerText.match(/Rain next[^\n]*/)?.[0] ?? '', scale: document.querySelector('.maplibregl-ctrl-scale')?.innerText ?? '', units: window.__store.get().units }))
    await page.getByRole('button', { name: 'Map', exact: true }).click()
    await page.waitForTimeout(500)
    await page.locator('.fab-main').click()
    await page.waitForTimeout(400)
    const legend = await page.locator('.fab-menu .legend-rows').innerText().catch(() => '')
    check('[en-US] one tap on °C: temperature in °C, the hourly rain line in mm, the rain legend in mm and the scale bar in km', /°C/.test(after.temp ?? '') && /\bmm\b/.test(after.rainLine) && /\bkm\b|\bm\b/.test(after.scale) && /mm/.test(legend) && after.units === 'metric', `${JSON.stringify(after)}; legend "${legend.split('\n').slice(0, 2).join(' | ')}"`)
    await page.locator('.fab-main').click()
    await page.getByRole('button', { name: /^Now/ }).click()
    await page.reload({ waitUntil: 'load' })
    await untilReady(page)
    check('[en-US] the °C choice from the chip survives a reload and matches Settings', /°C/.test(await page.locator('.cond-temp').innerText()) && (await page.evaluate(() => window.__store.get().units)) === 'metric' && (await page.locator('.screen.now .units-chip').getByRole('radio', { name: '°C' }).getAttribute('aria-checked')) === 'true')
  }
  if (locale === 'en-CA') {
    // The user picks Imperial in Settings: it wins now and after a reload.
    await setUnits(page, 'Imperial')
    await page.reload({ waitUntil: 'load' })
    await untilReady(page)
    const after = await page.locator('.cond-temp').innerText()
    check('[en-CA] Imperial chosen in Settings overrides the region default and survives a reload', after.includes('°F') && (await page.evaluate(() => window.__store.get().units)) === 'imperial', `"${after}"`)
  }
  done()
  await ctx.close()
}

// ---- 8. Forget my location and recent places (More), with a confirm step ----
{
  // A returning user: saved place, recent places, Metric chosen, a layer choice — location permission not granted.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  // Seeded once (the init script also runs on the reload below; sessionStorage marks the first run).
  await ctx.addInitScript(() => {
    try {
      if (sessionStorage.getItem('seeded')) return
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem('stormscope.place', JSON.stringify({ name: 'Johnston, Iowa', lngLat: { lng: -93.698, lat: 41.673 }, source: 'search', label: 'Johnston, Iowa' }))
      localStorage.setItem('stormscope.recent', JSON.stringify([{ name: 'Johnston, Iowa', lngLat: { lng: -93.698, lat: 41.673 } }, { name: 'Ames, Iowa', lngLat: { lng: -93.632, lat: 42.031 } }]))
      localStorage.setItem('stormscope.geo.asked', '1')
      localStorage.setItem('stormscope.units', 'metric')
      localStorage.setItem('stormscope.layers', JSON.stringify({ radar: false, satellite: true, rainfall: false, flood: false, rivers: true, station: true, nowcast: false }))
    } catch {}
  })
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'firstrun-check.mjs forget (mock)')
  await installMocks(ctx, {})
  await page.goto(BASE, { waitUntil: 'load' })
  await untilReady(page)
  check('[forget] returning user: no prompt, the saved place and two recent places are back', (await prompts(page)).length === 0 && (await page.evaluate(() => window.__store.get().recentPlaces.length)) === 2, `recents ${await page.evaluate(() => JSON.stringify(window.__store.get().recentPlaces.map((r) => r.name)))}`)
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.waitForTimeout(300)
  const btn = page.getByRole('button', { name: 'Forget my location and recent places' })
  check('[forget] More has a "Forget my location and recent places" button', (await btn.count()) === 1)
  await btn.click()
  await page.waitForTimeout(200)
  const confirm = page.getByRole('button', { name: 'Forget', exact: true })
  check('[forget] pressing it asks to confirm first (Forget / Cancel), nothing forgotten yet', (await confirm.count()) === 1 && (await page.getByRole('button', { name: 'Cancel' }).count()) === 1 && (await page.evaluate(() => !!localStorage.getItem('stormscope.place'))), '')
  await page.screenshot({ path: `${OUT}/forget-confirm.png` })
  await confirm.click()
  await page.waitForTimeout(400)
  const cleared = await page.evaluate(() => ({ keys: ['stormscope.place', 'stormscope.recent', 'stormscope.geo.asked'].map((k) => localStorage.getItem(k)), screen: window.__store.get().screen, place: window.__store.get().place }))
  check('[forget] confirming clears the saved place, the recents and the first-run flag and returns to Now', cleared.keys.every((v) => v === null) && cleared.screen === 'now' && cleared.place === null, JSON.stringify(cleared))
  await page.reload({ waitUntil: 'load' })
  await page.waitForTimeout(1500)
  const after = await prompts(page)
  const state = await page.evaluate(() => ({ recents: window.__store.get().recentPlaces.length, place: window.__store.get().place, units: window.__store.get().units, layers: window.__store.get().layers, keys: ['stormscope.place', 'stormscope.recent', 'stormscope.geo.asked'].map((k) => localStorage.getItem(k)) }))
  check('[forget] after confirming and reloading: the first-visit prompt shows and the recent list is empty', after.length === 1 && after[0] === 'dialog' && state.recents === 0 && state.place === null && state.keys.every((v) => v === null), `prompts ${JSON.stringify(after)}, recents ${state.recents}, keys ${JSON.stringify(state.keys)}`)
  check('[forget] units and layers are unchanged (Metric, satellite on)', state.units === 'metric' && state.layers.satellite === true && state.layers.radar === false, `units ${state.units}, layers ${JSON.stringify(state.layers)}`)
  await page.screenshot({ path: `${OUT}/forget-after.png` })
  done()
  await ctx.close()
}

// ---- Redesign 2. Forget in Settings and in the picker; per-item removal of recents; search with location denied ----
{
  // Location denied by the browser; a saved place and three recents.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await ctx.addInitScript(() => {
    try {
      if (sessionStorage.getItem('seeded')) return
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem('stormscope.place', JSON.stringify({ name: 'Johnston, Iowa', lngLat: { lng: -93.698, lat: 41.673 }, source: 'search', label: 'Johnston, Iowa' }))
      localStorage.setItem('stormscope.recent', JSON.stringify([{ name: 'Johnston, Iowa', lngLat: { lng: -93.698, lat: 41.673 } }, { name: 'Ames, Iowa', lngLat: { lng: -93.632, lat: 42.031 } }, { name: 'Cedar Rapids, Iowa', lngLat: { lng: -91.666, lat: 41.978 } }]))
      localStorage.setItem('stormscope.geo.asked', '1')
    } catch {}
    // The browser denies location.
    navigator.geolocation.getCurrentPosition = (_ok, err) => err && err({ code: 1, PERMISSION_DENIED: 1, TIMEOUT: 3, message: 'denied' })
  })
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'firstrun-check.mjs privacy (mock)')
  await installMocks(ctx, {})
  await page.goto(BASE, { waitUntil: 'load' })
  await untilReady(page)
  // Per-item removal in the picker: × on Ames removes Ames only.
  await page.getByRole('button', { name: 'Change place' }).first().click()
  await page.waitForTimeout(300)
  const before = await page.evaluate(() => window.__store.get().recentPlaces.map((r) => r.name))
  await page.getByRole('dialog').getByRole('button', { name: 'Remove Ames from recent places' }).click()
  await page.waitForTimeout(200)
  const afterX = await page.evaluate(() => ({ recents: window.__store.get().recentPlaces.map((r) => r.name), stored: JSON.parse(localStorage.getItem('stormscope.recent') ?? '[]').map((r) => r.name), chips: [...document.querySelectorAll('[role=dialog] .chip-main')].map((b) => b.textContent.trim()) }))
  check('[privacy] × on a recent entry in the picker removes that entry only (store, storage and the chips agree)', before.length === 3 && afterX.recents.join() === 'Johnston, Iowa,Cedar Rapids, Iowa' && afterX.stored.join() === afterX.recents.join() && afterX.chips.join() === 'Johnston,Cedar Rapids', JSON.stringify(afterX))
  // The same × in the search box's recent list (the Trip destination search uses the same box).
  await page.getByRole('dialog').getByRole('button', { name: /Search for a place/ }).click()
  await page.waitForTimeout(200)
  await page.getByRole('dialog').getByRole('button', { name: 'Remove Cedar Rapids from recent places' }).click()
  await page.waitForTimeout(200)
  check('[privacy] × in the search box\'s recent list removes that entry only', (await page.evaluate(() => window.__store.get().recentPlaces.map((r) => r.name).join())) === 'Johnston, Iowa', await page.evaluate(() => window.__store.get().recentPlaces.map((r) => r.name).join()))
  // Search still works with location denied.
  await page.getByRole('dialog').getByRole('searchbox').fill('Ames')
  await page.waitForTimeout(800)
  await page.getByRole('dialog').getByRole('option').first().click()
  await untilReady(page)
  check('[privacy] manual search sets a place while location is denied', /Ames/.test((await page.evaluate(() => window.__store.get().place?.name)) ?? ''), await page.evaluate(() => window.__store.get().place?.name ?? 'none'))
  await page.screenshot({ path: `${OUT}/privacy-search-denied.png` })
  // The picker has a Forget control; Settings has one too. Forget from Settings: storage empty and the first-run choice back at once.
  await page.getByRole('button', { name: 'Change place' }).first().click()
  await page.waitForTimeout(300)
  check('[privacy] the place picker offers "Forget my location and recent places"', (await page.getByRole('dialog').getByRole('button', { name: 'Forget my location and recent places' }).count()) === 1)
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /^Sources, freshness & settings/ }).click()
  await page.waitForTimeout(400)
  const settingsBtn = page.getByRole('button', { name: 'Forget my location and recent places' })
  check('[privacy] Settings offers "Forget my location and recent places"', (await settingsBtn.count()) === 1)
  // Mockup A7: Settings groups it all in a "Location & privacy" card — current place, the Remember toggle, Forget, the recents with Remove × and Clear all — and keys fetched vs observed on the sources list.
  const card = page.locator('.privacy-card')
  const cardText = (await card.innerText().catch(() => '')).replace(/\n/g, ' | ')
  check('[privacy] the "Location & privacy" card holds the current place, the Remember toggle, Forget, the recent places with Remove × and Clear all', /Location & privacy/.test(cardText) && /Current place: Ames/.test(cardText) && (await card.getByRole('checkbox', { name: /Remember this place/ }).count()) === 1 && (await card.getByRole('button', { name: 'Forget my location and recent places' }).count()) === 1 && (await card.getByRole('button', { name: /^Remove / }).count()) >= 1 && (await card.getByRole('button', { name: 'Clear all recent places' }).count()) === 1, cardText.slice(0, 200))
  check('[privacy] the sources list says what "fetched" and "observed" mean', /“Fetched” is when the app asked; “observed” or “reading” is when the measurement itself was taken/.test(await page.locator('.page-body').innerText()))
  await settingsBtn.click()
  await page.waitForTimeout(200)
  await page.getByRole('button', { name: 'Forget', exact: true }).click()
  await page.waitForTimeout(600)
  const gone = await page.evaluate(() => ({ keys: ['stormscope.place', 'stormscope.recent', 'stormscope.geo.asked'].map((k) => localStorage.getItem(k)), place: window.__store.get().place, recents: window.__store.get().recentPlaces.length }))
  check('[privacy] forgetting from Settings clears the place and every recent, leaves nothing behind, and shows the first-run choice at once (no reload)', gone.keys.every((v) => v === null) && gone.place === null && gone.recents === 0 && (await prompts(page)).join() === 'dialog', `${JSON.stringify(gone)}; prompts ${JSON.stringify(await prompts(page))}`)
  await page.screenshot({ path: `${OUT}/privacy-forgot.png` })
  done()
  await ctx.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
