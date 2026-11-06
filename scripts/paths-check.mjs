// Broken paths from the Nov 6, 2026 mobile audit, mocked only, at 390 × 844:
//  • A gauge row (More → Rivers) and a gauge marker on the map open that gauge in the bottom sheet at half,
//    directly: no chip ("toast") with a Details button in between.
//  • The Now rain row says what it does ("play on map ›"), not "timeline ›".
//  • Flood's and Trip's "Show on the map" are switches: the button shows On / Off, the panel stays open, and the
//    map's Layers menu has the same switch to turn the layer back off.
//  • "Use my location" says what is happening: the picker stays open with the reason when location is denied,
//    and the map's ◎ shows a notice with Try again.
//  • Every hourly span (12 / 24 / 48 h) opens on the "Now" card, even after the strip was scrolled.
//   node scripts/paths-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap, openMore, openNow, openTrip, settle } from './lib/ui.mjs'

const argv = process.argv.slice(2)
if (!argv.includes('--mock')) {
  console.log('SKIP  paths-check.mjs: mocked only')
  process.exit(3)
}
assertBudget('paths-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/paths'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const session = async (opts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'], locale: 'en-US' })
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'paths-check.mjs (mock)')
  await installMocks(ctx, opts)
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  const until = async (fn, ms = 30000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn, arg).catch(() => false)) return true; await page.waitForTimeout(200) } return false }
  await until(() => window.__store?.get().conditions.state === 'ready')
  return { ctx, page, done, until }
}
const state = (page) => page.evaluate(() => { const s = window.__store.get(); return { screen: s.screen, sheet: s.sheet, sel: s.selection?.title ?? null, kind: s.selection?.kind ?? null } })
const chipVisible = (page) => page.locator('.point-chip').isVisible().catch(() => false)

