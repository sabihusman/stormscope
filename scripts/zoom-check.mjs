// Close-zoom (level-0 block) pipeline check: all visible blocks must reach grid/rain/flood ready,
// and the rendered screenshot is saved for eyeballing.
import { chromium } from 'playwright'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
// --mock answers every API locally (zero live calls, scripts/lib/mock-server.mjs); live-only checks are skipped and said so.
const MOCK = process.argv.includes('--mock')
assertBudget(MOCK ? 'zoom-check.mjs (mock)' : 'zoom-check.mjs', { openMeteo: !MOCK })
import { mkdirSync } from 'node:fs'
import { allowLocation, openMap, openMore, openTrip, pageText, setLayers, setSheet, setUnits, sheetText, tripText, searchPlace, openNow } from './lib/ui.mjs'

const BASE = process.argv[2] || 'http://localhost:5174/'
const OUT = process.argv[3] || 'e2e-shots/zoom'
mkdirSync(OUT, { recursive: true })
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const c = await b.newContext({ viewport: { width: 1200, height: 800 }, geolocation: { latitude: 41.67, longitude: -93.7 }, permissions: ['geolocation'] })
await c.addInitScript(() => { try { if (!localStorage.getItem('stormscope.layers')) localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: false, station: false, nowcast: false })) } catch {} })
const p = await c.newPage()
const __recordBudget = trackOpenMeteo(p, 'zoom-check.mjs')
if (MOCK) await installMocks(c, { focus: { lat: 41.67, lng: -93.7 } })
const om = []
p.on('response', (r) => /open-meteo\.com\/v1\/forecast/.test(r.url()) && om.push(r.status()))
await p.goto(BASE, { waitUntil: 'load' })
await p.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
await p.waitForTimeout(4000)
await openMap(p)
await setLayers(p, { rainfall: true, flood: true })
await p.evaluate(() => window.__map.jumpTo({ center: [-93.6, 41.6], zoom: 11 }))
const t0 = Date.now()
let st = []
for (let i = 0; i < 120; i++) {
  st = await p.evaluate(() => {
    const s = window.__store.get()
    return s.visibleBlocks.map((k) => [s.blocks[k].grid.state, s.blocks[k].rainCells.state, s.blocks[k].flood.state].join('/'))
  })
  if (st.length && st.every((x) => x === 'ready/ready/ready')) break
  await p.waitForTimeout(1000)
}
await p.waitForTimeout(1500)
const info = await p.evaluate(() => {
  const s = window.__store.get()
  const nowHour = Math.floor(Date.now() / 3600000)
  return s.visibleBlocks.map((k) => {
    const bl = s.blocks[k]
    const f = bl.rainCells.data?.features ?? []
    const mid = f[Math.floor(f.length / 2)]?.properties ?? {}
    return { k, level: bl.id.level, cells: f.length, a24: mid[`a${nowHour + 24}`], floodCells: bl.flood.data?.cells.length ?? 0, err: bl.grid.error || bl.rainCells.error || bl.flood.error }
  })
})
const ok = info.length >= 2 && info.every((i) => i.level === 0 && i.cells === 49 && i.floodCells === 576 && !i.err)
console.log(`${ok ? 'PASS' : 'FAIL'}  Close zoom: ${info.length} level-0 blocks with 49 rain cells + 576 flood cells each (settled in ${Math.round((Date.now() - t0) / 1000)} s; open-meteo statuses ${[...new Set(om)].join(',')})`)
if (!ok) console.log(JSON.stringify(info))
await p.screenshot({ path: `${OUT}/close-zoom.png` })
__recordBudget()
await b.close()
console.log(`${ok ? 1 : 0}/1 passed`)
process.exit(ok ? 0 : 1)
