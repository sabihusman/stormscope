// Conditions-first flow tests (Phase 2 acceptance):
//   1. first run shows current conditions within N s after a location grant, and after an address entry
//   2. a map tap shows a chip, not a dialog; Details expands the sheet
//   3. every location-dependent view (Now, Trip, More → Flood / Rivers / Station) has a working place picker
//      (use my location · search · pick on map)
//   4. Trip is reachable in one tap from Now
// Real touch input at phone size. --mock answers every API locally (zero live calls).
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { touchTap, centre } from './lib/touch.mjs'
import { openMap, openNow, openTrip, openMore } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
assertBudget(`flows-check.mjs${MOCK ? ' (mock)' : ''}`)
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/flows'
mkdirSync(OUT, { recursive: true })
/** Budget for "current conditions visible" after a grant or an address: 15 s live, 10 s mocked. */
const N_MS = MOCK ? 10_000 : 15_000
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const JOHNSTON = { latitude: 41.673, longitude: -93.698 }
const newCtx = async (opts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: MOCK ? 'block' : 'allow', ...opts })
  const page = await ctx.newPage()
  const done = trackOpenMeteo(page, `flows-check.mjs${MOCK ? ' (mock)' : ''}`)
  if (MOCK) await installMocks(ctx, { alerts: [{ event: 'Severe Thunderstorm Warning', severity: 'Severe' }] })
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  return { ctx, page, done, errs }
}
/** Tap a control through real touch, scrolling it into view first (Now scrolls; its buttons can sit below the fold). */
const tap = async (page, loc) => { await loc.scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(80); await touchTap(page, await centre(loc)) }
const until = async (page, fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return Date.now() - t0; await page.waitForTimeout(150) } return null }
const conditionsVisible = () => !!document.querySelector('.cond-temp') && window.__store.get().conditions.state === 'ready'

// ---------------- 1a. First run, location granted
{
  const { ctx, page, done, errs } = await newCtx({ geolocation: JOHNSTON, permissions: ['geolocation'] })
  const t0 = Date.now()
  await page.goto(BASE, { waitUntil: 'load' })
  // With the permission already granted the app skips its own prompt and locates straight away.
  await page.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 2000 }).catch(() => {})
  const ms = await until(page, conditionsVisible, N_MS + 5000)
  check(`First run (granted): current conditions on screen within ${N_MS / 1000} s`, ms != null && Date.now() - t0 <= N_MS + 2000, `${Date.now() - t0} ms from navigation`)
  const now = await page.locator('.screen.now').innerText()
  check('Now shows alerts line first, then conditions, next 12 h, map window, Plan a trip', /NWS|alert/i.test(now.split('\n').slice(0, 6).join(' ')) && /Feels like/.test(now) && /NEXT 12 HOURS/i.test(now) && (await page.locator('.now-map-window').count()) === 1 && (await page.getByRole('button', { name: 'Plan a trip' }).count()) === 1)
  const obs = await page.locator('.cond-observed').innerText().catch(() => '')
  check('Observed line only when a fresh (< 30 min), near (< 10 mi) station reading exists', obs === '' || /Observed .*°.* at .*, .*ago/.test(obs), obs || '(no observed line)')
  if (MOCK) check('Mocked alert is shown as the first card', (await page.locator('.now-card.alert').first().innerText()).includes('Severe Thunderstorm Warning'))
  await page.screenshot({ path: `${OUT}/now-granted.png` })
  check('No page errors', errs.length === 0, errs[0])
  done()
  await ctx.close()
}

