// The ☰ layers button and its panel against the map chrome (mocked).
//   Phones (bottom-right, and a saved top-left corner): the open panel sits below the top bar, above ☰, inside
//   the viewport, first row visible, last row reachable by scrolling inside the panel — also with iPhone
//   safe-area insets simulated (--sat / --sab) and a short viewport standing in for Safari's expanded toolbar.
//   Desktop (side column open on Now, closed on Map; a saved bottom-left corner, which once put the button
//   under the rail): the button sits fully inside the map area under the zoom / compass column, is clickable,
//   and the panel opens inside the map area between the location bar and the playback bar.
//   node scripts/menu-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap, openNow } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  menu-check.mjs: mocked only (layout geometry)')
  process.exit(3)
}
assertBudget('menu-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/menu'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

async function session({ w, h, insets = null, corner = null, screen = 'map' }) {
  const mobile = w < 768
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
  if (insets) await ctx.addInitScript(([sat, sab]) => { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = `:root{--sat:${sat}px;--sab:${sab}px}`; document.head.appendChild(s) }) }, insets)
  if (corner) await ctx.addInitScript((c) => { try { localStorage.setItem('stormscope.fabCorner', c) } catch {} }, corner)
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'menu-check.mjs (mock)')
  await installMocks(ctx, {})
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  await page.waitForFunction(() => window.__store?.get().conditions.state === 'ready', null, { timeout: 60000 }).catch(() => {})
  if (screen === 'map') await openMap(page)
  else await openNow(page)
  await page.waitForTimeout(600)
  return { ctx, page, done }
}
const geometry = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom) }
    }
    const menu = document.querySelector('.fab-menu')
    let first = null
    let lastReachable = null
    let scroll = null
    if (menu) {
      const rows = [...menu.querySelectorAll('.fab-group-label, .fab-item, .legend-rows, .fab-hint')].filter((r) => r.offsetParent !== null)
      const f = rows[0].getBoundingClientRect()
      first = { top: Math.round(f.top), bottom: Math.round(f.bottom) }
      menu.scrollTop = menu.scrollHeight
      const l = rows.at(-1).getBoundingClientRect()
      const mb = menu.getBoundingClientRect()
      lastReachable = l.bottom <= mb.bottom + 1 && l.top >= mb.top - 1
      scroll = `${menu.scrollHeight}/${menu.clientHeight}`
      menu.scrollTop = 0
    }
    return { vw: innerWidth, vh: innerHeight, menu: box('.fab-menu'), first, lastReachable, scroll, overscroll: menu ? getComputedStyle(menu).overscrollBehaviorY : null, topbar: box('.topbar'), fab: box('.fab-main'), map: box('.map-root'), ctrl: box('.maplibregl-ctrl-top-right'), playbar: box('.playbar'), nav: box('.nav'), column: box('.screen') }
  })
const inside = (a, b) => a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom
const fmt = (b) => (b ? `${b.left}-${b.right}x${b.top}-${b.bottom}` : '-')

