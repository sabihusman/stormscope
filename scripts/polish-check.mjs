// The Oct 18 polish: pop-ups (point chip, monitor chooser) and the layers panel fade and slide 150 ms in and
// out and end in the right state; Reduce Motion turns every transition and animation off; the Now cards keep
// their loaded height while loading (no layout jump); the Now map box shows "Loading map…" with a shimmer until
// its first still and then "Map as of <time>"; one ring pulse on the tapped monitor dot (300 ms).
//   node scripts/polish-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  polish-check.mjs: mocked only (fixed data, delayed hosts)')
  process.exit(3)
}
assertBudget('polish-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/polish'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const FOCUS = { lat: 41.673, lng: -93.698 }
const SERVICE = 'https://monitors.stormscope.test/v1'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

async function session({ reducedMotion = 'no-preference', delayHosts = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion, geolocation: { latitude: FOCUS.lat, longitude: FOCUS.lng }, permissions: ['geolocation'] })
  await ctx.addInitScript((u) => { try { localStorage.setItem('stormscope.monitorService', u) } catch {} }, SERVICE)
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'polish-check.mjs (mock)')
  await installMocks(ctx, { delayHosts })
  await page.goto(BASE, { waitUntil: 'load' })
  // Not awaited: the helper waits up to 4 s for a dialog that may not appear, and the loading scenario must look before the data lands.
  const grant = allowLocation(page)
  if (!Object.keys(delayHosts).length) await grant
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(100) } return false }
  return { ctx, page, done, until }
}
/** Computed opacity, transform, transition duration and data-state of a selector (null when absent). */
const probe = (page, sel) => page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return { opacity: Number(cs.opacity), transform: cs.transform, duration: cs.transitionDuration, animation: cs.animationName, state: el.dataset.state ?? null } }, sel)
/**
 * Arm BEFORE the action: a MutationObserver records the pop-up's data-state and computed opacity the moment it is
 * inserted (the observer runs before the next paint, so this is the true start position whatever the latency),
 * every data-state change, every transitionend / animationend on it, and its removal. Nothing waits a fixed time.
 */
const arm = (page, sel) => page.evaluate((sel) => {
  const rec = { appeared: null, states: [], ends: [], removed: false }
  window.__tx = rec
  const attach = (el) => {
    rec.appeared = { state: el.dataset.state ?? null, opacity: Number(getComputedStyle(el).opacity) }
    el.addEventListener('transitionend', (e) => rec.ends.push({ prop: e.propertyName, state: el.dataset.state ?? null, opacity: Number(getComputedStyle(el).opacity) }))
    el.addEventListener('animationend', (e) => rec.ends.push({ prop: 'animation:' + e.animationName, state: null, opacity: Number(getComputedStyle(el).opacity) }))
    new MutationObserver(() => rec.states.push(el.dataset.state ?? null)).observe(el, { attributes: true, attributeFilter: ['data-state'] })
  }
  const existing = document.querySelector(sel)
  if (existing) attach(existing)
  new MutationObserver(() => { const el = document.querySelector(sel); if (el && !rec.appeared) attach(el); if (!el && rec.appeared) rec.removed = true }).observe(document.body, { childList: true, subtree: true })
}, sel)
/** Wait until the armed record satisfies `cond` (an expression over `r`), then return the record. */
const settled = async (page, cond, timeout = 4000) => {
  await page.waitForFunction((c) => { const r = window.__tx; return !!r && new Function('r', 'return ' + c)(r) }, cond, { timeout }).catch(() => {})
  return page.evaluate(() => { const r = window.__tx; return { appeared: r.appeared, states: r.states, ends: r.ends, removed: r.removed } })
}
const opened = (r) => r.appeared?.state === 'opening' && r.appeared.opacity < 1 && r.ends.some((e) => e.prop === 'opacity' && e.state === 'open' && e.opacity === 1)
const closed = (r) => r.states.includes('closing') && r.ends.some((e) => e.prop === 'opacity' && e.state === 'closing' && e.opacity === 0) && r.removed
const brief = (r) => `appeared ${JSON.stringify(r.appeared)} states ${r.states.join('>')} ends ${r.ends.map((e) => `${e.prop}@${e.state}:${e.opacity}`).join(',')} removed ${r.removed}`