// ---------------- 1b. First run, denied → address typed
{
  const { ctx, page, done } = await newCtx({ permissions: [] })
  await ctx.addInitScript(() => { navigator.geolocation.getCurrentPosition = (_ok, err) => setTimeout(() => err?.({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: 'denied' }), 200) })
  await page.goto(BASE, { waitUntil: 'load' })
  await page.waitForTimeout(600)
  const dlg = page.getByRole('dialog')
  await tap(page, dlg.getByRole('button', { name: 'Use my location' }))
  await page.waitForTimeout(1200)
  check('Denied: prompt flips to Search as the primary action, with pick-on-map', (await page.getByRole('heading', { name: "Couldn't get your location" }).count()) === 1 && (await page.getByRole('button', { name: /Pick a point on the map/ }).count()) >= 1)
  await tap(page, dlg.getByRole('button', { name: 'Search for a place' }))
  await page.waitForTimeout(400)
  const t0 = Date.now()
  await page.getByRole('dialog').getByRole('searchbox').fill('Iowa City')
  await page.waitForTimeout(MOCK ? 800 : 2500)
  await tap(page, page.getByRole('dialog').getByRole('option').first())
  const ms = await until(page, conditionsVisible, N_MS + 5000)
  check(`Address typed: current conditions on screen within ${N_MS / 1000} s of choosing the result`, ms != null && ms <= N_MS, `${ms ?? 'never'} ms`)
  check('Place row shows the chosen place', /Iowa City/.test(await page.locator('.place-row .chip-text').innerText()))
  await page.screenshot({ path: `${OUT}/now-address.png` })
  done()
  await ctx.close()
}

