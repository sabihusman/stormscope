// Headless walkthrough of the app: grants a mock location, enables every layer,
// opens each panel, and screenshots along the way. Reports console errors.
import { chromium } from 'playwright'
import { assertBudget, trackOpenMeteo } from './lib/qa-budget.mjs'
assertBudget('e2e.mjs')
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] || 'http://localhost:5173/'
const OUT = process.argv[3] || 'shots'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  geolocation: { latitude: 39.9526, longitude: -75.1652 }, // Philadelphia (US: NWS + USGS + NHD coverage)
  permissions: ['geolocation'],
})
const page = await ctx.newPage()
const __recordBudget = trackOpenMeteo(page, 'e2e.mjs')
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`)
})
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`))

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}
const waitMapIdle = async (ms = 8000) => {
  await page.waitForFunction(() => window.__map && window.__map.loaded(), null, { timeout: ms }).catch(() => {})
  await page.waitForTimeout(600)
}

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
await shot('01-first-run')

await page.getByRole('button', { name: 'Allow location' }).click({ timeout: 4000 }).catch(() => {})
await page.waitForTimeout(4000)
await waitMapIdle(15000)
await shot('02-located-radar')

// Open the sheet → timeline, press play, step.
await page.getByRole('tab', { name: 'Timeline' }).click()
await page.waitForTimeout(500)
await shot('03-timeline')
await page.getByRole('button', { name: 'Play' }).click()
await page.waitForTimeout(1500)
await page.getByRole('button', { name: 'Pause' }).click()

// Station panel
await page.getByRole('tab', { name: 'Station' }).click()
await page.waitForTimeout(2500)
await shot('04-station')

// Rivers panel
await page.getByRole('tab', { name: 'Rivers' }).click()
await page.waitForTimeout(6000)
await shot('05-rivers')

// Enable all layers via FAB.
await page.getByRole('button', { name: 'Open layer menu' }).click()
await page.waitForTimeout(300)
await shot('06-layer-menu')
for (const name of ['Rainfall', 'Flood risk', 'Nowcast']) {
  await page.getByRole('button', { name }).click()
  await page.waitForTimeout(350)
}
await page.getByRole('button', { name: /3D terrain/ }).click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: 'Close layer menu' }).click()
await page.waitForTimeout(12000)
await waitMapIdle(20000)
await shot('07-all-layers-3d')

// Timeline for rainfall + nowcast
await page.getByRole('tab', { name: 'Timeline' }).click()
await page.waitForTimeout(500)
const rainTab = page.getByRole('tab', { name: 'Rainfall' })
if (await rainTab.count()) {
  await rainTab.click()
  await page.waitForTimeout(500)
  await page.getByRole('radio', { name: '48 h' }).click()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: 'Next frame' }).click()
  await page.getByRole('button', { name: 'Next frame' }).click()
  await page.waitForTimeout(600)
  await shot('08-rainfall-timeline')
}
const nowTab = page.getByRole('tab', { name: 'Nowcast' })
if (await nowTab.count()) {
  await nowTab.click()
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: 'Play' }).click()
  await page.waitForTimeout(2500)
  await shot('09-nowcast-playing')
  await page.getByRole('button', { name: 'Pause' }).click()
}

// Flood panel + sources
await page.getByRole('tab', { name: 'Flood' }).click()
await page.waitForTimeout(500)
await shot('10-flood-panel')
await page.getByRole('tab', { name: 'Sources' }).click()
await page.waitForTimeout(500)
await shot('11-sources')

// Collapse the sheet, tap a gauge on the map (first river marker).
await page.getByRole('button', { name: 'Collapse panel' }).click()
await page.waitForTimeout(500)
const tapped = await page.evaluate(() => {
  const m = window.__map
  const feats = m.queryRenderedFeatures({ layers: ['river-gauges'] })
  // Pick a marker that isn't hidden under the legend / top bar / sheet.
  for (const f of feats) {
    const [lng, lat] = f.geometry.coordinates
    const p = m.project([lng, lat])
    if (p.x > 40 && p.x < 300 && p.y > 420 && p.y < 700) return { x: p.x, y: p.y }
  }
  return null
})
if (tapped) {
  await page.mouse.click(tapped.x, tapped.y)
  await page.waitForTimeout(800)
  await shot('12-gauge-popup')
}
// Tap near the corner of the map to test popup clamping.
await page.mouse.click(8, 120)
await page.waitForTimeout(600)
await shot('13-corner-popup')

// Search flow (non-US location → Open-Meteo fallback).
await page.getByRole('button', { name: 'Close popup' }).click().catch(() => {})
await page.getByRole('button', { name: 'Change location' }).click()
await page.getByRole('searchbox').fill('Manchester')
await page.waitForTimeout(2500)
await shot('14-search')
await page.getByRole('option').first().click()
await page.waitForTimeout(6000)
await waitMapIdle(15000)
await page.getByRole('tab', { name: 'Station' }).click()
await page.waitForTimeout(2000)
await shot('15-nonus-station')
await page.getByRole('tab', { name: 'Rivers' }).click()
await page.waitForTimeout(800)
await shot('16-nonus-rivers')

const state = await page.evaluate(() => {
  const m = window.__map
  return { layers: m.getStyle().layers.map((l) => l.id).filter((id) => !/^(water|land|building|road|place|poi|boundary|park|aero|transit|housenum|highway|railway|tunnel|bridge|ferry|admin|landuse|landcover|mountain|natural|ocean|background)/.test(id)), terrain: !!m.getTerrain(), pitch: m.getPitch() }
})
console.log('STATE', JSON.stringify(state, null, 1))
console.log('ERRORS', errors.length)
for (const e of errors.slice(0, 40)) console.log(' ', e.slice(0, 300))
__recordBudget()
await browser.close()
