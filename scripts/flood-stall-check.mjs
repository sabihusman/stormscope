// Mocked only (zero live calls), not part of the live suite:
//   node scripts/flood-stall-check.mjs http://localhost:4173/ [stall]
// With terrain-tile requests that never answer, the flood job must still
// settle (error or ready-with-fallback) within the fetch timeout instead of hanging forever.
import { chromium } from 'playwright'
import { installMocks } from './lib/mock-server.mjs'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
assertBudget('diag-flood-stall (mock)', { openMeteo: false })
const BASE = process.argv[2] || 'http://localhost:4173/'
const STALL = process.argv[3] === 'stall'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, geolocation: { latitude: 41.67, longitude: -93.7 }, permissions: ['geolocation'], serviceWorkers: 'block' })
await ctx.addInitScript(() => { try { localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: true, flood: true, rivers: false, station: false, nowcast: false })) } catch {} })
const page = await ctx.newPage()
const done = trackOpenMeteo(page, 'diag-flood-stall (mock)')
await installMocks(ctx, {})
let stalled = 0
if (STALL) await ctx.route(/s3\.amazonaws\.com\/elevation-tiles-prod/, () => { stalled++ /* never answered */ })
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
await page.waitForTimeout(3000)
await page.evaluate(() => window.__map.jumpTo({ center: [-93.6, 41.6], zoom: 11 }))
const t0 = Date.now()
let st
for (let i = 0; i < 60; i++) {
  st = await page.evaluate(() => { const s = window.__store.get(); return s.visibleBlocks.map((k) => ({ k, flood: s.blocks[k].flood.state, cells: s.blocks[k].flood.data?.cells.length ?? 0, err: s.blocks[k].flood.error })) })
  if (st.length && st.every((x) => x.flood === 'ready' || x.flood === 'error')) break
  await page.waitForTimeout(1000)
}
console.log(`${STALL ? 'STALLED terrain' : 'normal terrain'}: settled in ${Math.round((Date.now() - t0) / 1000)} s, terrain requests held: ${stalled}`)
console.log(JSON.stringify(st))
done()
await browser.close()
