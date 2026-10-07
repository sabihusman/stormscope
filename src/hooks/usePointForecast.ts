import { useEffect, useState } from 'react'
import { fetchPlaceForecast } from '../api/openMeteo'
import { describeError } from '../lib/fetch'
import type { LngLat } from '../lib/geo'
import type { PlaceForecast } from '../types'

const cache = new Map<string, { at: number; data: PlaceForecast }>()
const TTL = 10 * 60_000
const key = (p: LngLat) => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`

/**
 * Conditions at a tapped map point: one Open-Meteo location (current + 48 h), cached for 10 min
 * per ~100 m cell so re-tapping the same spot costs nothing. `null` while loading / when off.
 */
export function usePointForecast(p: LngLat | null): { data: PlaceForecast | null; error: string | null; loading: boolean } {
  const k = p ? key(p) : ''
  const hit = k ? cache.get(k) : undefined
  const fresh = hit && Date.now() - hit.at < TTL ? hit.data : null
  const [state, setState] = useState<{ k: string; data: PlaceForecast | null; error: string | null }>({ k, data: fresh, error: null })
  useEffect(() => {
    if (!p) return
    if (fresh) {
      setState({ k, data: fresh, error: null })
      return
    }
    const ctrl = new AbortController()
    setState({ k, data: null, error: null })
    fetchPlaceForecast(p, ctrl.signal)
      .then((data) => {
        cache.set(k, { at: Date.now(), data })
        if (!ctrl.signal.aborted) setState({ k, data, error: null })
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) setState({ k, data: null, error: describeError(e) })
      })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k])
  if (!p) return { data: null, error: null, loading: false }
  const current = state.k === k ? state : { data: fresh, error: null }
  return { data: current.data, error: current.error, loading: !current.data && !current.error }
}
