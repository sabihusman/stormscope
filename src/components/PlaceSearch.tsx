import { useEffect, useRef, useState } from 'react'
import { searchPlaces, type GeoResult } from '../api/geocode'
import { useDebouncedValue } from '../hooks/useMisc'
import { useApp, type RecentPlace } from '../state/store'

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
    const ctrl = new AbortController()
    setBusy(true)
    setErr(null)
    searchPlaces(dq, ctrl.signal)
      .then((r) => {
        setResults(r)
        if (!r.length) setErr('No places found')
      })
      .catch(() => setErr('Search failed — check your connection'))
      .finally(() => setBusy(false))
    return () => ctrl.abort()
  }, [dq])

  const pick = (r: { name: string; lngLat: { lng: number; lat: number } }) => {
    setQ('')
    onPick(r)
  }
  const showRecents = recents && q.trim().length < 2 && recent.length > 0

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
          {busy && <li className="muted">Searching…</li>}
          {!busy && err && <li className="muted">{err}</li>}
          {results.map((r, i) => (
            <li key={i} role="option" aria-selected={false}>
              <button type="button" onClick={() => pick({ name: [r.name, r.detail].filter(Boolean).join(', '), lngLat: r.lngLat })}>
                <span>{r.name}</span>
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
            <li key={r.name} role="option" aria-selected={false}>
              <button type="button" onClick={() => pick(r)}>
                <span>{r.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}
