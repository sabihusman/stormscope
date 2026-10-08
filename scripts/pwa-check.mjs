// Verifies the production build as a PWA: manifest, service-worker registration, precache +
// runtime caches, and that the app shell still loads with the network cut. Also grabs a
// desktop-width screenshot for the tablet/desktop layout. Needs a built site (npm run preview
// on :4173, or the production URL) — the dev server has no service worker.
import { chromium } from 'playwright'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
// --mock answers every API locally (zero live calls, scripts/lib/mock-server.mjs); live-only checks are skipped and said so.
const MOCK = process.argv.includes('--mock')
assertBudget(MOCK ? 'pwa-check.mjs (mock)' : 'pwa-check.mjs') // the Now screen fetches one Open-Meteo location per place on every load
import { mkdirSync } from 'node:fs'
import { allowLocation, openMap, openMore, openTrip, pageText, setLayers, setSheet, setUnits, sheetText, tripText, searchPlace, openNow } from './lib/ui.mjs'

const BASE = process.argv[2] || 'http://localhost:4173/'
const OUT = process.argv[3] || 'e2e-shots'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  geolocation: { latitude: 39.9526, longitude: -75.1652 },
  permissions: ['geolocation'],
  serviceWorkers: 'allow',
})
await ctx.addInitScript(() => { try { if (!localStorage.getItem('stormscope.layers')) localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: false, station: false, nowcast: false })) } catch {} }) // not under test here: keep gauge/NWS traffic off the shared IP
const page = await ctx.newPage()
const __recordBudget = trackOpenMeteo(page, MOCK ? 'pwa-check.mjs (mock)' : 'pwa-check.mjs')
if (MOCK) await installMocks(ctx, { focus: { lat: 39.9526, lng: -75.1652 } })
const errors = []
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
page.on('console', (m) => m.type() === 'error' && errors.push(`[console] ${m.text()}`))

// "load" + the place's conditions on screen, not network-idle: the live map keeps fetching tiles and
// the Now screen's slower reference calls (NWS station, NHD) can hold the network busy past 30 s.
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
for (let i = 0; i < 120; i++) { if (await page.evaluate(() => window.__store?.get().conditions.state === 'ready').catch(() => false)) break; await page.waitForTimeout(500) }
const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel=manifest]')
  if (!link) return null
  const r = await fetch(link.href)
  return { status: r.status, type: r.headers.get('content-type'), body: await r.json() }
})
check('Web manifest served with name, display mode and icons', manifest?.status === 200 && !!manifest.body?.name && !!manifest.body?.display && (manifest.body?.icons?.length ?? 0) >= 2, `${manifest?.status} ${manifest?.body?.name} ${manifest?.body?.display} ${manifest?.body?.icons?.length} icons`)

await page.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
await page.waitForTimeout(6000)

const sw = await page.evaluate(async () => {
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('no service worker within 15 s')), 15000))])
  return { scope: reg.scope, active: !!reg.active, state: reg.active?.state }
}).catch((e) => ({ error: e.message }))
check('Service worker registered and active', !!sw.active && sw.state === 'activated', JSON.stringify(sw))
// The app refetches once the SW takes control (first visit); give that a moment.
await page.waitForTimeout(8000)
const cached = await page.evaluate(async () => {
  const names = await caches.keys()
  const out = {}
  for (const n of names) out[n] = (await (await caches.open(n)).keys()).length
  return out
})
const precached = Object.entries(cached).filter(([n]) => /precache/i.test(n)).reduce((a, [, v]) => a + v, 0)
const runtime = Object.entries(cached).filter(([n]) => !/precache/i.test(n)).reduce((a, [, v]) => a + v, 0)
check('Workbox precache holds the app shell', precached >= 5, `${precached} precached entries`)
check('Runtime caches hold tiles / API responses', runtime >= 5, `${runtime} entries in ${Object.keys(cached).filter((n) => !/precache/i.test(n)).join(', ')}`)

// Cut the network and reload: app shell must render from the precache and
// the data must come back from the runtime cache with an offline banner.
await ctx.setOffline(true)
const reloadErr = await page.reload({ waitUntil: 'domcontentloaded' }).then(() => null, (e) => e.message)
await page.waitForTimeout(5000)
const offline = await page.evaluate(() => ({
  title: document.title,
  hasMap: !!document.querySelector('.maplibregl-canvas'),
  pills: [...document.querySelectorAll('.now-card')].map((p) => p.className.split(' ').slice(-1)[0]),
  banner: !!document.querySelector('.banner.offline') || document.body.innerText.includes('Offline'),
  online: navigator.onLine,
}))
check('Offline reload renders the app shell from the precache', !reloadErr && offline.hasMap && !offline.online, reloadErr ?? `${offline.title}, map canvas ${offline.hasMap}`)
check('Offline: the Now screen says so (banner) and still renders its cards', offline.banner && offline.pills.length > 0, offline.pills.join(' | '))
await page.screenshot({ path: `${OUT}/pwa-offline.png` })
await ctx.setOffline(false)

// Desktop layout.
const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, geolocation: { latitude: 39.9526, longitude: -75.1652 }, permissions: ['geolocation'] })
await deskCtx.addInitScript(() => { try { if (!localStorage.getItem('stormscope.layers')) localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: false, station: true, nowcast: false })) } catch {} })
const desk = await deskCtx.newPage()
const __recordDesk = trackOpenMeteo(desk, 'pwa-check.mjs (desktop)')
if (MOCK) await installMocks(deskCtx, { focus: { lat: 39.9526, lng: -75.1652 } })
await desk.goto(BASE, { waitUntil: 'networkidle' })
await desk.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
await desk.waitForTimeout(7000)
await openMore(desk, 'Station observations')
await desk.waitForTimeout(1000)
const side = await desk.evaluate(() => { const s = document.querySelector('.screen'); const m = document.querySelector('.map-root'); return !!s && !!m && s.getBoundingClientRect().width < window.innerWidth * 0.6 && m.getBoundingClientRect().left >= s.getBoundingClientRect().right - 2 })
check('Desktop: content column beside an always-visible map (rail + column + map)', side)
await desk.screenshot({ path: `${OUT}/desktop.png` })

// Network failures while offline are expected; anything else is a bug.
const real = errors.filter((e) => !/Failed to load resource|net::ERR|ERR_INTERNET_DISCONNECTED|status of (429|5\d\d)/.test(e))
check('No unexpected page/console errors', real.length === 0, real[0])
for (const e of real.slice(0, 10)) console.log(' ', e.slice(0, 300))
__recordBudget()
__recordDesk()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
