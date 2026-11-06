import { useCallback, useEffect, useState } from 'react'
import type { LngLat } from '../lib/geo'

export type GeoStatus = 'idle' | 'prompt' | 'locating' | 'granted' | 'denied' | 'unavailable' | 'timeout'

export interface GeoState {
  status: GeoStatus
  position: LngLat | null
  accuracyM: number | null
  message: string | null
  /** Counts "Use my location" requests, so the UI can tell this attempt's result from an earlier one's. */
  attempt: number
}

const LS_KEY = 'stormscope.geo.asked'

export function useGeolocation() {
  const [state, setState] = useState<GeoState>(() => ({
    status: typeof navigator !== 'undefined' && 'geolocation' in navigator ? (localStorage.getItem(LS_KEY) ? 'idle' : 'prompt') : 'unavailable',
    position: null,
    accuracyM: null,
    message: null,
    attempt: 0,
  }))

  const request = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setState((s) => ({ ...s, status: 'unavailable', message: 'This browser has no geolocation support.', attempt: s.attempt + 1 }))
      return
    }
    try {
      localStorage.setItem(LS_KEY, '1')
    } catch {
      /* private mode */
    }
    setState((s) => ({ ...s, status: 'locating', message: null, attempt: s.attempt + 1 }))
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setState((s) => ({
          status: 'granted',
          position: { lng: pos.coords.longitude, lat: pos.coords.latitude },
          accuracyM: pos.coords.accuracy,
          message: null,
          attempt: s.attempt,
        }))
      },
      (err) => {
        const status: GeoStatus =
          err.code === err.PERMISSION_DENIED ? 'denied' : err.code === err.TIMEOUT ? 'timeout' : 'unavailable'
        const message =
          status === 'denied'
            ? 'Location permission was denied. You can search for a place instead, or re-enable location in your browser settings.'
            : status === 'timeout'
              ? 'Finding your location took too long. Try again or search for a place.'
              : 'Your location is unavailable right now. Try again or search for a place.'
        setState((s) => ({ ...s, status, message }))
      },
      { enableHighAccuracy: false, timeout: 12_000, maximumAge: 5 * 60_000 },
    )
  }, [])

  // If the browser already granted us location earlier, skip the prompt and just locate.
  useEffect(() => {
    if (!('permissions' in navigator)) return
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((p) => {
        if (p.state === 'granted') request()
      })
      .catch(() => {})
  }, [request])

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(LS_KEY, '1')
    } catch {
      /* ignore */
    }
    // Any non-active state collapses to idle so the card doesn't come back until the user asks (◎).
    setState((s) => ({ ...s, status: s.status === 'locating' || s.status === 'granted' ? s.status : 'idle' }))
  }, [])

  return { ...state, request, dismiss }
}
