import { useEffect, useRef, useState } from 'react'
import { cachedSearch, PHOTON_URL, provisionalSearch, searchPlaces, type GeoResult } from '../api/geocode'
import { useDebouncedValue } from '../hooks/useMisc'
import { removeRecent, useApp, type RecentPlace } from '../state/store'

interface Props {
  placeholder?: string
  autoFocus?: boolean
  /** Show the recent places under an empty query. */
  recents?: boolean
  onPick: (r: { name: string; lngLat: { lng: number; lat: number } }) => void
}

/** One search box for places and trip destinations: Open-Meteo geocoding + Nominatim, with recents. */
export function PlaceSearch({ placeholder = 'City, postcode or place', autoFocus = true, recents = true, onPick }: Props) {
  const [q, setQ] = useState('')
  const dq = useDebouncedValue(q, 300)
  const [results, setResults] = useState<GeoResult[]>([])
  const [busy, setBusy] = useState(false)
  const [slow, setSlow] = useState(false)
  const [provisional, setProvisional] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const recent = useApp((s) => s.recentPlaces)

  useEffect(() => {
    if (autoFocus) setTimeout(() => input.current?.focus(), 50)
  }, [autoFocus])

  useEffect(() => {
    if (dq.trim().length < 2) {
      setResults([])
      setErr(null)
      return
    }
    // A query answered before: at once, no request.
    const kept = cachedSearch(dq)
    if (kept) {
      setResults(kept)
      setErr(null)
      setBusy(false)
      setSlow(false)
      setProvisional(false)
      return
    }
    // Otherwise places already known whose name starts with what is typed, while the service is asked.
    const early = provisionalSearch(dq)
    if (early.length) {
      setResults(early)
      setProvisional(true)
    }
    const ctrl = new AbortController()
    setBusy(true)
    setSlow(false)
    setErr(null)
    // Past 3 s the list says who it is waiting for, not only "Searching…".
    const slowTimer = window.setTimeout(() => setSlow(true), 3000)
    searchPlaces(dq, ctrl.signal)
      .then((r) => {
        setResults(r)
        setProvisional(false)
        if (!r.length) setErr(`No exact match for “${dq.trim()}”. Try a city or town name — this list is never filled with unrelated places.`)
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setErr('Search failed — check your connection')
      })
      .finally(() => {
        window.clearTimeout(slowTimer)
        if (!ctrl.signal.aborted) {
          setBusy(false)
          setSlow(false)
        }
      })
    return () => {
      window.clearTimeout(slowTimer)
      ctrl.abort()
    }
  }, [dq])

  const pick = (r: { name: string; lngLat: { lng: number; lat: number } }) => {
    setQ('')
    onPick(r)
  }
  const showRecents = recents && q.trim().length < 2 && recent.length > 0
  const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  const exactFirst = results.length > 0 && fold(results[0].name) === fold(dq)

  return (
    <form
      className="place-search"
      onSubmit={(e) => {
        e.preventDefault()
        if (results[0]) pick({ name: [results[0].name, results[0].detail].filter(Boolean).join(', '), lngLat: results[0].lngLat })
      }}
    >
      <input ref={input} className="text-input" type="search" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} aria-label={placeholder} autoComplete="off" enterKeyHint="search" />
      {(results.length > 0 || busy || err) && (
        <ul className="search-results inline" role="listbox" aria-label="Search results">
          {busy && (
            <li className="muted" aria-live="polite">
              {slow ? `Still searching — the place service (${new URL(PHOTON_URL).host}) is slow right now…` : provisional ? 'Places you searched before · checking for more…' : 'Searching…'}
            </li>
          )}
          {!busy && err && <li className="muted">{err}</li>}
          {results.length > 0 && <li className="muted results-head">{exactFirst ? `Exact matches for “${dq.trim()}” first` : 'Closest names first'}</li>}
          {results.map((r, i) => (
            <li key={i} role="option" aria-selected={false}>
              <button type="button" onClick={() => pick({ name: [r.name, r.detail].filter(Boolean).join(', '), lngLat: r.lngLat })}>
                <span>
                  {r.name}
                  {i === 0 && exactFirst && <em className="tag best">Best match</em>}
                </span>
                <small>{r.detail}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {showRecents && (
        <ul className="search-results inline recents" role="listbox" aria-label="Recent places">
          <li className="muted">Recent</li>
          {recent.map((r: RecentPlace) => (
            <li key={r.name} role="option" aria-selected={false} className="recent-item">
              <button type="button" onClick={() => pick(r)}>
                <span>{r.name}</span>
              </button>
              <button type="button" className="icon-btn recent-x" onClick={() => removeRecent(r.name)} aria-label={`Remove ${r.name.split(',')[0]} from recent places`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}
