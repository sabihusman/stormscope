import { useEffect, useRef } from 'react'
import { store, useApp, type SheetMode } from '../state/store'
import { PointDetails } from './PointChip'
import { ErrorBoundary } from './ErrorBoundary'

const ORDER: SheetMode[] = ['peek', 'half', 'full']
const step = (m: SheetMode, d: 1 | -1): SheetMode => ORDER[Math.max(0, Math.min(ORDER.length - 1, ORDER.indexOf(m) + d))]

/**
 * The Map screen's details sheet for a tapped point or object (opened by the chip's Details button;
 * playback lives in the docked bar instead). The map stays visible and interactive above it.
 * Collapsing works four ways on a phone: drag the handle down, tap the handle, tap the ▼ button, or —
 * when the content is scrolled to its top — drag the content itself down. Expanding also pushes a
 * history entry so the browser/Android back gesture collapses the sheet instead of leaving.
 */
export function BottomSheet() {
  const mode = useApp((s) => s.sheet)
  const drag = useRef<{ id: number; y: number; t: number } | null>(null)
  const bodyTouch = useRef<{ y: number; x: number; top: number; done: boolean } | null>(null)
  const pushed = useRef(false)
  const poppingOurs = useRef(false)
  const toggledAt = useRef(0)

  const setMode = (m: SheetMode) => store.set({ sheet: m })

  // ---- Handle: drag (pointer events, finished on window so a finger sliding off still counts) + tap ----
  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { id: e.pointerId, y: e.clientY, t: performance.now() }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* capture is a nicety; the window listeners below finish the gesture regardless */
    }
  }
  useEffect(() => {
    const finish = (e: PointerEvent) => {
      const d = drag.current
      if (!d || e.pointerId !== d.id) return
      drag.current = null
      const dy = e.clientY - d.y
      const dt = performance.now() - d.t
      const m = store.get().sheet
      if (Math.abs(dy) < 8 && dt < 400) {
        setMode(m === 'peek' ? 'half' : 'peek')
        return
      }
      if (dy < -30) setMode(step(m, 1))
      else if (dy > 30) setMode(step(m, -1))
    }
    const cancel = () => {
      drag.current = null
    }
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [])

  // ---- Content: a downward swipe that starts with the content scrolled to the top collapses one step ----
  const onBodyTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const t = e.touches[0]
    bodyTouch.current = { y: t.clientY, x: t.clientX, top: e.currentTarget.scrollTop, done: false }
  }
  const onBodyTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const b = bodyTouch.current
    if (!b || b.done || b.top > 0) return
    const t = e.touches[0]
    const dy = t.clientY - b.y
    const dx = Math.abs(t.clientX - b.x)
    if (dy > 48 && dx < dy / 2) {
      b.done = true
      setMode(step(store.get().sheet, -1))
    }
  }
  const onBodyTouchEnd = () => {
    bodyTouch.current = null
  }

  // ---- Back gesture: an expanded sheet owns one history entry ----
  useEffect(() => {
    const onPop = () => {
      if (poppingOurs.current) {
        poppingOurs.current = false
        return
      }
      pushed.current = false
      if (store.get().sheet !== 'peek') store.set({ sheet: 'peek' })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  useEffect(() => {
    if (mode !== 'peek' && !pushed.current) {
      pushed.current = true
      try {
        history.pushState({ ...(history.state ?? {}), sheet: true }, '')
      } catch {
        pushed.current = false
      }
    } else if (mode === 'peek' && pushed.current) {
      pushed.current = false
      poppingOurs.current = true
      history.back()
    }
  }, [mode])

  return (
    <section className={`sheet ${mode}`} aria-label="Point details">
      <div
        className="sheet-handle"
        onPointerDown={onPointerDown}
        role="button"
        tabIndex={0}
        aria-label="Resize panel"
        aria-expanded={mode === 'full'}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') setMode(step(mode, 1))
          if (e.key === 'ArrowDown' || e.key === 'Escape') setMode(step(mode, -1))
          if (e.key === 'Enter' || e.key === ' ') setMode(mode === 'peek' ? 'half' : 'peek')
        }}
      >
        <span className="grabber" />
      </div>
      <nav className="tabs">
        <div className="tablist details-head">
          <button className="btn small ghost" onClick={() => store.set({ selection: null, sheet: 'peek' })}>
            ‹ Close
          </button>
          <strong>Details</strong>
        </div>
        <button
          className="icon-btn sheet-toggle"
          onPointerUp={(e) => {
            if (e.pointerType === 'mouse') return
            toggledAt.current = performance.now()
            setMode('peek')
          }}
          onClick={() => {
            if (performance.now() - toggledAt.current < 600) return
            setMode('peek')
          }}
          aria-label="Collapse panel"
        >
          ▼
        </button>
      </nav>
      <div className="sheet-body" onTouchStart={onBodyTouchStart} onTouchMove={onBodyTouchMove} onTouchEnd={onBodyTouchEnd} onTouchCancel={onBodyTouchEnd}>
        <ErrorBoundary kind="panel" name="Details">
          <PointDetails />
        </ErrorBoundary>
      </div>
    </section>
  )
}
