// First visit (fresh profile: no saved place, empty storage, location not yet granted), mocked only:
// exactly one "Where are you?" prompt is visible on a phone and on a desktop (the dialog), the Now column's
// own card only after the dialog is dismissed. Later rounds add the forget-my-location and default-units checks.
//   node scripts/firstrun-check.mjs [base-url] [shots-dir] [--mock]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { assertBudget, trackTraffic } from './lib/qa-budget.mjs'
import { installMocks } from './lib/mock-server.mjs'

const argv = process.argv.slice(2)
const MOCK = argv.includes('--mock')
if (!MOCK) {
  console.log('SKIP  firstrun-check.mjs: mocked only (fresh profiles, no live data needed)')
  process.exit(3)
}
assertBudget('firstrun-check.mjs (mock)')
const positional = argv.filter((a) => !a.startsWith('--'))
const BASE = positional[0] || 'http://localhost:4173/'
const OUT = positional[1] || 'e2e-shots/firstrun'
mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, ev = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ev ? '  — ' + ev : ''}`)
}
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const VIEWPORTS = { phone: { width: 390, height: 844, isMobile: true, hasTouch: true }, desktop: { width: 1366, height: 800, isMobile: false, hasTouch: false } }
/** Visible "Where are you?" headings and where each one lives. */
const prompts = (page) => page.evaluate(() => [...document.querySelectorAll('h1, h2, h3')].filter((h) => h.textContent.trim() === 'Where are you?' && h.getClientRects().length > 0 && getComputedStyle(h).visibility !== 'hidden').map((h) => (h.closest('[role=dialog]') ? 'dialog' : h.closest('.screen.now') ? 'now-column' : 'elsewhere')))

// ---- 1. One prompt only on a first visit ----
for (const [name, vp] of Object.entries(VIEWPORTS)) {
  // A fresh browser profile: no storage, geolocation permission not yet decided (the browser would ask).
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch })
  const page = await ctx.newPage()
  const done = trackTraffic(page, `firstrun-check.mjs ${name} (mock)`)
  await installMocks(ctx, {})
  await page.goto(BASE, { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  const first = await prompts(page)
  check(`[${name}] first visit: exactly one "Where are you?" prompt is visible, and it is the dialog`, first.length === 1 && first[0] === 'dialog', `visible: ${JSON.stringify(first)}`)
  await page.screenshot({ path: `${OUT}/${name}-first-visit.png` })
  // Dismiss it by choosing Search, then close the picker: the Now column's own card is now the one prompt.
  await page.getByRole('dialog').getByRole('button', { name: 'Search for a place' }).click()
  await page.waitForTimeout(400)
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await page.waitForTimeout(400)
  const after = await prompts(page)
  check(`[${name}] after dismissing the dialog without a place: the Now column's card is the one prompt`, after.length === 1 && after[0] === 'now-column', `visible: ${JSON.stringify(after)}`)
  done()
  await ctx.close()
}

await browser.close()
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
