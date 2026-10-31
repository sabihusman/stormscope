import type { GeoStatus } from '../hooks/useGeolocation'
import { setSavePlacePref, useApp } from '../state/store'

interface Props {
  status: GeoStatus
  message: string | null
  onAllow: () => void
  onSearch: () => void
  onPickOnMap: () => void
  /** Closed without choosing: the Now screen shows its empty state with the same three options. */
  onClose: () => void
}

/**
 * First run: the place picker with an explanation line. Every exit sets a place (location,
 * search, or a point on the map) so the Now screen is never empty. After a denial or timeout
 * the primary action becomes Search.
 */
export function LocationPrompt({ status, message, onAllow, onSearch, onPickOnMap, onClose }: Props) {
  const failed = status === 'denied' || status === 'timeout' || status === 'unavailable'
  const savePref = useApp((s) => s.savePlacePref)
  return (
    <div className="overlay-center" role="dialog" aria-modal="true" aria-labelledby="loc-title">
      <div className="card prompt-card">
        <button className="icon-btn prompt-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="prompt-icon" aria-hidden="true">
          📍
        </div>
        <h2 id="loc-title">{failed ? "Couldn't get your location" : 'Where are you?'}</h2>
        <p>{failed ? message : 'Conditions, warnings and radar for your place. Your location is only sent to the weather services to fetch data for that spot.'}</p>
        <p className="muted prompt-privacy">Nothing is saved on this device unless you turn this on.</p>
        <label className="toggle-row">
          <input type="checkbox" checked={savePref} onChange={(e) => setSavePlacePref(e.target.checked)} />
          <span>
            Remember this place on this device
            <small className="muted"> · off by default; removable any time in Settings → Forget my location</small>
          </span>
        </label>
        <div className="prompt-actions">
          {failed ? (
            <>
              <button className="btn primary" onClick={onSearch}>
                Search for a place
              </button>
              <button className="btn" onClick={onPickOnMap}>
                Pick a point on the map
              </button>
              <button className="btn ghost" onClick={onAllow}>
                Try location again
              </button>
            </>
          ) : (
            <>
              <button className="btn primary choice" onClick={onAllow} disabled={status === 'locating'}>
                <span>{status === 'locating' ? 'Locating…' : 'Use my location'}</span>
                <small>One-time check. Nothing is saved unless you turn saving on below.</small>
              </button>
              <button className="btn choice" onClick={onSearch}>
                <span>Search for a place</span>
                <small>City, postcode or place name. No location access needed.</small>
              </button>
              <button className="btn ghost choice" onClick={onPickOnMap}>
                <span>Pick a point on the map</span>
                <small>Drop a pin anywhere.</small>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
