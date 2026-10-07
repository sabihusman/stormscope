// Requests per host for one ordinary session, phase by phase — the numbers the per-host test caps
// and the app's own traffic budget are sized from. Mocked by default (every API answered locally,
// zero live calls; the app code path is the same, so the counts are the live counts):
//
//   open app (grant location) → change place twice → open Map → open Trip
//
// then two extra phases reported separately: scroll the Now screen to the Rivers tile, and open
// More → Rivers & gauges. Usage: node scripts/traffic-count.mjs [base-url] [--live]
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= '1'
import { chromium } from 'playwright'
import { installMocks } from './lib/mock-server.mjs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { allowLocation, openMap, openMore, openNow, openTrip, searchPlace } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const LIVE = argv.includes('--live')
const BASE = argv.filter((a) => !a.startsWith('--'))[0] || 'http://localhost:4173/'
if (LIVE) assertBudget('traffic-count.mjs')

const phases = []
let cur = null
const isOM = (url) => /open-meteo\.com\/v1\/(forecast|era5)/.test(url)
const count = (url) => {
  if (!cur) return
  let host
  try {
    host = new URL(url).host
  } catch {
    return
  }
  if (!/^https?:/.test(url) || /^(localhost|127\.0\.0\.1|\[::1\])/.test(host) || host.endsWith('.vercel.app')) return
  cur.hosts[host] = (cur.hosts[host] ?? 0) + 1
  if (isOM(url)) cur.locations += (url.match(/[?&]latitude=([^&]*)/)?.[1].split(',').length ?? 1)
}
const phase = (name) => {
  cur = { name, hosts: {}, locations: 0 }
  phases.push(cur)
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
const page = await ctx.newPage()
const done = LIVE ? trackTraffic(page, 'traffic-count.mjs') : () => {}
if (LIVE) page.on('request', (r) => count(r.url()))
else {
  globalThis.__qaMockedRequest = count
  await installMocks(ctx, {})
}
const until = async (fn, ms = 60000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn).catch(() => false)) return true
    await page.waitForTimeout(250)
  }
  return false
}
const st = () => page.evaluate(() => { const s = window.__store.get(); return { place: s.place?.name, conditions: s.conditions.state, station: s.station.state, rivers: s.rivers.state, alerts: s.alerts.state, tier: s.riversTier ?? null } })
const settled = async () => {
  // Conditions, alerts and station are place-bound and load on every place change; give the rest 3 s to finish.
  await until(() => { const s = window.__store.get(); return s.conditions.state === 'ready' && s.station.state !== 'loading' && s.alerts.state !== 'loading' })
  await page.waitForTimeout(3000)
}
const changePlace = async (q) => {
  await openNow(page)
  await searchPlace(page, q)
  await page.waitForTimeout(600)
  await page.getByRole('dialog').getByRole('option').first().click()
  await until(() => !window.__store.get().pickerOpen)
  await settled()
}

phase('open app (grant location)')
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
await until(() => !!window.__map?.loaded())
await settled()
console.log('after open:', JSON.stringify(await st()))

phase('change place → Ames')
await changePlace('Ames')
console.log('after place 1:', JSON.stringify(await st()))

phase('change place → Cedar Rapids')
await changePlace('Cedar Rapids')
console.log('after place 2:', JSON.stringify(await st()))

phase('open Map')
await openMap(page)
await page.waitForTimeout(6000)

phase('open Trip')
await openTrip(page)
await page.waitForTimeout(3000)

// Extras (not part of the ordinary session above; reported on their own lines).
phase('extra: Now, scroll to the Rivers tile')
await openNow(page)
await page.locator('.tiles').scrollIntoViewIfNeeded()
await until(() => window.__store.get().rivers.state === 'ready' || window.__store.get().rivers.state === 'error', 20000)
await page.waitForTimeout(2000)
console.log('after tile:', JSON.stringify(await st()))

phase('extra: More → Rivers & gauges')
await openMore(page, 'Rivers & gauges')
await until(() => window.__store.get().rivers.state === 'ready' && (window.__store.get().riversTier == null || window.__store.get().riversTier === 'full'), 30000)
await page.waitForTimeout(2000)
console.log('after rivers page:', JSON.stringify(await st()))

cur = null
done()
await browser.close()

// Report: hosts × phases.
const hosts = [...new Set(phases.flatMap((p) => Object.keys(p.hosts)))].sort((a, b) => phases.reduce((n, p) => n + (p.hosts[b] ?? 0), 0) - phases.reduce((n, p) => n + (p.hosts[a] ?? 0), 0))
const ordinary = phases.filter((p) => !p.name.startsWith('extra'))
console.log(`\ntraffic-count: ${LIVE ? 'LIVE' : 'mocked'} ${BASE}`)
console.log(['host', ...phases.map((p) => p.name), 'ordinary session'].join(' | '))
for (const h of hosts) console.log([h, ...phases.map((p) => p.hosts[h] ?? 0), ordinary.reduce((n, p) => n + (p.hosts[h] ?? 0), 0)].join(' | '))
console.log(['Open-Meteo locations', ...phases.map((p) => p.locations), ordinary.reduce((n, p) => n + p.locations, 0)].join(' | '))
console.log(['all requests', ...phases.map((p) => Object.values(p.hosts).reduce((a, b) => a + b, 0)), ordinary.reduce((n, p) => n + Object.values(p.hosts).reduce((a, b) => a + b, 0), 0)].join(' | '))
