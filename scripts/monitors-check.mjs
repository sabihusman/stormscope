// Air monitors (EPA AirNow sites), phase 2 client against the mocked monitor service:
//   toggle on → the layer and its legend row (coloured dot = reading under 2 h, grey outline = stale / offline);
//   a fresh site is drawn in the EPA colour of its worst fresh reading; a stale site and an offline site are
//   grey outlines; tapping the ozone-only site lists ozone alone with its age and the distance from the place;
//   toggle off → layer and legend row gone; with no service configured the layer reports that, not an error dump.
//   node scripts/monitors-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  monitors-check.mjs: mocked only (the monitor service is mocked)')
  process.exit(3)
}
assertBudget('monitors-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/monitors'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const SERVICE = 'https://monitors.stormscope.test/v1'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

async function session({ service = SERVICE } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
  if (service) await ctx.addInitScript((u) => { try { localStorage.setItem('stormscope.monitorService', u) } catch {} }, service)
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'monitors-check.mjs (mock)')
  const calls = []
  globalThis.__qaMockedRequest = (url) => { if (/monitors\.stormscope\.test/.test(url)) calls.push(url) }
  await installMocks(ctx, {})
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(200) } return false }
  await until(() => window.__store?.get().conditions.state === 'ready')
  await openMap(page)
  await page.waitForTimeout(500)
  return { ctx, page, done, calls, until }
}
const features = (page) => page.evaluate(() => { const m = window.__map; if (!m.getLayer('air-monitors')) return null; return m.querySourceFeatures('air-monitors').map((f) => f.properties).filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i) })
const tap = async (page, id) => {
  const pt = await page.evaluate((id) => { const m = window.__map; const f = m.querySourceFeatures('air-monitors').find((x) => x.properties.id === id); if (!f) return null; const p = m.project(f.geometry.coordinates); return { x: p.x, y: p.y } }, id)
  if (!pt) return ''
  await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' }))
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: 'Details' }).click().catch(() => {})
  await page.waitForTimeout(400)
  return page.locator('.sheet-body').innerText().catch(() => page.locator('.point-chip').innerText().catch(() => ''))
}

