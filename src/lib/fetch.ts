/** fetch() with timeout, JSON parsing and useful error messages. */
export class HttpError extends Error {
  status: number
  url: string
  /** Server-provided reason (e.g. Open-Meteo's "Daily API request limit exceeded"). */
  reason?: string
  constructor(status: number, url: string, message?: string, reason?: string) {
    super(message ?? `HTTP ${status} for ${url}`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
    this.reason = reason
  }
}

const isOpenMeteo = (url: string) => url.includes('open-meteo.com/')

/** Which Open-Meteo quota tier a 429 reason names (null for any other service's 429). */
export function limitTier(e: unknown): 'minute' | 'hour' | 'day' | null {
  if (!(e instanceof HttpError) || e.status !== 429 || !isOpenMeteo(e.url)) return null
  const r = (e.reason ?? '').toLowerCase()
  return r.includes('daily') ? 'day' : r.includes('hourly') ? 'hour' : 'minute'
}

export interface FetchOptions extends RequestInit {
  timeoutMs?: number
}

import { WARM_CACHE_NO_REFETCH } from './perfFlags'

/** Hosts the service worker's `live-data` NetworkFirst route covers (keep in step with vite.config.ts). */
const LIVE_DATA = /^https:\/\/(api\.rainviewer\.com|api\.open-meteo\.com|geocoding-api\.open-meteo\.com|api\.waterdata\.usgs\.gov|api\.water\.noaa\.gov|api\.weather\.gov|hydro\.nationalmap\.gov|nominatim\.openstreetmap\.org)\//i

export async function fetchJSON<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { timeoutMs = 15_000, signal, ...init } = opts
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs)
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true })
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    // First visit: the service worker is not in control yet, so its runtime cache would miss everything
    // this session fetched. Store good live-data responses ourselves (same cache Workbox serves from
    // when offline) instead of refetching every API once the worker takes over.
    if (WARM_CACHE_NO_REFETCH && res.ok && LIVE_DATA.test(url) && 'serviceWorker' in navigator && !navigator.serviceWorker.controller && typeof caches !== 'undefined') {
      const copy = res.clone()
      caches
        .open('live-data')
        .then((c) => c.put(url, copy))
        .catch(() => {
          /* cache storage unavailable: nothing to warm */
        })
    }
    if (!res.ok) {
      let reason: string | undefined
      try {
        const body = (await res.json()) as { reason?: string; error?: unknown }
        reason = typeof body?.reason === 'string' ? body.reason : undefined
      } catch {
        /* no JSON body */
      }
      throw new HttpError(res.status, url, undefined, reason)
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** Run promise-returning tasks with a concurrency limit. */
export async function pLimitAll<T>(tasks: (() => Promise<T>)[], limit = 4): Promise<PromiseSettledResult<T>[]> {
  const out: PromiseSettledResult<T>[] = new Array(tasks.length)
  let i = 0
  async function worker() {
    while (i < tasks.length) {
      const idx = i++
      try {
        out[idx] = { status: 'fulfilled', value: await tasks[idx]() }
      } catch (reason) {
        out[idx] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return out
}

export function describeError(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status !== 429) return `Service returned ${e.status}`
    if (!isOpenMeteo(e.url)) {
      let host = e.url
      try {
        host = new URL(e.url).host
      } catch {
        /* keep the raw url */
      }
      return `rate-limited by ${host} (HTTP 429) — try again later`
    }
    const tier = limitTier(e)
    if (tier === 'day') return 'Open-Meteo daily limit reached for this network (10 000 calls) — resets at 00:00 UTC'
    if (tier === 'hour') return 'Open-Meteo hourly limit reached for this network (5 000 calls) — try again next hour'
    return 'Open-Meteo per-minute limit reached — retrying shortly'
  }
  if (e instanceof DOMException && e.name === 'TimeoutError') return 'Request timed out'
  if (e instanceof DOMException && e.name === 'AbortError') return 'Cancelled'
  if (e instanceof TypeError) return navigator.onLine ? 'Network error' : 'Offline'
  if (e instanceof Error) return e.message
  return 'Unknown error'
}

/** Identifies this app to APIs that require a User-Agent / contact (api.weather.gov, Nominatim). */
export const APP_CONTACT = 'StormScope PWA (github.com/stormscope; contact via app)'
