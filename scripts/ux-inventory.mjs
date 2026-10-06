// UX Phase 1 — screen inventory. Mocked (zero live calls): every screen / panel / state of the
// current UI at phone size (390×844, DPR 2), plus one tablet and one desktop home shot.
//
//   node scripts/ux-inventory.mjs [base-url] [out-dir]
//
// Writes <out>/NN-name.png and <out>/inventory.json (name, what it shows, how it was reached).
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { installMocks } from './lib/mock-server.mjs'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
assertBudget('ux-inventory.mjs (mock)', { openMeteo: false })

const BASE = (process.argv[2] || 'http://localhost:4173/').replace(/\/?$/, '/')
const OUT = process.argv[3] || 'docs/ux/inventory'
mkdirSync(OUT, { recursive: true })
const JOHNSTON = { latitude: 41.673, longitude: -93.698 }
const shots = []
let n = 0
// Headed Chrome with the real GPU (same as the walkthrough) so overlays, blur and 3D look as they do on a device.
const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--window-size=430,960', '--window-position=20,20'] })

const LAYERS_DEFAULT = { radar: true, satellite: false, rainfall: false, flood: false, rivers: true, station: true, nowcast: false }
async function newCtx({ geo = 'grant', layers = LAYERS_DEFAULT, viewport = { width: 390, height: 844 }, mobile = true, delayApis = 0, fail = false, dpr = 2 } = {}) {
  const ctx = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: dpr,
    serviceWorkers: 'block',
    ...(geo === 'grant' ? { geolocation: JOHNSTON, permissions: ['geolocation'] } : {}),
  })
  await ctx.addInitScript((l) => { try { localStorage.setItem('stormscope.layers', JSON.stringify(l)) } catch {} }, layers)
  if (geo === 'hang') await ctx.addInitScript(() => { navigator.geolocation.getCurrentPosition = () => {} })
  // Headed Chrome would show its own permission bubble; make "denied" deterministic instead.
  if (geo === 'none') await ctx.addInitScript(() => { navigator.geolocation.getCurrentPosition = (_ok, err) => setTimeout(() => err?.({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: 'User denied Geolocation' }), 300) })
  const done = trackOpenMeteo(ctx.pages()[0] ?? (await ctx.newPage()), 'ux-inventory.mjs (mock)')
  await installMocks(ctx, fail ? { failHosts: ['api.rainviewer.com', 'api.open-meteo.com', 'api.weather.gov', 'api.water.noaa.gov', 'api.waterdata.usgs.gov'] } : {})
  if (delayApis) await ctx.route(/open-meteo|rainviewer|weather\.gov|water\.noaa|usgs\.gov|nationalmap/, async (r) => { await new Promise((x) => setTimeout(x, delayApis)); r.fallback() })
  const page = ctx.pages()[0]
  return { ctx, page, done }
}
async function shot(page, name, what, how) {
  n++
  const file = `${String(n).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: `${OUT}/${file}`, animations: 'disabled' })
  shots.push({ file, name, what, how })
  console.log(`${file}  ${what}`)
}
const st = (page, fn, arg) => page.evaluate(fn, arg)
const waitFor = async (page, fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(250) } return false }
const settle = (page, ms = 1500) => page.waitForTimeout(ms)
// The sheet animates its height and React commits lag under SwiftShader: wait for the mode class
// to be applied *and* the box to reach that mode's height before shooting.
const sheetSettled = async (page, mode) => {
  await page.waitForFunction((m) => { const el = document.querySelector('.sheet'); if (!el || !el.classList.contains(m)) return false; const h = el.getBoundingClientRect().height; const target = m === 'peek' ? 92 : m === 'half' ? Math.min(innerHeight * 0.46, 420) : innerHeight - 70; return Math.abs(h - target) < 4 }, mode, { timeout: 20000 }).catch(() => console.log(`  (sheet did not reach ${mode})`))
  await page.waitForTimeout(500)
}
const openTab = async (page, name) => { await page.getByRole('tab', { name }).click(); await sheetSettled(page, await page.evaluate(() => window.__store.get().sheet)); await settle(page, 400) }
const setSheet = (page, mode) => st(page, (m) => window.__store.set({ sheet: m }), mode).then(() => sheetSettled(page, mode))
const tapFeature = async (page, layerId) => {
  // Tap the first rendered feature of a layer (through MapLibre's own hit test).
  const pt = await page.evaluate((id) => {
    const m = window.__map
    const f = m.queryRenderedFeatures(undefined, { layers: [id] })[0]
    if (!f) return null
    const g = f.geometry
    const c = g.type === 'Point' ? g.coordinates : g.type === 'Polygon' ? g.coordinates[0][0] : null
    if (!c) return null
    if (g.type === 'Polygon') { const ring = g.coordinates[0]; const lng = ring.reduce((a, p) => a + p[0], 0) / ring.length; const lat = ring.reduce((a, p) => a + p[1], 0) / ring.length; const p = m.project([lng, lat]); return { x: p.x, y: p.y } }
    const p = m.project(c); return { x: p.x, y: p.y }
  }, layerId)
  if (!pt) return false
  await page.mouse.click(pt.x, pt.y)
  await settle(page, 600)
  return true
}

try {
  // ---------- First run ----------
  {
    const { ctx, page, done } = await newCtx({ geo: 'none' })
    await page.goto(BASE, { waitUntil: 'load' }); await settle(page, 1200)
    await shot(page, 'first-run-location-prompt', 'First run: location prompt over the map (radar not centred yet)', 'fresh profile, open the app')
    await page.getByRole('button', { name: 'Search for a place' }).click(); await settle(page, 500)
    await shot(page, 'first-run-search-open', 'First run → "Search for a place": empty search field, map behind', 'tap "Search for a place"')
    await page.getByRole('searchbox', { name: 'Search for a place' }).fill('Iowa City'); await settle(page, 1200)
    await shot(page, 'search-results', 'Search results list for "Iowa City"', 'type in the search field')
    await page.getByRole('option').first().click(); await settle(page, 2500)
    await shot(page, 'after-address-home', 'After choosing an address: map recentred, sheet collapsed — no current conditions shown', 'pick the first result')
    await page.getByRole('button', { name: 'Change location' }).click(); await settle(page, 300)
    await ctx.route(/geocoding-api\.open-meteo\.com|nominatim/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [] }) }))
    await page.getByRole('searchbox', { name: 'Search for a place' }).fill('zzzzqq'); await settle(page, 1200)
    await shot(page, 'search-no-results', 'Search with no matches', 'type a nonsense query')
    await page.getByRole('button', { name: 'Close search' }).click()
    done(); await ctx.close()
  }
  {
    const { ctx, page, done } = await newCtx({ geo: 'none' })
    await page.goto(BASE, { waitUntil: 'load' }); await settle(page, 800)
    await page.getByRole('button', { name: 'Allow location' }).click(); await settle(page, 1500)
    await shot(page, 'first-run-location-denied', 'Location denied / failed: prompt turns into an error card with Try again', 'tap Allow with permission denied')
    await page.getByRole('button', { name: 'Just show the map' }).click(); await settle(page, 1200)
    await shot(page, 'no-location-map-only', '"Just show the map": no place set, status strip says "No location set"', 'tap "Just show the map"')
    await openTab(page, 'Journey')
    await shot(page, 'journey-no-place', 'Journey tab without a location: dead end ("Set your location first")', 'open Journey tab with no place')
    await openTab(page, 'Flood')
    await shot(page, 'flood-no-place-layer-off', 'Flood tab without a location: layer-off message, no way to pick a place', 'open Flood tab')
    done(); await ctx.close()
  }
  {
    const { ctx, page, done } = await newCtx({ geo: 'hang' })
    await page.goto(BASE, { waitUntil: 'load' }); await settle(page, 800)
    await page.getByRole('button', { name: 'Allow location' }).click(); await settle(page, 800)
    await shot(page, 'first-run-locating', 'Locating… (button disabled while the fix is pending)', 'tap Allow, fix pending')
    done(); await ctx.close()
  }
  // ---------- Loading / error / offline ----------
  {
    const { ctx, page, done } = await newCtx({ delayApis: 6000 })
    await page.goto(BASE, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {})
    await settle(page, 1500)
    await shot(page, 'loading-after-grant', 'Right after granting location: map centred, every data pill still loading ("…"), nothing about the weather yet', 'grant location, APIs slow')
    await setSheet(page, 'half')
    await shot(page, 'loading-timeline-half', 'Timeline tab while radar is still loading', 'open the sheet during load')
    done(); await ctx.close()
  }
  {
    const { ctx, page, done } = await newCtx({ fail: true })
    await page.goto(BASE, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {})
    await settle(page, 4000)
    await setSheet(page, 'half')
    await shot(page, 'error-radar-429', 'Radar/station/rivers APIs answering 429: pills show "!", Timeline shows the error text', 'force 429 from the data hosts')
    await openTab(page, 'Sources')
    await shot(page, 'error-sources-panel', 'Sources panel during the same failure: red dots, error text per source', 'open Sources tab')
    done(); await ctx.close()
  }
  // ---------- Main app (granted) ----------
  const { ctx, page, done } = await newCtx()
  await page.goto(BASE, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {})
  await waitFor(page, () => window.__store?.get().radar.state === 'ready' && window.__store.get().station.state === 'ready' && window.__store.get().rivers.state === 'ready')
  await settle(page, 1500)
  await shot(page, 'home-after-grant', 'Home after location grant: full-screen radar map, collapsed sheet with status pills — no temperature, no conditions, no warnings', 'grant location, wait for data')
  await ctx.setOffline(true); await settle(page, 800)
  await shot(page, 'offline-pill', 'Offline: "Offline — showing last saved data" pill in the status strip', 'go offline')
  await ctx.setOffline(false); await settle(page, 500)
  await setSheet(page, 'half')
  await shot(page, 'sheet-half-timeline', 'Sheet at half: Timeline tab (radar scrubber) is the default panel', 'tap the handle')
  await setSheet(page, 'full')
  await shot(page, 'sheet-full-timeline', 'Sheet at full height: same Timeline content, map reduced to a sliver', 'drag the handle up')
  await setSheet(page, 'half')
  await openTab(page, 'Station')
  await shot(page, 'station-panel', 'Station tab: nearest NWS observation (pressure, humidity, wind, temperature, precip totals) — the only place "current" weather appears', 'open Station tab')
  await openTab(page, 'Rivers')
  await shot(page, 'rivers-panel', 'Rivers tab: gauge list for the current place', 'open Rivers tab')
  await openTab(page, 'Flood')
  await shot(page, 'flood-layer-off', 'Flood tab with the layer off: "The flood risk layer is off" + Turn on', 'open Flood tab')
  await page.getByRole('button', { name: 'Turn on flood risk' }).click(); await settle(page, 1500)
  await shot(page, 'flood-zoomed-out', 'Flood tab after turning the layer on at the default zoom: "Zoom in to a region to load forecast blocks" — no way to pick a place from here', 'tap Turn on')
  await st(page, () => window.__map.jumpTo({ center: [-93.698, 41.673], zoom: 11 }))
  await waitFor(page, () => { const s = window.__store.get(); return s.visibleBlocks.length > 0 && s.visibleBlocks.every((k) => s.blocks[k]?.flood.data) }, 60000)
  await settle(page, 1000)
  await shot(page, 'flood-ready', 'Flood tab with data at zoom 11: cell counts + a long explanation paragraph', 'zoom in to the place')
  await openTab(page, 'Sources')
  await shot(page, 'sources-panel', 'Sources tab: units toggle, motion note, data sources with freshness, Open-Meteo budget, attribution', 'open Sources tab')
  await setSheet(page, 'full')
  await shot(page, 'sources-panel-full', 'Sources tab at full height', 'drag up')
  await setSheet(page, 'half')
  // Timeline variants
  await openTab(page, 'Timeline')
  await page.getByRole('button', { name: /layer menu/ }).click(); await page.getByRole('button', { name: 'Rainfall' }).click(); await page.getByRole('button', { name: /layer menu/ }).click(); await settle(page, 2500)
  await page.getByRole('tab', { name: 'Rainfall' }).click().catch(() => {}); await settle(page, 800)
  await shot(page, 'timeline-rainfall', 'Timeline with Radar + Rainfall + Flood on: layer switcher, horizon chips, scrubber', 'turn Rainfall on, pick it in the timeline')
  // Map taps
  await setSheet(page, 'peek')
  await st(page, () => window.__map.jumpTo({ center: [-93.698, 41.673], zoom: 10 })); await settle(page, 2500)
  await st(page, () => window.__store.set({ layers: { ...window.__store.get().layers, rainfall: false, flood: false } })); await settle(page, 800)
  await page.mouse.click(195, 300); await settle(page, 700)
  if (await page.locator('.map-popup').count()) await shot(page, 'map-tap-point', 'Tap on empty map: "Map point" popup with coordinates, Use as my location / Set as destination', 'tap the map')
  await st(page, () => window.__store.set({ selection: null, layers: { ...window.__store.get().layers, rainfall: true, flood: true } }))
  await waitFor(page, () => { const s = window.__store.get(); return s.visibleBlocks.length > 0 && s.visibleBlocks.every((k) => s.blocks[k]?.flood.data && s.blocks[k]?.rainCells.data) }, 60000); await settle(page, 1500)
  if (await tapFeature(page, 'rain-cells')) await shot(page, 'map-tap-rain-24h', 'Tap on a rain cell: "Expected rainfall · 24 h" dialog with three accumulation lines and "Scrub timeline"', 'tap a coloured rain cell')
  await st(page, () => window.__store.set({ selection: null }))
  if (await tapFeature(page, 'flood-cells')) await shot(page, 'map-tap-flood', 'Tap on a flood cell: risk popup with "How this is scored"', 'tap a flood cell')
  await st(page, () => window.__store.set({ selection: null, layers: { ...window.__store.get().layers, rainfall: false, flood: false } }))
  await st(page, () => window.__map.jumpTo({ center: [-93.698, 41.673], zoom: 9 })); await settle(page, 2000)
  if (await tapFeature(page, 'river-gauges')) await shot(page, 'map-tap-gauge', 'Tap on a river gauge: stage/flood category popup with "All gauges"', 'tap a gauge dot')
  await st(page, () => window.__store.set({ selection: null }))
  if (await tapFeature(page, 'station-marker')) await shot(page, 'map-tap-station', 'Tap on the station marker: observation popup with "Full observation"', 'tap the station marker')
  await st(page, () => window.__store.set({ selection: null }))
  // Layer menu, legend, satellite, nowcast, 3D
  await page.getByRole('button', { name: /layer menu/ }).click(); await settle(page, 400)
  await shot(page, 'layer-menu', 'Layer menu (☰): imagery radio, five toggles, 3D, legend, units, move-corner', 'tap ☰')
  await page.getByRole('radio', { name: 'Satellite' }).click(); await settle(page, 2500)
  await shot(page, 'layer-menu-satellite', 'Satellite selected: product sub-item appears; GOES imagery behind', 'tap Satellite')
  await page.getByRole('radio', { name: 'Radar' }).click(); await page.getByRole('button', { name: 'Nowcast' }).click(); await page.getByRole('button', { name: 'Rainfall' }).click(); await page.getByRole('button', { name: 'Flood risk' }).click()
  await page.getByRole('button', { name: /Legend/ }).click(); await page.getByRole('button', { name: /layer menu/ }).click(); await settle(page, 3500)
  await shot(page, 'legend-all-layers', 'Legend open with radar, rainfall, flood, rivers and nowcast on', 'turn everything on, open Legend')
  await st(page, () => window.__store.set({ legendOpen: false }))
  await setSheet(page, 'half'); await page.getByRole('tab', { name: 'Nowcast' }).click().catch(() => {}); await settle(page, 1500)
  await shot(page, 'timeline-nowcast', 'Timeline on Nowcast: wind streaks + cloud on the map, 10-min frames', 'pick Nowcast in the timeline')
  await setSheet(page, 'peek')
  await st(page, () => window.__store.set({ is3D: true })); await settle(page, 4000)
  await shot(page, '3d-terrain', '3D terrain on', 'toggle 3D in the layer menu')
  await st(page, () => window.__store.set({ is3D: false, layers: { ...window.__store.get().layers, nowcast: false, rainfall: false, flood: false } })); await settle(page, 1500)
  // Follow mode
  await st(page, () => window.__map.jumpTo({ center: [-92.0, 41.0], zoom: 9 })); await settle(page, 2500)
  await shot(page, 'follow-mode', 'Panned away from the place: "Showing map area · back to my spot" pill; data now follows the map centre', 'pan the map')
  await st(page, () => window.__store.set((s) => ({ recenterNonce: s.recenterNonce + 1 }))); await settle(page, 2000)
  // Toast + layer unavailable + panel unavailable
  await st(page, () => { const m = window.__map; const o = m.addSource.bind(m); m.addSource = (id, spec) => { if (id === 'rain-cells') throw new Error('source rejected'); return o(id, spec) } })
  await page.getByRole('button', { name: /layer menu/ }).click(); await page.getByRole('button', { name: 'Rainfall' }).click(); await settle(page, 1500)
  await shot(page, 'layer-unavailable', 'A layer failed: switched off, "unavailable — reason" in the menu, toast at the bottom', 'inject a layer failure')
  await page.getByRole('button', { name: /layer menu/ }).click()
  await st(page, () => window.__store.set({ toast: null }))
  await st(page, () => window.__store.set((x) => { const g = { ...x.rivers.data[0] }; Object.defineProperty(g, 'name', { get() { throw new Error('bad gauge record') }, enumerable: true }); return { rivers: { ...x.rivers, data: [g, ...x.rivers.data.slice(1)] } } }))
  await setSheet(page, 'half'); await openTab(page, 'Rivers')
  await shot(page, 'panel-unavailable', 'A panel failed: "Rivers unavailable — reason" with Retry; tabs and map keep working', 'inject a panel failure')
  await st(page, () => window.__store.set((x) => ({ rivers: { ...x.rivers, data: x.rivers.data.slice(1) } })))
  // Journey
  await openTab(page, 'Journey')
  await shot(page, 'journey-empty', 'Journey tab, no destination: search field, departure chips, hint to tap the map', 'open Journey')
  await page.getByRole('searchbox', { name: 'Destination' }).fill('Iowa City'); await settle(page, 1200)
  await shot(page, 'journey-search-results', 'Journey destination results', 'type a destination')
  await page.getByRole('option').first().click()
  await waitFor(page, () => { const j = window.__store.get().journey; return j.weather.state === 'ready' && j.road.state === 'ready' && j.hazards.state === 'ready' }, 90000)
  await settle(page, 1000)
  await shot(page, 'journey-route-half', 'Journey with route + forecast at half height: arrival card, worst-along-the-way, strip; route on the map above', 'pick the destination')
  await setSheet(page, 'full'); await settle(page, 500)
  await shot(page, 'journey-route-full', 'Journey at full height', 'drag up')
  await page.locator('.sheet-body').evaluate((el) => el.scrollTo(0, el.scrollHeight)); await settle(page, 500)
  await shot(page, 'journey-hazards-road', 'Journey scrolled to Hazards on this route + Road conditions (RWIS chips)', 'scroll the panel')
  await page.getByRole('radio', { name: 'Pick…' }).click(); await settle(page, 400)
  await page.locator('.sheet-body').evaluate((el) => el.scrollTo(0, 0)); await settle(page, 300)
  await shot(page, 'journey-departure-picker', 'Custom departure: datetime field under the chips', 'tap Pick…')
  await setSheet(page, 'peek'); await settle(page, 500)
  await shot(page, 'journey-map-route', 'Map with the route, alternates, sample dots and destination; sheet collapsed', 'collapse the sheet')
  await tapFeature(page, 'journey-samples')
  if (await page.locator('.map-popup').count()) await shot(page, 'map-tap-journey-sample', 'Tap on a route sample: ETA + conditions popup', 'tap a sample dot')
  await st(page, () => window.__store.set({ selection: null }))
  await page.mouse.click(120, 420); await settle(page, 600)
  if (await page.locator('.map-popup').count()) await shot(page, 'map-tap-point-with-journey', 'Tap on empty map while a journey exists: same "Map point" popup', 'tap the map')
  await st(page, () => window.__store.set({ selection: null }))
  await page.goto(`${BASE}?replay=2024-12-14-ice-storm`, { waitUntil: 'load' })
  await waitFor(page, () => window.__store.get().journey.weather.state === 'ready', 60000); await settle(page, 1000)
  await setSheet(page, 'half'); await openTab(page, 'Journey')
  await shot(page, 'journey-replay-banner', 'Replay fixture banner at the top of the Journey panel', 'open ?replay=…')
  done(); await ctx.close()
  // ---------- Tablet + desktop home ----------
  for (const [name, vp, mobile] of [['tablet-home', { width: 768, height: 1024 }, true], ['desktop-home', { width: 1280, height: 800 }, false]]) {
    const { ctx, page, done } = await newCtx({ viewport: vp, mobile, dpr: 1 })
    await page.goto(BASE, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {})
    await waitFor(page, () => window.__store?.get().radar.state === 'ready'); await settle(page, 1500)
    await setSheet(page, 'half')
    await shot(page, name, `${name === 'tablet-home' ? 'Tablet portrait' : 'Desktop'}: same phone layout stretched — sheet across the full width, FAB and legend chips`, 'grant location, open the sheet')
    done(); await ctx.close()
  }
} finally {
  writeFileSync(`${OUT}/inventory.json`, JSON.stringify(shots, null, 2))
  await browser.close()
  console.log(`${shots.length} screens → ${OUT}`)
}
