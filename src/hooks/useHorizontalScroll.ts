import { useEffect, type RefObject } from 'react'

/**
 * Makes a sideways strip scrollable with a mouse: the wheel (its vertical delta becomes horizontal scroll
 * while the pointer is over the strip, so the page does not scroll instead) and click-and-drag. Touch
 * scrolling is the browser's own and is left alone. Listeners run only on wheel and pointer events over
 * the strip — nothing per frame.
 */
export function useHorizontalScroll(ref: RefObject<HTMLElement | null>, present = true) {
  // `present` re-runs the effect when the strip appears (it is not rendered until the data is in).
  useEffect(() => {
    const el = ref.current
    if (!el || !present) return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return // a sideways wheel / trackpad already scrolls sideways
      if (el.scrollWidth <= el.clientWidth) return
      el.scrollLeft += e.deltaY
      e.preventDefault()
    }
    let drag: { x: number; left: number; moved: boolean } | null = null
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return
      drag = { x: e.clientX, left: el.scrollLeft, moved: false }
    }
    const onMove = (e: PointerEvent) => {
      if (!drag) return
      const dx = e.clientX - drag.x
      if (!drag.moved && Math.abs(dx) < 4) return
      if (!drag.moved) {
        drag.moved = true
        el.classList.add('dragging')
        el.setPointerCapture(e.pointerId)
      }
      el.scrollLeft = drag.left - dx
    }
    const onUp = () => {
      if (drag?.moved) el.classList.remove('dragging')
      drag = null
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
    }
  }, [ref, present])
}
