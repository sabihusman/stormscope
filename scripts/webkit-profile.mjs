// WebKit long-frame attribution without a profiler: with window.__perfMarks the app records a
// performance.measure for its own per-frame work (wind particle loop, nowcast canvas redraw,
// terrain apply). For every rAF gap over 50 ms during nowcast playback and the 3D toggle we
// report how much of the gap our code accounts for; the rest is the engine (layout, MapLibre's
// own render, compositing, GPU).  Interaction latency is measured directly as input → next
// painted frame (two rAFs after the pointerdown), because WebKit's Event Timing entries report
// duration 16 ms / processing 0 even for a 120 ms handler (checked).
import { webkit, chromium } from 'playwright'
import { installMocks } from './lib/mock-server.mjs'
import { touchTap, centre } from './lib/touch.mjs'
const argv = process.argv.slice(2)
const BASE = argv.find((a) => /^https?:/.test(a)) || 'http://localhost:4173/'
const ENGINE = argv.includes('--browser=chromium') ? 'chromium' : 'webkit'
const browser = ENGINE === 'webkit' ? await webkit.launch({ headless: false }) : await chromium.launch({ headless: false, channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'], serviceWorkers: 'block' })
await ctx.addInitScript(() => { try { localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: true, station: true, nowcast: false })) } catch {} })
await ctx.addInitScript(() => {
  window.__perfMarks = true
  window.__frames = []
  window.__inputs = []
  let last = performance.now()
  const loop = (t) => { window.__frames.push({ t, d: t - last }); last = t; requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  const onInput = (e) => { const t0 = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.__inputs.push({ type: e.type, t0, toPaintMs: Math.round(performance.now() - t0), target: (e.target?.tagName || '') + '.' + (e.target?.className || '').toString().split(' ')[0] }))) }
  document.addEventListener('pointerdown', onInput, true)
  document.addEventListener('click', onInput, true)
})
await installMocks(ctx, {})
const page = await ctx.newPage()
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {})
for (let i = 0; i < 40; i++) { await page.waitForTimeout(500); if (await page.evaluate(() => !!window.__map?.loaded() && !!window.__store?.get().radar.data)) break }
const phase = async (name, fn) => {
  const t0 = await page.evaluate(() => performance.now())
  await fn()
  const t1 = await page.evaluate(() => performance.now())
  const r = await page.evaluate(({ t0, t1 }) => {
    const frames = window.__frames.filter((f) => f.t >= t0 && f.t <= t1)
    const long = frames.filter((f) => f.d > 50)
    const measures = performance.getEntriesByType('measure').filter((m) => m.startTime >= t0 - 60 && m.startTime <= t1)
    const inFrame = (f) => measures.filter((m) => m.startTime >= f.t - f.d - 1 && m.startTime <= f.t)
    const attributed = long.map((f) => { const ms = inFrame(f); const ours = ms.reduce((a, m) => a + m.duration, 0); return { gapMs: Math.round(f.d), oursMs: Math.round(ours), parts: Object.fromEntries(ms.map((m) => [m.name, Math.round(m.duration)])) } })
    const inputs = window.__inputs.filter((i) => i.t0 >= t0 && i.t0 <= t1)
    return { frames: frames.length, long: long.length, over100: frames.filter((f) => f.d > 100).length, maxMs: Math.round(Math.max(0, ...frames.map((f) => f.d))), attributed: attributed.sort((a, b) => b.gapMs - a.gapMs).slice(0, 6), ourTotalMs: Math.round(measures.reduce((a, m) => a + m.duration, 0)), inputs }
  }, { t0, t1 })
  console.log(`== ${name}: frames ${r.frames}, >50 ms ${r.long}, >100 ms ${r.over100}, max ${r.maxMs} ms, our measured work ${r.ourTotalMs} ms`)
  for (const a of r.attributed) console.log(`   gap ${String(a.gapMs).padStart(4)} ms — ours ${String(a.oursMs).padStart(4)} ms ${JSON.stringify(a.parts)}`)
  for (const i of r.inputs) console.log(`   input→next paint: ${i.type} on ${i.target} ${i.toPaintMs} ms`)
}
const menu = async () => touchTap(page, await centre(page.getByRole('button', { name: /layer menu/ })))
await phase('enable rainfall+flood+nowcast', async () => { await menu(); for (const n of ['Rainfall', 'Flood risk', 'Nowcast']) { await touchTap(page, await centre(page.getByRole('button', { name: n }))); await page.waitForTimeout(300) } await menu(); for (let i = 0; i < 60; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => { const s = window.__store.get(); return s.visibleBlocks.length > 0 && s.visibleBlocks.every((k) => s.blocks[k]?.nowcast.data) })) break } })
await phase('nowcast playing (8 s)', async () => { await touchTap(page, await centre(page.getByRole('tab', { name: 'Timeline' }))); await page.waitForTimeout(400); const nt = page.getByRole('tab', { name: 'Nowcast' }); if (await nt.count()) await touchTap(page, await centre(nt)); await page.waitForTimeout(300); await touchTap(page, await centre(page.getByRole('button', { name: 'Play' }))); await page.waitForTimeout(8000) })
await phase('nowcast pause', async () => { await touchTap(page, await centre(page.getByRole('button', { name: 'Pause' }))); await page.waitForTimeout(1200) })
await phase('3D terrain on', async () => { await menu(); await touchTap(page, await centre(page.getByRole('button', { name: /3D terrain/ }))); await menu(); await page.waitForTimeout(3000) })
await phase('3D terrain off', async () => { await menu(); await touchTap(page, await centre(page.getByRole('button', { name: /3D terrain/ }))); await menu(); await page.waitForTimeout(2000) })
await phase('pan ×3', async () => { const { touchDrag } = await import('./lib/touch.mjs'); for (let i = 0; i < 3; i++) { await touchDrag(page, { x: 195, y: 300 }, { x: 95, y: 220 }, { steps: 10, settleMs: 60 }); await page.waitForTimeout(700) } })
await browser.close()
