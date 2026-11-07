// "What am I looking at?" from the Nov 6, 2026 audit (item 18: nothing explained gauge colours, wind streaks or AQI
// discs), at a real 390 × 844 phone and once at 1280 px, mocked only:
//  • the Layers menu's legend rows for river gauges, wind and the air-quality discs each link to the help at that section;
//  • the help opens over the map (the Layers menu closes: one panel at a time), fits above the nav, and closes with ×
//    or Escape; opening credits closes it;
//  • its gauge colours are the colours the map paints, and its AQI colours the legend's;
//  • the wind section gives the darkest-streak speed in the chosen units;
//  • More lists "What am I looking at?" and shows the same help as a page.
//   node scripts/help-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMap, openMore, setLayers, settle } from './lib/ui.mjs'
import { checker, mockedOnly, oneLine, until } from './lib/check-kit.mjs'

const { base: BASE, out: OUT } = mockedOnly('help-check.mjs', 'e2e-shots/help')
const { check, finish } = checker()
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

async function openApp(viewport, mobile) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'], locale: 'en-US' })
  const page = await ctx.newPage()
  const done = trackTraffic(page, `help-check.mjs (mock, ${viewport.width} px)`)
  await installMocks(ctx, {})
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  await page.waitForFunction(() => window.__store?.get().conditions.state === 'ready', null, { timeout: 30000 })
  await settle(page, 1200)
  return { ctx, page, done }
}

const helpOpen = (page) => page.evaluate(() => !!document.querySelector('.help-panel'))
/** The help panel's box against the screen and the nav, the focused section and whether it is in the panel's view. */
const helpBox = (page) =>
  page.evaluate(() => {
    const p = document.querySelector('.help-panel')
    if (!p) return null
    const r = p.getBoundingClientRect()
    const nav = document.querySelector('.nav, nav')?.getBoundingClientRect().top ?? innerHeight
    const focus = p.querySelector('.help-section.focus')
    const fr = focus?.getBoundingClientRect()
    const past = [...p.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.right > innerWidth + 1 || b.left < -1) }).length
    const close = p.querySelector('[aria-label="Close help"]')?.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), nav: Math.round(nav), w: innerWidth, h: innerHeight, focus: focus?.dataset.topic ?? null, focusInView: !!fr && fr.top >= r.top - 1 && fr.top < r.bottom - 40, past, close: close && [Math.round(close.width), Math.round(close.height)], menu: !!document.querySelector('.fab-menu'), flag: window.__store.get().layersMenuOpen }
  })
/** Opens the Layers menu and taps the "What do these mean?" link inside the legend row matching `rowSel`. */
async function openFromLegend(page, rowSel) {
  if (!(await page.evaluate(() => !!document.querySelector('.fab-menu')))) {
    await page.getByRole('button', { name: 'Open layer menu' }).tap()
    await settle(page, 400)
  }
  const link = page.locator(`.legend-rows ${rowSel} .help-link`)
  const n = await link.count()
  if (n) {
    await link.first().scrollIntoViewIfNeeded()
    await link.first().tap()
  }
  await until(page, () => !!document.querySelector('.help-panel[data-state="open"]'), 3000, 50)
  await until(page, () => !document.querySelector('.fab-menu'), 3000, 50)
  return n
}
const closeHelp = async (page) => {
  await page.getByRole('button', { name: 'Close help' }).tap()
  await until(page, () => !document.querySelector('.help-panel'), 3000, 50)
}

