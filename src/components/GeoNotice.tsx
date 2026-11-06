import { useState } from 'react'
import type { GeoStatus } from '../hooks/useGeolocation'

interface Props {
  status: GeoStatus
  message: string | null
  attempt: number
  onRetry: () => void
}

const FAILED: GeoStatus[] = ['denied', 'timeout', 'unavailable']

/**
 * What "Use my location" is doing once a place is already set (with no place, the location prompt says it):
 * "Finding your location…" while the browser looks, and why it failed — with Try again — when it does. Before
 * (Nov 6 audit) the map's ◎ and the picker's button changed nothing visible on a denial or a timeout.
 */
export function GeoNotice({ status, message, attempt, onRetry }: Props) {
  // The dismissed attempt: a new attempt (a new number) brings the notice back.
  const [dismissed, setDismissed] = useState(0)
  if (attempt === 0 || dismissed === attempt) return null
  if (status === 'locating')
    return (
      <div className="geo-notice" role="status" data-geo="locating">
        <span className="spinner" aria-hidden="true" /> Finding your location…
      </div>
    )
  if (!FAILED.includes(status)) return null
  return (
    <div className="geo-notice err" role="alert" data-geo={status}>
      <span>{message ?? 'Your location is unavailable right now.'}</span>
      <span className="geo-actions">
        <button className="btn small" onClick={onRetry}>
          Try again
        </button>
        <button className="icon-btn" onClick={() => setDismissed(attempt)} aria-label="Dismiss">
          ×
        </button>
      </span>
    </div>
  )
}