// ---- 1. Transitions run and end in the right state (motion allowed).
{
  const { ctx, page, done, until } = await session()
  await until(() => window.__store?.get().conditions.state === 'ready')
  await openMap(page)
  // Point chip: tap the map → opening → open (opacity 1, no transform) within 300 ms; × → closing → gone within 300 ms.
  const box = await page.locator('.maplibregl-canvas').boundingBox()
  // Armed before the tap: the chip must be inserted in its "opening" start position (opacity below 1) and its opacity transition must end in the "open" state at opacity 1.
  await arm(page, '.point-chip')
  await page.touchscreen.tap(box.x + 120, box.y + 300)
  const chipTx = await settled(page, "r.ends.some((e) => e.prop === 'opacity')")
  const chipOpen = await probe(page, '.point-chip')
  check('Point chip opens with the 150 ms transition: inserted at the "opening" start position (opacity < 1), the opacity transition ends in "open" at opacity 1, no transform, 150 ms', opened(chipTx) && chipOpen?.state === 'open' && chipOpen.opacity === 1 && chipOpen.transform === 'none' && chipOpen.duration.startsWith('0.15s'), `${brief(chipTx)} … ${JSON.stringify(chipOpen)}`)
  await arm(page, '.point-chip')
  await page.getByRole('button', { name: 'Dismiss' }).tap()
  const chipClose = await settled(page, 'r.removed')
  check('Point chip closes with the transition: data-state "closing", the opacity transition ends at 0 while closing, then it is unmounted', closed(chipClose) && !(await probe(page, '.point-chip')), brief(chipClose))
  // Layers panel: open → "open" at opacity 1; close → closing → gone.
  await arm(page, '.fab-menu')
  await page.getByRole('button', { name: 'Open layer menu' }).tap()
  const panelTx = await settled(page, "r.ends.some((e) => e.prop === 'opacity')")
  const panelOpen = await probe(page, '.fab-menu')
  check('Layers panel opens with the transition: inserted at the "opening" start position, the opacity transition ends in "open" at opacity 1, no transform, 150 ms', opened(panelTx) && panelOpen?.state === 'open' && panelOpen.opacity === 1 && panelOpen.transform === 'none' && panelOpen.duration.startsWith('0.15s'), `${brief(panelTx)} … ${JSON.stringify(panelOpen)}`)
  await arm(page, '.fab-menu')
  await page.getByRole('button', { name: 'Close layer menu' }).tap()
  const panelClose = await settled(page, 'r.removed')
  check('Layers panel closes with the transition ("closing", the opacity transition ends at 0), then unmounts', closed(panelClose), brief(panelClose))
  // Monitor chooser + dot pulse: Ozone discs and dots on, place zoom, finger tap between the two close dots.
  await page.getByRole('button', { name: 'Open layer menu' }).tap()
  await page.getByText('Air monitors (AirNow)').tap()
  await page.locator('[data-aq="OZONE"]').tap()
  await page.getByRole('button', { name: 'Close layer menu' }).tap()
  await page.evaluate(() => { const p = window.__store.get().place.lngLat; window.__map.jumpTo({ center: [p.lng, p.lat], zoom: 9.5 }) })
  await until(() => !window.__map.isMoving() && window.__store.get().monitors.state === 'ready' && window.__map.querySourceFeatures('air-monitors').length > 0, 20000)
  await page.waitForTimeout(600)
  const pt = await page.evaluate(() => { const s = window.__store.get().monitors.data.sites.find((x) => x.id === 'mock-ozone-only'); const p = window.__map.project([s.lngLat.lng, s.lngLat.lat]); return { x: p.x, y: p.y } })
  await arm(page, '.dot-chooser')
  await page.touchscreen.tap(box.x + pt.x + 9, box.y + pt.y + 8)
  const chooserTx = await settled(page, "r.ends.some((e) => e.prop === 'opacity')")
  const chooserOpen = await probe(page, '.dot-chooser')
  check('Monitor chooser opens with the transition: inserted at the "opening" start position, the opacity transition ends in "open" at opacity 1, no transform, 150 ms', opened(chooserTx) && chooserOpen?.state === 'open' && chooserOpen.opacity === 1 && chooserOpen.transform === 'none' && chooserOpen.duration.startsWith('0.15s'), `${brief(chooserTx)} … ${JSON.stringify(chooserOpen)}`)
  await arm(page, '.dot-pulse')
  await page.locator('.dot-chooser .chooser-row[data-site="mock-ozone-only"]').tap()
  const pulseTx = await settled(page, 'r.removed')
  check('Picking a monitor: one ring pulse appears on the dot, its 300 ms animation ends, and it is removed', !!pulseTx.appeared && pulseTx.ends.some((e) => e.prop === 'animation:dot-pulse') && pulseTx.removed, brief(pulseTx))
  const pulseAnim = await page.evaluate(() => { const el = document.createElement('div'); el.className = 'dot-pulse'; document.body.appendChild(el); const a = getComputedStyle(el).animationName; const d = getComputedStyle(el).animationDuration; el.remove(); return { a, d } })
  check('The pulse is a 300 ms scale/opacity animation', pulseAnim.a === 'dot-pulse' && pulseAnim.d === '0.3s', JSON.stringify(pulseAnim))
  await page.waitForFunction(() => !document.querySelector('.dot-chooser') && document.querySelector('.point-chip')?.dataset.state === 'open', null, { timeout: 4000 }).catch(() => {})
  check('Picking closed the chooser and the chip opened', !(await probe(page, '.dot-chooser')) && (await probe(page, '.point-chip'))?.state === 'open')
  await page.screenshot({ path: `${OUT}/chip-open.png` })
  done()
  await ctx.close()
}

