// Shared navigation helpers for the suites (conditions-first shell: Now / Map / Trip / More).
export const settle = (page, ms = 400) => page.waitForTimeout(ms)

/** First-run prompt (only shown when the browser has not already granted location). */
export const allowLocation = (page, timeout = 4000) => page.getByRole('dialog').getByRole('button', { name: 'Use my location' }).click({ timeout }).catch(() => {})

export const openNow = async (page) => { await page.getByRole('button', { name: /^Now/ }).click(); await settle(page) }
export const openMap = async (page) => { await page.getByRole('button', { name: 'Map', exact: true }).click(); await settle(page, 600) }
export const openTrip = async (page) => { await page.getByRole('button', { name: 'Trip', exact: true }).click(); await settle(page) }
/** More → a page: 'Flood risk' | 'Rivers & gauges' | 'Station observations' | 'Sources, freshness & settings'. */
export const openMore = async (page, title) => {
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await settle(page, 250)
  const back = page.getByRole('button', { name: 'Back to More' })
  if (await back.count()) { await back.click(); await settle(page, 200) }
  if (title) {
    await page.getByRole('button', { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).click()
    await settle(page, 500)
  }
}
/** More → Rivers & gauges, then wait for the full tier (thresholds + USGS sites) — gauges load only when something shows them. */
export const openRivers = async (page, timeout = 30000) => {
  await openMore(page, 'Rivers & gauges')
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const ok = await page.evaluate(() => { const s = window.__store.get(); return (s.rivers.state === 'ready' && s.riversTier === 'full') || s.rivers.state === 'error' || !!s.rivers.error }).catch(() => false)
    if (ok) break
    await page.waitForTimeout(250)
  }
  await settle(page, 300)
}
export const pageText = (page) => page.locator('.page-body').innerText()
export const tripText = (page) => page.locator('.screen.trip').innerText()
export const sheetText = (page) => page.locator('.sheet-body').innerText()
export const setSheet = async (page, mode) => { await page.evaluate((m) => window.__store.set({ sheet: m }), mode); await settle(page, 450) }
export const setLayers = async (page, patch) => { await page.evaluate((p) => window.__store.set((s) => ({ layers: { ...s.layers, ...p } })), patch); await settle(page, 300) }
/** Units via More → Settings. */
export const setUnits = async (page, which) => { await openMore(page, 'Sources, freshness & settings'); await page.getByRole('radio', { name: new RegExp(which) }).click(); await settle(page, 200) }
/** Open the place picker from whatever screen shows a place row / chip, then search. */
export const searchPlace = async (page, query) => {
  await page.getByRole('button', { name: 'Change place' }).first().click()
  await settle(page, 300)
  const search = page.getByRole('button', { name: /Search for a place/ })
  if (await search.count()) await search.click()
  await page.getByRole('dialog').getByRole('searchbox').fill(query)
}
