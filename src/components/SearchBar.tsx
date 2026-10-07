import { store, useApp } from '../state/store'

interface Props {
  onLocate: () => void
  locating: boolean
}

/** Map top bar: the place chip (opens the shared place picker) and the locate button. */
export function SearchBar({ onLocate, locating }: Props) {
  const label = useApp((s) => s.placeLabel)
  const place = useApp((s) => s.place)
  return (
    <div className="topbar">
      <div className="place-chip-row">
        <button className="place-chip" onClick={() => store.set({ pickerOpen: true })} aria-label="Change place">
          <span className="chip-icon" aria-hidden="true">
            📍
          </span>
          <span className="chip-text">{place ? (label ?? place.name) : 'Pick a place'}</span>
        </button>
        <button className="icon-btn round" onClick={onLocate} disabled={locating} aria-label="Use my location">
          {locating ? '…' : '◎'}
        </button>
      </div>
    </div>
  )
}
