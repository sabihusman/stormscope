// Hands-on walkthrough of every feature on three viewports, headed Chrome (real GPU), recording per
// feature: time to usable, interactions > 200 ms, dropped frames, console errors, a screenshot.
//
//   node scripts/walkthrough.mjs <base-url> [out-dir] [--mock] [--viewport=phone|tablet|desktop] [--no-throttle]
//
// --mock answers every API locally (zero live calls, see scripts/lib/mock-server.mjs). Phone and tablet
// run with CPU 4× (calibrated); desktop unthrottled. A hidden/throttled window marks the run INVALID.
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { touchDrag, touchTap, centre } from './lib/touch.mjs'
import { installMocks } from './lib/mock-server.mjs'

const args = process.argv.slice(2)
const MOCK = args.includes('--mock')
const NO_THROTTLE = args.includes('--no-throttle')
const only = args.find((a) => a.startsWith('--viewport='))?.slice(11)
const positional = args.filter((a) => !a.startsWith('--'))
assertBudget('walkthrough.mjs', { openMeteo: !MOCK })
const BASE = (positional[0] || 'http://localhost:4173/').replace(/\/?$/, '/')
const OUT = positional[1] || 'e2e-shots/walkthrough'
mkdirSync(OUT, { recursive: true })

const VIEWPORTS = {
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3, throttle: 4, window: '430,900' },
  tablet: { width: 800, height: 1280, isMobile: true, hasTouch: true, deviceScaleFactor: 2, throttle: 4, window: '840,1340' },
  desktop: { width: 1366, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1, throttle: 1, window: '1400,900' },
}
const FOCUS = { lat: 41.673, lng: -93.698 }
const report = { base: BASE, mock: MOCK, at: new Date().toISOString(), viewports: {} }

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  if (only && only !== vpName) continue
  const dir = `${OUT}/${vpName}`
  mkdirSync(dir, { recursive: true })
  const browser = await chromium.launch({ headless: false, channel: 'chrome', args: [`--window-size=${vp.window}`, '--window-position=20,20'] }).catch(() => chromium.launch({ headless: false, args: [`--window-size=${vp.window}`] }))
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor, geolocation: { latitude: FOCUS.lat, longitude: FOCUS.lng }, permissions: ['geolocation'], serviceWorkers: 'allow' })
  const page = await ctx.newPage()
  const done = MOCK ? () => {} : trackTraffic(page, `walkthrough.mjs ${vpName}`)
  if (MOCK) await installMocks(ctx, { focus: FOCUS })
  const cdp = await ctx.newCDPSession(page)
  const consoleErrors = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200)))
  page.on('pageerror', (e) => consoleErrors.push('[pageerror] ' + e.message.slice(0, 200)))

  // Environment: visible? frame rate? throttle calibrated?
  await page.goto('about:blank')
  const env = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const loop = () => (performance.now() - t0 < 1000 ? (n++, requestAnimationFrame(loop)) : res({ visibility: document.visibilityState, rafPerSecond: n })); requestAnimationFrame(loop) }))
  const bench = () => page.evaluate(() => { const t0 = performance.now(); let x = 0; for (let i = 0; i < 2e7; i++) x += Math.sqrt(i); return Math.round(performance.now() - t0) })
  const base = await bench()
  const rate = NO_THROTTLE ? 1 : vp.throttle
  await cdp.send('Emulation.setCPUThrottlingRate', { rate })
  const thr = await bench()
  env.cpu = { rate, ratio: +(thr / base).toFixed(1) }
  env.valid = env.visibility === 'visible' && env.rafPerSecond >= 30 && (rate === 1 || env.cpu.ratio >= 3)
  console.log(`\n=== ${vpName} ${vp.width}×${vp.height} dpr${vp.deviceScaleFactor} cpu×${rate} — ${JSON.stringify(env)}${env.valid ? '' : '  *** INVALID (hidden/throttled) ***'}`)
  const features = []
  const vpReport = { env, features }
  report.viewports[vpName] = vpReport

  // Probes installed before the app: event timing (INP), long tasks, frame sampler keyed by feature.
  await ctx.addInitScript(() => {
    window.__wt = { label: 'load', events: [], long: [], frames: {} }
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId && e.duration > 200) window.__wt.events.push({ label: window.__wt.label, name: e.name, dur: Math.round(e.duration), target: (e.target?.tagName || '') + '.' + (e.target?.className || '') }) }).observe({ type: 'event', buffered: true, durationThreshold: 104 })
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__wt.long.push({ label: window.__wt.label, dur: Math.round(e.duration) }) }).observe({ type: 'longtask', buffered: true })
    let last = performance.now()
    const loop = (t) => { const f = (window.__wt.frames[window.__wt.label] ??= { n: 0, over50: 0, over100: 0, max: 0 }); const d = t - last; last = t; f.n++; if (d > 50) f.over50++; if (d > 100) f.over100++; if (d > f.max) f.max = Math.round(d); requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
  })
  const setLabel = (l) => page.evaluate((l) => { window.__wt.label = l }, l).catch(() => {})
  const readWt = () => page.evaluate(() => ({ events: window.__wt.events, long: window.__wt.long, frames: window.__wt.frames }))

  /** Run one feature step: label it, time until `ready()` holds (time to usable), collect numbers, screenshot. */
  const feature = async (name, run, ready, { timeoutMs = 30000, shot = true } = {}) => {
    const errBefore = consoleErrors.length
    await setLabel(name)
    const t0 = Date.now()
    let runError = null
    try {
      await run()
    } catch (e) {
      runError = e.message.split('\n')[0].slice(0, 160)
    }
    let usable = null
    if (ready) {
      while (Date.now() - t0 < timeoutMs) {
        let ok = false
        try { ok = await ready() } catch { ok = false }
        if (ok) { usable = Date.now() - t0; break }
        await page.waitForTimeout(100)
      }
    } else usable = Date.now() - t0
    await page.waitForTimeout(400)
    const wt = await readWt().catch(() => ({ events: [], long: [], frames: {} }))
    const file = shot ? `${dir}/${String(features.length + 1).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png` : null
    if (file) await page.screenshot({ path: file }).catch(() => {})
    const f = wt.frames[name] ?? { n: 0, over50: 0, over100: 0, max: 0 }
    const rec = { name, timeToUsableMs: usable, timedOut: ready ? usable == null : false, runError, slowInteractions: wt.events.filter((e) => e.label === name), longTasks: wt.long.filter((l) => l.label === name).map((l) => l.dur), frames: f, consoleErrors: consoleErrors.slice(errBefore), screenshot: file }
    features.push(rec)
    console.log(`${(usable == null ? 'TIMEOUT' : usable + 'ms').padStart(8)}  ${name.padEnd(42)} slow:${rec.slowInteractions.map((e) => e.dur).join('/') || '-'} long>200:${rec.longTasks.filter((d) => d > 200).length} frames>50:${f.over50}(max ${f.max}) err:${rec.consoleErrors.length}${runError ? '  RUN-ERROR ' + runError : ''}`)
    return rec
  }
  const st = (fn) => page.evaluate(fn)
  const tap = async (locator) => { await locator.scrollIntoViewIfNeeded().catch(() => {}); const c = await centre(locator); if (!c) throw new Error('no target'); if (vp.hasTouch) await touchTap(page, c); else await locator.click() }
  const drag = async (from, to) => { if (vp.hasTouch) await touchDrag(page, from, to); else { await page.mouse.move(from.x, from.y); await page.mouse.down(); for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10); await page.mouse.up() } }
  const openMenu = () => tap(page.getByRole('button', { name: /layer menu/ }))
  const mapLoaded = () => st(() => !!window.__map && window.__map.loaded())
  const sheetMode = () => st(() => window.__store.get().sheet)

  // ---------------- first load, offline reload
  await feature('first load', async () => { await page.goto(BASE, { waitUntil: 'load' }); await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {}) }, () => st(() => !!window.__map?.loaded() && !!window.__store?.get().radar.data))
  await feature('station + rivers data', async () => {}, () => st(() => window.__store.get().station.state === 'ready' && window.__store.get().rivers.state === 'ready'))
  await page.waitForTimeout(6000) // let the service worker take control and warm its cache
  await feature('offline reload', async () => { await ctx.setOffline(true); await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}) }, () => st(() => !!document.querySelector('.maplibregl-canvas') && document.body.innerText.includes('Offline')), { timeoutMs: 20000 })
  await ctx.setOffline(false)
  await feature('back online', async () => { await page.reload({ waitUntil: 'load' }); await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 3000 }).catch(() => {}) }, () => st(() => !!window.__map?.loaded() && !!window.__store?.get().radar.data))

  // ---------------- pan / zoom across tile levels
  for (const z of [3, 5, 8, 11, 14]) {
    await feature(`zoom ${z} + pan`, async () => {
      await st((z) => window.__map.jumpTo({ zoom: z, center: [-93.698, 41.673] }), z)
      await page.waitForTimeout(600)
      const cx = vp.width / 2, cy = Math.round(vp.height * 0.35)
      await drag({ x: cx, y: cy }, { x: cx - 120, y: cy - 60 })
      await page.waitForTimeout(300)
      await drag({ x: cx - 120, y: cy - 60 }, { x: cx, y: cy })
    }, () => st(() => window.__map.loaded() && !window.__map.isMoving()), { timeoutMs: 15000 })
  }
  await st(() => window.__map.jumpTo({ zoom: 9.5, center: [-93.698, 41.673] }))
  await page.waitForTimeout(800)

  // ---------------- radar play / pause / scrub
  await feature('radar play', async () => { await tap(page.getByRole('tab', { name: 'Timeline' })); await page.waitForTimeout(400); await tap(page.getByRole('button', { name: 'Play' })); await page.waitForTimeout(5000) }, () => st(() => window.__store.get().playing))
  await feature('radar pause + scrub', async () => { await tap(page.getByRole('button', { name: 'Pause' })); await page.getByRole('slider').focus(); await page.keyboard.press('Home'); await page.waitForTimeout(500); await page.keyboard.press('End'); await page.waitForTimeout(500) }, () => st(() => !window.__store.get().playing))

  // ---------------- satellite GeoColor / IR + switch with time carry
  await feature('satellite GeoColor', async () => { await openMenu(); await tap(page.getByRole('radio', { name: /Satellite/ })); await page.waitForTimeout(300); await openMenu() }, () => st(() => window.__store.get().layers.satellite && (window.__store.get().satellite.data?.times.length ?? 0) > 0 && !window.__store.get().imageryCarry), { timeoutMs: 40000 })
  await feature('satellite IR', async () => { await openMenu(); await tap(page.getByRole('button', { name: /Satellite product/ })); await page.waitForTimeout(300); await openMenu() }, () => st(() => window.__store.get().satProduct !== 'geocolor' && (window.__store.get().satellite.data?.times.length ?? 0) > 0), { timeoutMs: 20000 })
  await feature('satellite → radar (time carry)', async () => { await openMenu(); await tap(page.getByRole('radio', { name: /Radar/ })); await page.waitForTimeout(300); await openMenu() }, () => st(() => window.__store.get().layers.radar && !window.__store.get().layers.satellite && !window.__store.get().imageryCarry), { timeoutMs: 30000 })

  // ---------------- rainfall, flood, nowcast + particles, 3D
  await feature('rainfall + flood layers', async () => { await openMenu(); await tap(page.getByRole('button', { name: 'Rainfall' })); await tap(page.getByRole('button', { name: 'Flood risk' })); await page.waitForTimeout(300); await openMenu() }, () => st(() => { const s = window.__store.get(); const v = s.visibleBlocks; return v.length > 0 && v.every((k) => s.blocks[k]?.rainCells.data && s.blocks[k]?.flood.data) }), { timeoutMs: 60000 })
  await feature('nowcast + wind particles playing', async () => { await openMenu(); await tap(page.getByRole('button', { name: 'Nowcast' })); await page.waitForTimeout(300); await openMenu(); await tap(page.getByRole('tab', { name: 'Timeline' })); await page.waitForTimeout(300); const nt = page.getByRole('tab', { name: 'Nowcast' }); if (await nt.count()) await tap(nt); await page.waitForTimeout(300); await tap(page.getByRole('button', { name: 'Play' })); await page.waitForTimeout(5000) }, () => st(() => { const s = window.__store.get(); return s.visibleBlocks.every((k) => s.blocks[k]?.nowcast.data) && s.playing }), { timeoutMs: 60000 })
  await feature('nowcast pause', async () => { await tap(page.getByRole('button', { name: 'Pause' })) }, () => st(() => !window.__store.get().playing))
  await feature('3D terrain on', async () => { await openMenu(); await tap(page.getByRole('button', { name: /3D terrain/ })); await page.waitForTimeout(300); await openMenu(); await page.waitForTimeout(1500) }, () => st(() => window.__map.getPitch() > 50 && !window.__map.isMoving()), { timeoutMs: 15000 })
  await feature('3D terrain off', async () => { await openMenu(); await tap(page.getByRole('button', { name: /3D terrain/ })); await page.waitForTimeout(300); await openMenu(); await page.waitForTimeout(1200) }, () => st(() => window.__map.getPitch() === 0))
  await feature('layers off again', async () => { await openMenu(); for (const n of ['Rainfall', 'Flood risk', 'Nowcast']) await tap(page.getByRole('button', { name: n })); await page.waitForTimeout(300); await openMenu() }, () => st(() => { const s = window.__store.get().layers; return !s.rainfall && !s.flood && !s.nowcast }))

  // ---------------- rivers / station panels
  await feature('rivers panel', async () => { await tap(page.getByRole('tab', { name: 'Rivers' })) }, () => st(() => (window.__store.get().rivers.data?.length ?? 0) > 0 && document.querySelector('.gauge-list') != null))
  await feature('gauge popup', async () => { const g = page.locator('.gauge-row').first(); if (await g.count()) await tap(g) }, () => st(() => !!window.__store.get().selection))
  await feature('station panel', async () => { await tap(page.getByRole('tab', { name: 'Station' })) }, () => st(() => window.__store.get().station.state === 'ready' && document.querySelector('.stat-grid') != null))

  // ---------------- layer menu + movable button
  await feature('layer menu open/close', async () => { await openMenu(); await page.waitForTimeout(400); await openMenu() }, null)
  await feature('move layer button to top-left', async () => { const fab = await centre(page.getByRole('button', { name: /layer menu/ })); await drag(fab, { x: 40, y: 120 }); await page.waitForTimeout(600) }, () => st(() => window.__store.get().fabCorner === 'tl'))
  await feature('move layer button back', async () => { const fab = await centre(page.getByRole('button', { name: /layer menu/ })); await drag(fab, { x: vp.width - 40, y: vp.height - 120 }); await page.waitForTimeout(600) }, () => st(() => window.__store.get().fabCorner === 'br'))

  // ---------------- bottom sheet: every tab; collapse by drag, tap, ▼, swipe, back
  for (const t of ['Timeline', 'Journey', 'Station', 'Rivers', 'Flood', 'Sources']) {
    await feature(`sheet ${t}: open full + collapse (drag/tap/▼/swipe/back)`, async () => {
      await tap(page.getByRole('tab', { name: t }))
      await page.waitForTimeout(400)
      const h = await centre(page.locator('.sheet-handle'))
      await drag(h, { x: h.x, y: h.y - 240 })
      await page.waitForTimeout(400)
      const body = await centre(page.locator('.sheet-body'))
      if (body) await drag({ x: body.x, y: body.y + 150 }, { x: body.x, y: body.y - 150 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/sheet-${t.toLowerCase()}-full.png` }).catch(() => {})
      let h2 = await centre(page.locator('.sheet-handle'))
      await drag(h2, { x: h2.x, y: h2.y + 200 })
      await page.waitForTimeout(400)
      h2 = await centre(page.locator('.sheet-handle'))
      await drag(h2, { x: h2.x, y: h2.y + 200 })
      await page.waitForTimeout(400)
      const m1 = await sheetMode()
      await tap(page.getByRole('tab', { name: t }))
      await page.waitForTimeout(300)
      await tap(page.locator('.sheet-handle'))
      await page.waitForTimeout(300)
      const m2 = await sheetMode()
      await tap(page.getByRole('tab', { name: t }))
      await page.waitForTimeout(300)
      await tap(page.getByRole('button', { name: 'Collapse panel' }))
      await page.waitForTimeout(300)
      const m3 = await sheetMode()
      await tap(page.getByRole('tab', { name: t }))
      await page.waitForTimeout(300)
      await page.evaluate(() => { const b = document.querySelector('.sheet-body'); if (b) b.scrollTop = 0 }) // swipe-down collapses only from the top of the content
      const b2 = await centre(page.locator('.sheet-body'))
      if (vp.hasTouch && b2) await drag(b2, { x: b2.x, y: b2.y + 220 })
      await page.waitForTimeout(300)
      const m4 = await sheetMode()
      await page.evaluate(() => window.__store.set({ sheet: 'half' }))
      await page.waitForTimeout(300)
      await page.goBack().catch(() => {})
      await page.waitForTimeout(400)
      const m5 = await sheetMode()
      const result = { drag: m1, tap: m2, button: m3, swipe: vp.hasTouch ? m4 : 'n/a', back: m5 }
      if (![m1, m2, m3, m5].every((m) => m === 'peek') || (vp.hasTouch && m4 !== 'peek')) throw new Error('collapse failed: ' + JSON.stringify(result))
    }, null, { shot: false })
  }

  // ---------------- journey
  await feature('journey: search + route + forecast', async () => { await tap(page.getByRole('tab', { name: 'Journey' })); await page.waitForTimeout(500); await page.getByRole('searchbox', { name: 'Destination' }).fill('Iowa City'); await page.waitForTimeout(1500); await tap(page.getByRole('option').first()) }, () => st(() => window.__store.get().journey.weather.state === 'ready' && window.__store.get().journey.road.state === 'ready'), { timeoutMs: 90000 })
  await feature('journey: departure chip +2 h', async () => { await tap(page.getByRole('radio', { name: '+2 h' })) }, () => st(() => window.__store.get().journey.weather.state === 'ready' && window.__store.get().journey.departure > Date.now() + 100 * 60000), { timeoutMs: 60000 })
  await feature('journey: date picker', async () => { await tap(page.getByRole('radio', { name: /Pick/ })); await page.waitForTimeout(400) }, () => st(() => !!document.querySelector('input[type=datetime-local]')), { timeoutMs: 5000 })
  await feature('journey: alternate route', async () => { const alt = page.getByRole('radio', { name: /Alt 1/ }); if (await alt.count()) await tap(alt) }, () => st(() => window.__store.get().journey.selected === 1 && window.__store.get().journey.weather.state === 'ready'), { timeoutMs: 60000 })
  await feature('journey: strip sample tap', async () => { const s = page.locator('li[class^="sev-"]').first(); if (await s.count()) await tap(s) }, () => st(() => window.__store.get().selection?.kind === 'journey'), { timeoutMs: 5000 })
  await feature('journey: hazards + road chips rendered', async () => { await tap(page.getByRole('tab', { name: 'Journey' })) }, () => st(() => /Hazards on this route/.test(document.body.innerText) && /Road conditions/.test(document.body.innerText)))
  await feature('journey: clear', async () => { await tap(page.getByRole('button', { name: 'Change', exact: true })) }, () => st(() => !window.__store.get().journey.to))

  // ---------------- replay modes (cached fixtures: zero live calls)
  for (const id of ['greenfield-2020z', 'ice-storm-2024-12-14']) {
    await feature(`replay ${id}`, async () => { await page.goto(`${BASE}?replay=${id}`, { waitUntil: 'load' }) }, () => st(() => { const j = window.__store.get().journey; return j.hazards.state === 'ready' && j.road.state === 'ready' && window.__map.getZoom() > 5 }), { timeoutMs: 90000 })
  }

  // ---------------- rate-limit / unavailable wording (Open-Meteo + NWPS answer 429)
  if (MOCK) {
    await ctx.close()
    const ctx2 = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor, geolocation: { latitude: FOCUS.lat, longitude: FOCUS.lng }, permissions: ['geolocation'] })
    await installMocks(ctx2, { focus: FOCUS, failHosts: ['api.open-meteo.com', 'api.water.noaa.gov', 'api.waterdata.usgs.gov'] })
    const p2 = await ctx2.newPage()
    const errs2 = []
    p2.on('console', (m) => m.type() === 'error' && errs2.push(m.text().slice(0, 160)))
    await p2.goto(BASE, { waitUntil: 'load' })
    await p2.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {})
    const t0 = Date.now()
    let text = ''
    while (Date.now() - t0 < 30000) { await p2.waitForTimeout(1000); const s = await p2.evaluate(() => window.__store.get()); if (s.rivers.state === 'error' || s.rivers.error) break }
    await p2.getByRole('tab', { name: 'Rivers' }).click()
    await p2.waitForTimeout(500)
    text = await p2.locator('.sheet-body').innerText()
    const pills = await p2.evaluate(() => [...document.querySelectorAll('.pill')].map((p) => p.textContent))
    const file = `${dir}/99-rate-limited.png`
    await p2.screenshot({ path: file })
    const rec = { name: 'rate-limited sources (429 from Open-Meteo, NWPS, USGS)', timeToUsableMs: Date.now() - t0, riversText: text.split('\n').slice(0, 3).join(' | '), pills, consoleErrors: errs2.filter((e) => !/429|Failed to load resource/.test(e)), screenshot: file, ok: /rate-limited|unavailable|limit/i.test(text) }
    features.push(rec)
    console.log(`${String(rec.timeToUsableMs + 'ms').padStart(8)}  ${rec.name.padEnd(42)} wording ok:${rec.ok} | ${rec.riversText.slice(0, 120)}`)
    await ctx2.close()
  }
  done()
  await browser.close()
}
writeFileSync(`${OUT}/walkthrough-report.json`, JSON.stringify(report, null, 2))
console.log(`\nreport: ${OUT}/walkthrough-report.json`)
