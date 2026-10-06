// Containment: a throwing map layer or panel must not unmount the app. The test makes the
// Rainfall layer throw (by making MapLibre reject its source) and the Rivers panel throw (by
// corrupting its data), then checks the layer is switched off with a visible note, the panel
// shows "unavailable" with Retry, and the menu, tabs, sheet and map all still work.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
// Toggling Rainfall on fetches Open-Meteo for the visible blocks on a live deployment; only the mocked run makes none.
assertBudget('boundary-check.mjs', { openMeteo: !MOCK })
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/boundary'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
await ctx.addInitScript(() => { try { if (!localStorage.getItem('stormscope.layers')) localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: true, station: true, nowcast: false })) } catch {} })
const page = await ctx.newPage()
// Guard first, mocks after: Playwright runs the last-registered route first, so the mocks answer and
// only what falls through them reaches the guard (counted and capped — never silently live).
const __recordBudget = trackOpenMeteo(page, `boundary-check.mjs${MOCK ? ' (mock)' : ''}`)
if (MOCK) await installMocks(ctx, {})
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {})
for (let i = 0; i < 40; i++) { await page.waitForTimeout(500); if (await page.evaluate(() => !!window.__map?.loaded() && window.__store?.get().rivers.state === 'ready')) break }
const st = () => page.evaluate(() => { const s = window.__store.get(); return { layers: s.layers, errors: s.layerErrors, sheet: s.sheet, tab: s.tab, toast: s.toast?.text ?? null } })

// ---- 1. A map layer throws inside its effect: MapLibre rejects the rainfall source.
await page.evaluate(() => {
  const m = window.__map
  const orig = m.addSource.bind(m)
  m.addSource = (id, spec) => { if (id === 'rain-cells') throw new Error('injected: rain-cells source rejected'); return orig(id, spec) }
  window.__restoreAddSource = () => { m.addSource = orig }
})
await page.getByRole('button', { name: /layer menu/ }).click()
await page.getByRole('button', { name: 'Rainfall' }).click()
await page.waitForTimeout(1500)
let s = await st()
check('Throwing layer is switched off and its error recorded', s.layers.rainfall === false && /injected/.test(s.errors?.rainfall ?? ''), JSON.stringify({ rainfall: s.layers.rainfall, error: s.errors?.rainfall }))
check('Layer menu shows "unavailable — reason" for it', /Rainfall[\s\S]{0,40}unavailable — injected/.test(await page.locator('.fab-menu, .fab-stack').innerText().catch(() => '')) || (await page.getByText(/unavailable — injected/).count()) > 0)
check('A toast says the layer was turned off', /Rainfall turned off/.test(s.toast ?? '') || (await page.getByText(/Rainfall turned off/).count()) > 0, s.toast ?? '')
check('Other layers untouched (radar, rivers, station still on)', s.layers.radar && s.layers.rivers && s.layers.station)
await page.getByRole('button', { name: /layer menu/ }).click() // close
check('Layer menu still opens and closes', (await page.getByRole('button', { name: /layer menu/ }).isVisible()))
await page.getByRole('tab', { name: 'Station' }).click()
await page.waitForTimeout(400)
s = await st()
check('Bottom sheet tabs still work after a layer failure', s.tab === 'station' && s.sheet === 'half')
await page.getByRole('button', { name: 'Collapse panel' }).click()
await page.waitForTimeout(400)
check('Sheet still collapses', (await st()).sheet === 'peek')
const mapOk = await page.evaluate(() => { const m = window.__map; const z = m.getZoom(); m.jumpTo({ zoom: z + 1 }); return Math.abs(m.getZoom() - (z + 1)) < 0.01 && !!m.getLayer('rv-radar-0') })
check('Map still interactive with the radar layer present', mapOk)
await page.screenshot({ path: `${OUT}/layer-failed.png` })
// Retry: fix the cause, enable again → works.
await page.evaluate(() => window.__restoreAddSource())
await page.getByRole('button', { name: /layer menu/ }).click()
await page.getByRole('button', { name: 'Rainfall' }).click()
await page.getByRole('button', { name: /layer menu/ }).click()
await page.waitForTimeout(2500)
s = await st()
check('Re-enabling the layer after the cause is fixed retries it (on, error cleared)', s.layers.rainfall === true && !s.errors?.rainfall && (await page.evaluate(() => !!window.__map.getSource('rain-cells'))), JSON.stringify({ rainfall: s.layers.rainfall, error: s.errors?.rainfall ?? null }))

// ---- 2. A panel throws during render: a gauge whose `name` getter throws. The map layer only reads
// `name` inside its click handler, so this hits the Rivers panel's render path alone.
await page.evaluate(() => window.__store.set((x) => {
  const g = { ...x.rivers.data[0] }
  Object.defineProperty(g, 'name', { get() { throw new Error('injected: panel-only failure') }, enumerable: true })
  return { rivers: { ...x.rivers, data: [g, ...x.rivers.data.slice(1)] } }
}))
await page.getByRole('tab', { name: 'Rivers' }).click()
await page.waitForTimeout(600)
const body = await page.locator('.sheet-body').innerText()
check('Throwing panel shows "unavailable — reason" with Retry, instead of unmounting the app', /Rivers unavailable —/.test(body) && (await page.getByRole('button', { name: 'Retry' }).count()) === 1, body.split('\n')[0])
await page.getByRole('tab', { name: 'Station' }).click()
await page.waitForTimeout(400)
check('Other tabs still render after a panel failure', /Station|pressure|Pressure/i.test(await page.locator('.sheet-body').innerText()))
await page.evaluate(() => window.__store.set((x) => ({ rivers: { ...x.rivers, data: x.rivers.data.slice(1) } })))
await page.getByRole('tab', { name: 'Rivers' }).click()
await page.waitForTimeout(400)
check('Panel recovers once its data is sane again', !/unavailable —/.test(await page.locator('.sheet-body').innerText()))
check('Layer menu, search and legend still present', (await page.getByRole('button', { name: /layer menu/ }).count()) === 1 && (await page.getByRole('button', { name: 'Change location' }).count()) === 1 && (await page.locator('.legend, .legend-chip').count()) >= 1)
await page.screenshot({ path: `${OUT}/panel-failed.png` })
check('No uncaught page errors (everything was contained)', pageErrors.length === 0, pageErrors[0])
__recordBudget()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
