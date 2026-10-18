// Phone map chrome (Oct 18): the layers button in the bottom-right corner on the playback pill's row while the
// pill is compact, lifted above the bar when it expands (220 ms transform; none with Reduce Motion), never over
// the pill, the bar, the bottom nav, the scale or the status tags, at 390×844 and 375×667; the layers panel opens
// fully on screen from both positions; the (i) control opens the credits; the credits are listed on the More tab.
//   node scripts/mapchrome-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap, openMore, setLayers } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
assertBudget('mapchrome-check.mjs')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/mapchrome'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const FOCUS = { lat: 41.673, lng: -93.698 }
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const CREDIT_NAMES = ['RainViewer', 'OpenFreeMap', 'OpenMapTiles', 'OpenStreetMap', 'AirNow', 'Open-Meteo', 'National Weather Service', 'NASA GIBS', 'MapLibre']

const rects = (page) => page.evaluate(() => {
  const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return b.width && b.height ? { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom } : null }
  return { fab: r('.fab-main'), pill: r('.playpill'), bar: r('.playbar'), nav: r('nav'), dock: r('.playdock'), scale: r('.maplibregl-ctrl-scale'), credits: r('.map-credits-btn'), tags: [...document.querySelectorAll('.playdock .pill')].map((el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom } }), vw: innerWidth, vh: innerHeight, expanded: window.__store.get().playbarExpanded, fabTransition: getComputedStyle(document.querySelector('.fab-stack')).transitionDuration }
})
const overlaps = (a, b) => !!a && !!b && a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1
const noOverlap = (R) => {
  const others = { pill: R.pill, bar: R.bar, nav: R.nav, scale: R.scale, credits: R.credits, ...Object.fromEntries(R.tags.map((t, i) => [`tag${i}`, t])) }
  return Object.entries(others).filter(([, o]) => overlaps(R.fab, o)).map(([k]) => k)
}

