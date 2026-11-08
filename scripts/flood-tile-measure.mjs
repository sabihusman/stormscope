// Measures what the Now flood tile costs, for one build, on the perf profile (headed Chrome, CPU 4×,
// Fast 4G, APIs mocked): per phase — first open, then a place change — requests by host (Open-Meteo
// locations, terrain tiles, NHD queries), time to conditions on Now, time until the app is settled
// (no network request for 2 s and no resource loading), and the longest main-thread task.
// Run it against two builds (eager tile vs on-demand) and compare.
//   node scripts/flood-tile-measure.mjs <base-url> [--viewport=phone|desktop] [--label=x] [--headless] [--mode=lite|full]
import { chromium } from 'playwright'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openNow, searchPlace } from './lib/ui.mjs'

const args = process.argv.slice(2)
const BASE = (args.find((a) => !a.startsWith('--')) || 'http://localhost:4173/').replace(/\/?$/, '/')
const VIEW = args.find((a) => a.startsWith('--viewport='))?.slice(11) ?? 'phone'
const LABEL = args.find((a) => a.startsWith('--label='))?.slice(8) ?? ''
const HEADLESS = args.includes('--headless')
const VP = VIEW === 'desktop' ? { width: 1366, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 } : { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }

const browser = HEADLESS
  ? await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  : await chromium.launch({ headless: false, channel: 'chrome', args: [`--window-size=${VP.width + 40},${VP.height + 60}`, '--window-position=40,40'] }).catch(() => chromium.launch({ headless: false, args: [`--window-size=${VP.width + 40},${VP.height + 60}`] }))
const ctx = await browser.newContext({ viewport: { width: VP.width, height: VP.height }, isMobile: VP.isMobile, hasTouch: VP.hasTouch, deviceScaleFactor: VP.deviceScaleFactor, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
await ctx.addInitScript(() => {
  try { if (!localStorage.getItem('stormscope.layers')) localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: true, station: true, nowcast: false })) } catch {}
  window.__longTasks = []
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push({ t: e.startTime, d: e.duration }) }).observe({ type: 'longtask', buffered: true }) } catch {}
})
const page = await ctx.newPage()
// --mode=lite|full (default full): which mode the app opens in (Lite is the app's default since Nov 7, 2026).
const MODE = args.find((a) => a.startsWith('--mode='))?.slice(7) ?? 'full'
const mocks = await installMocks(ctx, { mode: MODE })
const cdp = await ctx.newCDPSession(page)
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 })

// Request accounting per phase.
let phase = null
const phases = []
let lastReq = 0
const isOM = (u) => /open-meteo\.com\/v1\/(forecast|era5)/.test(u)
page.on('request', (r) => {
  const url = r.url()
  lastReq = Date.now()
  if (!phase || !/^https?:/.test(url) || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) return
  const host = new URL(url).host
  phase.hosts[host] = (phase.hosts[host] ?? 0) + 1
  phase.requests++
  if (isOM(url)) phase.omLocations += url.match(/[?&]latitude=([^&]*)/)?.[1].split(',').length ?? 1
  if (host === 's3.amazonaws.com') phase.terrainTiles++
  if (host === 'hydro.nationalmap.gov') phase.nhd++
})
const start = (name) => { phase = { name, t0: performance.now(), hosts: {}, requests: 0, omLocations: 0, terrainTiles: 0, nhd: 0, toConditionsMs: null, settledMs: null, longestTaskMs: 0 }; phases.push(phase); lastReq = Date.now() }
const now = () => Math.round(performance.now() - phase.t0)
const until = async (fn, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(100) } return false }
/** Settled: 2 s without any request and no resource still loading, and the flood block (if any) done. */
const settle = async () => {
  const t0 = Date.now()
  while (Date.now() - t0 < 90000) {
    const quiet = Date.now() - lastReq > 2000
    const busy = await page.evaluate(() => { const s = window.__store.get(); const pending = [s.conditions, s.alerts, s.station, s.rivers, s.radar].some((r) => r.state === 'loading'); const fb = s.floodFor ? s.blocks[s.floodFor] : null; const floodBusy = !!fb && (fb.grid.state === 'loading' || fb.flood.state === 'loading' || fb.flowlines.state === 'loading' || (fb.grid.state === 'ready' && fb.flood.state === 'idle')); return pending || floodBusy }).catch(() => false)
    if (quiet && !busy) return now()
    await page.waitForTimeout(200)
  }
  return null
}
const longest = async (sinceMs) => page.evaluate((s) => Math.max(0, ...window.__longTasks.filter((t) => t.t >= s).map((t) => t.d)), sinceMs)

// ---- Phase 1: first open (grant location) ----
start('first open')
const t0abs = await page.evaluate(() => performance.now()).catch(() => 0)
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
const tStart = await page.evaluate(() => performance.timeOrigin)
await until(() => window.__store?.get().conditions.state === 'ready')
phase.toConditionsMs = now()
phase.settledMs = await settle()
phase.longestTaskMs = Math.round(await longest(0))
void t0abs
void tStart

// ---- Phase 2: place change (search) ----
start('place change')
const pageT0 = await page.evaluate(() => performance.now())
await openNow(page)
await searchPlace(page, 'Ames')
await page.waitForTimeout(600)
await page.getByRole('dialog').getByRole('option').first().click()
await until(() => !window.__store.get().pickerOpen && window.__store.get().conditions.state === 'ready' && /Ames/.test(window.__store.get().place?.name ?? ''))
phase.toConditionsMs = now()
phase.settledMs = await settle()
phase.longestTaskMs = Math.round(await longest(pageT0))

await browser.close()
const fmt = (p) => `${p.name.padEnd(13)} OM locations ${String(p.omLocations).padStart(4)} · terrain tiles ${String(p.terrainTiles).padStart(3)} · NHD ${p.nhd} · requests ${String(p.requests).padStart(3)} · conditions ${p.toConditionsMs} ms · settled ${p.settledMs ?? '>90 000'} ms · longest task ${p.longestTaskMs} ms`
console.log(`flood-tile-measure ${LABEL} ${MODE} ${VIEW} ${HEADLESS ? 'headless' : 'headed'} CPU 4× Fast 4G mocked ${BASE}`)
for (const p of phases) console.log('  ' + fmt(p))
for (const p of phases) console.log(`  ${p.name}: ${Object.entries(p.hosts).sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h} ${n}`).join(', ')}`)
if (mocks.live.length) console.log(`  live fall-through: ${mocks.live.length} requests`)
console.log('JSON ' + JSON.stringify({ label: LABEL, view: VIEW, phases: phases.map(({ name, hosts, requests, omLocations, terrainTiles, nhd, toConditionsMs, settledMs, longestTaskMs }) => ({ name, hosts, requests, omLocations, terrainTiles, nhd, toConditionsMs, settledMs, longestTaskMs })) }))
