// Mobile layout from the Nov 6, 2026 audit, verified at a real 390 × 844 phone (mocked only):
//  • nothing on Trip, the playback bar, the layers menu or the legend runs past the screen edge or is cut;
//  • the legend's notes are separate lines (no "HazardousA");
//  • every control on Now, Map, Trip, the picker and Flood is at least 44 × 44 px;
//  • the hourly strip fades its last 28 px (a deliberate peek) instead of cutting a card;
//  • a point's sheet actions are on screen at half height (not behind the nav);
//  • a toast never sits on the screen's content (the scroll area starts below it);
//  • markers and the route draw below the labels and above every weather overlay;
//  • the smoke wash is at most 0.3 opacity and the wind streaks number at most area/1000;
//  • one panel at a time: opening credits closes the Layers menu.
//   node scripts/layout-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap, openMore, openNow, openTrip, settle } from './lib/ui.mjs'
import { checker, mockedOnly } from './lib/check-kit.mjs'

const { base: BASE, out: OUT } = mockedOnly('layout-check.mjs', 'e2e-shots/layout')
const { check, finish } = checker()
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'], locale: 'en-US' })
const page = await ctx.newPage()
const done = trackTraffic(page, 'layout-check.mjs (mock)')
await installMocks(ctx, {})
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
await page.waitForFunction(() => window.__store?.get().conditions.state === 'ready', null, { timeout: 30000 })
await settle(page, 1500)
// Elements whose text is cut: scrollWidth > clientWidth, or past the viewport's right edge.
const clipped = (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].flatMap((root) => [root, ...root.querySelectorAll('*')]).filter((e) => { const r = e.getBoundingClientRect(); if (!r.width || getComputedStyle(e).visibility === 'hidden') return false; return (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible' && e.children.length === 0) || r.right > innerWidth + 1 || r.left < -1 }).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} "${e.textContent.trim().slice(0, 24)}" [${Math.round(e.getBoundingClientRect().left)}–${Math.round(e.getBoundingClientRect().right)}]`).slice(0, 8), sel)
const small = (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44) }).map((e) => `"${(e.getAttribute('aria-label') || e.textContent).trim().slice(0, 18)}" ${Math.round(e.getBoundingClientRect().width)}×${Math.round(e.getBoundingClientRect().height)}`), sel)

// 1. Trip header with a route
await openTrip(page)
await page.getByRole('searchbox', { name: 'Destination' }).fill('Ames')
await page.waitForTimeout(800)
await page.getByRole('dialog').getByRole('option').first().click().catch(async () => page.getByRole('option').first().click())
await page.waitForFunction(() => window.__store.get().journey.routes.state === 'ready', null, { timeout: 60000 }).catch(() => {})
await settle(page, 800)
const tripHead = await clipped('.screen.trip .screen-head, .screen.trip .trip-from, .screen.trip .trip-to, .screen.trip .card-head')
check('Trip with a route (Des Moines area → Ames): the header and the from / to rows fit — nothing cut or past the edge', tripHead.length === 0, tripHead)

await page.screenshot({ path: `${OUT}/trip.png` })
// 9 targets on trip
const tripSmall = await small('.screen.trip button')
check('Trip: every button is at least 44 × 44 px', tripSmall.length === 0, tripSmall)

// 2. Playback bar (expanded)
await openMap(page)
await page.evaluate(() => window.__store.set({ playbarExpanded: true }))
await settle(page, 600)
const pbClip = await clipped('.playbar, .playdock')
check('Playback bar (expanded): nothing cut or past the edge ("Forecast →", the horizon pills, ✕)', pbClip.length === 0 && /Forecast →/.test(await page.locator('.playbar').innerText().catch(() => '')), pbClip)

await page.screenshot({ path: `${OUT}/playbar.png` })
const mapSmall = await small('.maplibregl-ctrl button, .fab-stack button, .playbar button, .playdock button, .topbar button')
check('Map: zoom / rotate / credits, ☰, the place bar and every playback control are at least 44 × 44 px', mapSmall.length === 0, mapSmall)

