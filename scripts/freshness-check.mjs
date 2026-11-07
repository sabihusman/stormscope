// The status row at the top of Now (Nov 6 audit: "No active NWS alerts · checked 2 min ago" was a line of small text,
// and a "checked X ago" must never contradict the cards), at a real 390 × 844, mocked only:
//  • with no alerts, the first thing on Now is a tappable row (at least 44 px tall): "No active NWS alerts · checked …"
//    and "Everything on Now checked within the last N min";
//  • N is the oldest check: with the sources set to known ages (1–7.7 min) it says 8 min, and no "checked / updated /
//    fetched … ago" on Now, on Sources & freshness or in More reads older;
//  • it holds across a tick of the shared clock;
//  • a source whose refresh failed is named; the row opens Sources & freshness, which lists alerts, the place's
//    forecast and the air monitors as well; More's row shows the same line;
//  • with an active alert, the alert is the first thing on Now, full width, and the row follows it.
//   node scripts/freshness-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation, openMore, openNow, settle } from './lib/ui.mjs'
import { checker, mockedOnly, oneLine, until } from './lib/check-kit.mjs'

const { base: BASE, out: OUT } = mockedOnly('freshness-check.mjs', 'e2e-shots/freshness')
const { check, finish } = checker()
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

async function openApp(mockOpts) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'], locale: 'en-US' })
  const page = await ctx.newPage()
  const done = trackTraffic(page, 'freshness-check.mjs (mock)')
  await installMocks(ctx, mockOpts)
  await page.goto(BASE, { waitUntil: 'load' })
  await allowLocation(page)
  await page.waitForFunction(() => { const s = window.__store?.get(); return s && s.conditions.state === 'ready' && s.alerts.state === 'ready' && s.station.state === 'ready' }, null, { timeout: 30000 })
  await settle(page, 1500)
  await openNow(page)
  return { ctx, page, done }
}

/** Every check age ("checked / updated / fetched … N min ago", "just now" = 0) in a text, in minutes. */
const checkAges = (text) => [...text.matchAll(/(?:checked|updated|fetched) (just now|(\d+)s ago|(\d+) min ago|(\d+) h ago)/g)].map((m) => (m[1] === 'just now' ? 0 : m[2] ? Number(m[2]) / 60 : m[3] ? Number(m[3]) : Number(m[4]) * 60))
const rowWithin = (text) => { const m = text.match(/Everything on Now checked (just now|within the last (\d+)s|within the last (\d+) min|within the last (\d+) h)/); return !m ? null : m[1] === 'just now' ? 0 : m[2] ? Number(m[2]) / 60 : m[3] ? Number(m[3]) : Number(m[4]) * 60 }

