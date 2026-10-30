import { useState } from 'react'
import { forgetPlaces, removeRecent, setPlace, startPickOnMap, store, useApp } from '../state/store'
import { PlaceSearch } from './PlaceSearch'

interface Props {
  onLocate: () => void
  locating: boolean
}

/**
 * The one place picker, behind every "Change" and every empty state:
 * use my location · search (with recents) · pick a point on the map.
 */
export function PlacePicker({ onLocate, locating }: Props) {
  const open = useApp((s) => s.pickerOpen)
  const mode = useApp((s) => s.pickerMode)
  const [searchingLocal, setSearching] = useState(false)
  const searching = searchingLocal || mode === 'search'
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
              onClick={() => {
                onLocate()
                close()
              }}
            >
              {locating ? 'Locating…' : '◎ Use my location'}
            </button>
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
