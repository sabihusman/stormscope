// Playback stutter diagnosis / regression check: plays N loops of satellite, then radar, and reports per
// loop — tile requests (by host), frames shown late (switch interval > 1.5 × the 450 ms step), frames
// shown before their tiles were loaded ("blank"), frame times (p50 / p95 / max from rAF deltas), the
// longest main-thread task, and the JS heap. Loops 2+ must make ~0 requests with no frame over 100 ms.
// Perf profile: headed Chrome by default (real GPU), CPU 4×, Fast 4G, APIs and tiles mocked.
// --live-tiles: the APIs stay mocked but the tile hosts (basemap, radar, GIBS, terrain) are fetched for
// real through the traffic guard — the stutter fix verified on real tile latency and sizes.
//   node scripts/playback-loop-diag.mjs [base-url] [--viewport=phone|desktop] [--loops=3] [--headless] [--assert] [--live-tiles]
import { chromium } from 'playwright'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap, setLayers } from './lib/ui.mjs'

const args = process.argv.slice(2)
const BASE = (args.find((a) => !a.startsWith('--')) || 'http://localhost:4173/').replace(/\/?$/, '/')
const VIEW = args.find((a) => a.startsWith('--viewport='))?.slice(11) ?? 'phone'
const LOOPS = Number(args.find((a) => a.startsWith('--loops='))?.slice(8) ?? 3)
const HEADLESS = args.includes('--headless')
const ASSERT = args.includes('--assert')
const LIVE_TILES = args.includes('--live-tiles')
const NAME = `playback-loop-diag.mjs ${VIEW}${LIVE_TILES ? ' (live tiles, APIs mocked)' : ' (mock)'}`
assertBudget(NAME)
const VP = VIEW === 'desktop' ? { width: 1366, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 } : { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
const STEP = 450
const TILE_HOSTS = /^(gibs\.earthdata\.nasa\.gov|tilecache\.rainviewer\.com|tiles\.openfreemap\.org|s3\.amazonaws\.com)$/

const browser = HEADLESS
  ? await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  : await chromium.launch({ headless: false, channel: 'chrome', args: [`--window-size=${VP.width + 40},${VP.height + 60}`, '--window-position=40,40'] }).catch(() => chromium.launch({ headless: false, args: [`--window-size=${VP.width + 40},${VP.height + 60}`] }))
const ctx = await browser.newContext({ viewport: { width: VP.width, height: VP.height }, isMobile: VP.isMobile, hasTouch: VP.hasTouch, deviceScaleFactor: VP.deviceScaleFactor, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
await ctx.addInitScript(() => {
  try { localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: false, station: false, nowcast: false })) } catch {}
  window.__longTasks = []
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push({ t: e.startTime, d: e.duration }) }).observe({ type: 'longtask', buffered: true }) } catch {}
})
const page = await ctx.newPage()
// The guard first (bypass + toolbar opt-out on a protected preview, caps on live tile hosts), then the mocks.
const done = trackTraffic(page, NAME)
await installMocks(ctx, { liveTiles: LIVE_TILES })
const cdp = await ctx.newCDPSession(page)
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 })

// Tile requests, stamped so they can be attributed to loops (mocked and live alike: the page's request events).
const reqs = []
page.on('request', (r) => { try { reqs.push({ t: Date.now(), host: new URL(r.url()).host }) } catch {} })

await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
const until = async (fn, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(150) } return false }
await until(() => !!window.__map?.loaded() && !!window.__store?.get().radar.data)
await openMap(page)
await page.waitForTimeout(800)

