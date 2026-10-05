import { useEffect, useRef, useState } from 'react'
import { searchPlaces, type GeoResult } from '../api/geocode'
import { useDebouncedValue } from '../hooks/useMisc'
import { store, useApp } from '../state/store'

interface Props {
  open: boolean
  onOpen: () => void
  onClose: () => void
  onLocate: () => void
  locating: boolean
}

export function SearchBar({ open, onOpen, onClose, onLocate, locating }: Props) {
  const label = useApp((s) => s.placeLabel)
  const [q, setQ] = useState('')
  const dq = useDebouncedValue(q, 300)
  const [results, setResults] = useState<GeoResult[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 50)
  }, [open])

  useEffect(() => {
    if (!open || dq.trim().length < 2) {
      setResults([])
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
  }, [dq, open])

  const choose = (r: GeoResult) => {
    store.set({ place: { name: [r.name, r.detail].filter(Boolean).join(', '), lngLat: r.lngLat, source: 'search' }, selection: null })
    setQ('')
    onClose()
  }

  return (
    <div className={`topbar ${open ? 'open' : ''}`}>
      {open ? (
        <form
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (results[0]) choose(results[0])
          }}
        >
          <input
            ref={input}
            className="search-input"
            type="search"
            placeholder="City, postcode or place"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search for a place"
            autoComplete="off"
            autoFocus
            enterKeyHint="search"
          />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close search">
            ×
          </button>
          {(results.length > 0 || busy || err) && (
            <ul className="search-results" role="listbox">
              {busy && <li className="muted">Searching…</li>}
              {!busy && err && <li className="muted">{err}</li>}
              {results.map((r, i) => (
                <li key={i} role="option" aria-selected={false}>
                  <button type="button" onClick={() => choose(r)}>
                    <span>{r.name}</span>
                    <small>{r.detail}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>
      ) : (
        <div className="place-chip-row">
          <button className="place-chip" onClick={onOpen} aria-label="Change location">
            <span className="chip-icon" aria-hidden="true">
              🔍
            </span>
            <span className="chip-text">{label ?? 'Search for a place'}</span>
          </button>
          <button className="icon-btn round" onClick={onLocate} aria-label="Use my location" disabled={locating}>
            {locating ? '…' : '◎'}
          </button>
        </div>
      )}
    </div>
  )
}