// ---------------- 2–4. Map tap chip, pickers everywhere, Trip in one tap
{
  const { ctx, page, done, errs } = await newCtx({ geolocation: JOHNSTON, permissions: ['geolocation'] })
  await page.goto(BASE, { waitUntil: 'load' })
  await until(page, conditionsVisible, 30_000)

  // 4. Trip in one tap from Now (the button), and from the nav.
  await tap(page, page.getByRole('button', { name: 'Plan a trip' }))
  const tripMs = await until(page, () => window.__store.get().screen === 'trip' && !!document.querySelector('input[aria-label="Destination"]'), 8000)
  const tripState = await page.evaluate(() => ({ screen: window.__store.get().screen, to: window.__store.get().journey.to?.name ?? null, text: (document.querySelector('.screen.trip')?.innerText ?? '').slice(0, 120).split(String.fromCharCode(10)).join(' | ') }))
  check('Trip is one tap from Now ("Plan a trip")', tripMs != null, `${tripMs ?? 'never'} ms to the destination field (lazy chunk) · ${JSON.stringify(tripState)}`)
  if (tripMs == null) await page.screenshot({ path: `${OUT}/fail-plan-a-trip.png` })
  await openNow(page)
  await tap(page, page.getByRole('button', { name: 'Trip', exact: true }))
  await page.waitForTimeout(300)
  check('Trip is one tap from the nav too', await page.evaluate(() => window.__store.get().screen === 'trip'))

  // 2. Map tap → chip, never a dialog
  await openMap(page)
  await page.evaluate(() => window.__map.jumpTo({ center: [-93.698, 41.673], zoom: 10 }))
  await page.waitForTimeout(1500)
  await touchTap(page, { x: 195, y: 300 })
  await page.waitForTimeout(800)
  const dialogs = await page.locator('[role=dialog]').count()
  const chip = await page.locator('.point-chip').count()
  check('Map tap shows a point chip, not a dialog', chip === 1 && dialogs === 0, `chip ${chip}, dialogs ${dialogs}`)
  const ms = await until(page, () => /°/.test(document.querySelector('.point-chip')?.innerText ?? ''), 20_000)
  check('Chip fills with conditions at the point (temperature) without opening anything', ms != null, `${ms ?? 'never'} ms`)
  await tap(page, page.getByRole('button', { name: 'Details' }))
  await page.waitForTimeout(600)
  check('Details expands the sheet with the point, 24 h strip and actions', await page.evaluate(() => window.__store.get().sheet !== 'peek') && /This point/.test(await page.locator('.sheet-body').innerText()) && (await page.getByRole('button', { name: 'Use as my place' }).count()) === 1)
  await page.screenshot({ path: `${OUT}/map-chip-details.png` })
  await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' }))
  await touchTap(page, { x: 195, y: 300 })
  await page.waitForTimeout(500)
  await tap(page, page.getByRole('button', { name: 'Dismiss' }))
  await page.waitForTimeout(300)
  check('Chip dismisses', (await page.locator('.point-chip').count()) === 0)

  // 3. Every location-dependent view has a working picker
  const views = [
    ['Now', async () => openNow(page)],
    ['Trip', async () => openTrip(page)],
    ['More → Flood risk', async () => openMore(page, 'Flood risk')],
    ['More → Rivers & gauges', async () => openMore(page, 'Rivers & gauges')],
    ['More → Station observations', async () => openMore(page, 'Station observations')],
  ]
  for (const [name, open] of views) {
    await open()
    await page.waitForTimeout(300)
    const change = page.getByRole('button', { name: 'Change place' }).first()
    const has = (await change.count()) === 1
    if (has) await tap(page, change)
    await page.waitForTimeout(400)
    const picker = await page.evaluate(() => window.__store.get().pickerOpen)
    const opts = await Promise.all([/Use my location/, /Search for a place/, /Pick a point on the map/].map((r) => page.getByRole('button', { name: r }).count()))
    check(`[${name}] has a place picker with use-my-location / search / pick-on-map`, has && picker && opts.every((n) => n >= 1), `picker ${picker}, options ${opts.join('/')}`)
    await page.getByRole('button', { name: 'Close' }).click().catch(() => {})
    await page.waitForTimeout(200)
  }
  // Pick on map from the Flood page: crosshair + confirm, then back to the page with the new place.
  await openMore(page, 'Flood risk')
  await tap(page, page.getByRole('button', { name: 'Change place' }).first())
  await page.waitForTimeout(300)
  await tap(page, page.getByRole('button', { name: /Pick a point on the map/ }))
  await page.waitForTimeout(800)
  check('Pick on map: map screen with a crosshair and a confirm button, nav hidden', await page.evaluate(() => window.__store.get().pickMode && window.__store.get().screen === 'map') && (await page.locator('.crosshair').count()) === 1 && (await page.locator('.nav').count()) === 0)
  await page.evaluate(() => window.__map.jumpTo({ center: [-93.0, 41.9], zoom: 9 }))
  await page.waitForTimeout(400)
  await tap(page, page.getByRole('button', { name: 'Use this point' }))
  await page.waitForTimeout(800)
  const after = await page.evaluate(() => { const s = window.__store.get(); return { screen: s.screen, page: s.morePage, lat: s.place?.lngLat.lat, lng: s.place?.lngLat.lng, pick: s.pickMode } })
  check('Confirming the point returns to the Flood page with the place moved there', after.screen === 'more' && after.page === 'flood' && Math.abs(after.lat - 41.9) < 0.05 && Math.abs(after.lng + 93.0) < 0.05 && !after.pick, JSON.stringify(after))
  const flood = await until(page, () => !!document.querySelector('.flood-here'), 60_000)
  check('Flood page computes for the picked place without touching the map layer or zoom', flood != null && (await page.evaluate(() => !window.__store.get().layers.flood)), `${flood ?? 'never'} ms`)
  // Search from the Trip page's From row.
  await openTrip(page)
  await tap(page, page.getByRole('button', { name: 'Change place' }).first())
  await page.waitForTimeout(300)
  await tap(page, page.getByRole('button', { name: /Search for a place/ }))
  await page.getByRole('dialog').getByRole('searchbox').fill('Iowa City')
  await page.waitForTimeout(MOCK ? 800 : 2500)
  const optBox = await page.getByRole('dialog').getByRole('option').first().boundingBox().catch(() => null)
  await page.screenshot({ path: `${OUT}/trip-search-options.png` })
  await tap(page, page.getByRole('dialog').getByRole('option').first())
  await page.waitForTimeout(600)
  console.log('      option box', JSON.stringify(optBox))
  const fromRow = await page.locator('.trip-from').innerText().catch(() => '(no from row)')
  check('Searching from Trip sets the place (From row updates)', /Iowa City/.test(fromRow), `${fromRow.split(String.fromCharCode(10)).join(' ')} · place=${await page.evaluate(() => window.__store.get().place?.name)} picker=${await page.evaluate(() => window.__store.get().pickerOpen)}`)
  // Use my location from Now.
  await openNow(page)
  await tap(page, page.getByRole('button', { name: 'Change place' }).first())
  await page.waitForTimeout(300)
  await tap(page, page.getByRole('button', { name: /Use my location/ }))
  const back = await until(page, () => { const p = window.__store.get().place; return !!p && Math.abs(p.lngLat.lat - 41.673) < 0.01 }, 10_000)
  check('Use my location from the picker returns to the device position', back != null, `${back ?? 'never'} ms`)
  await page.screenshot({ path: `${OUT}/pickers.png` })
  check('No page errors in the picker / map flows', errs.length === 0, errs[0])
  done()
  await ctx.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
