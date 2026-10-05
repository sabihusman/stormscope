import type { GeoStatus } from '../hooks/useGeolocation'

interface Props {
  status: GeoStatus
  message: string | null
  onAllow: () => void
  onSkip: () => void
  onSearch: () => void
}

/** Friendly first-run explanation shown *before* the browser's own permission dialog. */
export function LocationPrompt({ status, message, onAllow, onSkip, onSearch }: Props) {
  const failed = status === 'denied' || status === 'timeout' || status === 'unavailable'
  return (
    <div className="overlay-center" role="dialog" aria-labelledby="loc-title">
      <div className="card prompt-card">
        <div className="prompt-icon" aria-hidden="true">
          📍
        </div>
        <h2 id="loc-title">{failed ? "Couldn't get your location" : 'Use your location?'}</h2>
        <p>
          {failed
            ? message
            : 'StormScope centres the radar, rainfall forecast, flood-risk and river gauges on where you are. Your location stays on this device — it is only sent to the weather services to fetch data for that spot.'}
        </p>
        <div className="prompt-actions">
          <button className="btn primary" onClick={onAllow} disabled={status === 'locating'}>
            {status === 'locating' ? 'Locating…' : failed ? 'Try again' : 'Allow location'}
          </button>
          <button className="btn" onClick={onSearch}>
            Search for a place
          </button>
          <button className="btn ghost" onClick={onSkip}>
            Just show the map
          </button>
        </div>
      </div>
    </div>
  )
}
