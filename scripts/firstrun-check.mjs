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

// ---- 10. Default units follow the device's region; a Settings choice overrides it and is remembered ----
const GEO = { geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] }
const untilReady = async (page) => { const t0 = Date.now(); while (Date.now() - t0 < 30000) { if (await page.evaluate(() => window.__store?.get().conditions.state === 'ready').catch(() => false)) return; await page.waitForTimeout(200) } }
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

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
