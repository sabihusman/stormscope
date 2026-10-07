import { store, useApp } from '../state/store'

/** `📍 Place name · Change` — the same row at the top of every location-dependent screen. */
export function PlaceRow({ title }: { title?: string }) {
  const label = useApp((s) => s.placeLabel)
  const place = useApp((s) => s.place)
  const locating = useApp((s) => !!s.place && s.place.name === 'Your location' && !s.placeLabel)
  return (
    <div className="place-row">
      {title && <strong className="place-row-title">{title}</strong>}
      <button className="place-chip" onClick={() => store.set({ pickerOpen: true })} aria-label="Change place">
        <span className="chip-icon" aria-hidden="true">
          📍
        </span>
        <span className="chip-text">{place ? (label ?? (locating ? 'Locating…' : place.name)) : 'Pick a place'}</span>
        <span className="chip-action">Change</span>
      </button>
    </div>
  )
}
