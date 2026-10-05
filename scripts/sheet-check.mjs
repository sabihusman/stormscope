// Phone bottom sheet: once expanded it must collapse again — by dragging the handle down, by
// tapping the handle, by the ▼ button (which must be on screen), by dragging scrolled-to-top
// content down, and by the browser back gesture — from every tab, with the content scrolled.
// Real touch input (CDP touch events), phone viewport with touch + mobile emulation.
import { chromium, webkit } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
import { touchDrag, touchTap, centre } from './lib/touch.mjs'
import { installMocks } from './lib/mock-server.mjs'
assertBudget('sheet-check.mjs', { openMeteo: false }) // radar + station only

// --browser=webkit runs Playwright's WebKit (Safari engine, not iOS Safari); --mock answers every API locally.
const argv = process.argv.slice(2)
const WEBKIT = argv.includes('--browser=webkit')
const MOCK = argv.includes('--mock')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:5174/'
const OUT = positional[1] || (WEBKIT ? 'e2e-shots/sheet-webkit' : 'e2e-shots/sheet')
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = WEBKIT ? await webkit.launch({ headless: false }) : await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
console.log(`engine: ${browser.browserType().name()} ${browser.version()}${MOCK ? ' (mocked APIs)' : ''}`)
// WebKit: Playwright cannot route a service worker's fetches, so with mocks the worker is blocked (otherwise its fetches go live).
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'], serviceWorkers: WEBKIT && MOCK ? 'block' : 'allow' })
await ctx.addInitScript(() => { try { if (!localStorage.getItem('stormscope.layers')) localStorage.setItem('stormscope.layers', JSON.stringify({ radar: true, satellite: false, rainfall: false, flood: false, rivers: false, station: true, nowcast: false })) } catch {} })
if (MOCK) await installMocks(ctx, {})
const page = await ctx.newPage()
const __recordBudget = MOCK ? () => {} : trackOpenMeteo(page, 'sheet-check.mjs')
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {})
await page.waitForTimeout(3000)

const st = () =>
  page.evaluate(() => {
    const sheet = document.querySelector('.sheet').getBoundingClientRect()
    const body = document.querySelector('.sheet-body')
    const btn = document.querySelector('.sheet-toggle')?.getBoundingClientRect()
    const handle = document.querySelector('.sheet-handle').getBoundingClientRect()
    return {
      mode: window.__store.get().sheet,
      tab: window.__store.get().tab,
      height: Math.round(sheet.height),
      handleOnScreen: handle.y >= 0 && handle.bottom <= innerHeight && handle.height >= 24,
      btnOnScreen: !!btn && btn.x >= 0 && btn.right <= innerWidth && btn.y >= 0 && btn.bottom <= innerHeight,
      scrollTop: body?.scrollTop ?? 0,
      scrollable: body ? body.scrollHeight > body.clientHeight + 4 : false,
      url: location.pathname + location.search,
    }
  })
const handle = () => centre(page.locator('.sheet-handle'))
const settle = () => page.waitForTimeout(450)
const start = await st()
check('Starts collapsed (peek)', start.mode === 'peek', `height ${start.height}`)
const H0 = start.height

/** Expand to full from peek: tap the tab (→ half), then drag the handle up (→ full); scroll the content if it can. */
const expandAndScroll = async (tabName) => {
  const trail = []
  await touchTap(page, await centre(page.getByRole('tab', { name: tabName })))
  await settle()
  trail.push(`tab→${(await st()).mode}`)
  const h = await handle()
  await touchDrag(page, h, { x: h.x, y: h.y - 220 })
  await settle()
  trail.push(`handle↑(y${Math.round(h.y)})→${(await st()).mode}`)
  const body = await centre(page.locator('.sheet-body'))
  if (body) await touchDrag(page, { x: body.x, y: body.y + 180 }, { x: body.x, y: body.y - 180 })
  await settle()
  const s = await st()
  trail.push(`content↑→${s.mode}`)
  if (s.mode !== 'full') console.log(`      trail: ${trail.join(' ')}`)
  return s
}

for (const t of ['Timeline', 'Journey', 'Station', 'Rivers', 'Flood', 'Sources']) {
  // (a) drag the handle down, twice (full → half → peek)
  let s = await expandAndScroll(t)
  check(`[${t}] expanded to full with content${s.scrollable ? ' scrolled' : ' (not scrollable)'}; handle and ▼ on screen`, s.mode === 'full' && s.handleOnScreen && s.btnOnScreen, `${s.mode}, scrollTop ${s.scrollTop}`)
  let h = await handle()
  await touchDrag(page, h, { x: h.x, y: h.y + 180 })
  await settle()
  h = await handle()
  await touchDrag(page, h, { x: h.x, y: h.y + 180 })
  await settle()
  s = await st()
  check(`[${t}] drag-down on the handle collapses back to the starting height`, s.mode === 'peek' && s.height === H0, `${s.mode} ${s.height}px`)

  // (b) tap the handle
  s = await expandAndScroll(t)
  await touchTap(page, await handle())
  await settle()
  s = await st()
  check(`[${t}] tapping the handle collapses to the starting height`, s.mode === 'peek' && s.height === H0, `${s.mode} ${s.height}px`)

  // (c) tap the ▼ button (must be inside the viewport)
  s = await expandAndScroll(t)
  const b = await centre(page.getByRole('button', { name: 'Collapse panel' }))
  check(`[${t}] ▼ button is on screen in full mode`, !!b && b.x + 8 <= 390 && s.btnOnScreen, b ? `x ${Math.round(b.x)} of 390` : 'no box')
  if (b) await touchTap(page, b)
  await settle()
  s = await st()
  check(`[${t}] tapping ▼ collapses to the starting height`, s.mode === 'peek' && s.height === H0, `${s.mode} ${s.height}px`)

  // (d) drag the content down when it is scrolled to the top (one step per swipe)
  s = await expandAndScroll(t)
  const body = await centre(page.locator('.sheet-body'))
  if (s.scrollable) await touchDrag(page, { x: body.x, y: body.y - 180 }, { x: body.x, y: body.y + 220 }) // back to the top first
  await settle()
  await touchDrag(page, body, { x: body.x, y: body.y + 220 })
  await settle()
  const body2 = await centre(page.locator('.sheet-body')) // the sheet is shorter now; swipe from its new centre
  await touchDrag(page, body2, { x: body2.x, y: body2.y + 220 })
  await settle()
  s = await st()
  check(`[${t}] swiping the content down (at scroll top) collapses to the starting height`, s.mode === 'peek' && s.height === H0, `${s.mode} ${s.height}px`)
}

// (e) browser / Android back gesture collapses instead of leaving the app
let s = await expandAndScroll('Journey')
await page.goBack()
await settle()
s = await st()
check('Back gesture collapses the sheet and stays in the app', s.mode === 'peek' && s.height === H0 && /^\/(\?.*)?$/.test(s.url) && (await page.locator('.sheet').count()) === 1, `${s.mode} ${s.height}px url ${s.url}`)
// Tab switch while expanded keeps it usable: switch tabs, then collapse by handle tap.
s = await expandAndScroll('Station')
await touchTap(page, await centre(page.getByRole('tab', { name: 'Flood' })))
await settle()
await touchTap(page, await handle())
await settle()
s = await st()
check('After switching tabs while open, a handle tap still collapses', s.mode === 'peek' && s.tab === 'flood' && s.height === H0, `${s.mode} ${s.tab} ${s.height}px`)
await page.screenshot({ path: `${OUT}/sheet-final.png` })
check('No page errors', errs.length === 0, errs[0])
__recordBudget()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