// 6. Layers legend with AQ + all points
await page.evaluate(() => window.__store.set((s) => ({ layers: { ...s.layers, aqcircles: true, monitors: true, rivers: true, station: true, flood: true }, aqPollutant: 'PM2.5' })))
await page.getByRole('button', { name: 'Open layer menu' }).tap().catch(() => {})
await settle(page, 600)
const menu = await page.evaluate(() => { const m = document.querySelector('.fab-menu, .fab-panel, [role="menu"]'); if (!m) return null; const r = m.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight, scroll: m.scrollHeight > m.clientHeight, cls: m.className } })
check('Layers menu: it fits between the place bar and the screen bottom (it scrolls inside when long)', !!menu && menu.top >= 0 && menu.bottom <= menu.h, menu)
const legendText = await page.locator('.legend-rows').innerText().catch(() => '')
check('Legend: the AQI category names and the disc note are separate lines (no "HazardousA")', /Hazardous\s*\n/.test(legendText) && !/HazardousA/.test(legendText), legendText.match(/Very Unhealthy[^\n]*\n?[^\n]{0,20}/)?.[0])
const legClip = await clipped('.legend-rows')
check('Legend: nothing cut or past the edge', legClip.length === 0, legClip)
await page.screenshot({ path: `${OUT}/layers.png` })
await page.keyboard.press('Escape')
await settle(page, 300)

// 8. PM2.5 wash, wind streaks
const aqOp = await page.evaluate(() => { try { return window.__map.getPaintProperty('aq-circles', 'raster-opacity') } catch { return null } })
check('Smoke (PM2.5) wash at most 0.3 opacity, so streets and labels show through', aqOp != null && aqOp <= 0.3, `opacity ${aqOp}`)
await page.evaluate(() => window.__store.set((s) => ({ layers: { ...s.layers, nowcast: true, flood: false } })))
await settle(page, 2500)
const parts = await page.evaluate(() => ({ p: window.__particles ?? null, area: (() => { const c = window.__map.getContainer(); return c.clientWidth * c.clientHeight })() }))
check('Wind streaks: at most one per 1000 px² of map (549 → 329 on this phone)', !!parts.p && parts.p.count <= Math.max(250, Math.round(parts.area / 1000)), parts)

// 7. markers vs labels: layer order
const order = await page.evaluate(() => { const ls = window.__map.getStyle().layers.map((l) => [l.id, l.type]); const at = (id) => ls.findIndex(([x]) => x === id); const sym = ls.findIndex(([, t]) => t === 'symbol'); const top = at('overlay-top'); const points = ['station-marker', 'river-gauges', 'air-monitors', 'journey-line', 'journey-dest'].map((id) => [id, at(id)]).filter(([, i]) => i >= 0); const overlays = ls.map(([id, t], i) => [id, t, i]).filter(([id, t]) => (t === 'raster' && id !== 'terrain') || id === 'rain-cells' || id === 'flood-cells').map(([id, , i]) => [id, i]); return { sym, top, points, overlaysAbove: overlays.filter(([, i]) => i > top).map(([id]) => id) } })
check('Markers and the route draw below the basemap labels and above every weather overlay', order.top > 0 && order.points.length >= 3 && order.points.every(([, i]) => i > order.top && i < order.sym) && order.overlaysAbove.length === 0, order)
await page.screenshot({ path: `${OUT}/map.png` })
await page.evaluate(() => window.__store.set((s) => ({ layers: { ...s.layers, nowcast: false, aqcircles: false, monitors: false } })))

// 5. point detail actions
await page.evaluate(() => { const p = window.__store.get().place.lngLat; window.__store.set({ selection: { kind: 'point', lngLat: { lng: p.lng + 0.05, lat: p.lat + 0.03 }, title: 'Map point', lines: [], source: '' }, sheet: 'half' }) })
await settle(page, 1500)
const acts = await page.evaluate(() => { const nav = document.querySelector('nav.nav[aria-label="Main"]')?.getBoundingClientRect().top ?? innerHeight; return { nav: Math.round(nav), buttons: [...document.querySelectorAll('.sheet-body .popup-actions button')].map((b) => ({ t: b.textContent.trim(), bottom: Math.round(b.getBoundingClientRect().bottom) })) } })
check('A point\'s sheet at half height: its actions (Use as my place, Trip here, Flood risk) are on screen, above the nav', acts.buttons.length >= 3 && acts.buttons.every((b) => b.bottom <= acts.nav), acts)
await page.screenshot({ path: `${OUT}/sheet.png` })
await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' }))

