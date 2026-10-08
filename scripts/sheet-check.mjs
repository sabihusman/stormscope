// The Map screen's details sheet (opened by the point chip's Details button; playback lives in the docked bar): once expanded it must collapse again —
// by dragging the handle down, by tapping the handle, by the ▼ button (which must be on screen), by dragging
// scrolled-to-top content down, and by the browser back gesture — for both contents.
// Real touch input (CDP touch events), phone viewport with touch + mobile emulation.
import { chromium, webkit } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
import { touchDrag, touchTap, centre } from './lib/touch.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap, openMore, openTrip, pageText, setLayers, setSheet, setUnits, sheetText, tripText, searchPlace, openNow } from './lib/ui.mjs'

// --browser=webkit runs Playwright's WebKit (Safari engine, not iOS Safari); --mock answers every API locally.
const argv = process.argv.slice(2)
const WEBKIT = argv.includes('--browser=webkit')
const MOCK = argv.includes('--mock')
assertBudget(`sheet-check.mjs${MOCK ? ' (mock)' : ''}`) // the Now screen fetches one Open-Meteo location per place on every load
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
const page = await ctx.newPage()
// Guard first, mocks after (last-registered route runs first): the mocks answer, and only what falls
// through them reaches the guard — counted and capped, never silently live.
const __recordBudget = trackOpenMeteo(page, `sheet-check.mjs${MOCK ? ' (mock)' : ''}`)
if (MOCK) await installMocks(ctx, {})
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(BASE, { waitUntil: 'load' })
await page.getByRole('button', { name: 'Use my location' }).first().click({ timeout: 4000 }).catch(() => {})
await page.waitForTimeout(3000)
await openMap(page)
await page.waitForTimeout(600)

// No sheet is rendered while collapsed (peek) — the chip stays, the bar stays; height is then 0.
const st = () =>
  page.evaluate(() => {
    const el = document.querySelector('.sheet')
    const sheet = el?.getBoundingClientRect()
    const body = document.querySelector('.sheet-body')
    const btn = document.querySelector('.sheet-toggle')?.getBoundingClientRect()
    const handle = document.querySelector('.sheet-handle')?.getBoundingClientRect()
    return {
      mode: window.__store.get().sheet,
      content: window.__store.get().selection ? 'details' : 'none',
      height: sheet ? Math.round(sheet.height) : 0,
      handleOnScreen: !!handle && handle.y >= 0 && handle.bottom <= innerHeight && handle.height >= 24,
      btnOnScreen: !!btn && btn.x >= 0 && btn.right <= innerWidth && btn.y >= 0 && btn.bottom <= innerHeight,
      scrollTop: body?.scrollTop ?? 0,
      scrollable: body ? body.scrollHeight > body.clientHeight + 4 : false,
      url: location.pathname + location.search,
    }
  })
const handle = () => centre(page.locator('.sheet-handle'))
const settle = () => page.waitForTimeout(450)
const start = await st()
check('Starts collapsed (peek): no sheet on screen until a point is tapped', start.mode === 'peek' && start.height === 0 && (await page.locator('.playbar').count()) === 1, `height ${start.height}`)
const H0 = start.height

/** Open the details sheet (a map tap, then the chip's Details button), expand to full, scroll if it can. */
const select = async () => {
  if (!(await st()).content.startsWith('details')) { await touchTap(page, { x: 195, y: 300 }); await settle() }
  const d = page.getByRole('button', { name: 'Details' })
  if (await d.count()) await touchTap(page, await centre(d))
  await settle()
}
const expandAndScroll = async (content) => {
  const trail = []
  await select(content)
  trail.push(`${content}→${(await st()).mode}`)
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

for (const t of ['details']) {
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
let s = await expandAndScroll('details')
await page.goBack()
await settle()
s = await st()
check('Back gesture collapses the sheet and stays in the app', s.mode === 'peek' && s.height === H0 && /^\/(\?.*)?$/.test(s.url) && (await page.locator('.sheet').count()) === 0, `${s.mode} ${s.height}px url ${s.url}`)
// Close from inside the expanded sheet: the selection and the chip go, the bar stays.
s = await expandAndScroll('details')
await touchTap(page, await centre(page.getByRole('button', { name: '‹ Close' })))
await settle()
s = await st()
check('‹ Close clears the selection, removes the sheet and the chip, keeps the playback bar', s.mode === 'peek' && s.content === 'none' && s.height === H0 && (await page.locator('.point-chip').count()) === 0 && (await page.locator('.playbar').count()) === 1, `${s.mode} ${s.content} ${s.height}px`)
await page.screenshot({ path: `${OUT}/sheet-final.png` })
check('No page errors', errs.length === 0, errs[0])
__recordBudget()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
