// Lite mode (owner decision, Nov 7, 2026: Lite is the default, Full is in Settings > Mode), mocked only, at 390 × 844
// and 1280 × 800:
//  • a first open (nothing saved) is Lite: the Lite home, no full map mounted, no map handle;
//  • what Lite requests on open, by host: the place's forecast (one Open-Meteo location), NWS (alerts + the station)
//    and the basemap — no radar, satellite, gauges, air monitors or forecast blocks; Full's open is counted the same
//    way for comparison;
//  • the home: status row, the headline with its labelled observation, 12 hours (no span switch), 7 days, rain next
//    24 h, a small map with the basemap only (not draggable, no radar source), the More row;
//  • the More row: nothing loads until Load; Load Rivers asks for gauges only and shows them on the home, Hide removes
//    them; Load Air asks for the monitors;
//  • the "Full ›" link and the nav's Map are a one-time look: the map mounts, the saved mode stays Lite, and
//    "Back to Lite" unmounts it again;
//  • Settings > Mode: two options, "Lite (default)" checked; Full is saved at once and survives a reload (the map and
//    radar load); Lite is saved at once, unloads the map and returns to the Lite home;
//  • on a desktop width Lite is one centred column with the bottom nav, and nothing overflows at 390 px.
//   node scripts/lite-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMore, settle } from './lib/ui.mjs'
import { checker, mockedOnly, oneLine, until } from './lib/check-kit.mjs'

const { base: BASE, out: OUT } = mockedOnly('lite-check.mjs', 'e2e-shots/lite')
const { check, finish } = checker()
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

const OWN = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
/** External requests by host since `since` (the page's own origin is not counted). */
function counter(page) {
  const log = []
  page.on('request', (r) => {
    let u
    try {
      u = new URL(r.url())
    } catch {
      return
    }
    if (!/^https?:$/.test(u.protocol) || OWN.test(u.host)) return
    log.push({ host: u.host, url: r.url(), at: Date.now() })
  })
  return {
    log,
    since: (t) => log.filter((x) => x.at >= t),
    byHost: (t = 0) => log.filter((x) => x.at >= t).reduce((a, x) => ({ ...a, [x.host]: (a[x.host] ?? 0) + 1 }), {}),
  }
}
const HEAVY = /rainviewer|gibs\.earthdata|api\.water\.noaa\.gov|waterdata\.usgs\.gov|monitors\.stormscope\.test|hydro\.nationalmap|s3\.amazonaws\.com/

async function openApp({ viewport = { width: 390, height: 844 }, mode = null } = {}) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 768, hasTouch: viewport.width < 768, deviceScaleFactor: 2, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'], locale: 'en-US' })
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'lite-check.mjs (mock)')
  // mode null: nothing saved, the app's own default (a first open).
  await installMocks(ctx, { mode })
  const net = counter(page)
  // The own-origin /api/sites (the monitor function) is answered by the mock too: count it as the monitors.
  page.on('request', (r) => r.url().includes('/api/sites') && net.log.push({ host: 'api/sites (monitors)', url: r.url(), at: Date.now() }))
  const t0 = Date.now()
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  await page.waitForFunction(() => { const s = window.__store?.get(); return s?.conditions.state === 'ready' && s.alerts.state === 'ready' && s.station.state === 'ready' }, null, { timeout: 30000 })
  await page.locator('.cond-temp').first().waitFor({ timeout: 15000 })
  const toTemp = Date.now() - t0
  return { ctx, page, done, net, t0, toTemp }
}

const openWindowMs = 6000
const omLocations = (entries) => entries.filter((x) => /open-meteo\.com\/v1\/forecast/.test(x.url)).reduce((n, x) => n + (new URL(x.url).searchParams.get('latitude') ?? '').split(',').filter(Boolean).length, 0)

