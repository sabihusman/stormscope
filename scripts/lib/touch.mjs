// Real touch input for Playwright/Chromium via CDP (Input.dispatchTouchEvent): touchstart →
// touchmove… → touchend, the sequence a finger produces. Playwright's mouse/pointer helpers do not
// exercise touch-action, pointercancel or scroll-vs-drag arbitration, so phone bugs hide from them.
const isChromium = (page) => page.context().browser()?.browserType().name() === 'chromium'

/**
 * WebKit has no CDP, so drags are synthesized in-page: pointer + touch events dispatched on the
 * element under the finger. This exercises the app's own handlers but NOT the engine's gesture
 * arbitration (touch-action, scroll-vs-drag, pointercancel) — see the report for what that leaves out.
 */
async function syntheticDrag(page, from, to, { steps = 12, settleMs = 150 } = {}) {
  await page.evaluate(async ({ from, to, steps, settleMs }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const at = (x, y) => document.elementFromPoint(x, y) ?? document.body
    const target = at(from.x, from.y)
    const makeTouch = (el, x, y) => {
      try {
        return new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y, radiusX: 2, radiusY: 2, force: 1 })
      } catch {
        return document.createTouch(window, el, 1, x, y, x, y) // WebKit: no Touch constructor, legacy factory instead
      }
    }
    const list = (arr) => (typeof document.createTouchList === 'function' ? document.createTouchList(...arr) : arr)
    const touch = (type, el, x, y) => {
      const t = makeTouch(el, x, y)
      const active = type === 'touchend' ? [] : [t]
      el.dispatchEvent(new TouchEvent(type, { touches: list(active), targetTouches: list(active), changedTouches: list([t]), bubbles: true, cancelable: true, composed: true }))
    }
    const pointer = (type, el, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true, buttons: type === 'pointerup' ? 0 : 1 }))
    pointer('pointerdown', target, from.x, from.y)
    touch('touchstart', target, from.x, from.y)
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps
      const y = from.y + ((to.y - from.y) * i) / steps
      pointer('pointermove', target, x, y)
      touch('touchmove', target, x, y)
      await sleep(16)
    }
    await sleep(settleMs)
    pointer('pointerup', at(to.x, to.y), to.x, to.y)
    touch('touchend', target, to.x, to.y)
  }, { from, to, steps, settleMs })
}

export async function touchDrag(page, from, to, { steps = 12, holdMs = 0, settleMs = 150 } = {}) {
  if (!isChromium(page)) return syntheticDrag(page, from, to, { steps, settleMs })
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
  if (!isChromium(page)) return page.touchscreen.tap(x, y) // real touch input in WebKit/Firefox
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