{
  const { ctx, page, done, until } = await session()

  // ---- Gauge row → the Map with that gauge's sheet at half, no chip ----
  await openMore(page, 'Rivers & gauges')
  await until(() => window.__store.get().rivers.state === 'ready' && window.__store.get().riversTier === 'full')
  await settle(page, 400)
  const row = page.locator('.gauge-row').first()
  const rowName = (await row.locator('.gauge-main > span').first().innerText()).trim()
  await row.tap()
  await settle(page, 900)
  const a = await state(page)
  const sheetA = await page.locator('.sheet-body').innerText().catch(() => '')
  check('A gauge row opens the Map with that gauge in the sheet at half — no chip, no Details tap', a.screen === 'map' && a.sheet === 'half' && a.kind === 'gauge' && a.sel === rowName && !(await chipVisible(page)) && sheetA.includes(rowName), `${JSON.stringify(a)}; row "${rowName}"; chip ${await chipVisible(page)}`)
  const centred = await page.evaluate(() => { const m = window.__map; const sel = window.__store.get().selection; const p = m.project([sel.lngLat.lng, sel.lngLat.lat]); return { x: Math.round(p.x), y: Math.round(p.y), h: innerHeight } })
  check('…and the map centres that gauge in the part of the map above the sheet', a.screen === 'map' && centred.x > 120 && centred.x < 270 && centred.y > 60 && centred.y < centred.h * 0.5, JSON.stringify(centred))
  await page.screenshot({ path: `${OUT}/gauge-from-row.png` })

  // ---- Gauge marker on the map → the same sheet, directly ----
  await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' }))
  await settle(page, 500)
  const target = await page.evaluate(() => {
    const m = window.__map
    const feats = m.queryRenderedFeatures(undefined, { layers: m.getStyle().layers.filter((l) => /river|gauge/i.test(l.id) && l.type === 'circle').map((l) => l.id) })
    const w = innerWidth, h = innerHeight
    for (const f of feats) {
      const p = m.project(f.geometry.coordinates)
      if (p.x > 40 && p.x < w - 70 && p.y > 140 && p.y < h * 0.55) return { x: p.x, y: p.y, id: f.properties.id }
    }
    return null
  })
  if (target) {
    await page.touchscreen.tap(target.x, target.y)
    await settle(page, 900)
  }
  const b = await state(page)
  const gName = target ? await page.evaluate((id) => window.__store.get().rivers.data.find((g) => g.id === id)?.name, target.id) : null
  check('Tapping a gauge marker opens that gauge in the sheet at half, directly (no chip)', !!target && b.screen === 'map' && b.sheet === 'half' && b.kind === 'gauge' && b.sel === gName && !(await chipVisible(page)), `${JSON.stringify(b)}; marker ${target?.id ?? 'none found on screen'}`)
  await page.screenshot({ path: `${OUT}/gauge-from-marker.png` })
  await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' }))

  // ---- The rain row says what it does ----
  await openNow(page)
  await settle(page, 500)
  const rainRow = (await page.locator('.now-card.hourly .link-row').innerText().catch(() => '')).replace(/\s+/g, ' ')
  check('The Now rain row reads "Rain next N h: … · play on map ›" (no "timeline")', /^Rain next \d+ h: .+ · play on map ›$/.test(rainRow) && !/timeline/i.test(rainRow), rainRow)

  // ---- Hourly: every span opens on "Now", even after a scroll ----
  const spans = []
  // Each tap is a change of span (the strip starts on 12 h), after the strip was scrolled to its end.
  for (const n of [24, 48, 12]) {
    await page.locator('.hour-strip').evaluate((el) => (el.scrollLeft = el.scrollWidth))
    await page.getByRole('radio', { name: `${n} h`, exact: true }).click()
    await settle(page, 400)
    spans.push(await page.locator('.hour-strip').evaluate((el) => {
      const first = [...el.querySelectorAll('li')].find((li) => li.getBoundingClientRect().right > el.getBoundingClientRect().left + 4)
      return { scroll: Math.round(el.scrollLeft), first: first?.querySelector('.hour-t')?.textContent }
    }))
  }
  check('12 h, 24 h and 48 h each open on the "Now" card (the strip scrolls back to it on a switch)', spans.every((s) => s.scroll === 0 && s.first === 'Now'), JSON.stringify(spans))

  try {
  // ---- Flood: "Show on the map" is a switch ----
  await page.evaluate(() => window.__store.set((s) => ({ layers: { ...s.layers, flood: false } })))
  await openMore(page, 'Flood risk')
  await until(() => { const s = window.__store.get(); const bl = s.floodFor ? s.blocks[s.floodFor] : null; return !!bl && bl.flood.state === 'ready' && !bl.flood.data?.preliminary }, 40000)
  await settle(page, 400)
  const tgl = page.locator('[data-toggle="flood"]')
  const off0 = { pressed: await tgl.getAttribute('aria-pressed'), text: (await tgl.innerText()).trim() }
  await tgl.tap()
  await settle(page, 400)
  const on1 = { pressed: await tgl.getAttribute('aria-pressed'), text: (await tgl.innerText()).trim(), layer: await page.evaluate(() => window.__store.get().layers.flood), screen: (await state(page)).screen, page: await page.locator('.flood-page').isVisible() }
  check('Flood: the map button is a switch — "Off" → tap → "On", the flood layer turns on, and the Flood panel stays open', off0.pressed === 'false' && /: Off$/.test(off0.text) && on1.pressed === 'true' && /: On$/.test(on1.text) && on1.layer === true && on1.screen === 'more' && on1.page, `${JSON.stringify(off0)} → ${JSON.stringify(on1)}`)
  await page.getByRole('button', { name: 'Open the map ›' }).tap()
  await settle(page, 700)
  await page.getByRole('button', { name: 'Open layer menu' }).tap()
  await settle(page, 400)
  const menuFlood = await page.locator('[data-overlay="flood"]').getAttribute('aria-checked')
  await page.locator('[data-overlay="flood"]').tap()
  await settle(page, 400)
  const offFromMap = await page.evaluate(() => window.__store.get().layers.flood)
  await page.keyboard.press('Escape')
  await openMore(page, 'Flood risk')
  await settle(page, 400)
  const back = await page.locator('[data-toggle="flood"]').getAttribute('aria-pressed')
  check('…the map\'s Layers menu shows Flood on and turns it off, and the Flood panel switch then reads Off', menuFlood === 'true' && offFromMap === false && back === 'false', `menu ${menuFlood}, after map tap ${offFromMap}, panel ${back}`)
  await page.screenshot({ path: `${OUT}/flood-toggle.png` })

  // ---- Trip: "Show on map" is a switch ----
  await openTrip(page)
  await page.getByRole('searchbox', { name: 'Destination' }).fill('Ames')
  await page.waitForTimeout(800)
  await page.getByRole('dialog').getByRole('option').first().click().catch(async () => page.getByRole('option').first().click())
  await until(() => { const j = window.__store.get().journey; return j.routes.state === 'ready' }, 90000)
  await settle(page, 500)
  const rt = page.locator('[data-toggle="route"]')
  const r0 = { pressed: await rt.getAttribute('aria-pressed').catch(() => null), text: (await rt.innerText().catch(() => '')).trim() }
  await rt.tap()
  await settle(page, 300)
  const r1 = { pressed: await rt.getAttribute('aria-pressed'), text: (await rt.innerText()).trim(), store: await page.evaluate(() => window.__store.get().routeOnMap), screen: (await state(page)).screen }
  const drawn = () => page.evaluate(() => (window.__map.getStyle().layers ?? []).some((l) => l.id === 'journey-line'))
  await openMap(page)
  const offOnMap = { drawn: await drawn() }
  await page.getByRole('button', { name: 'Open layer menu' }).tap()
  await settle(page, 400)
  offOnMap.menu = await page.locator('[data-layer="route"]').getAttribute('aria-pressed').catch(() => null)
  await page.locator('[data-layer="route"]').tap()
  await settle(page, 1200)
  const onOnMap = { menu: await page.locator('[data-layer="route"]').getAttribute('aria-pressed').catch(() => null), drawn: await drawn() }
  check('Trip: "Route on map: On" → tap → "Off" and the Trip page stays open; on the map the route is gone and the Layers menu\'s "Trip route" switch reads off, and turning it on there draws the route again', r0.pressed === 'true' && /: On$/.test(r0.text) && r1.pressed === 'false' && /: Off$/.test(r1.text) && r1.store === false && r1.screen === 'trip' && offOnMap.drawn === false && offOnMap.menu === 'false' && onOnMap.menu === 'true' && onOnMap.drawn === true, `${JSON.stringify(r0)} → ${JSON.stringify(r1)}; map off ${JSON.stringify(offOnMap)}; map on ${JSON.stringify(onOnMap)}`)
  await page.keyboard.press('Escape')
  } catch (e) {
  check('Flood / Trip switches: the controls the checks above drive exist', false, String(e.message).split('\n')[0])
  }
  done()
  await ctx.close()
}