// ---- Phone ----
{
  const { ctx, page, done } = await openApp({ width: 390, height: 844 }, true)
  await openMap(page)
  await setLayers(page, { rivers: true })
  await until(page, () => (window.__map?.getSource('river-gauges') ? window.__map.querySourceFeatures('river-gauges').length : 0) > 0, 30000)

  // 1. River gauges
  const gLinks = await openFromLegend(page, '.legend-row:has(.legend-title:text-is("River gauges"))')
  const g = await helpBox(page)
  check('Layers menu → River gauges → "What do these mean?" opens the help at the gauge section, in view', gLinks === 1 && g?.focus === 'gauges' && g.focusInView, { links: gLinks, ...g })
  check('The help replaces the Layers menu (one panel at a time) and fits between the top of the screen and the nav', !!g && !g.menu && !g.flag && g.top >= 0 && g.bottom <= g.nav && g.past === 0, g)
  check('The help\'s × is a 44 × 44 px target', !!g?.close && g.close[0] >= 44 && g.close[1] >= 44, g?.close)
  await page.screenshot({ path: `${OUT}/phone-gauges.png` })

  // Colours: every colour the map paints on a gauge is a row in the help, with the matching words.
  const colours = await page.evaluate(() => {
    const painted = [...new Set(window.__map.querySourceFeatures('river-gauges').map((f) => f.properties.color.toLowerCase()))]
    const rows = [...document.querySelectorAll('.help-panel [data-topic="gauges"] li')].map((li) => ({ level: li.dataset.level, color: getComputedStyle(li.querySelector('.dot')).backgroundColor, text: li.textContent }))
    const hex = (rgb) => '#' + rgb.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')
    return { painted, rows: rows.map((r) => ({ ...r, hex: hex(r.color) })) }
  })
  const rowHex = colours.rows.map((r) => r.hex)
  check('Every gauge colour on the map is explained in the help (5 rows: red, orange, yellow, green, grey)', colours.rows.length === 5 && colours.painted.every((c) => rowHex.includes(c)), { painted: colours.painted, help: rowHex })
  const words = Object.fromEntries(colours.rows.map((r) => [r.level, r.text]))
  check('The gauge rows give the app\'s rules: flood stage = red, action stage or 3× median flow = orange, 75 % of minor stage or 1.75× = yellow, no reading in 12 h = grey',
    /flood stage/.test(words.flooding ?? '') && /action stage/.test(words.high ?? '') && /3×/.test(words.high ?? '') && /75 %/.test(words.elevated ?? '') && /1\.75/.test(words.elevated ?? '') && /12 hours/.test(words.unknown ?? ''), words)

  // 2. Escape closes it.
  await page.keyboard.press('Escape')
  const escClosed = await until(page, () => !document.querySelector('.help-panel'), 3000, 50)
  check('Escape closes the help', escClosed && (await page.evaluate(() => window.__store.get().helpTopic)) == null)

  // 3. Wind
  await setLayers(page, { nowcast: true })
  const wLinks = await openFromLegend(page, '.legend-row:has(.legend-title:text-is("Wind"))')
  const w = await helpBox(page)
  const windText = oneLine(await page.locator('.help-panel [data-topic="wind"]').innerText().catch(() => ''))
  check('Layers menu → Wind → "What do these mean?" opens the help at the wind section, in view', wLinks === 1 && w?.focus === 'wind' && w.focusInView, { links: wLinks, ...w })
  check('The wind section says what the streaks are (forecast wind at 10 m, the playback clock) and the darkest speed in mph', /10 m/.test(windText) && /playback clock/.test(windText) && /\b17 mph\b/.test(windText), windText.slice(0, 300))
  await page.screenshot({ path: `${OUT}/phone-wind.png` })
  await closeHelp(page)

  // 4. Air-quality discs
  await setLayers(page, { aqcircles: true })
  const aLinks = await openFromLegend(page, '.aqi-legend')
  const a = await helpBox(page)
  const aqi = await page.evaluate(() => {
    const hex = (rgb) => '#' + rgb.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')
    return {
      help: [...document.querySelectorAll('.help-panel [data-topic="aqi"] li')].map((li) => [li.dataset.aqi, hex(getComputedStyle(li.querySelector('.dot')).backgroundColor)]),
      text: document.querySelector('.help-panel [data-topic="aqi"]')?.textContent ?? '',
    }
  })
  // The legend lives in the (now closed) Layers menu; its swatch colours are the same constants, read back from the panel when reopened.
  check('Layers menu → air-quality legend → "What do these mean?" opens the help at the AQI section, in view', aLinks === 1 && a?.focus === 'aqi' && a.focusInView, { links: aLinks, ...a })
  check('The AQI section lists the six EPA categories and says what a disc is (25 km, under 2 h, no estimate between monitors)', aqi.help.length === 6 && /25 km/.test(aqi.text) && /2 hours/.test(aqi.text) && /never estimates/.test(aqi.text), { help: aqi.help, text: aqi.text.slice(0, 200) })
  await page.screenshot({ path: `${OUT}/phone-aqi.png` })
  await closeHelp(page)
  await page.getByRole('button', { name: 'Open layer menu' }).tap()
  await settle(page, 400)
  const legendHex = await page.evaluate(() => { const hex = (rgb) => '#' + rgb.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join(''); return [...document.querySelectorAll('.aqi-legend [data-aqi] i')].map((i) => hex(getComputedStyle(i).backgroundColor)) })
  check('The help\'s AQI colours are the legend\'s, in order', legendHex.length === 6 && legendHex.every((c, i) => aqi.help[i]?.[1] === c), { legend: legendHex, help: aqi.help.map((x) => x[1]) })

  // 5. One panel at a time: credits closes the help.
  await openFromLegend(page, '.aqi-legend')
  await page.evaluate(() => window.__store.set({ creditsOpen: true }))
  await settle(page, 300)
  const afterCredits = await page.evaluate(() => ({ help: window.__store.get().helpTopic, state: document.querySelector('.help-panel')?.dataset.state ?? 'gone' }))
  const left = await until(page, () => !document.querySelector('.help-panel'), 3000, 50)
  check('Opening credits closes the help (one panel at a time)', afterCredits.help == null && ['closing', 'gone'].includes(afterCredits.state) && left, afterCredits)
  await page.evaluate(() => window.__store.set({ creditsOpen: false }))

  // 6. More → What am I looking at?
  await openMore(page)
  const row = await page.locator('.more-row', { hasText: 'What am I looking at?' }).innerText().catch(() => '')
  check('More lists "What am I looking at?" (gauge colours, wind streaks, air-quality discs)', /What am I looking at\?/.test(row) && /gauge colours/.test(row), oneLine(row))
  await openMore(page, 'What am I looking at?')
  const pageInfo = await page.evaluate(() => ({ sections: [...document.querySelectorAll('.page-body .help-section')].map((s) => s.dataset.topic), placeRow: !!document.querySelector('.screen.more .place-row, .screen.more .place-chip'), past: [...document.querySelectorAll('.screen.more *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > innerWidth + 1 }).length }))
  check('More → What am I looking at? shows the three sections as a page, nothing past the edge', pageInfo.sections.join() === 'gauges,wind,aqi' && pageInfo.past === 0, pageInfo)
  await page.screenshot({ path: `${OUT}/phone-more-help.png`, fullPage: false })
  done()
  await ctx.close()
}

// ---- Desktop ----
{
  const { ctx, page, done } = await openApp({ width: 1280, height: 800 }, false)
  await setLayers(page, { rivers: true })
  await settle(page, 600)
  const link = page.locator('.legend-rows .legend-row:has(.legend-title:text-is("River gauges")) .help-link')
  await link.scrollIntoViewIfNeeded().catch(() => {})
  await link.click().catch(() => {})
  await until(page, () => !!document.querySelector('.help-panel[data-state="open"]'), 3000, 50)
  const d = await page.evaluate(() => { const r = document.querySelector('.help-panel')?.getBoundingClientRect(); const m = document.querySelector('.fab-menu')?.getBoundingClientRect(); return r && { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: innerWidth, h: innerHeight, docked: !!m, menu: m && [Math.round(m.left), Math.round(m.right)], overlap: !!m && r.left < m.right && m.left < r.right && r.top < m.bottom && m.top < r.bottom } })
  check('Desktop (1280 px): the help opens as a panel inside the window, beside the docked Layers panel (it stays: the one-panel rule is for phones; no overlap)', !!d && d.left >= 0 && d.right <= d.w && d.top >= 0 && d.bottom <= d.h && d.docked && !d.overlap, d)
  await page.screenshot({ path: `${OUT}/desktop-help.png` })
  done()
  await ctx.close()
}

await browser.close()
finish()
