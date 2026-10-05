// Real touch input for Playwright/Chromium via CDP (Input.dispatchTouchEvent): touchstart →
// touchmove… → touchend, the sequence a finger produces. Playwright's mouse/pointer helpers do not
// exercise touch-action, pointercancel or scroll-vs-drag arbitration, so phone bugs hide from them.
export async function touchDrag(page, from, to, { steps = 12, holdMs = 0, settleMs = 150 } = {}) {
  const cdp = await page.context().newCDPSession(page)
  const pt = (x, y) => ({ x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(from.x, from.y)] })
  if (holdMs) await page.waitForTimeout(holdMs)
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps
    const y = from.y + ((to.y - from.y) * i) / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(x, y)] })
    await page.waitForTimeout(16)
  }
  // Rest the finger before lifting: lifting mid-motion is a fling, and Chromium (like a real
  // phone) consumes the *next* tap as "stop the fling" without a click.
  if (settleMs) await page.waitForTimeout(settleMs)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

export async function touchTap(page, { x, y }) {
  const cdp = await page.context().newCDPSession(page)
  const p = { x, y, radiusX: 2, radiusY: 2, force: 1, id: 1 }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] })
  await page.waitForTimeout(40)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

/** Centre of an element's bounding box, or null when it has no box. */
export async function centre(locator) {
  const b = await locator.boundingBox()
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b } : null
}