// ---- "Use my location" when the browser refuses: the picker and the map's ◎ say so ----
{
  const { ctx, page, done } = await session()
  try {
  // The browser refuses location from here on (as a blocked permission answers: PERMISSION_DENIED).
  await page.evaluate(() => {
    window.__realGeo = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation)
    navigator.geolocation.getCurrentPosition = (_ok, err) => setTimeout(() => err({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: 'User denied Geolocation' }), 300)
  })
  await openNow(page)
  await page.evaluate(() => window.__store.set({ pickerOpen: true, pickerMode: 'menu' }))
  await settle(page, 300)
  await page.getByRole('dialog').getByRole('button', { name: /Use my location/ }).tap()
  await page.waitForTimeout(1500)
  const pickerOpen = await page.evaluate(() => window.__store.get().pickerOpen)
  const pickerErr = await page.locator('.geo-error').innerText().catch(() => '')
  check('Picker: "Use my location" with location blocked keeps the picker open and says why', pickerOpen && /denied|unavailable|too long/i.test(pickerErr), `open ${pickerOpen}; "${pickerErr}"`)
  await page.screenshot({ path: `${OUT}/geo-picker.png` })
  await page.evaluate(() => window.__store.set({ pickerOpen: false }))
  await openMap(page)
  await page.getByRole('button', { name: 'Use my location' }).tap()
  await page.waitForTimeout(1500)
  const notice = await page.locator('.geo-notice').innerText().catch(() => '')
  const retry = await page.locator('.geo-notice').getByRole('button', { name: 'Try again' }).isVisible().catch(() => false)
  check('Map ◎ with location blocked: a notice says why, with Try again', /denied|unavailable|too long/i.test(notice) && retry, `"${notice.replace(/\n/g, ' | ')}"`)
  await page.screenshot({ path: `${OUT}/geo-map.png` })
  // Allowed again: the picker closes on the fix.
  await page.evaluate(() => (navigator.geolocation.getCurrentPosition = window.__realGeo))
  await page.evaluate(() => window.__store.set({ pickerOpen: true, pickerMode: 'menu' }))
  await settle(page, 300)
  await page.getByRole('dialog').getByRole('button', { name: /Use my location/ }).tap()
  await page.waitForTimeout(1500)
  const closed = !(await page.evaluate(() => window.__store.get().pickerOpen))
  const noticeGone = !(await page.locator('.geo-notice.err').isVisible().catch(() => false))
  check('Location allowed: the picker closes once the browser answers, and the failure notice is gone', closed && noticeGone, `closed ${closed}; notice gone ${noticeGone}`)
  } catch (e) {
  check('Use my location: the controls the checks above drive exist', false, String(e.message).split('\n')[0])
  }
  done()
  await ctx.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