// In-page recorder: frame switches (from the store), rAF deltas, tiles loaded at the switch.
await page.evaluate((STEP) => {
  const m = window.__map
  const rec = (window.__rec = { switches: [], raf: [], running: false })
  let lastPlay = null
  window.__store.subscribe(() => {
    const s = window.__store.get()
    if (s.playTime === lastPlay) return
    lastPlay = s.playTime
    if (!rec.running) return
    // Frame sources are keyed by their time (and product / kind), not by index.
    const id = s.layers.satellite ? `gibs-sat-${s.satellite.data?.times[s.satFrame]}-${s.satellite.data?.layer.id}` : `rv-radar-${s.radar.data?.frames[s.radarFrame]?.time}-${s.radar.data?.frames[s.radarFrame]?.kind}`
    const loaded = m.getSource(id) ? m.isSourceLoaded(id) : null
    rec.switches.push({ t: performance.now(), playTime: s.playTime, id, loaded })
  })
  let last = performance.now()
  const loop = () => { const now = performance.now(); if (rec.running) rec.raf.push(now - last); last = now; requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  void STEP
}, STEP)

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }
const results = []

async function measure(layerName) {
  // Reset, start from the first frame (so loop 1 is a full loop) and play. The window is brought to the
  // front: an occluded headed window throttles rAF to 1 Hz and the frame times would be meaningless.
  await page.bringToFront()
  await page.evaluate(() => {
    const s = window.__store.get()
    const first = s.layers.satellite ? s.satellite.data?.times[0] : (s.radar.data?.frames[0]?.time ?? 0) * 1000
    window.__rec.switches = []; window.__rec.raf = []; window.__longTasks = []
    window.__store.set({ playing: false, playTime: first || null })
  })
  await page.waitForTimeout(600)
  const ticks = await page.evaluate(() => { const s = window.__store.get(); return s.layers.satellite ? (s.satellite.data?.times.length ?? 0) : (s.radar.data?.frames.length ?? 0) })
  const t0 = Date.now()
  const reqStart = reqs.length
  await page.evaluate(() => { window.__rec.running = true; window.__store.set({ playing: true }) })
  // After the first full loop, force the frame-list refresh the app does every 5 min (and on tab focus):
  // the refreshed list must not rebuild the frame sources, or loops 2+ refetch every tile.
  const wraps = () => page.evaluate(() => { const sw = window.__rec.switches; let w = 0; for (let i = 1; i < sw.length; i++) if (sw[i].playTime < sw[i - 1].playTime) w++; return w })
  const need = LOOPS
  await until(() => { const sw = window.__rec.switches; let w = 0; for (let i = 1; i < sw.length; i++) if (sw[i].playTime < sw[i - 1].playTime) w++; return w >= 1 }, Math.max(30000, ticks * STEP * 2 + 10000))
  await page.evaluate(() => window.__store.set((s) => ({ refreshNonce: s.refreshNonce + 1 })))
  await until(() => { const sw = window.__rec.switches; let w = 0; for (let i = 1; i < sw.length; i++) if (sw[i].playTime < sw[i - 1].playTime) w++; return w >= 3 }, Math.max(30000, LOOPS * ticks * STEP * 2 + 10000))
  void wraps
  await page.evaluate(() => { window.__rec.running = false; window.__store.set({ playing: false }) })
  const rec = await page.evaluate(() => ({ switches: window.__rec.switches, raf: window.__rec.raf, longTasks: window.__longTasks, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, origin: performance.timeOrigin }))
  // Split switches into loops at wraps; attribute requests and rAF samples by time.
  const loops = []
  let cur = { frames: [], startAbs: rec.origin + (rec.switches[0]?.t ?? 0) }
  for (let i = 0; i < rec.switches.length; i++) {
    const s = rec.switches[i]
    if (i > 0 && s.playTime < rec.switches[i - 1].playTime) { cur.endAbs = rec.origin + s.t; loops.push(cur); cur = { frames: [], startAbs: rec.origin + s.t } }
    cur.frames.push(s)
  }
  cur.endAbs = Date.now()
  loops.push(cur)
  const report = []
  for (let li = 0; li < Math.min(need, loops.length); li++) {
    const L = loops[li]
    const tStart = L.frames[0]?.t ?? 0
    const tEnd = (loops[li + 1]?.frames[0]?.t ?? rec.switches.at(-1)?.t ?? tStart) || tStart
    // Tile hosts only: the forced refresh also re-polls the APIs (NWS, Open-Meteo), which is not playback traffic.
    const byHost = {}
    for (const r of reqs.slice(reqStart)) if (r.t >= L.startAbs && r.t < L.endAbs && TILE_HOSTS.test(r.host)) byHost[r.host] = (byHost[r.host] ?? 0) + 1
    const intervals = L.frames.slice(1).map((f, k) => f.t - L.frames[k].t)
    const late = intervals.filter((d) => d > STEP * 1.5).length
    const blank = L.frames.filter((f) => f.loaded === false).length
    const unknown = L.frames.filter((f) => f.loaded === null).length
    // rAF samples inside this loop's time window (approximate: the raf array is in order, stamp by cumulative sum)
    let acc = rec.switches[0]?.t ?? 0
    const rafIn = []
    for (const d of rec.raf) { acc += d; if (acc >= tStart && acc < tEnd) rafIn.push(d) }
    const longest = Math.max(0, ...rec.longTasks.filter((x) => x.t >= tStart && x.t < tEnd).map((x) => x.d))
    report.push({ loop: li + 1, frames: L.frames.length, requests: byHost, late, blank, unknown, p50: Math.round(pct(rafIn, 50)), p95: Math.round(pct(rafIn, 95)), max: Math.round(Math.max(0, ...rafIn)), longestTask: Math.round(longest), heapMB: rec.heapMB })
  }
  results.push({ layer: layerName, ticks, report })
  void t0
}

