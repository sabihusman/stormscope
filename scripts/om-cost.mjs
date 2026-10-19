// Open-Meteo cost per user action, mocked (the app's code path is the same, so the counts are the live counts):
// locations (the quota unit: every location in a multi-location request counts) and requests, phase by phase —
// app load, a place change, each map layer switched on, 3D terrain, each playback range.
//   node scripts/om-cost.mjs [base-url]
import { chromium } from 'playwright'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap, openNow, searchPlace } from './lib/ui.mjs'

const BASE = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] || 'http://localhost:4173/'
const phases = []
let cur = null
const isOM = (url) => /open-meteo\.com\/v1\/(forecast|era5)/.test(url)
globalThis.__qaMockedRequest = (url) => {
  if (!cur || !isOM(url)) return
  cur.requests++
  cur.locations += url.match(/[?&]latitude=([^&]*)/)?.[1].split(',').length ?? 1
  const u = new URL(url)
  const kind = u.searchParams.get('minutely_15') ? 'minutely' : u.searchParams.get('daily') ? 'place forecast' : u.searchParams.get('past_hours') === '24' ? 'past 24 h' : 'hourly block'
  cur.kinds[kind] = (cur.kinds[kind] ?? 0) + (url.match(/[?&]latitude=([^&]*)/)?.[1].split(',').length ?? 1)
}
const phase = (name) => { cur = { name, requests: 0, locations: 0, kinds: {} }; phases.push(cur) }

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
const page = await ctx.newPage()
await installMocks(ctx, {})
const until = async (fn, ms = 40000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(200) } return false }
const settle = async (ms = 4000) => { await until(() => window.__store.get().conditions.state === 'ready'); await page.waitForTimeout(ms) }
const menu = async (fn) => {
  if (!(await page.locator('.fab-menu').count())) { await page.getByRole('button', { name: 'Open layer menu' }).tap(); await page.waitForTimeout(400) }
  await fn()
  await page.waitForTimeout(300)
  if (await page.locator('.fab-menu').count()) { await page.getByRole('button', { name: 'Close layer menu' }).tap(); await page.waitForTimeout(300) }
  await page.waitForTimeout(5000)
}

phase('app load (grant location)')
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
await until(() => !!window.__map?.loaded())
await settle()

phase('place change (search → Ames)')
await openNow(page)
await searchPlace(page, 'Ames')
await page.waitForTimeout(600)
await page.getByRole('dialog').getByRole('option').first().click()
await until(() => !window.__store.get().pickerOpen)
await settle()

phase('open Map (no overlay)')
await openMap(page)
await page.waitForTimeout(5000)

const layerNames = await page.evaluate(() => { const m = document.querySelector('.fab-menu'); return m ? 'open' : 'closed' })
void layerNames
const toggles = [
  ['radar', () => page.getByRole('radio', { name: /Radar/ }).tap()],
  ['satellite', () => page.getByRole('radio', { name: /Satellite/ }).tap()],
  ['rainfall overlay (forecast, 24 h)', () => page.locator('[data-overlay="rainfall"]').tap()],
  ['nowcast overlay (wind & cloud)', () => page.locator('[data-overlay="nowcast"]').tap()],
  ['flood overlay', () => page.locator('[data-overlay="flood"]').tap()],
  ['river gauges', () => page.getByRole('button', { name: /River gauges/ }).tap()],
  ['station', () => page.getByRole('button', { name: /^Station/ }).tap()],
  ['air quality: Smoke discs', () => page.locator('[data-aq="PM2.5"]').tap()],
  ['air monitors (dots)', () => page.getByRole('button', { name: /Air monitors/ }).tap()],
  ['3D terrain', () => page.getByRole('button', { name: /3D terrain/ }).tap()],
]
for (const [name, act] of toggles) {
  phase(`layer on: ${name}`)
  try { await menu(act) } catch (e) { cur.note = `could not toggle: ${String(e).slice(0, 80)}` }
}
// Playback ranges (the rainfall overlay is on from above; the bar's range buttons).
for (const h of [6, 12, 24, 48]) {
  phase(`playback range ${h} h`)
  try {
    const pill = page.getByRole('button', { name: /Show controls/ })
    if (await pill.count()) { await pill.tap(); await page.waitForTimeout(400) }
    const r = page.getByRole('radio', { name: new RegExp(`^${h} h`) })
    if (await r.count()) await r.first().tap()
    else await page.getByRole('button', { name: new RegExp(`^${h} h`) }).first().tap()
    await page.waitForTimeout(5000)
  } catch (e) { cur.note = `could not set: ${String(e).slice(0, 80)}` }
}
cur = null
await browser.close()
console.log('\nOpen-Meteo cost per action (mocked, Johnston → Ames, phone):')
console.log('action | requests | locations | by kind')
for (const p of phases) console.log(`${p.name} | ${p.requests} | ${p.locations} | ${Object.entries(p.kinds).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}${p.note ? ' | ' + p.note : ''}`)
console.log(`TOTAL | ${phases.reduce((a, p) => a + p.requests, 0)} | ${phases.reduce((a, p) => a + p.locations, 0)}`)
