// Performance measurement (no assertions): mid-range phone profile — CPU throttled 4×, "Fast 4G"
// network — against a deployment. Reports time to first map + first radar frame, LCP, INP per
// interaction, every main-thread task > 50 ms with its dominant source (from a DevTools trace),
// JS bundle size, first-load request count/bytes, Open-Meteo 429/limiter waits.
//
//   node scripts/perf-measure.mjs <base-url> [out-dir] [--mock=<har>] [--record] [--label=<name>]
//   --mock   answer every API from saved/synthesized bodies (scripts/lib/mock-server.mjs) and tiles
//            from the HAR: zero live calls. --record captures the tile HAR once (live, through the guard).
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { touchDrag, touchTap, centre } from './lib/touch.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'

const args = process.argv.slice(2)
const mockArg = args.find((a) => a === '--mock' || a.startsWith('--mock='))
const MOCK = mockArg ? mockArg.slice(7) || 'synthetic' : null // --mock → synthetic tiles; --mock=<har> → tiles from the HAR
const HAR = MOCK && MOCK !== 'synthetic' ? MOCK : null
const RECORD = args.includes('--record')
const LABEL = args.find((a) => a.startsWith('--label='))?.slice(8) ?? ''
const positional = args.filter((a) => !a.startsWith('--'))
assertBudget('perf-measure.mjs', { openMeteo: !!MOCK ? false : true })

const BASE = (positional[0] || 'http://localhost:4173/').replace(/\/?$/, '/')
const OUT = positional[1] || 'e2e-shots/perf'
mkdirSync(OUT, { recursive: true })
const out = { base: BASE, label: LABEL, mock: MOCK ? (RECORD ? 'record' : 'replay') : 'live', at: new Date().toISOString(), profile: { cpuThrottle: 4, network: 'Fast 4G (4 Mbps down, 3 Mbps up, 20 ms RTT)' } }

// ---- Bundle size (from the local dist/ that was deployed) ----
try {
  const files = readdirSync('dist/assets').filter((f) => /\.(js|css)$/.test(f))
  out.bundle = files.map((f) => { const b = readFileSync(`dist/assets/${f}`); return { file: f, kb: +(b.length / 1024).toFixed(1), gzipKb: +(gzipSync(b).length / 1024).toFixed(1) } }).sort((a, b) => b.kb - a.kb)
  out.bundleTotal = { kb: +out.bundle.reduce((a, f) => a + f.kb, 0).toFixed(0), gzipKb: +out.bundle.reduce((a, f) => a + f.gzipKb, 0).toFixed(0), js: out.bundle.filter((f) => f.file.endsWith('.js')).reduce((a, f) => a + f.gzipKb, 0).toFixed(0) + ' KB gzip' }
} catch { out.bundle = 'dist/ not built locally' }

// --headed: real Chrome with the machine's GPU (headless SwiftShader inflates raster/upload cost and
// therefore INP presentation delay; script time is comparable either way).
const HEADED = args.includes('--headed')
// --cdp=http://localhost:9222: drive a real device's Chrome over remote debugging (adb forward
// tcp:9222 localabstract:chrome_devtools_remote). No CPU throttle, no viewport emulation — the
// device's own numbers, which outrank the laptop's.
const CDP = args.find((a) => a.startsWith('--cdp='))?.slice(6) ?? null
// --low-device: present the app with a low-end device class (4 cores, 4 GB) so class-scaled work
// (wind particle count) can be measured on this machine.
const LOW_DEVICE = args.includes('--low-device')
const browser = CDP
  ? await chromium.connectOverCDP(CDP)
  : HEADED
    ? await chromium.launch({ headless: false, channel: 'chrome', args: ['--window-size=430,900', '--window-position=40,40'] }).catch(() => chromium.launch({ headless: false, args: ['--window-size=430,900'] }))
    : await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
