import { useEffect, useRef, useState } from 'react'

/** The phone's Reduce Motion setting: every transition is then instant (the CSS also drops them). */
export const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

export type Presence = { mounted: boolean; state: 'opening' | 'open' | 'closing' }

/**
 * Keeps a pop-up mounted through a short exit transition. `open` true → mounted at once with
 * state "opening" (the CSS start position), "open" on the next frame (the transition runs);
 * `open` false → "closing" for `ms` (the CSS end position), then unmounted. With Reduce Motion
 * on, the states still change but the exit waits 0 ms, so nothing is ever shown moving.
 */
export function usePresence(open: boolean, ms = 150): Presence {
  const [mounted, setMounted] = useState(open)
  const [state, setState] = useState<Presence['state']>(open ? 'open' : 'closing')
  const timer = useRef(0)
  const raf = useRef(0)
  useEffect(() => {
    window.clearTimeout(timer.current)
    cancelAnimationFrame(raf.current)
    if (open) {
      setMounted(true)
      setState('opening')
      raf.current = requestAnimationFrame(() => {
        raf.current = requestAnimationFrame(() => setState('open'))
      })
    } else {
      setState('closing')
      const wait = reducedMotion() ? 0 : ms
      if (wait === 0) setMounted(false)
      else timer.current = window.setTimeout(() => setMounted(false), wait)
    }
    return () => {
      window.clearTimeout(timer.current)
      cancelAnimationFrame(raf.current)
    }
  }, [open, ms])
  return { mounted, state }
}
