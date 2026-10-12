// Air quality from EPA AirNow monitors only (mocked monitor service; no modeled data anywhere):
//   the pollutant switch (Off / Ozone / Smoke) and the sites toggle; 25 km discs in the EPA colour of each
//   monitor's reading under 2 h, overlaps never darker than either disc, no shading anywhere else; the
//   25 km and 2 h edges; an ozone-only site absent from the Smoke view; stale / offline grey dots; tap
//   details; both Now-tab states; the "service not set up" state.
//   node scripts/monitors-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap, openNow } from './lib/ui.mjs'

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
const FOCUS = { lat: 41.673, lng: -93.698 }
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

async function session({ service = SERVICE, noMonitors = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: FOCUS.lat, longitude: FOCUS.lng }, permissions: ['geolocation'] })
  if (service) await ctx.addInitScript((u) => { try { localStorage.setItem('stormscope.monitorService', u) } catch {} }, service)
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'monitors-check.mjs (mock)')
  const calls = []
  globalThis.__qaMockedRequest = (url) => { if (/monitors\.stormscope\.test/.test(url)) calls.push(url) }
  await installMocks(ctx, { noMonitors })
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(200) } return false }
  await until(() => window.__store?.get().conditions.state === 'ready')
  return { ctx, page, done, calls, until }
}
const features = (page) => page.evaluate(() => { const m = window.__map; if (!m.getLayer('air-monitors')) return null; return m.querySourceFeatures('air-monitors').map((f) => f.properties).filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i) })
const discs = (page) => page.evaluate(() => window.__aqCircles ?? null)
/** Canvas pixel of the discs layer at a lng/lat: [r, g, b, a], or null when outside the drawn extent. */
const pixel = (page, lng, lat) =>
  page.evaluate(([lng, lat]) => {
    const c = window.__aqCirclesCanvas, e = window.__aqCirclesExtent
    if (!c || !e) return null
    const R = 6378137
    const x = (R * lng * Math.PI) / 180, y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
    const px = Math.round((x - e.x0) / e.res), py = Math.round((e.y1 - y) / e.res)
    if (px < 0 || py < 0 || px >= e.w || py >= e.h) return [0, 0, 0, 0]
    return [...c.getContext('2d').getImageData(px, py, 1, 1).data]
  }, [lng, lat])
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
const nowLines = (page) => page.evaluate(() => [...document.querySelectorAll('.now-card.airnow .aq-lines li')].map((li) => ({ p: li.dataset.pollutant, state: li.dataset.state, text: li.innerText.replace(/\n/g, ' '), badge: li.querySelector('.aqi-badge') ? getComputedStyle(li.querySelector('.aqi-badge')).backgroundColor : null })))

// ---- 1. Now tab, measured state (the fixture around Johnston) and the no-monitor state.
{
  const { ctx, page, done, until } = await session()
  await until(() => window.__store.get().monitorsNear.state === 'ready', 20000)
  await page.waitForTimeout(300)
  const lines = await nowLines(page)
  const oz = lines.find((l) => l.p === 'OZONE'), pm = lines.find((l) => l.p === 'PM2.5')
  check('Now: Ozone measured — AQI 55 Moderate (yellow) at the nearest ozone monitor, 8 km-ish away, 25 min ago', oz?.state === 'measured' && /^Ozone 55 Moderate at Carpenter \(mock\), [45]\.\d (mi|km) away, 25 min ago$/.test(oz.text) && oz.badge === 'rgb(255, 255, 0)', oz?.text)
  check('Now: Smoke (PM2.5) measured — AQI 62 Moderate at Public Works, 30 min ago (the nearest fresh PM2.5 monitor; the 2 h 05 site 5 km away does not count)', pm?.state === 'measured' && /^Smoke \(PM2\.5\) 62 Moderate at Public Works \(mock\), [56]\.\d (mi|km) away, 30 min ago$/.test(pm.text) && pm.badge === 'rgb(255, 255, 0)', pm?.text)
  const cardText = await page.locator('.now-card.airnow').innerText()
  check('Now: the card is credited to EPA AirNow as preliminary and says "measured"', /measured \(EPA AirNow\)/i.test(cardText) && /preliminary/i.test(cardText), cardText.replace(/\n/g, ' | ').slice(0, 120))
  await page.screenshot({ path: `${OUT}/now-measured.png` })
  done()
  await ctx.close()
}
{
  const { ctx, page, done, until } = await session({ noMonitors: true })
  await until(() => window.__store.get().monitorsNear.state === 'ready', 20000)
  await page.waitForTimeout(300)
  const lines = await nowLines(page)
  check('Now with no monitor within 25 km: both lines say "No monitor within 25 km", no number, no badge', lines.length === 2 && lines.every((l) => l.state === 'none' && /No monitor within 25 km/.test(l.text) && !l.badge && !/\d/.test(l.text.replace(/25 km|PM2\.5/g, ''))), lines.map((l) => l.text).join(' | '))
  await page.screenshot({ path: `${OUT}/now-none.png` })
  done()
  await ctx.close()
}

