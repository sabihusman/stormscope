// Why is "journey open" (tapping a destination search result) slow? CPU 4×, phone viewport, touch;
// Open-Meteo and routing are aborted at the network layer so this costs no quota — the interaction
// latency happens before any response arrives anyway.
import { startInMode } from './lib/mode.mjs'
import { chromium } from 'playwright'
import { touchTap, centre } from './lib/touch.mjs'
const BASE = process.argv[2] || 'http://localhost:5174/'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
await ctx.addInitScript(() => { try { localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: false, station: true, nowcast: false })) } catch {} })
await ctx.route(/open-meteo\.com\/v1\/(forecast|archive)|valhalla1\.openstreetmap\.de|router\.project-osrm\.org/, (r) => r.abort('blockedbyclient'))
await startInMode(ctx, 'full')
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
await page.addInitScript(() => {
  window.__ev = []
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) window.__ev.push({ t: Math.round(e.startTime), dur: Math.round(e.duration), name: e.name, processing: Math.round(e.processingEnd - e.processingStart), inputDelay: Math.round(e.processingStart - e.startTime), target: e.target?.tagName + '.' + (e.target?.className || '') }) }).observe({ type: 'event', buffered: true, durationThreshold: 16 })
  window.__lt = []
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ t: Math.round(e.startTime), dur: Math.round(e.duration) }) }).observe({ type: 'longtask', buffered: true })
})
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {})
await page.waitForTimeout(6000)
await touchTap(page, await centre(page.getByRole('tab', { name: 'Journey' })))
await page.waitForTimeout(1500)
await page.getByRole('searchbox', { name: 'Destination' }).fill('Iowa City')
await page.waitForTimeout(3000)
// Profile just the option tap.
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
await cdp.send('Profiler.start')
const t0 = await page.evaluate(() => performance.now())
await touchTap(page, await centre(page.getByRole('option').first()))
await page.waitForTimeout(2500)
const { profile } = await cdp.send('Profiler.stop')
const ev = await page.evaluate((t0) => ({ events: window.__ev.filter((e) => e.t >= t0 - 50), longTasks: window.__lt.filter((e) => e.t >= t0 - 50) }), t0)
console.log('interactions after the tap:', JSON.stringify(ev.events))
console.log('long tasks after the tap:', JSON.stringify(ev.longTasks))
// Self-time by function over the profiled window.
const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
const self = new Map()
const dt = profile.timeDeltas
for (let i = 0; i < profile.samples.length; i++) { const n = nodes.get(profile.samples[i]); const cf = n.callFrame; const key = `${cf.functionName || '(anon)'} ${(cf.url || '').replace(/^https?:\/\/[^/]+/, '').slice(0, 50)}:${cf.lineNumber}`; self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0)) }
const total = [...self.values()].reduce((a, b) => a + b, 0) / 1000
console.log(`profiled ${total.toFixed(0)} ms; top self-time:`)
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${(v / 1000).toFixed(0).padStart(5)} ms  ${k}`)
// Inclusive time for app-level entry points (top of stack per sample → walk parents).
const parentOf = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id)
const incl = new Map()
for (let i = 0; i < profile.samples.length; i++) { let id = profile.samples[i]; const seen = new Set(); while (id != null) { const n = nodes.get(id); const cf = n.callFrame; const key = `${cf.functionName || '(anon)'} ${(cf.url || '').replace(/^https?:\/\/[^/]+/, '').slice(0, 40)}`; if (!seen.has(key)) { seen.add(key); incl.set(key, (incl.get(key) ?? 0) + (dt[i] ?? 0)) } id = parentOf.get(id) } }
console.log('top inclusive (app + react):')
for (const [k, v] of [...incl.entries()].filter(([k]) => !/\(root\)|\(program\)|\(idle\)|\(garbage/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 16)) console.log(`  ${(v / 1000).toFixed(0).padStart(5)} ms  ${k}`)
await browser.close()
