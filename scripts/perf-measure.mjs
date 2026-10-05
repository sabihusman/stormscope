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

const args = process.argv.slice(2)
const MOCK = args.find((a) => a.startsWith('--mock='))?.slice(7) ?? null
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

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
await ctx.addInitScript(() => { try { if (!localStorage.getItem('stormscope.layers')) localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: true, station: true, nowcast: false })) } catch {} })
const page = await ctx.newPage()
// Replay: no guard needed (nothing leaves the machine); record/live: the guard counts and caps.
const done = MOCK && !RECORD ? () => {} : trackTraffic(page, 'perf-measure.mjs')
const mocks = MOCK ? await installMocks(ctx, { har: MOCK, record: RECORD }) : null
const cdp = await ctx.newCDPSession(page)
await cdp.send('Network.enable')
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 })

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

// ---- Trace the whole session for task attribution ----
await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-v8.cpu_profiler', options: 'sampling-frequency=1000', transferMode: 'ReportEvents' })
const traceEvents = []
cdp.on('Tracing.dataCollected', (e) => traceEvents.push(...e.value))

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

// ---- Interactions, each labelled for INP attribution ----
const label = (l) => page.evaluate((l) => { window.__perfLabel = l }, l)
await label('tab-switch')
for (const t of ['Station', 'Sources', 'Timeline']) { await touchTap(page, await centre(page.getByRole('tab', { name: t }))); await page.waitForTimeout(900) }
await label('pan')
for (let i = 0; i < 3; i++) { await touchDrag(page, { x: 195, y: 300 }, { x: 95, y: 220 }, { steps: 10, settleMs: 60 }); await page.waitForTimeout(900) }
await label('radar-play')
await touchTap(page, await centre(page.getByRole('button', { name: 'Play' })))
await page.waitForTimeout(5000)
await touchTap(page, await centre(page.getByRole('button', { name: 'Pause' })))
await page.waitForTimeout(500)
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
const { value: traceHandle } = await cdp.send('Tracing.end').then(() => new Promise((res) => cdp.once('Tracing.tracingComplete', (e) => res({ value: e }))))
void traceHandle

// ---- INP per label (max event duration), long tasks ----
const inpBy = {}
for (const e of vitals.inp) { const k = e.label || 'first-load'; if (!inpBy[k] || e.dur > inpBy[k].dur) inpBy[k] = { dur: e.dur, name: e.name, target: e.target } }
out.inp = inpBy
out.inpOverall = vitals.inp.length ? Math.max(...vitals.inp.map((e) => e.dur)) : null

// ---- Attribute tasks > 50 ms from the trace: dominant child slice per top-level task ----
const navEv = traceEvents.find((e) => e.name === 'navigationStart' && e.args?.data?.isLoadingMainFrame !== false) ?? traceEvents.find((e) => e.name === 'navigationStart')
const navTs = navEv?.ts ?? 0
const tasks = traceEvents.filter((e) => e.name === 'RunTask' && e.ph === 'X' && e.dur >= 50_000).sort((a, b) => a.ts - b.ts)
const children = traceEvents.filter((e) => e.ph === 'X' && e.dur && e.name !== 'RunTask' && e.tid != null)
const srcOf = (e) => e.args?.data?.functionName || e.args?.data?.url || e.args?.data?.scriptName || e.args?.beginData?.frame || ''
out.longTasks = tasks.map((t) => {
  const inside = children.filter((c) => c.tid === t.tid && c.ts >= t.ts && c.ts + c.dur <= t.ts + t.dur + 100)
  const agg = {}
  for (const c of inside) { const k = c.name + (srcOf(c) ? ` (${String(srcOf(c)).replace(/^https?:\/\/[^/]+/, '').slice(0, 60)})` : ''); agg[k] = (agg[k] ?? 0) + c.dur }
  const top = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, d]) => `${k} ${(d / 1000).toFixed(0)}ms`)
  // Trace timestamps are µs on the trace clock; align them with the page's performance clock via the
  // navigationStart mark that blink.user_timing records for the main frame.
  const when = vitals.longTasks.find((l) => Math.abs(l.t - (t.ts - navTs) / 1000) < 60)
  return { durMs: Math.round(t.dur / 1000), label: when?.label ?? '', top }
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
console.log(JSON.stringify({ headline: out.headline, firstLoad: out.firstLoad, inp: out.inp, inpOverall: out.inpOverall, longTaskSummary: out.longTaskSummary, longTasksByPhase: byPhase, bundleTotal: out.bundleTotal, bundle: out.bundle, openMeteo: out.openMeteo }, null, 1))
done()
await browser.close()
