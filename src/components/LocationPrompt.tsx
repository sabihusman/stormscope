import type { GeoStatus } from '../hooks/useGeolocation'

interface Props {
  status: GeoStatus
  message: string | null
  onAllow: () => void
  onSearch: () => void
  onPickOnMap: () => void
}

/**
 * First run: the place picker with an explanation line. Every exit sets a place (location,
 * search, or a point on the map) so the Now screen is never empty. After a denial or timeout
 * the primary action becomes Search.
 */
export function LocationPrompt({ status, message, onAllow, onSearch, onPickOnMap }: Props) {
  const failed = status === 'denied' || status === 'timeout' || status === 'unavailable'
  return (
    <div className="overlay-center" role="dialog" aria-labelledby="loc-title">
      <div className="card prompt-card">
        <div className="prompt-icon" aria-hidden="true">
          📍
        </div>
        <h2 id="loc-title">{failed ? "Couldn't get your location" : 'Where are you?'}</h2>
        <p>{failed ? message : 'Conditions, warnings and radar for your place. Your location stays on this device — it is only sent to the weather services to fetch data for that spot.'}</p>
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
              <button className="btn primary" onClick={onAllow} disabled={status === 'locating'}>
                {status === 'locating' ? 'Locating…' : 'Use my location'}
              </button>
              <button className="btn" onClick={onSearch}>
                Search for a place
              </button>
              <button className="btn ghost" onClick={onPickOnMap}>
                Pick a point on the map
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
