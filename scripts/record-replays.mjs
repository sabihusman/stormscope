// Records, for every replay scenario (or --only=id,id), the live route and the raw Open-Meteo
// response the app fetched, into the fixture folder, and points public/fixtures/index.json at
// them — after that a replay makes no routing or forecast call at all. One-time cost per
// scenario: one routing call + one Open-Meteo request (~23 locations); the guard counts it.
//
//   node scripts/record-replays.mjs [http://localhost:5174/] [--only=ice-storm-2024-12-14]
//
// Run against the dev server (no service worker in the way) with `?live=1`, which makes the
// app ignore any cache already recorded.
import { startInMode } from './lib/mode.mjs'
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
assertBudget('record-replays.mjs')

const BASE = (process.argv.find((a) => /^https?:/.test(a)) || 'http://localhost:5174/').replace(/\/?$/, '/')
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',')
const INDEX = 'public/fixtures/index.json'
const index = JSON.parse(readFileSync(INDEX, 'utf8'))
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
let failures = 0

for (const sc of index) {
  if (only && !only.includes(sc.id)) continue
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('stormscope.layers', JSON.stringify({ radar: false, satellite: false, rainfall: false, flood: false, rivers: false, station: false, nowcast: false })) } catch {} })
  await startInMode(ctx, 'full')
  const page = await ctx.newPage()
  const done = trackTraffic(page, `record-replays.mjs ${sc.id}`)
  let weather = null
  page.on('response', (r) => {
    const u = r.url()
    if (!/open-meteo\.com\/v1\/(forecast|archive|era5)/.test(u)) return
    if (r.status() !== 200) {
      console.log(`      ${sc.id}: Open-Meteo answered ${r.status()} — not saved`)
      return
    }
    // Only a well-formed success body is ever written: an array of locations (or one location) with hourly data.
    weather = r
      .json()
      .then((body) => {
        const locs = Array.isArray(body) ? body : [body]
        const ok = locs.length > 0 && locs.every((l) => l && !l.error && l.hourly && Array.isArray(l.hourly.time) && l.hourly.time.length > 0)
        if (!ok) console.log(`      ${sc.id}: Open-Meteo body is an error or incomplete — not saved`)
        return ok ? { url: u, body } : null
      })
      .catch(() => null)
  })
  await page.goto(`${BASE}?replay=${encodeURIComponent(sc.id)}&live=1`, { waitUntil: 'load' })
  let st = {}
  for (let i = 0; i < 180; i++) {
    await page.waitForTimeout(1000)
    st = await page.evaluate(() => {
      const j = window.__store.get().journey
      return { live: !!window.__store.get().replay?.live, rs: j.routes.state, re: j.routes.error, ws: j.weather.state, we: j.weather.error, samples: j.weather.data?.samples.length ?? 0, calls: j.weather.data?.calls }
    })
    if ((st.ws === 'ready' && st.samples > 0) || st.we || st.re) break
  }
  const captured = weather ? await weather : null
  if (!st.live || st.ws !== 'ready' || !captured || st.calls === 0) {
    failures++
    console.log(`FAIL  ${sc.id}: ${JSON.stringify(st)}; weather response captured: ${!!captured}`)
    done()
    await ctx.close()
    continue
  }
  const routes = await page.evaluate(() => {
    const d = window.__store.get().journey.routes.data
    return { engine: d.engine, routes: d.routes }
  })
  const dir = `public/fixtures/${sc.fixture}`
  const key = `${sc.from.lat.toFixed(3)}_${sc.from.lng.toFixed(3)}__${sc.to.lat.toFixed(3)}_${sc.to.lng.toFixed(3)}`
  const routeFile = `route.${key}.json`
  const weatherFile = `weather.${sc.id}.json`
  writeFileSync(`${dir}/${routeFile}`, JSON.stringify({ recordedAt: new Date().toISOString(), from: sc.from, to: sc.to, engine: routes.engine, routes: routes.routes }))
  writeFileSync(`${dir}/${weatherFile}`, JSON.stringify({ recordedAt: new Date().toISOString(), scenario: sc.id, departure: sc.departure, weather: sc.weather ?? 'era5', url: captured.url, samples: st.samples, response: captured.body }))
  sc.files.route = routeFile
  sc.files.weatherCache = weatherFile
  writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n')
  console.log(`OK    ${sc.id}: ${routes.routes.length} route(s) via ${routes.engine} (${routes.routes[0].coords.length} vertices) → ${routeFile}; ${st.samples} samples, ${st.calls} locations → ${weatherFile}`)
  done()
  await ctx.close()
}
await browser.close()
console.log(failures ? `${failures} scenario(s) not recorded` : 'all requested scenarios recorded')
process.exit(failures ? 1 : 0)
