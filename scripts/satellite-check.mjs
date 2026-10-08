// Satellite layer (P1) + radar/satellite exclusivity with time carry-over.
// Run with VIEWPORT=mobile for a phone-sized check.
import { chromium } from 'playwright'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
// --mock answers every API locally (zero live calls, scripts/lib/mock-server.mjs); live-only checks are skipped and said so.
const MOCK = process.argv.includes('--mock')
assertBudget(MOCK ? 'satellite-check.mjs (mock)' : 'satellite-check.mjs') // the Now screen fetches one Open-Meteo location per place on every load
import { mkdirSync } from 'node:fs'
import { allowLocation, expandPlayback, openMap, openMore, openTrip, pageText, setLayers, setSheet, setUnits, sheetText, tripText, searchPlace, openNow } from './lib/ui.mjs'

const BASE = process.argv[2] || 'http://localhost:5174/'
const OUT = process.argv[3] || 'e2e-shots/satellite'
mkdirSync(OUT, { recursive: true })
const mobile = process.env.VIEWPORT === 'mobile'
console.log(`viewport: ${mobile ? 'mobile 390×844' : 'desktop 1200×800'}`)
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({
  viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 800 },
  isMobile: mobile,
  hasTouch: mobile,
  geolocation: { latitude: 41.67, longitude: -93.7 },
  permissions: ['geolocation'],
})
await ctx.addInitScript(() => { try { if (!localStorage.getItem('stormscope.layers')) localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: false, station: true, nowcast: false })) } catch {} }) // not under test here: keep gauge/NWS traffic off the shared IP
const page = await ctx.newPage()
const logs = []
page.on('console', (m) => /[imagery]/.test(m.text()) && logs.push(m.text()))
await page.addInitScript(() => { window.__trace = true })
const __recordBudget = trackOpenMeteo(page, MOCK ? 'satellite-check.mjs (mock)' : 'satellite-check.mjs')
if (MOCK) await installMocks(ctx, { focus: { lat: 41.67, lng: -93.7 } })
const tiles = []
page.on('response', (r) => /gibs\.earthdata\.nasa\.gov\/wmts\/epsg3857\/best\/GOES/.test(r.url()) && tiles.push(r.status()))
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
await page.waitForTimeout(4000)
await openMap(page)
await page.evaluate(() => window.__map.jumpTo({ zoom: 6 }))

const st = () =>
  page.evaluate(() => {
    const s = window.__store.get()
    const past = s.radar.data?.frames.filter((f) => f.kind === 'past') ?? []
    return {
      layers: s.layers,
      radarFrames: s.radar.data?.frames.length ?? 0,
      radarFrame: s.radarFrame,
      radarTime: (s.radar.data?.frames[s.radarFrame]?.time ?? 0) * 1000,
      radarOldest: (past[0]?.time ?? 0) * 1000,
      satN: s.satellite.data?.times.length ?? 0,
      satFrame: s.satFrame,
      satTime: s.satellite.data?.times[s.satFrame] ?? 0,
      satLatest: s.satellite.data?.latest ?? 0,
      satLayer: s.satellite.data?.layer.id,
      anim: s.animLayer,
      lag: s.imageryLag,
      carry: s.imageryCarry,
      mapRadar: window.__map.getStyle().layers.filter((l) => l.id.startsWith('rv-radar-')).length,
      mapSat: window.__map.getStyle().layers.filter((l) => l.id.startsWith('gibs-sat-')).length,
      mapRivers: !!window.__map.getLayer('river-gauges'),
      mapStation: !!window.__map.getLayer('station-marker'),
    }
  })
const waitFor = async (pred, ms = 60000) => {
  const t0 = Date.now()
  let s = await st()
  while (!pred(s) && Date.now() - t0 < ms) {
    await page.waitForTimeout(800)
    s = await st()
  }
  return s
}
const openMenu = () => page.getByRole('button', { name: /layer menu/ }).click()

// ---- Baseline: radar on, satellite off (default), station on, rivers off (not under test).
let s = await waitFor((x) => x.radarFrames > 0)
check('Default: radar on, satellite off, map has radar frames', s.layers.radar && !s.layers.satellite && s.mapRadar === s.radarFrames && s.mapSat === 0, `${s.mapRadar} radar layers`)

// Scrub radar back to its oldest past frame (~2 h ago) so the carry-over has a satellite match.
await expandPlayback(page) // the phone layout shows a pill until expanded
await page.getByRole('slider', { name: 'Playback time' }).focus()
await page.keyboard.press('Home')
s = await st()
const viewedRadar = s.radarTime
check('Radar scrubbed to its oldest frame', s.radarFrame === 0 && viewedRadar > 0, new Date(viewedRadar).toISOString().slice(11, 16) + 'Z')

