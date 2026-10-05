// P4 road conditions: RWIS confirmation rules on the ice fixtures + a live run.
import { chromium } from 'playwright'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
assertBudget('road-check.mjs')
import { mkdirSync } from 'node:fs'

const BASE = (process.argv[2] || 'http://localhost:5174/').replace(/\/$/, '')
const OUT = process.argv[3] || 'e2e-shots/road'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
await ctx.addInitScript(() => { try { if (!localStorage.getItem('stormscope.layers')) localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: false, station: false, nowcast: false })) } catch {} })
const page = await ctx.newPage()
const __recordBudget = trackOpenMeteo(page, 'road-check.mjs')
const errs = []
page.on('pageerror', (e) => errs.push(e.message))

const report = async (ms = 150000) => {
  const t0 = Date.now()
  let stable = 0
  while (Date.now() - t0 < ms) {
    const s = await page.evaluate(() => {
      const j = window.__store.get().journey
      const d = j.road.data
      const w = j.weather.data
      return {
        state: j.road.state, err: j.road.error, werr: j.weather.error, provider: w?.provider, to: j.to?.name, rstate: j.routes.state, rerr: j.routes.error, wstate: j.weather.state,
        road: d?.samples ?? null,
        stations: d?.stations.map((s) => ({ id: s.id, name: s.name, state: s.state, stale: s.stale, ageMin: s.ageMin, pavementF: s.pavementF, condition: s.condition, confirms: s.confirmsIce, obsTime: s.obsTime })) ?? null,
        forecastIce: w?.samples.filter((x) => x.condition.code === 'ice').length ?? null,
        samples: w?.samples.length ?? null,
      }
    })
    // Consistent snapshot only: road evaluated AND the weather it was evaluated against is the
    // current, ready one (a first-visit refresh re-routes and clears weather for a moment).
    const ok = (s.road && s.wstate === 'ready' && s.provider) || s.err || s.werr || s.rerr
    if (ok && stable++ >= 1) return s
    if (!ok) stable = 0
    await page.waitForTimeout(1000)
  }
  return page.evaluate(() => { const j = window.__store.get().journey; return { state: `${j.road.state} (to=${j.to?.name ?? "none"} routes=${j.routes.state}${j.routes.error ? " err=" + j.routes.error : ""} weather=${j.weather.state}${j.weather.error ? " err=" + j.weather.error : ""})`, road: null } })
}
const panelText = () => page.locator('.sheet-body').innerText()
const byId = (r, id) => r.stations?.find((s) => s.id === id)

