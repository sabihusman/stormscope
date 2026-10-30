// The place's flood screening with a slow drainage (USGS NHD) answer, mocked only — the NHD query is held 8 s:
// the Flood page shows a quick rain-only level marked "refining…" within a few seconds, then the refined result
// once the drainage data lands; a reload in the same browser uses the drainage saved on the device (no NHD
// request) and the page says how much is saved.
//   node scripts/floodquick-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMore } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  floodquick-check.mjs: mocked only (a held drainage answer)')
  process.exit(3)
}
assertBudget('floodquick-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/floodquick'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const DELAY = 8000
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
const page = await ctx.newPage()
const done = trackTraffic(page, 'floodquick-check.mjs (mock)')
let nhd = 0
globalThis.__qaMockedRequest = (url) => { if (/hydro\.nationalmap\.gov/.test(url)) nhd++ }
await installMocks(ctx, { delayHosts: { 'hydro.nationalmap.gov': DELAY } })
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(100) } return false }
await until(() => window.__store?.get().conditions.state === 'ready')
/** The "How this is scored" details, opened (its text is hidden while closed). */
const method = async () => { const d = page.locator('.flood-page details.method'); if (!(await d.evaluate((el) => el.open))) await d.locator('summary').click(); await page.waitForTimeout(150); return d.innerText() }
const floodState = () => page.evaluate(() => { const s = window.__store.get(); const b = s.floodFor ? s.blocks[s.floodFor] : null; return { flood: b?.flood.state, prelim: b?.flood.data?.preliminary ?? null, cells: b?.flood.data?.cells.length ?? 0, flowlines: b?.flowlines.state, saved: b?.flowlines.data?.saved ?? null, bytes: b?.flowlines.data?.bytes ?? null, text: document.querySelector('.flood-page')?.innerText.replace(/\n/g, ' | ') ?? '' } })

// 1. First load: the quick estimate within a few seconds, labelled refining.
const t0 = Date.now()
await openMore(page, 'Flood risk')
const quick = await until(() => { const s = window.__store.get(); const b = s.floodFor ? s.blocks[s.floodFor] : null; return b?.flood.state === 'ready' && b.flood.data?.cells.length > 0 }, DELAY - 1000)
const tQuick = Date.now() - t0
await page.waitForTimeout(300) // the store has it; let React paint it
const q = await floodState()
check(`The Flood page shows a level within a few seconds (${(tQuick / 1000).toFixed(1)} s) while the drainage answer is still held`, quick && q.cells > 0 && q.flowlines === 'loading', JSON.stringify(q))
check('That first level is the quick rain-only pass, marked "refining…" on the page', q.prelim === true && /refining/.test(q.text), q.text.slice(0, 220))
await page.screenshot({ path: `${OUT}/quick.png` })
// 2. The refined result replaces it once the drainage lands.
const refined = await until(() => { const s = window.__store.get(); const b = s.floodFor ? s.blocks[s.floodFor] : null; return b?.flowlines.state === 'ready' && b.flood.state === 'ready' && !b.flood.data?.preliminary }, DELAY + 20000)
const r = await floodState()
check('Once the drainage data arrives the refined result replaces the quick one and "refining" goes', refined && !r.prelim && !/refining/.test(r.text), JSON.stringify(r).slice(0, 220))
check('The first load made one NHD request and saved the drainage on the device, the page reporting its size', nhd === 1 && r.saved === false && r.bytes > 0 && /saved on this device \(\d+ KB/.test(await method()), `NHD requests ${nhd}, bytes ${r.bytes}`)
await page.screenshot({ path: `${OUT}/refined.png` })

// 3. Second load in the same browser: the saved drainage is used, no NHD request, the full result straight away.
nhd = 0
await page.reload({ waitUntil: 'load' })
await until(() => window.__store?.get().conditions.state === 'ready')
const t1 = Date.now()
await openMore(page, 'Flood risk')
const full = await until(() => { const s = window.__store.get(); const b = s.floodFor ? s.blocks[s.floodFor] : null; return b?.flood.state === 'ready' && !b.flood.data?.preliminary && b.flood.data?.cells.length > 0 }, DELAY - 1000)
const tFull = Date.now() - t1
const s2 = await floodState()
check(`Second load: the saved drainage is used — no NHD request, the full result in ${(tFull / 1000).toFixed(1)} s (under the ${DELAY / 1000} s hold)`, full && nhd === 0 && s2.saved === true && !s2.prelim, `NHD requests ${nhd}, ${JSON.stringify(s2).slice(0, 220)}`)
check('The page says the drainage saved on this device was used on this load', /saved on this device \(\d+ KB, kept 30 days, used on this load\)/.test(await method()), (await method()).match(/Drainage for this place[^.]*\./)?.[0] ?? '(no line)')
await page.screenshot({ path: `${OUT}/second-load.png` })
// The terrain line names what the figure compares with (the average of the surrounding 10 mi window), never a bare "vs surroundings".
const terrainLine = (await page.locator('.flood-here').innerText()).replace(/\n/g, ' | ')
check('The flood card\'s terrain wording names the comparison: "level with the surrounding 10 mi" or "N ft below/above the average of the surrounding 10 mi"', /level with the surrounding 10 mi|ft (below|above) the average of the surrounding 10 mi/.test(terrainLine) && !/vs surroundings/.test(terrainLine), terrainLine.slice(0, 200))
// Redesign 7: the elevation figure is explained in plain words on the result itself, outside the scoring note.
const why = await page.locator('.flood-here .flood-why').innerText().catch(() => '')
const rel = await page.evaluate(() => { const s = window.__store.get(); const b = s.blocks[s.floodFor]; const p = s.place.lngLat; const cells = b.flood.data.cells; return cells.reduce((best, c) => (Math.hypot(c.center.lng - p.lng, c.center.lat - p.lat) < Math.hypot(best.center.lng - p.lng, best.center.lat - p.lat) ? c : best)).relElevation })
const expectWord = Math.abs(rel) < 2 ? /level with the land around it/ : rel < 0 ? /below it\. Rain runs downhill and collects on low ground/ : /above it\. Rain runs off high ground/
check(`The result explains "surroundings" (the average elevation of the 10 mi around the place) and why the figure matters, on the card itself (rel ${rel.toFixed(1)} m)`, /"Surroundings" means the average elevation of the 10 mi around the place|"surroundings" means the average elevation of the 10 mi around the place/.test(why) && expectWord.test(why) && !(await page.locator('.flood-page details.method').evaluate((el) => el.contains(document.querySelector('.flood-why')))), why.slice(0, 220))
check('The rain horizon options (6 / 12 / 24 / 48 h), the cell counts and "Show on the map" are still there', (await page.getByRole('radio', { name: /^next (6|12|24|48) h$/ }).count()) === 4 && (await page.locator('.flood-page .stat-grid .stat').count()) >= 3 && (await page.getByRole('button', { name: 'Show on the map' }).count()) === 1)
done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