out.profile.renderer = CDP ? `real device over CDP (${browser.version()})` : HEADED ? 'headed Chrome, real GPU' : 'headless Chromium, SwiftShader (software GL)'
const VP = args.includes('--viewport=tablet') ? { width: 800, height: 1280, deviceScaleFactor: 2 } : { width: 390, height: 844, deviceScaleFactor: 3 }
out.profile.viewport = CDP ? 'device native' : VP
// A real device's Chrome cannot create browser contexts: use its default context as is.
const ctx = CDP ? browser.contexts()[0] : await browser.newContext({ viewport: { width: VP.width, height: VP.height }, isMobile: true, hasTouch: true, deviceScaleFactor: VP.deviceScaleFactor, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
if (CDP) {
  await ctx.grantPermissions(['geolocation']).catch(() => {})
  await ctx.setGeolocation({ latitude: 41.673, longitude: -93.698 }).catch(() => {})
}
const LAYERS = JSON.parse(args.find((a) => a.startsWith('--layers='))?.slice(9) ?? '{"radar":true,"satellite":false,"rainfall":false,"flood":false,"rivers":true,"station":true,"nowcast":false}')
out.profile.layers = LAYERS
await ctx.addInitScript((layers) => { try { if (!localStorage.getItem('stormscope.layers')) localStorage.setItem('stormscope.layers', JSON.stringify(layers)) } catch {} }, LAYERS)
if (LOW_DEVICE) await ctx.addInitScript(() => { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 }); Object.defineProperty(navigator, 'deviceMemory', { get: () => 4 }) })
out.profile.deviceClass = LOW_DEVICE ? 'low (4 cores, 4 GB emulated)' : 'host'
const page = await ctx.newPage()
// Replay: no guard needed (nothing leaves the machine); record/live: the guard counts and caps.
const done = MOCK && !RECORD ? () => {} : trackTraffic(page, 'perf-measure.mjs')
const mocks = MOCK ? await installMocks(ctx, { har: HAR, record: RECORD }) : null
const cdp = await ctx.newCDPSession(page)
await cdp.send('Network.enable')
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
if (!CDP) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 })
else out.profile.network = 'device network, unthrottled'

// Network accounting for the first load.
const reqs = new Map()
cdp.on('Network.requestWillBeSent', (e) => reqs.set(e.requestId, { url: e.request.url, start: e.timestamp, type: e.type, bytes: 0, status: null }))
cdp.on('Network.responseReceived', (e) => { const r = reqs.get(e.requestId); if (r) { r.status = e.response.status; r.mime = e.response.mimeType; r.fromSw = e.response.fromServiceWorker } })
cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) { r.bytes = e.encodedDataLength; r.end = e.timestamp } })

// Web-vitals style observers, installed before any script runs.
await page.addInitScript(() => {
  window.__perf = { lcp: null, inp: [], longTasks: [], mapLoad: null, firstRadar: null, navStart: performance.timeOrigin }
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = { t: Math.round(e.startTime), el: e.element?.tagName + (e.element?.className ? '.' + String(e.element.className).split(' ')[0] : ''), size: e.size } }).observe({ type: 'largest-contentful-paint', buffered: true })
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) window.__perf.inp.push({ t: Math.round(e.startTime), dur: Math.round(e.duration), name: e.name, target: e.target?.tagName + (e.target?.className ? '.' + String(e.target.className).split(' ')[0] : ''), label: window.__perfLabel ?? '' }) }).observe({ type: 'event', buffered: true, durationThreshold: 16 })
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longTasks.push({ t: Math.round(e.startTime), dur: Math.round(e.duration), label: window.__perfLabel ?? '' }) }).observe({ type: 'longtask', buffered: true })
  const poll = setInterval(() => { const m = window.__map; if (m && !window.__perf._hooked) { window.__perf._hooked = true; const mark = () => { window.__perf.mapLoad ??= Math.round(performance.now()) }; if (m.loaded()) mark(); else m.once('load', mark) } }, 20)
  setTimeout(() => clearInterval(poll), 60000)
})
page.on('response', (r) => { if (!window_firstRadar && /tilecache\.rainviewer\.com/.test(r.url()) && r.status() === 200) window_firstRadar = Date.now() })
let window_firstRadar = 0

// ---- Trace the whole session for task attribution, plus a sampling CPU profile so microtask runs
// (promise continuations, which the trace only shows as "RunMicrotasks") get function names ----
await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,v8.execute,blink.user_timing', transferMode: 'ReportEvents' })
const traceEvents = []
cdp.on('Tracing.dataCollected', (e) => traceEvents.push(...e.value))
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
await cdp.send('Profiler.start')

