import { useEffect, useRef, useState } from 'react'

/** The phone's Reduce Motion setting: every transition is then instant (the CSS also drops them). */
export const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

export type Presence = { mounted: boolean; state: 'opening' | 'open' | 'closing' }

/**
 * Keeps a pop-up mounted through a short exit transition. `open` true → mounted in the same render
 * with state "opening" (the CSS start position; anything that measures the element on open finds
 * it), "open" two frames later (the transition runs); `open` false → "closing" for `ms` (the CSS
 * end position), then unmounted. With Reduce Motion on, the exit waits 0 ms, so nothing is ever
 * shown moving.
 */
export function usePresence(open: boolean, ms = 150): Presence {
  // Stays true from the first open render until the exit has finished (the mounted flag's slow half).
  const [held, setHeld] = useState(open)
  // False until two frames after opening: the "opening" start position, then the transition.
  const [entered, setEntered] = useState(open)
  const timer = useRef(0)
  const raf = useRef(0)
  useEffect(() => {
    window.clearTimeout(timer.current)
    cancelAnimationFrame(raf.current)
    if (open) {
      setHeld(true)
      raf.current = requestAnimationFrame(() => {
        raf.current = requestAnimationFrame(() => setEntered(true))
      })
    } else {
      setEntered(false)
      const wait = reducedMotion() ? 0 : ms
      if (wait === 0) setHeld(false)
      else timer.current = window.setTimeout(() => setHeld(false), wait)
    }
    return () => {
      window.clearTimeout(timer.current)
      cancelAnimationFrame(raf.current)
    }
  }, [open, ms])
  const mounted = open || held
  const state: Presence['state'] = open ? (entered ? 'open' : 'opening') : 'closing'
  return { mounted, state }
}