{
  const { ctx, page, done } = await openApp({})

  // 1. The row
  const first = await page.evaluate(() => {
    const kids = [...document.querySelector('.screen.now').children].filter((e) => !e.classList.contains('now-head') && !e.classList.contains('banner'))
    const row = document.querySelector('.status-row')
    const r = row?.getBoundingClientRect()
    return { first: kids[0]?.className ?? '', tag: row?.tagName, h: r && Math.round(r.height), w: r && Math.round(r.width), text: row?.innerText ?? '' }
  })
  check('No alerts: the first card on Now is the status row, a full-width button at least 44 px tall', /status-row/.test(first.first) && first.tag === 'BUTTON' && first.h >= 44 && first.w >= 350, first)
  check('It reads "No active NWS alerts · checked …" and "Everything on Now checked …"', /No active NWS alerts · checked (just now|\d+)/.test(first.text) && rowWithin(first.text) != null, oneLine(first.text))
  await page.screenshot({ path: `${OUT}/row.png` })

  // 2. Known ages: the oldest (station, 7 min 40 s) sets the row; nothing on Now may read older.
  const AGES = { alerts: 60, conditions: 4 * 60 + 20, station: 7 * 60 + 40, monitorsNear: 2 * 60, rivers: 3 * 60 }
  await page.evaluate((ages) => {
    const s = window.__store.get()
    const patch = {}
    for (const [k, sec] of Object.entries(ages)) if (s[k]?.freshness) patch[k] = { ...s[k], freshness: { ...s[k].freshness, fetchedAt: Date.now() - sec * 1000 } }
    window.__store.set(patch)
  }, AGES)
  // The shared clock moves on its next tick (≤ 15 s); read once it has.
  await page.waitForTimeout(16000)
  const present = await page.evaluate((keys) => keys.filter((k) => window.__store.get()[k]?.data != null && window.__store.get()[k]?.freshness), Object.keys(AGES))
  const nowText = await page.locator('.screen.now').innerText()
  const within = rowWithin(nowText)
  const ages = checkAges(nowText)
  check('With the sources checked 1–7.7 min ago, the row says "within the last 8 min" (the oldest: the station)', within === 8 && present.includes('station'), { within, present })
  check('No check time on Now reads older than the row (alerts, the forecast\'s "updated", the air monitors\' "fetched")', ages.length >= 3 && ages.every((a) => a <= within), { ages, within })

  // 3. Across clock ticks the row and the cards move together.
  let worst = null
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(16000)
    const t = await page.locator('.screen.now').innerText()
    const w = rowWithin(t)
    const over = checkAges(t).filter((a) => a > w)
    if (over.length) worst = { tick: i, within: w, over }
  }
  check('Over four ticks of the shared clock (about a minute), no card ever reads older than the row', worst == null, worst)

  // 4. A failed refresh is named.
  await page.evaluate(() => { const s = window.__store.get(); window.__store.set({ station: { ...s.station, error: 'HTTP 503' } }) })
  await settle(page, 300)
  const failed = oneLine(await page.locator('.status-row').innerText())
  check('A source whose last refresh failed is named in the row ("station: last refresh failed")', /station: last refresh failed/.test(failed), failed)
  await page.evaluate(() => { const s = window.__store.get(); window.__store.set({ station: { ...s.station, error: null } }) })
  await settle(page, 300)

  // 5. The row opens Sources & freshness, which lists what Now shows, none older than the row.
  const rowNow = rowWithin(await page.locator('.status-row').innerText())
  await page.locator('.status-row').tap()
  await settle(page, 600)
  const src = await page.evaluate(() => ({ title: document.querySelector('.screen.more h2')?.textContent ?? '', text: document.querySelector('.page-body')?.innerText ?? '' }))
  const named = ['NWS alerts', 'Forecast for the place (Now)', 'Station', 'Air monitors near the place', 'River gauges'].filter((n) => !src.text.includes(n))
  const srcAges = src.text.split('\n').filter((l, i, all) => /^(NWS alerts|Forecast for the place|Station|Air monitors near|River gauges)/.test(all[i - 1] ?? '')).flatMap(checkAges)
  check('Tapping the row opens Sources & freshness, which lists NWS alerts, the place\'s forecast, the station, the air monitors and the gauges', /Sources, freshness/.test(src.title) && named.length === 0, { title: src.title, missing: named })
  check('On that page, none of those rows was fetched longer ago than the row says', srcAges.length >= 3 && srcAges.every((a) => a <= rowNow), { srcAges, row: rowNow })
  await page.screenshot({ path: `${OUT}/sources.png` })

  // 6. More's row shows the same line.
  await openMore(page)
  const more = oneLine(await page.locator('.more-row', { hasText: 'Sources, freshness' }).innerText())
  await openNow(page)
  const nowLine = (await page.locator('.status-row .status-checked').innerText()).trim()
  check('More → "Sources, freshness & settings" shows the same "Everything on Now checked …" line as the row', more.includes(nowLine), { more, now: nowLine })
  done()
  await ctx.close()
}

// 7. With an active alert: the alert first, full width, then the row.
{
  const { ctx, page, done } = await openApp({ alerts: [{ event: 'Flood Warning', severity: 'Severe' }] })
  const order = await page.evaluate(() => {
    const kids = [...document.querySelector('.screen.now').children].filter((e) => !e.classList.contains('now-head') && !e.classList.contains('banner'))
    const region = kids[0]
    const alert = region?.querySelector('.alert')
    const row = region?.querySelector('.status-row')
    const a = alert?.getBoundingClientRect()
    const rr = row?.getBoundingClientRect(); const icon = row?.querySelector('.status-icon')?.getBoundingClientRect()
    return { first: region?.className ?? '', alertW: a && Math.round(a.width), iconInset: rr && icon && Math.round(icon.left - rr.left), alertText: alert?.querySelector('summary')?.textContent ?? '', rowAfter: !!(alert && row && (alert.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)), row: row?.innerText ?? '', top: a && Math.round(a.top) }
  })
  check('An active alert is the first thing on Now, full width, and the status row follows it ("1 active NWS alert · checked …", "Everything on Now checked …")', /now-alerts/.test(order.first) && /Flood Warning/.test(order.alertText) && order.alertW >= 350 && order.iconInset >= 10 && order.rowAfter && /1 active NWS alert · checked/.test(order.row) && rowWithin(order.row) != null, { ...order, row: oneLine(order.row) })
  await page.screenshot({ path: `${OUT}/alert.png` })
  done()
  await ctx.close()
}

await browser.close()
finish()