// Satellite first (frames need a moment to list), then radar.
await setLayers(page, { satellite: true, radar: false })
await until(() => (window.__store.get().satellite.data?.times.length ?? 0) > 0 && window.__map.areTilesLoaded(), 60000)
await page.waitForTimeout(1500)
await measure('satellite')
await setLayers(page, { radar: true, satellite: false })
await until(() => window.__map.areTilesLoaded(), 30000)
await page.waitForTimeout(1500)
await measure('radar')
done()
await browser.close()

// Frame times are only meaningful on a real GPU with the window in front; headless SwiftShader asserts requests only.
let okReq = true
let okFrames = true
console.log(`playback-loop-diag ${VIEW} ${HEADLESS ? 'headless' : 'headed'} CPU 4× Fast 4G ${LIVE_TILES ? 'live tiles, APIs mocked' : 'mocked'} ${BASE}`)
for (const r of results) {
  console.log(`  ${r.layer}: ${r.ticks} frames per loop`)
  for (const L of r.report) {
    const reqN = Object.values(L.requests).reduce((a, b) => a + b, 0)
    const badReq = L.loop >= 2 && reqN > 2
    // A frame whose source could not be found counts as not verified: the assertion must not pass vacuously.
    const badFrames = L.loop >= 2 && (L.max > 100 || L.blank > 0 || L.unknown > 0)
    if (badReq) okReq = false
    if (badFrames) okFrames = false
    console.log(`    loop ${L.loop}: frames ${L.frames} · requests ${reqN}${reqN ? ' (' + Object.entries(L.requests).map(([h, n]) => `${h} ${n}`).join(', ') + ')' : ''} · late ${L.late} · blank ${L.blank}${L.unknown ? ` · unverified ${L.unknown}` : ''} · frame p50/p95/max ${L.p50}/${L.p95}/${L.max} ms · longest task ${L.longestTask} ms · heap ${L.heapMB ?? '?'} MB${badReq || badFrames ? '   ← over' : ''}`)
  }
}
console.log('JSON ' + JSON.stringify({ view: VIEW, results }))
if (ASSERT) {
  const results2 = []
  const check = (name, ok, ev = '') => { results2.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`) }
  check(`[${VIEW}] loops 2+ make ≤ 2 tile requests (satellite and radar)`, okReq)
  if (!HEADLESS) check(`[${VIEW}] loops 2+ show no blank frame and no frame over 100 ms (headed, real GPU)`, okFrames)
  else console.log(`INFO  (headless) frame times not asserted — software GL; the live pass runs this headed and asserts them`)
  console.log(`${results2.filter(Boolean).length}/${results2.length} passed`)
  process.exit(results2.every(Boolean) ? 0 : 1)
}
