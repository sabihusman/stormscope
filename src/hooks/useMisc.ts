import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

const rmQuery = () => window.matchMedia('(prefers-reduced-motion: reduce)')
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const q = rmQuery()
      q.addEventListener('change', cb)
      return () => q.removeEventListener('change', cb)
    },
    () => rmQuery().matches,
    () => false,
  )
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb)
      window.addEventListener('offline', cb)
      return () => {
        window.removeEventListener('online', cb)
        window.removeEventListener('offline', cb)
      }
    },
    () => navigator.onLine,
    () => true,
  )
}

/** ≥ 768 px: left rail + content column + always-visible map. */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

/** ≥ 1024 px (desktop): the Now column stays on the left and Trip / More open as a dock beside the map. */
export function useDesktop(): boolean {
  const [desk, setDesk] = useState(() => window.matchMedia('(min-width: 1024px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const on = () => setDesk(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return desk
}

/** Ticks every `ms` so "updated X ago" labels stay honest. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Latest-value ref, handy for callbacks inside map event handlers. */
export function useLatest<T>(v: T) {
  const r = useRef(v)
  r.current = v
  return r
}

/** rAF-driven animation loop; `cb` receives elapsed ms since previous frame. */
export function useAnimationFrame(cb: (dt: number) => void, active: boolean) {
  const cbRef = useLatest(cb)
  useEffect(() => {
    if (!active) return
    let raf = 0
    let last = performance.now()
    const loop = (t: number) => {
      cbRef.current(t - last)
      last = t
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [active, cbRef])
}
