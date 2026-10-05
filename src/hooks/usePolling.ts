import { useEffect, useRef } from 'react'

/**
 * Calls `fn` immediately (when `enabled`), then every `intervalMs`, and again
 * whenever the tab returns to the foreground or the network comes back —
 * but only if the last successful run is older than `minAgeMs`.
 */
export function usePolling(
  fn: () => void | Promise<void>,
  intervalMs: number,
  enabled: boolean,
  deps: unknown[],
  minAgeMs = intervalMs / 2,
) {
  const lastRun = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const run = () => {
      if (cancelled) return
      lastRun.current = Date.now()
      void fnRef.current()
    }
    run()
    const timer = setInterval(run, intervalMs)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRun.current > minAgeMs) run()
    }
    const onOnline = () => {
      if (Date.now() - lastRun.current > 5_000) run()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('focus', onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('focus', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, ...deps])
}
