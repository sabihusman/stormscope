import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isFull, useApp } from '../state/store'

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

/**
 * ≥ 768 px in Full: left rail + content column + always-visible map. Lite has no wide layout (one centred column at
 * any width, no map beside it), so this is false there whatever the screen.
 */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 768px)').matches)
  const full = useApp(isFull)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide && full
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
/**
 * One clock per interval, shared by every component that shows an age ("checked 4 min ago"): they all read the same
 * "now", so the status row's "everything on Now checked within the last 4 min" and a card's own "5 min ago" can never
 * come from clocks up to an interval apart. The timer runs only while something listens.
 */
const clocks = new Map<number, { now: number; subs: Set<() => void>; timer: number }>()
function clock(ms: number) {
  let c = clocks.get(ms)
  if (!c) {
    c = { now: Date.now(), subs: new Set(), timer: 0 }
    clocks.set(ms, c)
  }
  return c
}
function subscribeClock(ms: number, cb: () => void) {
  const c = clock(ms)
  if (!c.subs.size) {
    // Restarting after a pause: catch up first (React re-reads the snapshot after subscribing).
    c.now = Date.now()
    c.timer = window.setInterval(() => {
      c.now = Date.now()
      c.subs.forEach((f) => f())
    }, ms)
  }
  c.subs.add(cb)
  return () => {
    c.subs.delete(cb)
    if (!c.subs.size) window.clearInterval(c.timer)
  }
}
/** One subscribe function per interval: a new one each render would make React resubscribe every render, and a
 * clock whose only listener resubscribes restarts and moves its "now" — an endless re-render (React error #185). */
const subscribers = new Map<number, (cb: () => void) => () => void>()
const getters = new Map<number, () => number>()
export function useNow(ms = 15_000): number {
  let sub = subscribers.get(ms)
  let get = getters.get(ms)
  if (!sub || !get) {
    sub = (cb) => subscribeClock(ms, cb)
    get = () => clock(ms).now
    subscribers.set(ms, sub)
    getters.set(ms, get)
  }
  return useSyncExternalStore(sub, get, get)
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