// ---- 2. The map: switch, discs, edges, overlap, blank areas, dots, tap, toggle.
{
  const { ctx, page, done, calls, until } = await session()
  await openMap(page)
  // A view that holds every fixture site (±0.25° around the place).
  await page.evaluate(() => { const p = window.__store.get().place.lngLat; window.__map.jumpTo({ center: [p.lng, p.lat], zoom: 8.6 }) })
  await page.waitForTimeout(400)
  const callsBefore = calls.length // the Now tab already asked the service for the sites around the place
  await page.getByRole('button', { name: 'Open layer menu' }).click()
  const radios = await page.evaluate(() => [...document.querySelectorAll('[data-aq]')].map((b) => ({ id: b.dataset.aq, checked: b.getAttribute('aria-checked') })))
  check('Layers panel: an "Air quality (AirNow monitors, measured)" switch with Off / Ozone / Smoke (PM2.5), Off by default', radios.map((r) => r.id).join(',') === 'off,OZONE,PM2.5' && radios[0].checked === 'true', JSON.stringify(radios))
  await page.locator('[data-aq="PM2.5"]').click()
  await page.waitForTimeout(300)
  const legendSmoke = await page.locator('.aqi-legend').innerText().catch(() => '')
  const swatches = await page.evaluate(() => [...document.querySelectorAll('.aqi-legend .legend-swatch')].map((s) => getComputedStyle(s.querySelector('i')).backgroundColor))
  check('Smoke on: the legend shows the six EPA colours with breakpoints and says 25 km discs, no shading = no monitor', swatches.join('|') === 'rgb(0, 228, 0)|rgb(255, 255, 0)|rgb(255, 126, 0)|rgb(255, 0, 0)|rgb(143, 63, 151)|rgb(126, 0, 35)' && /Smoke \(PM2\.5\) · measured/.test(legendSmoke) && /25 km disc/.test(legendSmoke) && /no shading = no monitor/.test(legendSmoke), legendSmoke.split('\n')[0])
  await page.getByRole('button', { name: 'Close layer menu' }).click()
  await until(() => window.__store.get().monitors.state === 'ready' && window.__aqCircles && window.__aqCircles.discs.length > 0, 20000)
  await page.waitForTimeout(600)
  const d = await discs(page)
  const ids = (d?.discs ?? []).map((x) => x.id).sort().join(',')
  check('Smoke view: discs for the monitors with a PM2.5 reading under 2 h only — fresh, the 24.5 km site (1 h 55 min old) and the 25.5 km site; not the ozone-only, 2 h 05, 3 h or offline sites', d?.pollutant === 'PM2.5' && ids === 'mock-edge-in,mock-edge-out,mock-fresh', ids)
  check('Disc colours are the EPA colours of the readings (62 → yellow, 160 → red, 90 → yellow)', (d?.discs ?? []).every((x) => (x.id === 'mock-edge-in' ? x.color === '#FF0000' : x.color === '#FFFF00')), JSON.stringify(d?.discs))
  check("One request to the monitor service for the map view (bbox), besides the Now tab's request around the place", calls.length - callsBefore === 1 && /\/sites\?bbox=-?\d/.test(calls[calls.length - 1]), `${calls.length - callsBefore} view call(s), ${callsBefore} before`)
  // Pixels: inside the fresh disc (yellow), in the overlap of the fresh (yellow) and edge-in (red) discs, far from any monitor.
  const fresh = { lng: FOCUS.lng + 0.06, lat: FOCUS.lat - 0.07 }
  const edgeIn = { lng: FOCUS.lng, lat: FOCUS.lat + 24.5 / 111.2 }
  const pInside = await pixel(page, fresh.lng, fresh.lat)
  const pOverlap = await pixel(page, (fresh.lng + edgeIn.lng) / 2, (fresh.lat + edgeIn.lat) / 2)
  const pBlank = await pixel(page, FOCUS.lng + 0.9, FOCUS.lat)
  const pEdgeOutOnly = await pixel(page, FOCUS.lng, FOCUS.lat - 25.5 / 111.2)
  check('Inside the fresh disc the canvas is the EPA yellow at full alpha (the layer draws it at 45 % opacity)', pInside && pInside[0] === 255 && pInside[1] === 255 && pInside[2] === 0 && pInside[3] === 255, JSON.stringify(pInside))
  check('Overlap of the yellow and red discs is never darker than either: every channel ≥ both discs (per-channel max)', pOverlap && pOverlap[3] === 255 && pOverlap[0] >= 255 && pOverlap[1] >= 255 && pOverlap[2] >= 0, JSON.stringify(pOverlap))
  check('Far from any monitor (100 km east): no shading at all (alpha 0) — no estimate, no interpolation', pBlank && pBlank[3] === 0, JSON.stringify(pBlank))
  check('The 25.5 km site still draws its own disc on the map (it is a real monitor; it just does not count for the place)', pEdgeOutOnly && pEdgeOutOnly[3] === 255, JSON.stringify(pEdgeOutOnly))
  // Switch to Ozone: the ozone-only site appears, the PM2.5-only sites go.
  await page.getByRole('button', { name: 'Open layer menu' }).click()
  await page.locator('[data-aq="OZONE"]').click()
  await page.waitForTimeout(400)
  const rad2 = await page.evaluate(() => [...document.querySelectorAll('[data-aq]')].map((b) => b.getAttribute('aria-checked')).join(','))
  await page.getByRole('button', { name: 'Close layer menu' }).click()
  await page.waitForTimeout(500)
  const d2 = await discs(page)
  const ids2 = (d2?.discs ?? []).map((x) => x.id).sort().join(',')
  check('Ozone view (one at a time: Ozone checked, Smoke not): discs for fresh ozone readings only — fresh, ozone-only, the 24.5 km site', rad2 === 'false,true,false' && d2?.pollutant === 'OZONE' && ids2 === 'mock-edge-in,mock-fresh,mock-ozone-only', ids2)
  await page.screenshot({ path: `${OUT}/ozone-discs.png` })
  // Sites toggle: dots for every site in view, grey outlines for stale / offline.
  await page.getByRole('button', { name: 'Open layer menu' }).click()
  await page.getByText('Air monitors (AirNow)').click()
  await page.waitForTimeout(300)
  const legendDots = await page.evaluate(() => [...document.querySelectorAll('.monitors-legend .legend-swatch')].map((s) => s.dataset.monitor).join(','))
  await page.getByRole('button', { name: 'Close layer menu' }).click()
  await page.waitForTimeout(600)
  const f = await features(page)
  const by = Object.fromEntries((f ?? []).map((p) => [p.id, p]))
  check('Sites toggle on: a dot at every site in view (7), the legend row with both dot styles', Object.keys(by).length === 7 && legendDots === 'fresh,stale', `${Object.keys(by).length} dots · legend ${legendDots}`)
  check('Fresh site dot in its EPA colour (worst fresh reading, PM2.5 62 → yellow); 2 h 05 and 3 h sites and the offline site are grey outlines', by['mock-fresh']?.style === 'fresh' && by['mock-fresh']?.color === '#FFFF00' && ['mock-stale-edge', 'mock-stale', 'mock-offline'].every((id) => by[id]?.style === 'stale' && by[id]?.color === '#94a3b8'), JSON.stringify(['mock-fresh', 'mock-stale-edge', 'mock-stale', 'mock-offline'].map((id) => by[id])))
  const t = await tap(page, 'mock-ozone-only')
  check('Tap on the ozone-only site: name, "Measures: ozone", the reading with its age, the distance from the place', /Carpenter \(mock\)/.test(t) && /Measures: ozone$/m.test(t) && !/PM2\.5/.test(t) && /ozone: AQI 55 Moderate · 59 PPB · 25 min ago/.test(t) && /(km|mi) from your place/.test(t), t.replace(/\n/g, ' | ').slice(0, 200))
  const ts = await tap(page, 'mock-stale-edge')
  check('Tap on the 2 h 05 site: its reading marked stale', /2 h ago \(stale\)/.test(ts), ts.replace(/\n/g, ' | ').slice(0, 160))
  await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' }))
  await page.getByRole('button', { name: 'Open layer menu' }).click()
  await page.getByText('Air monitors (AirNow)').click()
  await page.locator('[data-aq="off"]').click()
  await page.waitForTimeout(400)
  const off = await page.evaluate(() => ({ dots: window.__map.getLayer('air-monitors') ? window.__map.getLayoutProperty('air-monitors', 'visibility') : 'gone', discs: !!window.__map.getLayer('aq-circles'), legendDots: !!document.querySelector('.monitors-legend'), legendScale: !!document.querySelector('.aqi-legend') }))
  check('Toggle off and switch Off: dots hidden, discs gone, both legend rows gone', (off.dots === 'none' || off.dots === 'gone') && !off.discs && !off.legendDots && !off.legendScale, JSON.stringify(off))
  done()
  await ctx.close()
}

// ---- 3. No service configured.
{
  const { ctx, page, done, calls, until } = await session({ service: '' })
  await until(() => window.__store.get().monitorsNear.state === 'error', 10000)
  const card = await page.locator('.now-card.airnow').innerText().catch(() => '')
  check('No service configured: the Now card says the monitor service is not set up yet (no numbers, no "No monitor" claim) and nothing was requested', /Monitor service not set up yet/.test(card) && !/No monitor within/.test(card) && calls.length === 0, card.split('\n').slice(0, 2).join(' | '))
  await openNow(page)
  done()
  await ctx.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