// Environment check: a hidden or throttled page (screen locked/off) makes every timing invalid.
await page.goto('about:blank')
out.environment = await page.evaluate(
  () =>
    new Promise((res) => {
      let n = 0
      const t0 = performance.now()
      const loop = () => (performance.now() - t0 < 1000 ? (n++, requestAnimationFrame(loop)) : res({ visibility: document.visibilityState, hasFocus: document.hasFocus(), rafPerSecond: n, gpu: (() => { try { const c = document.createElement('canvas'); const gl = c.getContext('webgl2') || c.getContext('webgl'); const d = gl?.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a' } catch { return 'n/a' } })() }))
      requestAnimationFrame(loop)
    }),
)
// Calibrate the CPU throttle: a fixed busy loop before/after Emulation.setCPUThrottlingRate (headless
// Chromium on this machine ignores the rate and runs ~4× slower than native Chrome anyway, so only a
// measured ratio near 4 means the profile is what it claims to be).
const bench = () => page.evaluate(() => { const t0 = performance.now(); let x = 0; for (let i = 0; i < 2e7; i++) x += Math.sqrt(i); return Math.round(performance.now() - t0) })
const RATE = CDP ? 1 : 4 // a real device is measured as it is
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
const unthrottledMs = await bench()
await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE })
const throttledMs = await bench()
out.environment.cpu = { unthrottledMs, throttledMs, ratio: +(throttledMs / unthrottledMs).toFixed(1), rate: RATE }
out.profile.cpuThrottle = RATE
out.environment.valid = out.environment.visibility === 'visible' && out.environment.rafPerSecond >= 30 && (RATE === 1 || out.environment.cpu.ratio >= 3)
if (!out.environment.valid) console.log(`WARNING: page ${out.environment.visibility}, ${out.environment.rafPerSecond} rAF/s — timings below are INVALID (hidden/throttled window)`)
console.log('environment:', JSON.stringify(out.environment))

const t0 = Date.now()
await page.goto(BASE, { waitUntil: 'load' })
const navToLoad = Date.now() - t0
await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {})
// First load settles: wait for the map + radar, up to 30 s.
for (let i = 0; i < 60; i++) { await page.waitForTimeout(500); const p = await page.evaluate(() => ({ map: window.__perf.mapLoad, radar: !!window.__store?.get().radar.data })); if (p.map && window_firstRadar) break }
await page.waitForTimeout(3000)
const firstLoad = await page.evaluate(() => ({ lcp: window.__perf.lcp, mapLoad: window.__perf.mapLoad, longTasks: window.__perf.longTasks.length }))
out.firstLoad = { navigationToLoadEventMs: navToLoad, timeToFirstMapMs: firstLoad.mapLoad, timeToFirstRadarFrameMs: window_firstRadar ? window_firstRadar - t0 : null, lcp: firstLoad.lcp }
const first = [...reqs.values()].filter((r) => r.end)
const byHost = {}
for (const r of first) { const h = new URL(r.url).host; byHost[h] ??= { n: 0, kb: 0 }; byHost[h].n++; byHost[h].kb += r.bytes / 1024 }
out.firstLoad.requests = { count: first.length, totalKb: +first.reduce((a, r) => a + r.bytes / 1024, 0).toFixed(0), byHost: Object.fromEntries(Object.entries(byHost).sort((a, b) => b[1].kb - a[1].kb).map(([h, v]) => [h, { n: v.n, kb: +v.kb.toFixed(0) }])) }

// ---- Interactions, each labelled for INP attribution; a rAF sampler records frame times per label ----
await page.evaluate(() => {
  window.__frames = {}
  let last = performance.now()
  const loop = (t) => {
    const k = window.__perfLabel ?? 'first-load'
    const f = (window.__frames[k] ??= { n: 0, over50: 0, over100: 0, maxMs: 0, totalMs: 0 })
    const d = t - last
    last = t
    f.n++
    f.totalMs += d
    if (d > 50) f.over50++
    if (d > 100) f.over100++
    if (d > f.maxMs) f.maxMs = Math.round(d)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
})
// Labels are also recorded with their page time so trace tasks can be attributed by time window —
// the longtask observer misses tasks started by DevTools (page.evaluate), which would otherwise be
// lumped into "first-load".
await page.evaluate(() => { window.__labelTimes = [{ label: 'first-load', t: 0 }] })
const label = (l) => page.evaluate((l) => { window.__perfLabel = l; window.__labelTimes.push({ label: l, t: performance.now() }) }, l)
await label('tab-switch')
for (const t of ['Station', 'Sources', 'Timeline']) { await touchTap(page, await centre(page.getByRole('tab', { name: t }))); await page.waitForTimeout(900) }
await label('pan')
for (let i = 0; i < 3; i++) { await touchDrag(page, { x: 195, y: 300 }, { x: 95, y: 220 }, { steps: 10, settleMs: 60 }); await page.waitForTimeout(900) }
await label('zoom-jump')
// (return nothing: returning the Map would make Playwright serialize it — 0.7 s of fake "stall")
for (const z of [5, 11, 9.5]) { await page.evaluate((z) => { window.__map.jumpTo({ zoom: z, center: [-93.698, 41.673] }) }, z); await page.waitForTimeout(1500) }
await label('3d-on')
await touchTap(page, await centre(page.getByRole('button', { name: /layer menu/ })))
await touchTap(page, await centre(page.getByRole('button', { name: /3D terrain/ })))
await touchTap(page, await centre(page.getByRole('button', { name: /layer menu/ })))
await page.waitForTimeout(2500)
await label('3d-off')
await touchTap(page, await centre(page.getByRole('button', { name: /layer menu/ })))
await touchTap(page, await centre(page.getByRole('button', { name: /3D terrain/ })))
await touchTap(page, await centre(page.getByRole('button', { name: /layer menu/ })))
await page.waitForTimeout(1500)
await label('radar-play')
if (LAYERS.radar) {
  await touchTap(page, await centre(page.getByRole('button', { name: 'Play' })))
  await page.waitForTimeout(5000)
  await touchTap(page, await centre(page.getByRole('button', { name: 'Pause' })))
  await page.waitForTimeout(500)
}
await label('all-layers-nowcast')
await touchTap(page, await centre(page.getByRole('button', { name: /layer menu/ })))
for (const n of ['Rainfall', 'Flood risk', 'Nowcast']) { await touchTap(page, await centre(page.getByRole('button', { name: n }))); await page.waitForTimeout(300) }
await touchTap(page, await centre(page.getByRole('button', { name: /layer menu/ })))
await page.waitForTimeout(20000) // blocks load + nowcast
await touchTap(page, await centre(page.getByRole('tab', { name: 'Timeline' })))
await page.waitForTimeout(500)
const nowTab = page.getByRole('tab', { name: 'Nowcast' })
if (await nowTab.count()) { await touchTap(page, await centre(nowTab)); await page.waitForTimeout(400) }
await touchTap(page, await centre(page.getByRole('button', { name: 'Play' })))
await page.waitForTimeout(4000)
await touchTap(page, await centre(page.getByRole('button', { name: 'Pause' })))
await label('idle-all-layers')
await page.waitForTimeout(4000)
await label('journey-open')
await touchTap(page, await centre(page.getByRole('tab', { name: 'Journey' })))
await page.waitForTimeout(500)
await page.getByRole('searchbox', { name: 'Destination' }).fill('Iowa City')
await page.waitForTimeout(2500)
await touchTap(page, await centre(page.getByRole('option').first()))
for (let i = 0; i < 90; i++) { await page.waitForTimeout(1000); const s = await page.evaluate(() => window.__store.get().journey.weather.state); if (s === 'ready' || s === 'error') break }
await page.waitForTimeout(1500)

const vitals = await page.evaluate(() => window.__perf)
const labelTimes = await page.evaluate(() => window.__labelTimes)
const labelAt = (pageMs) => { let cur = 'first-load'; for (const l of labelTimes) if (l.t <= pageMs) cur = l.label; return cur }
out.frames = await page.evaluate(() => Object.fromEntries(Object.entries(window.__frames).map(([k, f]) => [k, { frames: f.n, fps: +(f.n / (f.totalMs / 1000)).toFixed(1), over50: f.over50, over100: f.over100, maxMs: f.maxMs }])))
const { profile } = await cdp.send('Profiler.stop')
const { value: traceHandle } = await cdp.send('Tracing.end').then(() => new Promise((res) => cdp.once('Tracing.tracingComplete', (e) => res({ value: e }))))
void traceHandle
// Profile samples → absolute µs (same TimeTicks clock as the trace), so each long task can be
// attributed to the functions sampled inside it.
const pNodes = new Map(profile.nodes.map((n) => [n.id, n]))
const pParent = new Map()
for (const n of profile.nodes) for (const c of n.children ?? []) pParent.set(c, n.id)
const pSamples = []
{
  let t = profile.startTime
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i] ?? 0
    pSamples.push({ t, id: profile.samples[i] })
  }
}
// Resolve minified frames to source names through the build's sourcemaps (PERF_SOURCEMAP=1 build).
const maps = new Map()
const mapFor = (url) => {
  const file = (url || '').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '')
  if (!file.startsWith('assets/')) return null
  if (!maps.has(file)) {
    try {
      maps.set(file, new TraceMap(JSON.parse(readFileSync(`dist/${file}.map`, 'utf8'))))
    } catch {
      maps.set(file, null)
    }
  }
  return maps.get(file)
}
const nameCache = new Map()
const frameName = (n) => {
  const cf = n.callFrame
  const key = `${cf.url}|${cf.lineNumber}|${cf.columnNumber}|${cf.functionName}`
  if (nameCache.has(key)) return nameCache.get(key)
  let out = `${cf.functionName || '(anon)'}@${(cf.url || '').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '').slice(0, 36)}:${cf.lineNumber}`
  const m = mapFor(cf.url)
  if (m && cf.lineNumber >= 0) {
    const pos = originalPositionFor(m, { line: cf.lineNumber + 1, column: Math.max(0, cf.columnNumber) })
    if (pos.source) out = `${pos.name || cf.functionName || '(anon)'}@${pos.source.replace(/^.*?(src|node_modules)\//, '$1/').slice(0, 48)}:${pos.line}`
  }
  nameCache.set(key, out)
  return out
}
function attribute(tsStart, tsEnd, top = 4) {
  const self = new Map()
  const incl = new Map()
  let n = 0
  for (const s of pSamples) {
    if (s.t < tsStart || s.t > tsEnd) continue
    n++
    const node = pNodes.get(s.id)
    if (!node) continue
    const name = frameName(node)
    if (!/^\((idle|program|garbage|root)/.test(name)) self.set(name, (self.get(name) ?? 0) + 1)
    let id = s.id
    const seen = new Set()
    while (id != null) {
      const nn = pNodes.get(id)
      const k = frameName(nn)
      if (!seen.has(k) && !/^\((idle|program|garbage|root)/.test(k)) { seen.add(k); incl.set(k, (incl.get(k) ?? 0) + 1) }
      id = pParent.get(id)
    }
  }
  const pct = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => `${k} ${Math.round((100 * v) / Math.max(1, n))}%`)
  return { samples: n, self: pct(self), inclusive: pct(incl) }
}

// ---- INP per label (max event duration), long tasks ----
const inpBy = {}
for (const e of vitals.inp) { const k = e.label || 'first-load'; if (!inpBy[k] || e.dur > inpBy[k].dur) inpBy[k] = { dur: e.dur, name: e.name, target: e.target } }
out.inp = inpBy
out.inpOverall = vitals.inp.length ? Math.max(...vitals.inp.map((e) => e.dur)) : null

// ---- Attribute tasks > 50 ms from the trace: dominant child slice per top-level task ----
const navEv = traceEvents.find((e) => e.name === 'navigationStart' && e.args?.data?.isLoadingMainFrame !== false) ?? traceEvents.find((e) => e.name === 'navigationStart')
const navTs = navEv?.ts ?? 0
// Only the page's renderer main thread counts: worker threads and the GPU process also emit RunTask.
const mainThread = traceEvents.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain' && e.pid === navEv?.pid) ?? traceEvents.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
const onMain = (e) => mainThread ? e.pid === mainThread.pid && e.tid === mainThread.tid : true
const tasks = traceEvents.filter((e) => e.name === 'RunTask' && e.ph === 'X' && e.dur >= 50_000 && onMain(e)).sort((a, b) => a.ts - b.ts)
const children = traceEvents.filter((e) => e.ph === 'X' && e.dur && e.name !== 'RunTask' && onMain(e))
const srcOf = (e) => e.args?.data?.functionName || e.args?.data?.url || e.args?.data?.scriptName || e.args?.beginData?.frame || ''
out.longTasks = tasks.map((t) => {
  const inside = children.filter((c) => c.ts >= t.ts && c.ts + c.dur <= t.ts + t.dur + 100)
  const agg = {}
  for (const c of inside) { const k = c.name + (srcOf(c) ? ` (${String(srcOf(c)).replace(/^https?:\/\/[^/]+/, '').slice(0, 60)})` : ''); agg[k] = (agg[k] ?? 0) + c.dur }
  const top = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, d]) => `${k} ${(d / 1000).toFixed(0)}ms`)
  // Trace timestamps are µs on the trace clock; align them with the page's performance clock via the
  // navigationStart mark that blink.user_timing records for the main frame.
  const prof = t.dur >= 150_000 ? attribute(t.ts, t.ts + t.dur) : undefined
  return { durMs: Math.round(t.dur / 1000), label: labelAt((t.ts - navTs) / 1000), top, prof }
})
// Classify: rendering (Layout/Paint/Raster/ImageDecode/GPU) vs script.
const cls = (lt) => (lt.top.some((s) => /FunctionCall|EvaluateScript|v8|RunMicrotasks|TimerFire|XHR|FireAnimationFrame|MessageEvent/.test(s)) ? 'script' : lt.top.length ? 'rendering/decode' : 'unattributed')
out.longTaskSummary = { count: out.longTasks.length, over200: out.longTasks.filter((l) => l.durMs > 200).length, script: out.longTasks.filter((l) => cls(l) === 'script').length, rendering: out.longTasks.filter((l) => cls(l) === 'rendering/decode').length }
for (const lt of out.longTasks) lt.kind = cls(lt)