{
  const { ctx, page, done, calls, until } = await session()
  // The site cluster sits a few km from the place; zoom so every mock site is in view.
  await page.evaluate(() => { const p = window.__store.get().place.lngLat; window.__map.jumpTo({ center: [p.lng + 0.04, p.lat + 0.02], zoom: 9.6 }) })
  await page.getByRole('button', { name: 'Open layer menu' }).click()
  await page.getByRole('checkbox', { name: /Air monitors/ }).click().catch(async () => page.getByRole('radio', { name: /Air monitors/ }).click().catch(async () => page.getByText('Air monitors (AirNow)').click()))
  await page.waitForTimeout(300)
  const menuText = await page.locator('.fab-menu').innerText()
  const on = await page.evaluate(() => window.__store.get().layers.monitors)
  const pointsIdx = menuText.search(/points/i)
  const monIdx = menuText.search(/air monitors \(airnow\)/i)
  check('Toggle on: "Air monitors (AirNow)" is in the Points group and turns the layer on', on === true && pointsIdx >= 0 && monIdx > pointsIdx, `on ${on} · menu: ${menuText.replace(/\n/g, ' | ').slice(0, 160)}`)
  const legend = await page.evaluate(() => { const sw = [...document.querySelectorAll('.monitors-legend .legend-swatch')]; return sw.map((s) => { const i = s.querySelector('i'); const cs = getComputedStyle(i); return { kind: s.dataset.monitor, bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopColor, text: s.textContent.trim() } }) })
  check('Legend shows both dot styles: a coloured dot for a reading under 2 h and a grey outlined dot for stale / offline, with the AirNow credit', legend.length === 2 && legend[0].kind === 'fresh' && legend[0].bg === 'rgb(255, 255, 0)' && legend[1].kind === 'stale' && legend[1].bg === 'rgba(0, 0, 0, 0)' && /2px rgb\(148, 163, 184\)/.test(legend[1].border) && /EPA AirNow/.test(menuText) && /preliminary/.test(menuText), JSON.stringify(legend))
  await page.getByRole('button', { name: 'Close layer menu' }).click()
  await until(() => window.__store.get().monitors.state === 'ready', 20000)
  await page.waitForTimeout(600)
  const f = await features(page)
  const by = Object.fromEntries((f ?? []).map((p) => [p.id, p]))
  check('One request to the monitor service for the view, with a bbox', calls.length === 1 && /\/sites\?bbox=-?\d/.test(calls[0]), `${calls.length} call(s) ${calls[0]?.slice(-60) ?? ''}`)
  check('Fresh site: drawn in the EPA colour of its worst reading under 2 h (PM2.5 AQI 62 → Moderate yellow)', by['mock-fresh']?.style === 'fresh' && by['mock-fresh']?.color === '#FFFF00' && by['mock-fresh']?.aqi === 62, JSON.stringify(by['mock-fresh']))
  check('Stale site (readings 3 h old): grey outlined dot, no category colour', by['mock-stale']?.style === 'stale' && by['mock-stale']?.color === '#94a3b8', JSON.stringify(by['mock-stale']))
  check('Offline site (no readings): grey outlined dot too', by['mock-offline']?.style === 'stale', JSON.stringify(by['mock-offline']))
  check('Ozone-only site: fresh, drawn in its ozone category colour (AQI 55 → Moderate)', by['mock-ozone-only']?.style === 'fresh' && by['mock-ozone-only']?.aqi === 55, JSON.stringify(by['mock-ozone-only']))
  const paint = await page.evaluate(() => { const m = window.__map; return { fill: JSON.stringify(m.getPaintProperty('air-monitors', 'circle-color')), stroke: JSON.stringify(m.getPaintProperty('air-monitors', 'circle-stroke-color')) } })
  check('Stale dots are transparent with a grey stroke in the layer paint', /rgba\(0,0,0,0\)/.test(paint.fill) && /#94a3b8/.test(paint.stroke))
  const t = await tap(page, 'mock-ozone-only')
  check('Tap on the ozone-only site: name, "Measures: ozone" only, the reading with its age, the distance from the place', /Carpenter \(mock\)/.test(t) && /Measures: ozone\b/.test(t) && !/PM2\.5/.test(t) && /ozone: AQI 55 Moderate · 59 PPB · 25 min ago/.test(t) && /(km|mi) from your place/.test(t) && /EPA AirNow/.test(t), t.replace(/\n/g, ' | ').slice(0, 220))
  const ts = await tap(page, 'mock-stale')
  check('Tap on the stale site: every reading marked stale with its age', /3 h ago \(stale\)/.test(ts) && /Measures: PM2\.5, ozone/.test(ts), ts.replace(/\n/g, ' | ').slice(0, 160))
  await page.screenshot({ path: `${OUT}/monitors-on.png` })
  await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' }))
  await page.getByRole('button', { name: 'Open layer menu' }).click()
  await page.getByText('Air monitors (AirNow)').click()
  await page.waitForTimeout(400)
  const off = await page.evaluate(() => ({ layer: !!window.__map.getLayer('air-monitors'), legend: !!document.querySelector('.monitors-legend'), on: window.__store.get().layers.monitors }))
  check('Toggle off: the layer and its legend row are gone', !off.layer && !off.legend && off.on === false, JSON.stringify(off))
  done()
  await ctx.close()
}
{
  const { ctx, page, done, calls, until } = await session({ service: '' })
  await page.evaluate(() => window.__store.set((s) => ({ layers: { ...s.layers, monitors: true } })))
  await until(() => !!window.__store.get().layerErrors.monitors, 10000)
  const err = await page.evaluate(() => window.__store.get().layerErrors.monitors)
  check('No service configured: the layer says the monitor service is not set up yet and makes no request', /Monitor service not set up yet/.test(err ?? '') && calls.length === 0, `${err} · ${calls.length} call(s)`)
  done()
  await ctx.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