// ---------- 1. A first open is Lite ----------
let liteOpen, fullOpen
{
  const { ctx, page, done, net, t0, toTemp } = await openApp()
  await settle(page, openWindowMs)
  const st = await page.evaluate(() => ({ mode: window.__store.get().mode, saved: localStorage.getItem('stormscope.mode'), lite: !!document.querySelector('.app.lite'), home: !!document.querySelector('.lite-home'), mapRoot: !!document.querySelector('.map-root'), map: !!window.__map, liteMap: !!window.__liteMap }))
  check('A first open (nothing saved) is Lite: the Lite home, no full map mounted, no map handle', st.mode === 'lite' && st.saved === null && st.lite && st.home && !st.mapRoot && !st.map && st.liteMap, st)

  const opened = net.since(t0)
  const hosts = net.byHost(t0)
  liteOpen = { hosts, total: opened.length, om: omLocations(opened), toTemp }
  check('Lite on open asks for no radar, satellite, gauges, air monitors, drainage or terrain', !opened.some((x) => HEAVY.test(x.url) || x.host.startsWith('api/sites')), hosts)
  check('Lite on open: one Open-Meteo location (the place forecast), NWS for alerts + station, the basemap', liteOpen.om === 1 && (hosts['api.weather.gov'] ?? 0) >= 2 && (hosts['tiles.openfreemap.org'] ?? 0) >= 1, { om: liteOpen.om, hosts })

  // ---------- 2. The home ----------
  const home = await page.evaluate(() => {
    const kids = [...document.querySelector('.lite-home').children].map((e) => e.className.split(' ').find((c) => /status-row|conditions|now-summary|hourly|daily|lite-rain|lite-map|lite-more|lite-foot|now-head/.test(c)) ?? e.className)
    const lm = window.__liteMap
    return {
      order: kids,
      obs: document.querySelector('.cond-observed')?.innerText ?? '',
      hours: document.querySelectorAll('.hour-strip li').length,
      spanSwitch: !!document.querySelector('.span-switch'),
      playLink: !!document.querySelector('[data-rain-span]'),
      days: document.querySelectorAll('.day-rows li').length,
      rain: document.querySelector('.lite-rain')?.innerText ?? '',
      sources: lm ? Object.keys(lm.getStyle().sources) : [],
      drag: lm ? lm.dragPan.isEnabled() : null,
      zoomCtl: !!document.querySelector('.lite-map .maplibregl-ctrl-zoom-in'),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }
  })
  const want = ['now-head', 'status-row', 'conditions', 'now-summary', 'hourly', 'daily', 'lite-rain', 'lite-map', 'lite-more', 'lite-foot']
  check('Lite home order: place, status row, headline, summary, 12 hours, 7 days, rain 24 h, map, More row, footer', want.every((c, i) => home.order.indexOf(c) > (i ? home.order.indexOf(want[i - 1]) : -1)), home.order)
  check('The headline keeps its labelled station observation ("Measured … at …")', /^Measured .+ at /.test(home.obs), home.obs)
  check('12 hours, no span switch and no "play on map"; 7 days; rain next 24 h', home.hours === 12 && !home.spanSwitch && !home.playLink && home.days === 7 && /Rain next 24 h[\s\S]*Total expected/i.test(home.rain), { hours: home.hours, spanSwitch: home.spanSwitch, playLink: home.playLink, days: home.days, rain: oneLine(home.rain) })
  check('The small map: basemap sources only (no radar, no terrain), not draggable, no controls', home.sources.length > 0 && !home.sources.some((s) => /radar|sat|terrain|rain|flood|gauge|monitor/i.test(s)) && home.drag === false && !home.zoomCtl, { sources: home.sources, drag: home.drag })
  check('Nothing overflows at 390 px', home.overflow <= 0, home.overflow)
  await page.screenshot({ path: `${OUT}/lite-home.png`, fullPage: false })
  await page.locator('.lite-more').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${OUT}/lite-home-bottom.png` })

  // ---------- 3. The More row ----------
  const tMore = Date.now()
  await page.getByRole('button', { name: /More: Rivers \/ Flood \/ Trip \/ Air/ }).click()
  await settle(page, 1500)
  const rows = await page.locator('.lite-blocks li').evaluateAll((ls) => ls.map((l) => ({ id: l.dataset.block, btn: l.querySelector('button')?.innerText, h: Math.round(l.querySelector('button').getBoundingClientRect().height) })))
  check('Opening the More row shows Rivers, Flood, Trip and Air, each with Load (≥ 40 px), and asks for nothing', rows.map((r) => r.id).join() === 'rivers,flood,trip,air' && rows.every((r) => r.btn === 'Load' && r.h >= 40) && net.since(tMore).length === 0, { rows, requests: net.since(tMore).length })
  await page.screenshot({ path: `${OUT}/lite-more.png` })

  const tRivers = Date.now()
  await page.getByRole('button', { name: 'Load Rivers' }).click()
  const riversShown = await until(page, () => !!document.querySelector('.lite-block[data-block="rivers"]') && window.__store.get().rivers.state === 'ready', 20000)
  await settle(page, 800)
  const rReq = net.byHost(tRivers)
  check('Load Rivers asks for the gauges only (NOAA / USGS) and shows them on the Lite home', riversShown && (rReq['api.water.noaa.gov'] ?? 0) > 0 && !Object.keys(rReq).some((h) => /rainviewer|gibs|monitors|api\/sites/.test(h)), rReq)
  await page.screenshot({ path: `${OUT}/lite-rivers.png` })
  await page.getByRole('button', { name: 'Hide Rivers' }).click()
  await settle(page, 400)
  check('Hide Rivers takes the block off the home', !(await page.locator('.lite-block[data-block="rivers"]').count()))

  const tAir = Date.now()
  await page.getByRole('button', { name: 'Load Air quality' }).click()
  const airShown = await until(page, () => window.__store.get().monitorsNear.state === 'ready' && !!document.querySelector('.lite-home .airnow'), 20000)
  const aReq = net.byHost(tAir)
  check('Load Air quality asks for the air monitors and shows the measured lines', airShown && Object.keys(aReq).some((h) => /monitors|api\/sites/.test(h)), aReq)

  // ---------- 4. One-time look ----------
  await page.getByRole('button', { name: /^Full: a one-time look/ }).click()
  const mounted = await until(page, () => !!window.__map && !!document.querySelector('.map-root'), 10000)
  const look = await page.evaluate(() => ({ peek: window.__store.get().fullPeek, mode: window.__store.get().mode, saved: localStorage.getItem('stormscope.mode'), banner: document.querySelector('.banner.peek')?.innerText ?? '' }))
  check('"Full ›" is a one-time look: the map mounts, the saved mode stays Lite, Now says so', mounted && look.peek === 'look' && look.mode === 'lite' && look.saved !== 'full' && /looking at Full once[\s\S]*Back to Lite/i.test(look.banner), look)
  await page.screenshot({ path: `${OUT}/lite-peek.png` })
  await page.getByRole('button', { name: 'Back to Lite' }).click()
  const back = await until(page, () => !window.__map && !document.querySelector('.map-root') && !!document.querySelector('.lite-home'), 5000)
  check('"Back to Lite" unmounts the map and returns to the Lite home', back)

  const mapBtn = page.getByRole('button', { name: /^Open full map/ })
  const tag = await mapBtn.evaluate((b) => b.tagName)
  await mapBtn.click()
  const mapLook = await until(page, () => !!window.__map && window.__store.get().screen === 'map' && window.__store.get().fullPeek === 'look', 10000)
  check('The small map is a real <button>; tapping it opens Full\'s map as a one-time look', tag === 'BUTTON' && mapLook, tag)
  await page.getByRole('button', { name: /^Now/ }).click()
  await page.getByRole('button', { name: 'Back to Lite' }).click()
  await until(page, () => !!document.querySelector('.lite-home'), 5000)

  await page.getByRole('button', { name: 'Map', exact: true }).click()
  const navLook = await until(page, () => !!window.__map && window.__store.get().screen === 'map' && window.__store.get().fullPeek === 'look', 10000)
  check("The nav's Map in Lite opens Full's map as a one-time look (mode still Lite)", navLook && (await page.evaluate(() => window.__store.get().mode)) === 'lite')
  await page.getByRole('button', { name: /^Now/ }).click()
  await page.getByRole('button', { name: 'Back to Lite' }).click()
  await settle(page, 500)

  // ---------- 5. Settings > Mode ----------
  await openMore(page, 'Sources, freshness & settings')
  const radios = await page.locator('.mode-option').evaluateAll((bs) => bs.map((b) => ({ id: b.dataset.mode, checked: b.getAttribute('aria-checked'), text: b.innerText, h: Math.round(b.getBoundingClientRect().height) })))
  check('Settings > Mode: two options, "Lite (default)" checked, "Full" not, each ≥ 44 px', radios.length === 2 && radios[0].checked === 'true' && /Lite \(default\)/.test(radios[0].text) && radios[1].checked === 'false' && radios[1].text.startsWith('Full') && radios.every((r) => r.h >= 44), radios)
  await page.screenshot({ path: `${OUT}/lite-settings.png` })
  const tFull = Date.now()
  await page.getByRole('radio', { name: /^Full/ }).click()
  const fullOn = await until(page, () => localStorage.getItem('stormscope.mode') === 'full' && !!window.__map && !document.querySelector('.app.lite'), 10000)
  const radarAsked = await until(page, () => window.__store.get().radar.state === 'ready', 15000)
  check('Choosing Full saves it at once and loads the map and radar', fullOn && radarAsked && Object.keys(net.byHost(tFull)).some((h) => /rainviewer/.test(h)), net.byHost(tFull))
  await page.reload({ waitUntil: 'load' })
  const keptFull = await until(page, () => window.__store?.get().mode === 'full' && !!window.__map, 15000)
  check('Full survives a reload', keptFull)
  await openMore(page, 'Sources, freshness & settings')
  await page.getByRole('radio', { name: /^Lite/ }).click()
  const liteAgain = await until(page, () => localStorage.getItem('stormscope.mode') === 'lite' && !window.__map && !document.querySelector('.map-root') && window.__store.get().screen === 'now' && !!document.querySelector('.lite-home'), 8000)
  check('Choosing Lite saves it at once, unloads the map and returns to the Lite home', liteAgain, await page.evaluate(() => ({ saved: localStorage.getItem('stormscope.mode'), map: !!window.__map, screen: window.__store.get().screen })))
  await done()
  await ctx.close()
}

// ---------- 6. Full's open, counted the same way ----------
{
  const { ctx, page, done, net, t0, toTemp } = await openApp({ mode: 'full' })
  await settle(page, openWindowMs)
  const opened = net.since(t0)
  fullOpen = { hosts: net.byHost(t0), total: opened.length, om: omLocations(opened), toTemp }
  check('Full on open (same window) makes more requests than Lite and includes radar', fullOpen.total > liteOpen.total && Object.keys(fullOpen.hosts).some((h) => /rainviewer/.test(h)), { lite: liteOpen.total, full: fullOpen.total })
  await done()
  await ctx.close()
}

// ---------- 7. Desktop width ----------
{
  const { ctx, page, done } = await openApp({ viewport: { width: 1280, height: 800 } })
  await settle(page, 1000)
  const d = await page.evaluate(() => {
    const a = document.querySelector('.app').getBoundingClientRect()
    const n = document.querySelector('.nav').getBoundingClientRect()
    return { lite: !!document.querySelector('.app.lite'), narrow: !!document.querySelector('.app.narrow'), left: Math.round(a.left), width: Math.round(a.width), navBottom: Math.round(n.bottom), navWidth: Math.round(n.width), map: !!window.__map }
  })
  check('1280 × 800: Lite is one centred column (≤ 600 px) with the bottom nav inside its 1 px borders, no full map', d.lite && d.narrow && d.width <= 600 && Math.abs(d.left - (1280 - d.width) / 2) <= 1 && d.navBottom === 800 && d.navWidth >= d.width - 2 && !d.map, d)
  await page.screenshot({ path: `${OUT}/lite-desktop.png` })
  await done()
  await ctx.close()
}

console.log(`requests in the first ${openWindowMs / 1000} s after the place's data (mocked, headless; counts, not timings):`)
console.log(`  Lite: ${liteOpen.total} requests, ${liteOpen.om} Open-Meteo location(s) · ${JSON.stringify(liteOpen.hosts)}`)
console.log(`  Full: ${fullOpen.total} requests, ${fullOpen.om} Open-Meteo location(s) · ${JSON.stringify(fullOpen.hosts)}`)
await browser.close()
finish()
