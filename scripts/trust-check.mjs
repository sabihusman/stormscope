// Trust and data conflicts from the Nov 6, 2026 mobile audit, mocked only, at 390 × 844:
//  • USGS sends a stale 1996 gage height after today's for the same site: the gauge shows today's, never "No recent readings".
//  • One flow per gauge, with its source named, and the map sheet redraws the gauge from the current list (a refresh
//    that changes the flow changes the open chip too — no copy taken at tap time).
//  • An Iowa Flood Center sensor reporting 826.01 ft reads as a water level above sea level, not a river stage.
//  • The Now card says its headline is the forecast model and labels the station reading as measured; the Station page
//    rounds that reading the same way, so one temperature reads one way.
//  • A drainage (NHD) request that fails shows in the Flood panel, not only in Settings.
//   node scripts/trust-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMore } from './lib/ui.mjs'
import { checker, mockedOnly, oneLine, until as untilIn } from './lib/check-kit.mjs'

const { base: BASE, out: OUT } = mockedOnly('trust-check.mjs', 'e2e-shots/trust')
const { check, finish } = checker()
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'], locale: 'en-US' })
const page = await ctx.newPage()
const done = trackTraffic(page, 'trust-check.mjs (mock)')
// The drainage service answers 504 (as a timed-out request would surface); everything else as usual, plus the trust fixtures.
await installMocks(ctx, { trustFixtures: true, failHosts: ['hydro.nationalmap.gov'], failStatus: 504 })
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
const until = (fn, ms) => untilIn(page, fn, ms)
await until(() => { const s = window.__store?.get(); return s?.conditions.state === 'ready' && s.station.state === 'ready' })
await page.waitForTimeout(500)

// ---- Temperatures: the headline is the model's; the station reading is a labelled measurement ----
const card = oneLine(await page.locator('.now-card.conditions').innerText())
const measured = card.match(/Measured (-?\d+ °F)/)?.[1]
// One line at 390 px (a wrap moved everything below it by a line when the reading landed).
const measuredOnOneLine = await page.locator('.cond-observed').evaluate((e) => e.getClientRects().length === 1 && e.getBoundingClientRect().height < 22).catch(() => false)
check('Now card: the footer says the headline is the forecast model, and the station line reads "Measured N °F … · <age> at <station>" on one line', /Headline: forecast model \(Open-Meteo\)/.test(card) && !!measured && /ago at .*Airport/.test(card) && measuredOnOneLine, card.slice(0, 260))
await openMore(page, 'Station observations')
await page.waitForTimeout(500)
const station = oneLine(await page.locator('.page-body').innerText())
const stTemp = station.match(/Temperature · measured \| (-?[\d.]+ °F)/i)?.[1]
check('Station page: temperature and wind labelled "measured", the temperature rounded as on the Now card (one reading, one value)', !!stTemp && stTemp === measured && /Wind · measured/i.test(station), `Now "${measured}" vs Station "${stTemp}"`)

// ---- Gauges: the newest USGS record wins; one flow with its source; elevation-based gauges labelled ----
await openMore(page, 'Rivers & gauges')
await until(() => window.__store.get().rivers.state === 'ready' && window.__store.get().riversTier === 'full', 30000)
await page.waitForTimeout(500)
const rows = await page.evaluate(() => [...document.querySelectorAll('.gauge-list li')].map((li) => li.innerText.replaceAll('\n', ' | ')))
const gauges = await page.evaluate(() => window.__store.get().rivers.data.map((g) => ({ id: g.id, name: g.name, lid: g.lid, stage: g.stage, flow: g.flow })))
const lastSite = gauges.find((g) => g.id === 'USGS-05481998')
check('A site whose stale 1996 gage height arrives after today\'s keeps today\'s reading (newest record wins)', !!lastSite?.stage && new Date(lastSite.stage.time).getFullYear() >= 2026 && Math.abs(lastSite.stage.value - 2.18) > 0.001, JSON.stringify(lastSite?.stage))
const flows = gauges.filter((g) => g.flow)
check('Every flow carries its source (USGS or NOAA NWPS)', flows.length > 0 && flows.every((g) => /USGS|NOAA NWPS/.test(g.flow.source ?? '')), `${flows.length} flows; sources ${[...new Set(flows.map((g) => g.flow.source))].join(', ')}`)
const ifc = rows.find((r) => /North Walnut Creek/.test(r)) ?? ''
const ifcDetail = await page.evaluate(() => { const g = window.__store.get().rivers.data.find((x) => x.id === 'USGS-05481999'); return g ? JSON.stringify(g.stage) : 'absent' })
check('The IFC gauge reporting 826.01 ft is marked elevation-based, never shown as a river stage', /"basis":"elevation"/.test(ifcDetail), `stage ${ifcDetail}; row "${ifc.slice(0, 120)}"`)

// ---- One source for list and sheet: tap a gauge, change its flow in the list, the open chip follows ----
const target = flows[0]
await page.evaluate(() => window.__store.set({ screen: 'map' }))
await page.waitForTimeout(500)
await page.evaluate((id) => {
  const s = window.__store.get()
  const g = s.rivers.data.find((x) => x.id === id)
  // The same selection a tap makes (the gauge's id rides with it).
  window.__store.set({ selection: { kind: 'gauge', gaugeId: g.id, lngLat: g.lngLat, title: g.name, lines: ['stale copy'], source: 'x' }, sheet: 'half' })
}, target.id)
await page.waitForTimeout(400)
const before = await page.locator('.sheet-body, .point-chip').first().innerText().catch(() => '')
await page.evaluate((id) => {
  const s = window.__store.get()
  window.__store.set({ rivers: { ...s.rivers, data: s.rivers.data.map((g) => (g.id === id ? { ...g, flow: { ...g.flow, value: 12345, source: 'USGS' } } : g)) } })
}, target.id)
await page.waitForTimeout(400)
const after = await page.locator('.sheet-body, .point-chip').first().innerText().catch(() => '')
check('The open gauge redraws from the current list: no stale copy, its flow line names the source, and a changed flow shows at once (12,345 ft³/s · USGS)', !/stale copy/.test(before) && /Flow .* · (USGS|NOAA NWPS)/.test(before) && /Flow 12,345 ft³\/s · [^|\n]*ago · USGS/.test(after) && !/Flow 12,345/.test(before), `before "${oneLine(before).slice(0, 400)}" → after "${oneLine(after).slice(0, 400)}"`)
await page.screenshot({ path: `${OUT}/gauge-sheet.png` })
await page.evaluate(() => window.__store.set({ selection: null, screen: 'now' }))

// ---- Flood: the failed drainage request is said in the Flood panel ----
await openMore(page, 'Flood risk')
await until(() => { const s = window.__store.get(); const b = s.floodFor ? s.blocks[s.floodFor] : null; return !!b && b.flowlines.state === 'ready' && b.flood.state === 'ready' && !b.flood.data?.preliminary }, 40000)
await page.waitForTimeout(500)
const flood = oneLine(await page.locator('.flood-page').innerText())
check('Flood panel: a failed drainage request reads "stream data unavailable right now (…) — this score is terrain + rain only"', /stream data unavailable right now \(.+\) — this score is terrain \+ rain only/.test(flood), flood.match(/computed[^|]*/)?.[0] ?? flood.slice(0, 200))
await page.screenshot({ path: `${OUT}/flood.png` })
done()
await browser.close()
finish()