// ---------------- 1. Ice storm, depart 08:00Z: all four sensors icy within window; Grinnell unknown
await page.goto(`${BASE}/?replay=ice-storm-2024-12-14`, { waitUntil: 'load' })
let r = await report()
check('[08:00Z] road report evaluated', !!r.road, `${r.state}${r.err ? ' · ' + r.err : ''}${r.werr ? ' · weather: ' + r.werr : ''}`)
if (r.road) {
  // SCAN/ScanWeb statuses: "Ice/Snow Warning" = continuous ice-water film, insufficient chemical → confirms;
  // "Ice/Snow Watch" = thin or spotty moisture at/below freezing → possible ice only.
  const obsZ = (st) => `${st.condition} ${st.pavementF} °F obs ${new Date(st.obsTime).toISOString().slice(11, 16)}Z`
  for (const [id, name] of [['RCFI4', 'Colfax'], ['RTFI4', 'Tiffin']]) {
    const st = byId(r, id)
    check(`[08:00Z] ${name} confirms ICY (Warning status at an ETA within 90 min of its obs)`, !!st && st.confirms && st.state === 'ice' && /Warning|Frost/i.test(st.condition ?? ''), st ? obsZ(st) : 'station not near route')
  }
  for (const [id, name] of [['RTOI4', 'Altoona'], ['RIOI4', 'Iowa City']]) {
    const st = byId(r, id)
    check(`[08:00Z] ${name} reports Ice Watch → possible ice only, never confirms`, !!st && !st.confirms && st.state === 'watch' && /Watch/i.test(st.condition ?? ''), st ? obsZ(st) : 'station not near route')
  }
  const g = byId(r, 'RGRI4')
  check('[08:00Z] Grinnell stays UNKNOWN (no pavement readings), never "no ice"', !!g && g.state === 'unknown' && !g.confirms && g.condition == null, JSON.stringify(g))
  const confirmed = r.road.filter((x) => x.status === 'icy-confirmed')
  const watch = r.road.filter((x) => x.status === 'ice-watch')
  check('[08:00Z] icy-confirmed samples come only from the Warning stations (Colfax, Tiffin)', confirmed.length >= 2 && confirmed.every((x) => ['RCFI4', 'RTFI4'].includes(x.station?.id)), `${confirmed.length} confirmed via ${[...new Set(confirmed.map((x) => x.station?.id))].join(',')}; ${watch.length} watch-only of ${r.road.length}`)
  check('[08:00Z] Watch stations produce "ice-watch" samples (Altoona, Iowa City), never confirmations', watch.length >= 1 && watch.every((x) => ['RTOI4', 'RIOI4'].includes(x.station?.id)) && !r.road.some((x) => x.station?.id === 'RGRI4'), [...new Set(watch.map((x) => x.station?.id))].join(','))
  const t = await panelText()
  check('[08:00Z] station chips show pavement temp, condition and obs time', /Colfax[\s\S]{0,80}pavement \d+ °F, [^\n]*obs \d{1,2}:\d{2}/.test(t))
  check('[08:00Z] strip says "Icy — RWIS confirmed" only for the Warning stations', /Icy — RWIS confirmed \((Colfax|Tiffin)/.test(t) && !/Icy — RWIS confirmed \((Altoona|Iowa City)/.test(t))
  check('[08:00Z] strip says "Possible ice — … reports Ice Watch" for the Watch stations', /Possible ice — (Altoona|Iowa City)[^\n]*reports Ice Watch/.test(t))
  check('[08:00Z] Watch chip is labelled possible, not confirmed', /Altoona[\s\S]{0,120}Watch at your ETA — possible ice, not confirmed/.test(t))
  check('[08:00Z] weather provider is ERA5 hindsight', /ERA5/.test(r.provider ?? ''), r.provider)
  // Replay camera: the route is ready before the style loads; the fit must still win.
  let z = 0
  for (let i = 0; i < 60 && z <= 5; i++) { await page.waitForTimeout(1000); z = await page.evaluate(() => window.__map.getZoom()) }
  check('[08:00Z] map camera fits the replay route (not left at continental zoom)', z > 5, `zoom ${z.toFixed(2)}`)
  await page.screenshot({ path: `${OUT}/ice-0800z.png` })
}

// ---------------- 2. Forecast-as-issued variant, depart 10:00Z: does the forecast alone flag ice?
await page.goto(`${BASE}/?replay=ice-storm-2024-12-14-forecast`, { waitUntil: 'load' })
r = await report()
check('[10:00Z forecast] weather came from the Historical Forecast API (GFS as issued)', /as issued/.test(r.provider ?? ''), r.provider)
check('[10:00Z forecast] forecast ALONE flags ice on some samples (codes 56/66 from 10Z)', (r.forecastIce ?? 0) > 0, `${r.forecastIce}/${r.samples} samples classed ice by forecast`)
const t2 = await panelText()
check('[10:00Z forecast] panel still shows RWIS confirmation where sensors are icy', /Icy — RWIS confirmed/.test(t2))
await page.screenshot({ path: `${OUT}/ice-1000z-forecast.png` })

// ---------------- 3. Late departure: 4 h after the last icy obs → nothing confirmed
await page.goto(`${BASE}/?replay=ice-storm-2024-12-15-late`, { waitUntil: 'load' })
r = await report()
check('[late] road report evaluated', !!r.road, `${r.state}${r.err ? ' · ' + r.err : ''}`)
if (r.road) {
  check('[late] NO station confirms icy (obs out of window or non-icy)', !r.road.some((x) => x.status === 'icy-confirmed') && !r.stations.some((s) => s.confirms), r.stations.map((s) => `${s.name}:${s.state}${s.stale ? '(stale)' : ''}`).join(', '))
  const t3 = await panelText()
  check('[late] strip shows at most "Possible ice", never "Icy — RWIS confirmed"', !/Icy — RWIS confirmed/.test(t3))
  check('[late] out-of-window stations are marked stale/unknown', r.stations.some((s) => s.stale), r.stations.map((s) => `${s.id}:${s.stale}`).join(','))
  await page.screenshot({ path: `${OUT}/ice-late.png` })
}

// ---------------- 4. Live: Johnston → Iowa City (I-80 RWIS stations exist)
await page.goto(`${BASE}/`, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {})
await page.waitForTimeout(4000)
await page.getByRole('tab', { name: 'Journey' }).click()
await page.getByRole('searchbox', { name: 'Destination' }).fill('Iowa City')
await page.waitForTimeout(2500)
await page.getByRole('option').first().click()
r = await report(180000)
check('[live] road report evaluated for a live journey', !!r.road, `${r.state}${r.err ? ' · ' + r.err : ''}`)
if (r.road) {
  check('[live] I-80 RWIS stations found within 5 km of the route', (r.stations?.length ?? 0) >= 2, r.stations?.map((s) => `${s.name} (${s.ageMin} min)`).join(', '))
  const t4 = await panelText()
  check('[live] every chip shows an age ("X min ago" / "just now")', (t4.match(/(\d+ min ago|just now)/g) ?? []).length >= (r.stations?.length ?? 0))
  check('[live] stale stations (> 60 min) are flagged and never confirm', r.stations.every((s) => !(s.ageMin > 60) || (s.stale && !s.confirms)))
  await page.screenshot({ path: `${OUT}/live-johnston-iowacity.png` })
}
check('No page errors', errs.length === 0, errs[0])

__recordBudget()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