// ---- Phones
const phone = [
  { w: 390, h: 844 },
  { w: 390, h: 744, note: 'toolbar expanded' },
  { w: 375, h: 667 },
  { w: 375, h: 567, note: 'toolbar expanded' },
  { w: 390, h: 844, insets: [47, 34] },
  { w: 390, h: 744, insets: [47, 34], note: 'toolbar expanded' },
  { w: 375, h: 667, insets: [47, 34] },
  { w: 375, h: 567, insets: [47, 34], note: 'toolbar expanded' },
  { w: 390, h: 844, insets: [47, 34], corner: 'tl' },
  { w: 375, h: 667, insets: [47, 34], corner: 'tl' },
]
for (const c of phone) {
  const { ctx, page, done } = await session(c)
  await page.getByRole('button', { name: 'Open layer menu' }).click()
  await page.waitForTimeout(500)
  const g = await geometry(page)
  const label = `phone ${c.w}x${c.h}${c.insets ? ` insets ${c.insets[0]}/${c.insets[1]}` : ''}${c.corner ? ' corner ' + c.corner : ''}${c.note ? ' (' + c.note + ')' : ''}`
  const topAnchored = c.corner?.startsWith('t')
  const viewport = { left: 0, right: g.vw, top: 0, bottom: g.vh }
  const clearOfChrome = topAnchored ? g.menu.top >= g.fab.bottom && (!g.nav || g.menu.bottom <= g.nav.top) : g.menu.top >= g.topbar.bottom && g.menu.bottom <= g.fab.top
  check(`${label}: panel inside the viewport, clear of the top bar and the button`, inside(g.menu, viewport) && clearOfChrome, `topbar ${g.topbar.top}-${g.topbar.bottom} · panel ${g.menu.top}-${g.menu.bottom} · button ${g.fab.top}-${g.fab.bottom} · vh ${g.vh}`)
  check(`${label}: first row visible, last row reachable by scrolling inside, scroll contained`, g.first.top >= g.menu.top && g.first.bottom <= g.menu.bottom && g.lastReachable && g.overscroll === 'contain', `first ${g.first.top}-${g.first.bottom} · content ${g.scroll}`)
  await page.screenshot({ path: `${OUT}/${label.replace(/[^a-z0-9]+/gi, '-')}.png` })
  done()
  await ctx.close()
}

// ---- Desktop
const desktop = [
  { w: 1280, h: 800, screen: 'now', corner: 'bl', note: 'side column open' },
  { w: 1280, h: 800, screen: 'map', corner: 'bl', note: 'column closed' },
  { w: 1920, h: 1080, screen: 'now', corner: 'bl', note: 'side column open' },
  { w: 1920, h: 1080, screen: 'map', note: 'column closed, default corner' },
  { w: 844, h: 390, screen: 'map', insets: [0, 21], note: 'phone landscape = wide layout, insets 0/21' },
]
for (const c of desktop) {
  const { ctx, page, done } = await session(c)
  const g0 = await geometry(page)
  const label = `desktop ${c.w}x${c.h} ${c.note}${c.corner ? ', saved corner ' + c.corner : ''}`
  check(`${label}: button fully inside the map area, under the zoom / compass column`, inside(g0.fab, g0.map) && g0.fab.top >= g0.ctrl.bottom && Math.abs(g0.fab.right - g0.ctrl.right) <= 1 && (!g0.column || g0.fab.left >= g0.column.right), `button ${fmt(g0.fab)} · controls ${fmt(g0.ctrl)} · map ${fmt(g0.map)} · column ${fmt(g0.column)}`)
  const hit = await page.evaluate(() => {
    const b = document.querySelector('.fab-main')
    const r = b.getBoundingClientRect()
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!el && (el === b || b.contains(el))
  })
  await page.getByRole('button', { name: 'Open layer menu' }).click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(500)
  const g = await geometry(page)
  check(`${label}: the button is the element under its own centre and the click opens the panel`, hit && !!g.menu, hit ? (g.menu ? 'opened' : 'click did not open') : 'covered')
  if (g.menu) {
    check(`${label}: panel inside the map area, beside the controls, below the location bar, above the playback bar`, inside(g.menu, g.map) && g.menu.top >= g.topbar.bottom && (!g.playbar || g.menu.bottom <= g.playbar.top) && g.menu.right <= g.ctrl.left && g.menu.right <= g.fab.left, `panel ${fmt(g.menu)} · topbar ${fmt(g.topbar)} · controls ${fmt(g.ctrl)} · playbar ${fmt(g.playbar)}`)
    check(`${label}: first row visible, last row reachable, scroll contained`, g.first.top >= g.menu.top && g.first.bottom <= g.menu.bottom && g.lastReachable && g.overscroll === 'contain', `content ${g.scroll}`)
  }
  await page.screenshot({ path: `${OUT}/${label.replace(/[^a-z0-9]+/gi, '-')}.png` })
  done()
  await ctx.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