// ---- 2. Reduce Motion: no transition or animation anywhere; pop-ups close at once.
{
  const { ctx, page, done, until } = await session({ reducedMotion: 'reduce' })
  await until(() => window.__store?.get().conditions.state === 'ready')
  const mapLoading = await page.evaluate(() => { const el = document.querySelector('.now-map-window .shimmer'); return el ? getComputedStyle(el).animationName : 'absent' })
  check('Reduce Motion: the map-box shimmer has no animation (or the still is already drawn)', mapLoading === 'none' || mapLoading === 'absent', mapLoading)
  await openMap(page)
  const box = await page.locator('.maplibregl-canvas').boundingBox()
  await page.touchscreen.tap(box.x + 120, box.y + 300)
  await page.waitForTimeout(80)
  const chip = await probe(page, '.point-chip')
  check('Reduce Motion: the chip has a 0 s transition and is fully shown at once', chip?.duration === '0s' && chip.opacity === 1 && chip.transform === 'none', JSON.stringify(chip))
  await page.getByRole('button', { name: 'Dismiss' }).tap()
  await page.waitForTimeout(40)
  check('Reduce Motion: the chip is gone right after Dismiss (no exit wait)', !(await probe(page, '.point-chip')))
  await page.getByRole('button', { name: 'Open layer menu' }).tap()
  await page.waitForTimeout(80)
  const panel = await probe(page, '.fab-menu')
  await page.getByRole('button', { name: 'Close layer menu' }).tap()
  await page.waitForTimeout(40)
  check('Reduce Motion: the layers panel has a 0 s transition and unmounts at once on close', panel?.duration === '0s' && panel.opacity === 1 && !(await probe(page, '.fab-menu')), JSON.stringify(panel))
  const pulseAnim = await page.evaluate(() => { const el = document.createElement('div'); el.className = 'dot-pulse'; document.body.appendChild(el); const a = getComputedStyle(el).animationName; el.remove(); return a })
  check('Reduce Motion: the dot pulse has no animation (a still ring)', pulseAnim === 'none', pulseAnim)
  done()
  await ctx.close()
}

// ---- 3. Now tab while loading: placeholders hold the loaded height (no jump); the map box's loading state and time.
{
  const { ctx, page, done, until } = await session({ delayHosts: { 'api.open-meteo.com': 7000, 'monitors.stormscope.test': 7000, 'tiles.openfreemap.org': 7000 } })
  // The cards exist (the place is set) while the delayed data is still on its way.
  await until(() => !!document.querySelector('.now-card.conditions') && window.__store.get().conditions.state !== 'ready', 15000)
  await page.waitForTimeout(300)
  const tops = () => page.evaluate(() => { const q = (s) => document.querySelector(s)?.getBoundingClientRect().top ?? null; return { map: q('.now-map-window'), trip: q('.now-actions'), tiles: q('.tiles'), busy: [...document.querySelectorAll('.now-card[aria-busy="true"]')].map((e) => e.className.split(' ').pop()), loadingText: document.querySelector('.now-map-window .map-loading-text')?.textContent ?? null, shimmer: document.querySelector('.now-map-window .shimmer') ? getComputedStyle(document.querySelector('.now-map-window .shimmer')).animationName : null, asof: document.querySelector('.now-map-window .map-asof')?.textContent ?? null } })
  const t0 = await tops()
  check('While loading: the conditions, next-12-h, 7-day and air-quality cards are busy placeholders, the map box says "Loading map…" with a running shimmer, no "Map as of" yet', t0.busy.length >= 3 && t0.loadingText === 'Loading map…' && t0.shimmer === 'map-shimmer' && !t0.asof, JSON.stringify(t0))
  await until(() => window.__store.get().conditions.state === 'ready' && window.__store.get().monitorsNear.state === 'ready', 30000)
  await until(() => (window.__mapWindow?.drawn ?? 0) > 0, 20000)
  await page.waitForTimeout(500)
  const t1 = await tops()
  check('When the data lands nothing below the cards moves: the map box, the Trip button and the tiles keep their positions (±2 px)', Math.abs(t1.map - t0.map) <= 2 && Math.abs(t1.trip - t0.trip) <= 2 && Math.abs(t1.tiles - t0.tiles) <= 2 && t1.busy.length === 0, `map ${t0.map}→${t1.map}, trip ${t0.trip}→${t1.trip}, tiles ${t0.tiles}→${t1.tiles}`)
  const clockNow = await page.evaluate(() => new Date(window.__mapWindow.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
  check('After the first still: "Loading map…" is gone and the time of the still shows on the picture ("Map as of <time>")', !t1.loadingText && t1.asof === `Map as of ${clockNow}`, `${t1.asof} (expected ${clockNow})`)
  await page.screenshot({ path: `${OUT}/now-loaded.png` })
  done()
  await ctx.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
