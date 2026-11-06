import { useEffect, useRef, useState } from 'react'
import type { GeoState } from '../hooks/useGeolocation'
import { forgetPlaces, removeRecent, setPlace, startPickOnMap, store, useApp } from '../state/store'
import { PlaceSearch } from './PlaceSearch'

interface Props {
  onLocate: () => void
  locating: boolean
  geo?: Pick<GeoState, 'status' | 'message' | 'attempt'>
}

/**
 * The one place picker, behind every "Change" and every empty state:
 * use my location · search (with recents) · pick a point on the map.
 */
export function PlacePicker({ onLocate, locating, geo }: Props) {
  const open = useApp((s) => s.pickerOpen)
  const mode = useApp((s) => s.pickerMode)
  const [searchingLocal, setSearching] = useState(false)
  const searching = searchingLocal || mode === 'search'
  // "Use my location" keeps the picker open with "Locating…" until the browser answers: it closes on a fix and
  // says why on a failure (it used to close at once, so a denial or a timeout looked like nothing happened).
  const waitingFor = useRef(0)
  const [geoError, setGeoError] = useState<string | null>(null)
  useEffect(() => {
    if (!geo || !waitingFor.current || geo.attempt < waitingFor.current) return
    if (geo.status === 'granted') {
      waitingFor.current = 0
      store.set({ pickerOpen: false, pickerMode: 'menu' })
    } else if (geo.status === 'denied' || geo.status === 'timeout' || geo.status === 'unavailable') {
      waitingFor.current = 0
      setGeoError(geo.message ?? 'Your location is unavailable right now.')
    }
  }, [geo?.status, geo?.attempt]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) setGeoError(null)
  }, [open])
  if (!open) return null
  const close = () => {
    setSearching(false)
    store.set({ pickerOpen: false, pickerMode: 'menu' })
  }
  return (
    <div className="overlay-center picker-overlay" role="dialog" aria-modal="true" aria-labelledby="picker-title" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="card picker-card">
        <div className="picker-head">
          <h2 id="picker-title">Pick a place</h2>
          <button className="icon-btn" onClick={close} aria-label="Close">
            ×
          </button>
        </div>
        {searching ? (
          <PlaceSearch
            onPick={(r) => {
              setPlace({ name: r.name, lngLat: r.lngLat, source: 'search' }, r.name)
              setSearching(false)
            }}
          />
        ) : (
          <div className="prompt-actions">
            <button
              className="btn primary"
              disabled={locating}
              aria-busy={locating}
              onClick={() => {
                setGeoError(null)
                waitingFor.current = (geo?.attempt ?? 0) + 1
                onLocate()
                if (!geo) close()
              }}
            >
              {locating ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Locating…
                </>
              ) : (
                '◎ Use my location'
              )}
            </button>
            {geoError && (
              <p className="geo-error" role="alert">
                {geoError}
              </p>
            )}
            <button className="btn" onClick={() => setSearching(true)}>
              🔍 Search for a place
            </button>
            <button className="btn" onClick={startPickOnMap}>
              🗺 Pick a point on the map
            </button>
          </div>
        )}
        {!searching && <Recents />}
        {!searching && <ForgetButton />}
      </div>
    </div>
  )
}

function Recents() {
  const recent = useApp((s) => s.recentPlaces)
  if (!recent.length) return null
  return (
    <div className="recents-row">
      <small className="muted">Recent</small>
      <div className="chips">
        {recent.map((r) => (
          <span key={r.name} className="chip chip-removable">
            <button className="chip-main" onClick={() => setPlace({ name: r.name, lngLat: r.lngLat, source: 'search' }, r.name)}>
              {r.name.split(',')[0]}
            </button>
            <button className="chip-x" onClick={() => removeRecent(r.name)} aria-label={`Remove ${r.name.split(',')[0]} from recent places`}>
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}

/** Privacy control in the picker itself: forget the saved place and the recents, back to the first-run choice. */
function ForgetButton() {
  const hasAny = useApp((s) => !!s.place || s.recentPlaces.length > 0)
  const [confirming, setConfirming] = useState(false)
  if (!hasAny) return null
  return confirming ? (
    <div className="forget-inline">
      <small className="muted">Forget the saved place and the recent places on this device?</small>
      <div className="prompt-actions row">
        <button className="btn small primary" onClick={forgetPlaces}>
          Forget
        </button>
        <button className="btn small" onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
    </div>
  ) : (
    <button className="btn ghost small forget-link" onClick={() => setConfirming(true)}>
      Forget my location and recent places
    </button>
  )
}
