import { useCallback, useEffect, useRef, useState } from 'react'
import type { TransitionEvent } from 'react'

/** The phone's Reduce Motion setting: every transition is then instant (the CSS also drops them). */
export const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

export type Presence = {
  mounted: boolean
  state: 'opening' | 'open' | 'closing'
  /** Attach to the element: the exit unmounts when its opacity transition actually ends (a timer is only the fallback). */
  onTransitionEnd: (e: TransitionEvent) => void
}

/**
 * Keeps a pop-up mounted through a short exit transition. `open` true → mounted in the same render
 * with state "opening" (the CSS start position; anything that measures the element on open finds
 * it), "open" two frames later (the transition runs); `open` false → "closing" (the CSS end
 * position) until the element's opacity transition ends — reported through `onTransitionEnd` —
 * then unmounted; a timer of `ms` + 150 is the fallback if no transition event arrives. With
 * Reduce Motion on, the exit waits 0 ms, so nothing is ever shown moving.
 */
export function usePresence(open: boolean, ms = 150): Presence {
  // Stays true from the first open render until the exit has finished (the mounted flag's slow half).
  const [held, setHeld] = useState(open)
  // False until two frames after opening: the "opening" start position, then the transition.
  const [entered, setEntered] = useState(open)
  const timer = useRef(0)
  const raf = useRef(0)
  const closing = useRef(false)
  useEffect(() => {
    window.clearTimeout(timer.current)
    cancelAnimationFrame(raf.current)
    if (open) {
      closing.current = false
      setHeld(true)
      raf.current = requestAnimationFrame(() => {
        raf.current = requestAnimationFrame(() => setEntered(true))
      })
    } else {
      setEntered(false)
      closing.current = true
      if (reducedMotion()) {
        closing.current = false
        setHeld(false)
      } else {
        // Fallback only: the element's own transitionend normally unmounts it first.
        timer.current = window.setTimeout(() => {
          closing.current = false
          setHeld(false)
        }, ms + 150)
      }
    }
    return () => {
      window.clearTimeout(timer.current)
      cancelAnimationFrame(raf.current)
    }
  }, [open, ms])
  const onTransitionEnd = useCallback((e: TransitionEvent) => {
    if (!closing.current || e.propertyName !== 'opacity' || e.target !== e.currentTarget) return
    closing.current = false
    window.clearTimeout(timer.current)
    setHeld(false)
  }, [])
  const mounted = open || held
  const state: Presence['state'] = open ? (entered ? 'open' : 'opening') : 'closing'
  return { mounted, state, onTransitionEnd }
}
