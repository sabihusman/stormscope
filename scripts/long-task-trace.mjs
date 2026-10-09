// What is the long main-thread task after Pause with radar + nowcast? Reproduces qa.mjs's idle window
// (phone 390×844, APIs mocked, headless software GL unless --headed) and, over N windows of
// play 3 s → pause → 3 s idle, records every long task (with its attribution) and a CPU profile of the
// idle window, then prints the functions with the most self time inside it.
//   node scripts/long-task-trace.mjs [base-url] [--windows=3] [--headed] [--out=e2e-shots/trace]
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { summarise } from './lib/cpu-profile.mjs'
import { allowLocation, expandPlayback, openMap, settle } from './lib/ui.mjs'

const args = process.argv.slice(2)
const BASE = (args.find((a) => !a.startsWith('--')) || 'http://localhost:4173/').replace(/\/?$/, '/')
const WINDOWS = Number(args.find((a) => a.startsWith('--windows='))?.slice(10) ?? 3)
const HEADED = args.includes('--headed')
const OUT = args.find((a) => a.startsWith('--out='))?.slice(6) ?? 'e2e-shots/trace'
mkdirSync(OUT, { recursive: true })
assertBudget('long-task-trace.mjs (mock)')

const PHL = { lat: 39.9526, lng: -75.1652 }
const browser = HEADED
  ? await chromium.launch({ headless: false, channel: 'chrome' }).catch(() => chromium.launch({ headless: false }))
  : await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: PHL.lat, longitude: PHL.lng }, permissions: ['geolocation'] })
await ctx.addInitScript(() => {
  try { localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: false, station: false, nowcast: false })) } catch {}
})
const page = await ctx.newPage()
const done = trackTraffic(page, 'long-task-trace.mjs (mock)')
await installMocks(ctx, { focus: PHL })
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
const until = async (fn, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(200) } return false }
await until(() => window.__store?.get().conditions.state === 'ready')
await openMap(page)
await page.getByRole('button', { name: 'Open layer menu' }).click()
await page.getByRole('radio', { name: 'Next 2 h wind & cloud' }).click()
await page.getByRole('button', { name: 'Close layer menu' }).click()
await settle(page, 12000)
await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' }))
await expandPlayback(page)

const cdp = await ctx.newCDPSession(page)
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 250 })

const report = []
for (let w = 1; w <= WINDOWS; w++) {
  await page.getByRole('button', { name: 'Play' }).click()
  await settle(page, 3000)
  // Arm the observer *before* Pause: qa's window starts right after the click.
  await page.evaluate(() => {
    window.__lt = []
    window.__ltObs?.disconnect()
    window.__ltObs = new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push({ t: Math.round(e.startTime), d: Math.round(e.duration), attr: e.attribution?.map((a) => `${a.containerType}${a.containerName ? ':' + a.containerName : ''}${a.containerSrc ? ':' + a.containerSrc.slice(-40) : ''}`).join(',') })))
    window.__ltObs.observe({ type: 'longtask', buffered: false })
    window.__t0 = performance.now()
  })
  await cdp.send('Profiler.start')
  await page.getByRole('button', { name: 'Pause' }).click()
  await settle(page, 3000)
  const { profile } = await cdp.send('Profiler.stop')
  const lt = await page.evaluate(() => { window.__ltObs.disconnect(); return { tasks: window.__lt.map((e) => ({ ...e, t: e.t - Math.round(window.__t0) })), heap: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576) } })
  const s = summarise(profile, 15)
  writeFileSync(`${OUT}/window-${w}.cpuprofile`, JSON.stringify(profile))
  report.push({ window: w, longTasks: lt.tasks, heapMB: lt.heap, busyMs: s.total, top: s.top })
  console.log(`window ${w}: long tasks ${lt.tasks.length ? lt.tasks.map((t) => `${t.d} ms at +${t.t} ms${t.attr ? ' (' + t.attr + ')' : ''}`).join('; ') : 'none'} · JS busy ${s.total} ms of 3 000 · heap ${lt.heap} MB`)
  for (const t of s.top) console.log(`    ${String(t.ms).padStart(7)} ms  ${t.fn}`)
}
writeFileSync(`${OUT}/report.json`, JSON.stringify({ base: BASE, headed: HEADED, at: new Date().toISOString(), report }, null, 1))
done()
await browser.close()