for (const vp of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
  const ctx = await browser.newContext({ viewport: vp, isMobile: true, hasTouch: true, geolocation: { latitude: FOCUS.lat, longitude: FOCUS.lng }, permissions: ['geolocation'] })
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'mapchrome-check.mjs')
  if (MOCK) await installMocks(ctx, {})
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(150) } return false }
  await until(() => window.__store?.get().conditions.state === 'ready')
  await openMap(page)
  await setLayers(page, { radar: true })
  await until(() => !!document.querySelector('.playpill'), 15000)
  await page.waitForTimeout(500)
  const tag = `${vp.width}x${vp.height}`
  const R0 = await rects(page)
  check(`${tag}: pill compact — the layers button is in the bottom-right corner on the pill's row (right edge within 20 px of the screen edge, bottoms within 8 px)`, R0.fab && R0.pill && !R0.expanded && R0.vw - R0.fab.r <= 20 && Math.abs(R0.fab.b - R0.pill.b) <= 8 && R0.fab.b <= R0.nav.y, `fab right ${Math.round(R0.vw - (R0.fab?.r ?? 0))} px from edge, fab bottom ${Math.round(R0.fab?.b)}, pill bottom ${Math.round(R0.pill?.b)}, nav top ${Math.round(R0.nav?.y)}`)
  check(`${tag}: pill compact — the button overlaps nothing (pill, nav, scale, status tags, (i))`, noOverlap(R0).length === 0, `overlaps: ${noOverlap(R0).join(',') || 'none'}; (i) at ${JSON.stringify(R0.credits)}`)
  check(`${tag}: the (i) credits control sits under the zoom column at the top right, clear of the scale, the pill and the button`, R0.credits && R0.credits.y < R0.vh / 2 && R0.vw - R0.credits.r <= 30 && !overlaps(R0.credits, R0.scale) && !overlaps(R0.credits, R0.pill), JSON.stringify(R0.credits))
  // The layers panel opens fully on screen from the corner position.
  await page.getByRole('button', { name: 'Open layer menu' }).tap()
  await page.waitForTimeout(400)
  const m0 = await page.locator('.fab-menu').boundingBox()
  check(`${tag}: the layers panel opens fully on screen above the corner button`, m0 && m0.y >= 0 && m0.y + m0.height <= (R0.fab?.y ?? 0) + 1 && m0.y + m0.height <= vp.height, `panel ${Math.round(m0?.y)}–${Math.round(m0?.y + m0?.height)}, fab top ${Math.round(R0.fab?.y)}`)
  await page.getByRole('button', { name: 'Close layer menu' }).tap()
  await page.waitForTimeout(300)
  // Expand the bar: the button slides up above it.
  await page.getByRole('button', { name: /Show controls/ }).tap()
  await page.waitForTimeout(500)
  const R1 = await rects(page)
  check(`${tag}: bar expanded — the button moved up above the bar (its bottom above the bar's top) with a 220 ms transform transition`, R1.expanded && R1.bar && R1.fab && R1.fab.b <= R1.bar.y + 1 && R1.fab.y < (R0.fab?.y ?? 0) && R1.fabTransition.startsWith('0.22s'), `fab bottom ${Math.round(R1.fab?.b)}, bar top ${Math.round(R1.bar?.y)}, transition ${R1.fabTransition}`)
  check(`${tag}: bar expanded — the button overlaps nothing (bar, nav, scale, tags, (i))`, noOverlap(R1).length === 0, `overlaps: ${noOverlap(R1).join(',') || 'none'}`)
  await page.getByRole('button', { name: 'Open layer menu' }).tap()
  await page.waitForTimeout(400)
  const m1 = await page.locator('.fab-menu').boundingBox()
  check(`${tag}: the layers panel opens fully on screen above the lifted button`, m1 && m1.y >= 0 && m1.y + m1.height <= (R1.fab?.y ?? 0) + 1, `panel ${Math.round(m1?.y)}–${Math.round(m1?.y + m1?.height)}, fab top ${Math.round(R1.fab?.y)}`)
  await page.getByRole('button', { name: 'Close layer menu' }).tap()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${OUT}/bar-expanded-${tag}.png` })
  // Collapse: back down to the pill's row.
  await page.getByRole('button', { name: 'Hide controls' }).tap()
  await page.waitForTimeout(500)
  const R2 = await rects(page)
  check(`${tag}: bar collapsed — the button is back on the pill's row`, !R2.expanded && R2.fab && R2.pill && Math.abs(R2.fab.b - R2.pill.b) <= 8 && Math.abs(R2.fab.y - (R0.fab?.y ?? 0)) <= 2, `fab bottom ${Math.round(R2.fab?.b)}, pill bottom ${Math.round(R2.pill?.b)}`)
  // Credits.
  check(`${tag}: no attribution banner on the map`, (await page.locator('.maplibregl-ctrl-attrib').count()) === 0)
  await page.locator('.map-credits-btn').tap()
  await page.waitForTimeout(400)
  const creditsText = await page.locator('.credits-panel').innerText().catch(() => '')
  check(`${tag}: tapping (i) opens the credits with every source named (OpenStreetMap spelled exactly)`, CREDIT_NAMES.every((n) => creditsText.includes(n)) && /© OpenStreetMap contributors/.test(creditsText), creditsText.replace(/\n/g, ' | ').slice(0, 140))
  await page.getByRole('button', { name: 'Close credits' }).tap()
  await page.waitForTimeout(300)
  check(`${tag}: × closes the credits`, (await page.locator('.credits-panel').count()) === 0)
  await page.screenshot({ path: `${OUT}/pill-compact-${tag}.png` })
  done()
  await ctx.close()
}

// Reduce Motion: the lift has no transition. And the More tab lists the credits.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', geolocation: { latitude: FOCUS.lat, longitude: FOCUS.lng }, permissions: ['geolocation'] })
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'mapchrome-check.mjs')
  if (MOCK) await installMocks(ctx, {})
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(150) } return false }
  await until(() => window.__store?.get().conditions.state === 'ready')
  await openMap(page)
  const dur = await page.evaluate(() => getComputedStyle(document.querySelector('.fab-stack')).transitionDuration)
  check('Reduce Motion: the layers button has no transition (0 s)', dur === '0s', dur)
  await openMore(page, 'About / Credits')
  const moreText = await page.locator('.page-body').innerText().catch(() => '')
  check('More › About / Credits lists every source (OpenStreetMap spelled exactly)', CREDIT_NAMES.every((n) => moreText.includes(n)) && /© OpenStreetMap contributors/.test(moreText), moreText.replace(/\n/g, ' | ').slice(0, 140))
  await page.screenshot({ path: `${OUT}/more-credits.png` })
  done()
  await ctx.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
