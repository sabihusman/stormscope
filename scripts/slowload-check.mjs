// A first load on a slow forecast service, mocked only — Open-Meteo's answer is held 14 s: the conditions card
// shows its skeletons, and about 10 s after the page opened says it is still waiting for Open-Meteo with a Retry; once the answer lands
// the card renders and the note goes.
//   node scripts/slowload-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'
import { allowLocation } from './lib/ui.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  slowload-check.mjs: mocked only (a held forecast answer)')
  process.exit(3)
}
assertBudget('slowload-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/slowload'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const HOLD = 14_000
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: 41.673, longitude: -93.698 }, permissions: ['geolocation'] })
const page = await ctx.newPage()
const done = trackTraffic(page, 'slowload-check.mjs (mock)')
await installMocks(ctx, { delayHosts: { 'api.open-meteo.com': HOLD } })
const t0 = Date.now()
await page.goto(BASE, { waitUntil: 'load' })
await allowLocation(page)
const until = async (fn, ms) => { const s = Date.now(); while (Date.now() - s < ms) { if (await page.evaluate(fn).catch(() => false)) return true; await page.waitForTimeout(150) } return false }
const note = () => page.locator('.conditions .slow-note').innerText().catch(() => '')
// Poll from the page open: skeletons without a note first, the note at about 10 s.
let skeletonsFirst = false
let shown = false
let tNote = 0
while (Date.now() - t0 < 14000) {
  const s = await page.evaluate(() => ({ skel: document.querySelectorAll('.conditions .skeleton').length, note: !!document.querySelector('.conditions .slow-note') })).catch(() => ({ skel: 0, note: false }))
  if (s.note) { shown = true; tNote = Date.now() - t0; break }
  if (s.skel > 0) skeletonsFirst = true
  await page.waitForTimeout(150)
}
check('Skeletons show first, without the note', skeletonsFirst, '')
check(`After about 10 s the card says it is still waiting for Open-Meteo, with a Retry (${(tNote / 1000).toFixed(1)} s)`, shown && /Still waiting for the forecast service \(Open-Meteo\)/.test(await note()) && (await page.locator('.conditions .slow-note button', { hasText: 'Retry' }).count()) === 1 && tNote >= 9000 && tNote <= 13000, `"${await note()}"`)
await page.screenshot({ path: `${OUT}/waiting.png` })
const landed = await until(() => window.__store.get().conditions.state === 'ready', HOLD + 10000)
await page.waitForTimeout(300)
check('Once the forecast lands the card renders the temperature and the note goes', landed && (await page.locator('.conditions .cond-temp').count()) === 1 && (await note()) === '', `temp "${await page.locator('.conditions .cond-temp').innerText().catch(() => '')}"`)
await page.screenshot({ path: `${OUT}/landed.png` })
done()
await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
