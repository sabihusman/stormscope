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

async function session({ service = SERVICE, noMonitors = false, notConfigured = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: FOCUS.lat, longitude: FOCUS.lng }, permissions: ['geolocation'] })
  if (service) await ctx.addInitScript((u) => { try { localStorage.setItem('stormscope.monitorService', u) } catch {} }, service)
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'monitors-check.mjs (mock)')
  const calls = []
  globalThis.__qaMockedRequest = (url) => { if (/monitors\.stormscope\.test/.test(url)) calls.push(url) }
  await installMocks(ctx, { noMonitors })
  // The function without its key: a 503 with its own message on the same-origin /api route.
  if (notConfigured) await page.route('**/api/sites*', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Monitor service not configured: AIRNOW_API_KEY is not set' }) }))
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
/**
 * Tap a dot the way a finger does: a real touch (the context has touch) 9 px right and 8 px below the dot's
 * centre — 12 px off, inside a 44 px target but outside the 15 px dot — with whatever chip is on screen left
 * as is and the discs on; then the chip's Details button. Until Oct 17 this helper cleared the selection
 * through the store and mouse-clicked the exact centre, which no finger does, and passed on a build where a
 * tap 12 px off fell through to the map's point chip.
 */
const FINGER = { dx: 9, dy: 8 }
const tap = async (page, id) => {
  // Zoom in on the dot first, as a user does before tapping one dot among neighbours (the fixture's
  // Public Works and Carpenter are 1 km apart: 3 px at the city zoom, 60 px at zoom 13).
  await page.evaluate((id) => { const s = window.__store.get().monitors.data?.sites.find((x) => x.id === id); if (s) window.__map.jumpTo({ center: [s.lngLat.lng, s.lngLat.lat], zoom: 13 }) }, id)
  await page.waitForTimeout(800)
  // The dot's screen position once the view has settled (the jump re-centres the place and reloads the sites in view).
  let pt = null
  for (let i = 0; i < 30 && !pt; i++) {
    pt = await page.evaluate((id) => { const m = window.__map; if (m.isMoving() || window.__store.get().monitors.state !== 'ready') return null; const f = m.querySourceFeatures('air-monitors').find((x) => x.properties.id === id); if (!f) return null; const p = m.project(f.geometry.coordinates); return { x: p.x, y: p.y } }, id)
    if (!pt) await page.waitForTimeout(200)
  }
  if (!pt) {
    const why = await page.evaluate(() => ({ moving: window.__map.isMoving(), zoom: window.__map.getZoom(), state: window.__store.get().monitors.state, err: window.__store.get().monitors.error ?? null, ids: window.__map.querySourceFeatures('air-monitors').map((f) => f.properties.id).filter((v, i, a) => a.indexOf(v) === i) }))
    return { chip: '', text: '', rows: [], missing: `${id}: ${JSON.stringify(why)}` }
  }
  const box = await page.locator('.maplibregl-canvas').boundingBox()
  await page.touchscreen.tap(box.x + pt.x + FINGER.dx, box.y + pt.y + FINGER.dy)
  await page.waitForTimeout(500)
  const chip = await page.locator('.point-chip').innerText().catch(() => '')
  await page.getByRole('button', { name: 'Details' }).click().catch(() => {})
  await page.waitForTimeout(400)
  const text = await page.locator('.sheet-body').innerText().catch(() => '')
  const rows = await page.evaluate(() => [...document.querySelectorAll('.sheet-body .popup-readings li')].map((li) => ({ label: li.dataset.reading, stale: li.dataset.stale === 'true', badge: getComputedStyle(li.querySelector('.aqi-badge')).backgroundColor, text: li.innerText.replace(/\n/g, ' ') })))
  // Put the sheet away (a user would swipe it down) so the next dot is not under it; the chip stays.
  await page.evaluate(() => window.__store.set({ sheet: 'peek' }))
  await page.waitForTimeout(300)
  return { chip: chip.replace(/\n/g, ' | '), text, rows }
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
  await page.evaluate(() => { const p = window.__store.get().place.lngLat; window.__map.jumpTo({ center: [p.lng, p.lat], zoom: 8.2 }) })
  await page.waitForTimeout(400)
  const callsBefore = calls.length // the Now tab already asked the service for the sites around the place
  await page.getByRole('button', { name: 'Open layer menu' }).click()
  const radios = await page.evaluate(() => [...document.querySelectorAll('[data-aq]')].map((b) => ({ id: b.dataset.aq, checked: b.getAttribute('aria-checked') })))
  check('Layers panel: an "Air quality (AirNow monitors, measured)" switch with Off / Ozone / Smoke (PM2.5), Off by default', radios.map((r) => r.id).join(',') === 'off,OZONE,PM2.5' && radios[0].checked === 'true', JSON.stringify(radios))
  await page.locator('[data-aq="PM2.5"]').click()
  await page.waitForTimeout(300)
  const legendSmoke = await page.locator('.aqi-legend').innerText().catch(() => '')
  const swatches = await page.evaluate(() => [...document.querySelectorAll('.aqi-legend .legend-swatch')].map((s) => getComputedStyle(s.querySelector('i')).backgroundColor))
  check('Smoke on: the legend shows the six EPA colours with breakpoints and says 25 km discs, no shading = no monitor', swatches.join('|') === 'rgb(0, 228, 0)|rgb(255, 255, 0)|rgb(255, 126, 0)|rgb(255, 0, 0)|rgb(143, 63, 151)|rgb(126, 0, 35)' && /Smoke \(PM2\.5\) · measured/.test(legendSmoke) && /25 km disc/.test(legendSmoke) && /overlaps show the worse reading/.test(legendSmoke) && /no shading = no monitor/.test(legendSmoke), legendSmoke.split('\n')[0])
  await page.getByRole('button', { name: 'Close layer menu' }).click()
  await until(() => window.__store.get().monitors.state === 'ready' && window.__aqCircles && window.__aqCircles.discs.length > 0, 20000)
  await page.waitForTimeout(600)
  const d = await discs(page)
  const ids = (d?.discs ?? []).map((x) => x.id).sort().join(',')
  check('Smoke view: discs for the monitors with a PM2.5 reading under 2 h only — fresh, the 24.5 km site (1 h 55 min old), the 25.5 km site and the four overlap fixtures; not the ozone-only, 2 h 05, 3 h or offline sites', d?.pollutant === 'PM2.5' && ids === 'mock-edge-in,mock-edge-out,mock-fresh,mock-good,mock-haz,mock-usg,mock-vu', ids)
  const EXPECT = { 'mock-fresh': '#FFFF00', 'mock-edge-in': '#FF0000', 'mock-edge-out': '#FFFF00', 'mock-good': '#00E400', 'mock-usg': '#FF7E00', 'mock-vu': '#8F3F97', 'mock-haz': '#7E0023' }
  check('Disc colours are the EPA colours of the readings, and the discs are ordered by category rank (worse painted last)', (d?.discs ?? []).every((x) => x.color === EXPECT[x.id]) && (d?.discs ?? []).every((x, i, a) => i === 0 || a[i - 1].rank <= x.rank), JSON.stringify((d?.discs ?? []).map((x) => `${x.id}:${x.rank}`)))
  check("One request to the monitor service for the map view (bbox), besides the Now tab's request around the place", calls.length - callsBefore === 1 && /\/sites\?bbox=-?\d/.test(calls[calls.length - 1]), `${calls.length - callsBefore} view call(s), ${callsBefore} before`)
  // Pixels: inside the fresh disc (yellow), in the overlap of the fresh (yellow) and edge-in (red) discs, far from any monitor.
  // Pixel samples (offsets from the place in degrees; 1° lat ≈ 111 km, 1° lng ≈ 83 km here). Each point lies inside
  // exactly the discs named; the canvas holds solid EPA colours at full alpha (the layer shows it at 45 %).
  const at = (dLat, dLng) => pixel(page, FOCUS.lng + dLng, FOCUS.lat + dLat)
  const YELLOW = [255, 255, 0, 255], RED = [255, 0, 0, 255], MAROON = [126, 0, 35, 255]
  const same = (a, b) => !!a && a.join(',') === b.join(',')
  const pInside = await at(-0.07, 0.25) // fresh (Moderate) only
  const pModUnh = await at(0.075, 0.12) // fresh (Moderate) ∩ edge-in (Unhealthy)
  const pGoodUnh = await at(0.26, 0.15) // good (Good) ∩ edge-in (Unhealthy)
  const pVuHaz = await at(-0.3, -0.37) // vu (Very Unhealthy) ∩ haz (Hazardous)
  const pThree = await at(0.08, 0.03) // fresh (Moderate) ∩ edge-in (Unhealthy) ∩ usg (USG)
  const pSame = await at(-0.15, 0.03) // fresh (Moderate 62) ∩ edge-out (Moderate 90)
  const pBlank = await at(0, 0.9) // 75 km east of everything
  const pEdgeOut = await at(-25.5 / 111.2, 0) // the 25.5 km site's own disc
  check('A point under one disc only (fresh, Moderate) is the EPA yellow at full alpha', same(pInside, YELLOW), JSON.stringify(pInside))
  check('Moderate + Unhealthy overlap shows Unhealthy (red), not yellow', same(pModUnh, RED), JSON.stringify(pModUnh))
  check('Good + Unhealthy overlap shows Unhealthy (red)', same(pGoodUnh, RED), JSON.stringify(pGoodUnh))
  check('Very Unhealthy + Hazardous overlap shows Hazardous (maroon)', same(pVuHaz, MAROON), JSON.stringify(pVuHaz))
  check('Three discs overlapping (Moderate, Unhealthy, Unhealthy for Sensitive Groups) show the worst of the three (red)', same(pThree, RED), JSON.stringify(pThree))
  check('Same-category overlap (two Moderate discs) is identical to a single Moderate disc', same(pSame, YELLOW) && same(pSame, pInside), JSON.stringify(pSame))
  check('Far from any monitor: no shading at all (alpha 0) — no estimate, no interpolation', pBlank && pBlank[3] === 0, JSON.stringify(pBlank))
  check('The 25.5 km site still draws its own disc on the map (it is a real monitor; it just does not count for the place)', same(pEdgeOut, YELLOW), JSON.stringify(pEdgeOut))
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
  check('Sites toggle on: a dot at every site in view (11), the legend row with both dot styles', Object.keys(by).length === 11 && legendDots === 'fresh,stale', `${Object.keys(by).length} dots · legend ${legendDots}`)
  check('Fresh site dot in its EPA colour (worst fresh reading, PM2.5 62 → yellow); 2 h 05 and 3 h sites and the offline site are grey outlines', by['mock-fresh']?.style === 'fresh' && by['mock-fresh']?.color === '#FFFF00' && ['mock-stale-edge', 'mock-stale', 'mock-offline'].every((id) => by[id]?.style === 'stale' && by[id]?.color === '#94a3b8'), JSON.stringify(['mock-fresh', 'mock-stale-edge', 'mock-stale', 'mock-offline'].map((id) => by[id])))
  const t = await tap(page, 'mock-ozone-only')
  check('A finger tap 12 px off the ozone-only dot (discs on, no chip cleared) opens that monitor in the chip — not the map\'s "This point" chip', /Carpenter \(mock\) · air monitor/.test(t.chip) && !/This point/.test(t.chip), t.chip.slice(0, 120))
  check('Details: the name, "Measures: ozone" (no PM2.5), the distance from the place, the agency', /Carpenter \(mock\)/.test(t.text) && /Measures: ozone$/m.test(t.text) && !/PM2\.5/.test(t.text) && /(km|mi) from your place/.test(t.text), t.text.replace(/\n/g, ' | ').slice(0, 200))
  const r = t.rows[0]
  check('Details: one reading row — the AQI badge 55 in EPA yellow, "Moderate", 59 PPB, the reading\'s local clock time, "25 min ago"', t.rows.length === 1 && r?.label === 'ozone' && r.badge === 'rgb(255, 255, 0)' && /^55 ozone Moderate · 59 PPB \d{1,2}:\d{2}(\s?[AP]M)? · 25 min ago$/.test(r.text) && !r.stale, JSON.stringify(r))
  const ts = await tap(page, 'mock-stale-edge')
  const rs = ts.rows[0]
  check('Tap on the 2 h 05 site (with the previous chip still up): its reading row marked stale, "2 h ago (stale)"', /mock-stale-edge|Stale edge|air monitor/i.test(ts.chip) && !/This point/.test(ts.chip) && rs?.stale === true && /2 h ago \(stale\)$/.test(rs.text), ts.missing ? `dot not found — ${ts.missing}` : `${ts.chip.slice(0, 60)} — ${JSON.stringify(rs)}`)
  // ---- At the place zoom (9.5, where the map lands on a place), without zooming in: Public Works (mock) and
  // Carpenter (mock) are 1 km apart — closer than the 44 px target — so a tap there must list them, never guess.
  await page.evaluate(() => { const p = window.__store.get().place.lngLat; window.__map.jumpTo({ center: [p.lng, p.lat], zoom: 9.5 }) })
  await until(() => !window.__map.isMoving() && window.__store.get().monitors.state === 'ready', 15000)
  await page.waitForTimeout(800)
  const screenPos = (id) => page.evaluate((id) => { const s = window.__store.get().monitors.data?.sites.find((x) => x.id === id); if (!s) return null; const p = window.__map.project([s.lngLat.lng, s.lngLat.lat]); return { x: p.x, y: p.y } }, id)
  const pFresh = await screenPos('mock-fresh'), pOzone = await screenPos('mock-ozone-only'), pStale = await screenPos('mock-stale-edge')
  const gap = pFresh && pOzone ? Math.hypot(pFresh.x - pOzone.x, pFresh.y - pOzone.y) : NaN
  check('At zoom 9.5 the two neighbouring dots are under 44 px apart on screen (the chooser case)', gap > 0 && gap < 44, `${gap.toFixed(1)} px`)
  const mapBox = await page.locator('.maplibregl-canvas').boundingBox()
  await page.touchscreen.tap(mapBox.x + pOzone.x + FINGER.dx, mapBox.y + pOzone.y + FINGER.dy)
  await page.waitForTimeout(500)
  const chooser = await page.evaluate(() => ({ rows: [...document.querySelectorAll('.dot-chooser .chooser-row')].map((b) => ({ id: b.dataset.site, text: b.innerText.replace(/\n/g, ' ') })), title: document.querySelector('.dot-chooser .chooser-title')?.innerText ?? '', chip: !!document.querySelector('.point-chip'), sel: window.__store.get().selection?.title ?? null }))
  check('A finger tap there opens a chooser listing both monitors with their badges and distances (no chip, no guessed monitor)', chooser.rows.length === 2 && chooser.rows.every((r) => ['mock-fresh', 'mock-ozone-only'].includes(r.id)) && /2 monitors here/.test(chooser.title) && !chooser.chip && chooser.sel === null && chooser.rows.every((r) => /(km|mi) from your place/.test(r.text)), JSON.stringify(chooser).slice(0, 220))
  await page.locator('.dot-chooser .chooser-row[data-site="mock-ozone-only"]').click()
  await page.waitForTimeout(400)
  const picked = await page.evaluate(() => ({ chooser: !!document.querySelector('.dot-chooser'), chip: document.querySelector('.point-chip')?.innerText.replace(/\n/g, ' | ') ?? '' }))
  check('Picking Carpenter (mock) in the chooser opens its chip and closes the chooser', !picked.chooser && /Carpenter \(mock\) · air monitor/.test(picked.chip) && /ozone: AQI 55 Moderate/.test(picked.chip), picked.chip.slice(0, 100))
  await page.touchscreen.tap(mapBox.x + pStale.x + FINGER.dx, mapBox.y + pStale.y + FINGER.dy)
  await page.waitForTimeout(500)
  const lone = await page.evaluate(() => ({ chooser: !!document.querySelector('.dot-chooser'), chip: document.querySelector('.point-chip')?.innerText.replace(/\n/g, ' | ') ?? '' }))
  check('A lone dot at zoom 9.5 (the 2 h 05 site, with the Carpenter chip still up) opens directly — no chooser', !lone.chooser && /Stale 2 h 05 \(mock\) · air monitor/.test(lone.chip), lone.chip.slice(0, 100))
  await page.screenshot({ path: `${OUT}/tap-chooser.png` })
  await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek', dotChooser: null }))
  await page.getByRole('button', { name: 'Open layer menu' }).click()
  await page.getByText('Air monitors (AirNow)').click()
  await page.locator('[data-aq="off"]').click()
  await page.waitForTimeout(400)
  const off = await page.evaluate(() => ({ dots: window.__map.getLayer('air-monitors') ? window.__map.getLayoutProperty('air-monitors', 'visibility') : 'gone', discs: !!window.__map.getLayer('aq-circles'), legendDots: !!document.querySelector('.monitors-legend'), legendScale: !!document.querySelector('.aqi-legend') }))
  check('Toggle off and switch Off: dots hidden, discs gone, both legend rows gone', (off.dots === 'none' || off.dots === 'gone') && !off.discs && !off.legendDots && !off.legendScale, JSON.stringify(off))
  done()
  await ctx.close()
}

// ---- 3. The function without its key (same-origin /api, 503 "not configured").
{
  const { ctx, page, done, calls, until } = await session({ service: '', notConfigured: true })
  await until(() => window.__store.get().monitorsNear.state === 'error', 10000)
  const card = await page.locator('.now-card.airnow').innerText().catch(() => '')
  check('Function without its key: the Now card shows "Monitor service not configured: AIRNOW_API_KEY is not set" (no numbers, no "No monitor" claim); the mocked external service was not called', /Monitor service not configured: AIRNOW_API_KEY is not set/.test(card) && !/No monitor within/.test(card) && calls.length === 0, card.split('\n').slice(0, 2).join(' | '))
  await openNow(page)
  done()
  await ctx.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