// ---- Rate limiter / 429 waiting vs network ----
const all = [...reqs.values()].filter((r) => r.end)
const om = all.filter((r) => /open-meteo\.com/.test(r.url))
out.openMeteo = { requests: om.length, status429: om.filter((r) => r.status === 429).length, status503: om.filter((r) => r.status === 503).length, medianMs: om.length ? Math.round(om.map((r) => (r.end - r.start) * 1000).sort((a, b) => a - b)[Math.floor(om.length / 2)]) : null, maxMs: om.length ? Math.round(Math.max(...om.map((r) => (r.end - r.start) * 1000))) : null }
out.limiterNote = 'The client limiter only delays when >550 locations are requested within a minute; 429 back-off is 61 s on the minute tier. Both leave a visible "Rate limited" pill. Counted above: 429s seen in this session.'
out.swResponses = all.filter((r) => r.fromSw).length
// Headline load metric: time to the first radar frame (the first useful weather pixel), not LCP.
out.headline = { timeToFirstRadarFrameMs: out.firstLoad.timeToFirstRadarFrameMs, timeToFirstMapMs: out.firstLoad.timeToFirstMapMs, lcpMs: out.firstLoad.lcp?.t ?? null }
const byPhase = {}
for (const t of out.longTasks) { const k = t.label || 'first-load'; byPhase[k] ??= { n: 0, over200: 0, maxMs: 0, totalMs: 0 }; byPhase[k].n++; if (t.durMs > 200) byPhase[k].over200++; byPhase[k].maxMs = Math.max(byPhase[k].maxMs, t.durMs); byPhase[k].totalMs += t.durMs }
out.longTasksByPhase = byPhase
if (mocks) out.liveFallthrough = mocks.live.filter((u) => !/tiles\.openfreemap\.org|s3\.amazonaws\.com|gibs\.earthdata\.nasa\.gov/.test(u)).slice(0, 10)
const file = `${OUT}/perf-report${LABEL ? '-' + LABEL : ''}.json`
writeFileSync(file, JSON.stringify(out, null, 2))
console.log(JSON.stringify({ environment: out.environment, frames: out.frames, headline: out.headline, firstLoad: out.firstLoad, inp: out.inp, inpOverall: out.inpOverall, longTaskSummary: out.longTaskSummary, longTasksByPhase: byPhase, bundleTotal: out.bundleTotal, bundle: out.bundle, openMeteo: out.openMeteo }, null, 1))
done()
await browser.close()