// ---- Switch to satellite via the imagery radio: radar goes off, others stay, time carries.
await openMenu()
check('Imagery control is a radio group with Radar and Satellite', (await page.getByRole('radio', { name: /Radar/ }).count()) === 1 && (await page.getByRole('radio', { name: /Satellite/ }).count()) === 1)
await page.getByRole('radio', { name: /Satellite/ }).click()
await page.waitForTimeout(400)
await openMenu()
s = await waitFor((x) => x.satN > 0 && !x.carry, 90000)
check('(a) Enabling satellite disables radar (store + map)', s.layers.satellite && !s.layers.radar && s.mapRadar === 0 && s.mapSat === s.satN, `${s.mapSat} satellite layers, ${s.mapRadar} radar layers`)
s = await waitFor((x) => x.mapStation, 60000) // its data may still be loading right after start-up
check('(b) Unrelated layers are untouched by the switch (station stays on, rivers stay off)', s.layers.station && s.mapStation && !s.layers.rivers, JSON.stringify({ rivers: s.layers.rivers, station: s.layers.station, mapStation: s.mapStation }))
check('Playback follows the active layer (satellite)', s.anim === 'satellite')
const delta1 = Math.abs(s.satTime - viewedRadar) / 60000
check('(c) Time carried over: satellite frame within 10 min of the radar time', delta1 <= 10 && !s.lag, `radar ${new Date(viewedRadar).toISOString().slice(11, 16)}Z → satellite ${new Date(s.satTime).toISOString().slice(11, 16)}Z (Δ ${delta1.toFixed(0)} min)`)
check('GIBS frames listed (10-min cadence, last ~3 h)', s.satN >= 10 && s.satN <= 20, `${s.satN} frames, ${s.satLayer}`)
await page.waitForTimeout(4000)
check('GOES tiles fetched OK', tiles.filter((t) => t === 200).length >= 4, `${tiles.filter((t) => t === 200).length} tiles 200`)
let tl = await page.locator('.playbar').innerText()
check('No lag label when the time carried over', !/earlier than the radar time/.test(tl))
await page.screenshot({ path: `${OUT}/satellite-carried.png` })

// ---- Back to radar: carry the satellite time to the nearest radar frame.
await openMenu()
await page.getByRole('radio', { name: /Radar/ }).click()
await page.waitForTimeout(400)
await openMenu()
s = await waitFor((x) => x.layers.radar && x.radarFrames > 0 && !x.carry)
const delta2 = Math.abs(s.radarTime - s.satTime) / 60000
check('Back to radar: satellite off, radar frame nearest the satellite time', s.layers.radar && !s.layers.satellite && s.mapSat === 0 && delta2 <= 10, `Δ ${delta2.toFixed(0)} min`)

// ---- Lag case: radar on its newest frame (~10 min old) → satellite newest is ~1 h older.
await page.getByRole('slider').focus()
await page.keyboard.press('End')
s = await st()
const newestRadar = s.radarTime
await openMenu()
await page.getByRole('radio', { name: /Satellite/ }).click()
await page.waitForTimeout(400)
await openMenu()
s = await waitFor((x) => x.layers.satellite && x.satN > 0 && !x.carry)
// Let the switch settle (debounced toggle + frame refresh) before reading the landing frame.
s = await waitFor((x) => x.layers.satellite && !x.carry && (x.lag || Math.abs(x.satTime - newestRadar) <= 10 * 60000), 15000)
const gap = (newestRadar - s.satTime) / 60000
if (gap > 10) {
  if (!(s.satFrame === s.satN - 1 && !!s.lag)) console.log('trace:', logs.slice(-4).join(' || '))
  check('(d) Satellite lands on its newest frame when nothing is within 10 min', s.satFrame === s.satN - 1 && !!s.lag, `gap ${gap.toFixed(0)} min, lag note ${JSON.stringify(s.lag && { viewed: new Date(s.lag.viewed).toISOString().slice(11, 16), landed: new Date(s.lag.landed).toISOString().slice(11, 16) })}`)
  tl = await page.locator('.playbar').innerText()
  const m = tl.match(/Satellite: (\d{1,2}:\d{2}[^—]*) — (\d+) min earlier than the radar time you were on/)
  check('(d) Lag label "Satellite: HH:MM — X min earlier than the radar time you were on"', !!m && Math.abs(Number(m[2]) - gap) <= 10, m?.[0] ?? tl.split('\n').slice(0, 4).join(' | '))
  await page.screenshot({ path: `${OUT}/satellite-lag.png` })
  // Scrubbing clears the note.
  await page.getByRole('slider', { name: 'Playback time' }).focus()
  await page.keyboard.press('ArrowLeft')
  s = await st()
  check('Moving the playhead clears the lag note', !s.lag)
} else {
  check('(d) lag case', true, `skipped — satellite newest is only ${gap.toFixed(0)} min behind radar right now`)
  results.push(true)
}

// ---- Product switch → IR (still exclusive with radar).
await openMenu()
await page.getByRole('button', { name: /Satellite product/ }).click()
await page.waitForTimeout(400)
await openMenu()
s = await waitFor((x) => /Band13/.test(x.satLayer ?? ''), 60000)
check('Switching to IR reloads frames for the IR layer; radar stays off', /Band13/.test(s.satLayer ?? '') && !s.layers.radar, s.satLayer)
await openMenu()
await page.waitForTimeout(300)
const legend = await page.locator('.fab-menu .legend-rows').innerText().catch(() => '')
await openMenu()
check('Legend shows only the active imagery (satellite IR, no radar bar)', /Band 13 IR/.test(legend) && !/Radar \(RainViewer\)/.test(legend))
await page.screenshot({ path: `${OUT}/ir.png` })

// ---- Background 'None' leaves no imagery (allowed); legend drops it.
await openMenu()
await page.getByRole('radio', { name: 'None' }).click()
await page.waitForTimeout(500)
await openMenu()
s = await st()
check('Background "None" turns imagery off (nothing selected)', !s.layers.satellite && !s.layers.radar && s.mapSat === 0 && s.mapRadar === 0)

__recordBudget()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
