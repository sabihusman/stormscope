// DPR cap re-evaluation at 390×844, DPR 3, mocked data (zero live calls), Chrome and WebKit.
// For pixelRatio 3 (as is) and 2 (the proposed cap) in the same session (map.setPixelRatio):
//   - map canvas pixel size, nowcast canvas sizes (block canvases are n×8 px per cell, DPR-independent)
//   - frame-time distribution while the nowcast plays and while panning (what the cap actually changes)
//   - our nowcast redraw cost per frame change (performance.measure) and a texImage2D micro-benchmark
//     for one nowcast canvas (the "upload" cost; DPR-independent, shown for completeness).
import { chromium, webkit } from 'playwright'
import { installMocks } from './lib/mock-server.mjs'
import { touchTap, touchDrag, centre } from './lib/touch.mjs'
const BASE = process.argv[2] || 'http://localhost:4173/'
const out = {}
for (const engine of ['chromium', 'webkit']) {
  const browser = engine === 'webkit' ? await webkit.launch({ headless: false }) : await chromium.launch({ headless: false, channel: 'chrome', args: ['--window-size=430,900'] })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'], serviceWorkers: 'block' })
  await ctx.addInitScript(() => { try { localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: true, flood: true, rivers: true, station: true, nowcast: true })) } catch {} })
  await ctx.addInitScript(() => { window.__perfMarks = true; window.__frames = []; let last = performance.now(); const loop = (t) => { window.__frames.push({ t, d: t - last }); last = t; requestAnimationFrame(loop) }; requestAnimationFrame(loop) })
  await installMocks(ctx, {})
  const page = await ctx.newPage()
  const cdp = engine === 'chromium' ? await ctx.newCDPSession(page) : null
  if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await page.goto(BASE, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
  for (let i = 0; i < 90; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => { const s = window.__store?.get(); return !!window.__map?.loaded() && !!s && s.visibleBlocks.length > 0 && s.visibleBlocks.every((k) => s.blocks[k]?.nowcast.data && s.blocks[k]?.rainCells.data) })) break }
  await page.getByRole('button', { name: 'Map', exact: true }).click(); await page.waitForTimeout(600); await page.evaluate(() => window.__store.set({ sheet: 'half' }))
  await page.waitForTimeout(400)
  const nt = page.getByRole('tab', { name: 'Nowcast' })
  if (await nt.count()) await touchTap(page, await centre(nt))
  await page.waitForTimeout(300)
  const res = { engine: `${engine} ${browser.version()}`, dpr: await page.evaluate(() => devicePixelRatio), cpuThrottle: cdp ? 4 : 1, ratios: {} }
  const upload = await page.evaluate(() => {
    // texImage2D of one nowcast block canvas (what MapLibre does per canvas source per frame change)
    const src = document.querySelector('canvas') // any canvas just for size reference; use a fresh one of nowcast size
    void src
    const n = Math.max(...Object.values(window.__store.get().blocks).map((b) => b.nowcast.data?.n ?? 0)) * 8
    const c = document.createElement('canvas'); c.width = n; c.height = n
    const g = document.createElement('canvas').getContext('webgl')
    const tex = g.createTexture(); g.bindTexture(g.TEXTURE_2D, tex)
    const t0 = performance.now(); for (let i = 0; i < 20; i++) g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, c); g.finish(); const per = (performance.now() - t0) / 20
    return { nowcastCanvasPx: `${n}×${n}`, texImage2DMs: +per.toFixed(2) }
  })
  res.upload = upload
  for (const ratio of [3, 2]) {
    await page.evaluate((r) => { window.__map.setPixelRatio(r) }, ratio)
    await page.waitForTimeout(1200)
    const canvas = await page.evaluate(() => { const c = window.__map.getCanvas(); return { w: c.width, h: c.height, mpx: +((c.width * c.height) / 1e6).toFixed(2) } })
    const phase = async (name, fn) => {
      const t0 = await page.evaluate(() => performance.now())
      await fn()
      const t1 = await page.evaluate(() => performance.now())
      return page.evaluate(({ t0, t1 }) => {
        const f = window.__frames.filter((x) => x.t >= t0 && x.t <= t1).map((x) => x.d).sort((a, b) => a - b)
        const q = (p) => Math.round(f[Math.min(f.length - 1, Math.floor(p * f.length))])
        const redraw = performance.getEntriesByType('measure').filter((m) => m.name === 'nowcast-redraw' && m.startTime >= t0 && m.startTime <= t1).map((m) => m.duration)
        return { frames: f.length, p50: q(0.5), p90: q(0.9), max: Math.round(f[f.length - 1] ?? 0), over50: f.filter((d) => d > 50).length, over100: f.filter((d) => d > 100).length, redrawN: redraw.length, redrawAvgMs: redraw.length ? +(redraw.reduce((a, b) => a + b, 0) / redraw.length).toFixed(1) : null, redrawMaxMs: redraw.length ? +Math.max(...redraw).toFixed(1) : null }
      }, { t0, t1 })
    }
    const play = await phase('play', async () => { await touchTap(page, await centre(page.getByRole('button', { name: 'Play' }))); await page.waitForTimeout(6000); await touchTap(page, await centre(page.getByRole('button', { name: 'Pause' }))) })
    const pan = await phase('pan', async () => { for (let i = 0; i < 3; i++) { await touchDrag(page, { x: 195, y: 300 }, { x: 95, y: 220 }, { steps: 10, settleMs: 60 }); await page.waitForTimeout(600) } })
    res.ratios[ratio] = { mapCanvas: canvas, nowcastPlaying: play, pan }
    console.log(`${engine} pixelRatio ${ratio}: map canvas ${canvas.w}×${canvas.h} (${canvas.mpx} Mpx) | nowcast playing p50/p90/max ${play.p50}/${play.p90}/${play.max} ms, >50 ${play.over50}, >100 ${play.over100}, redraw avg/max ${play.redrawAvgMs}/${play.redrawMaxMs} ms (${play.redrawN} frame changes) | pan p50/p90/max ${pan.p50}/${pan.p90}/${pan.max} ms, >50 ${pan.over50}`)
  }
  console.log(`${engine}: nowcast block canvas ${upload.nowcastCanvasPx} px, texImage2D ${upload.texImage2DMs} ms per canvas`)
  out[engine] = res
  await browser.close()
}
import('node:fs').then((fs) => fs.writeFileSync('e2e-shots/perf/dpr-check.json', JSON.stringify(out, null, 2)))