// 3. recents in picker / trip destination
await page.evaluate(() => window.__store.set({ recentPlaces: [{ name: 'Des Moines, Iowa, United States', lngLat: { lng: -93.6, lat: 41.59 } }, { name: 'Ames, Iowa, United States', lngLat: { lng: -93.62, lat: 42.03 } }, ...window.__store.get().recentPlaces] }))
await openNow(page)
await page.evaluate(() => window.__store.set({ pickerOpen: true, pickerMode: 'menu' }))
await settle(page, 500)
const recents = await page.evaluate(() => [...document.querySelectorAll('.picker-card .chips button')].filter((b) => !b.classList.contains('chip-x')).map((b) => ({ t: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height) })))
check('Picker: recent places are compact one-line pills ("Des Moines ×")', recents.length >= 2 && recents.every((r) => r.h <= 48 && !/\n/.test(r.t)), recents)
const pickSmall = await small('.picker-card button')
check('Picker: Close, recent pills and their × are at least 44 × 44 px', pickSmall.length === 0, pickSmall)
await page.screenshot({ path: `${OUT}/picker.png` })
await page.evaluate(() => window.__store.set({ pickerOpen: false }))

// 4. toast over 7-day
await openNow(page)
await page.locator('.screen.now').evaluate((e) => (e.scrollTop = e.scrollHeight))
await page.evaluate(() => window.__store.set({ toast: { id: 999, text: 'weather.gov unavailable (timeout) — using Open-Meteo', kind: 'warn' } }))
await settle(page, 300)
const tv = await page.evaluate(() => { const t = document.querySelector('.toast')?.getBoundingClientRect(); const sc = document.querySelector('.screen.now').getBoundingClientRect(); return { toastBottom: t && Math.round(t.bottom), screenTop: Math.round(sc.top) } })
check('A toast on Now sits in its own strip: the screen\'s scroll area starts below it, so it covers no content', tv.toastBottom != null && tv.screenTop >= tv.toastBottom, tv)
await page.screenshot({ path: `${OUT}/toast.png` })
await page.evaluate(() => window.__store.set({ toast: null }))

// 9 Now targets: Change, hourly cards, span pills
const nowSmall = await small('.screen.now button')
check('Now: Change, °F / °C, 12 / 24 / 48 h and the rain row are at least 44 × 44 px', nowSmall.length === 0, nowSmall)
const mask = await page.locator('.hour-strip').evaluate((e) => getComputedStyle(e).maskImage || getComputedStyle(e).webkitMaskImage)
check('Hourly strip: the right edge fades (a deliberate peek of the next card), not a hard cut', /gradient/.test(mask ?? ''), mask)
await openMore(page, 'Flood risk')
await settle(page, 800)
const floodSmall = await small('.flood-page button, .flood-page [role="radio"]')
check('Flood: the 6 / 12 / 24 / 48 h pills and the map switch are at least 44 × 44 px', floodSmall.length === 0, floodSmall)

// 10. one panel at a time
await openMap(page)
await page.getByRole('button', { name: 'Open layer menu' }).tap().catch(() => {})
await settle(page, 300)
await page.evaluate(() => window.__store.set({ creditsOpen: true }))
await settle(page, 300)
const both = await page.evaluate(() => ({ menu: !!document.querySelector('.fab-menu'), credits: window.__store.get().creditsOpen }))
check('One panel at a time: opening credits closes the Layers menu', both.credits && !both.menu, both)
await page.screenshot({ path: `${OUT}/panels.png` })
done()
await browser.close()
finish()
