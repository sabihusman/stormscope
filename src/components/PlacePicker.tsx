import { useState } from 'react'
import { setPlace, startPickOnMap, store, useApp } from '../state/store'
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
  const [searching, setSearching] = useState(false)
  if (!open) return null
  const close = () => {
    setSearching(false)
    store.set({ pickerOpen: false })
  }
  return (
    <div className="overlay-center picker-overlay" role="dialog" aria-labelledby="picker-title" onClick={(e) => e.target === e.currentTarget && close()}>
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
          <button key={r.name} className="chip" onClick={() => setPlace({ name: r.name, lngLat: r.lngLat, source: 'search' }, r.name)}>
            {r.name.split(',')[0]}
          </button>
        ))}
      </div>
    </div>
  )
}
