import { lazy, Suspense } from 'react'
import { go, store, useApp } from '../state/store'
import { useWide } from '../hooks/useMisc'
import { ErrorBoundary } from './ErrorBoundary'

const JourneyPanel = lazy(() => import('./JourneyPanel').then((m) => ({ default: m.JourneyPanel })))

/** Trip: the journey planner as a full page (from = the place, to = search or a map pick). */
export function TripScreen() {
  const place = useApp((s) => s.place)
  const hasRoute = useApp((s) => !!s.journey.routes.data)
  const routeOnMap = useApp((s) => s.routeOnMap)
  const wide = useWide()
  return (
    <section className="screen trip" aria-label="Trip">
      <div className="screen-head">
        <h2>Trip</h2>
        {hasRoute && (
          // A switch, not a door: the route stays on (or off) the map, and says which; the map's Layers menu has the same switch.
          <div className="head-actions">
            <button className={`btn small map-toggle ${routeOnMap ? 'on' : ''}`} aria-pressed={routeOnMap} data-toggle="route" onClick={() => store.set({ routeOnMap: !routeOnMap })}>
              Route on map: {routeOnMap ? 'On' : 'Off'}
            </button>
            {!wide && routeOnMap && (
              <button className="btn small" onClick={() => go('map')}>
                Map ›
              </button>
            )}
          </div>
        )}
      </div>
      {!place ? (
        <div className="card now-card">
          <p>The trip starts from your place.</p>
          <button className="btn primary" onClick={() => store.set({ pickerOpen: true })}>
            Pick a place
          </button>
        </div>
      ) : (
        <ErrorBoundary kind="panel" name="Trip">
          <Suspense fallback={<p className="muted">Loading trip tools…</p>}>
            <JourneyPanel />
          </Suspense>
        </ErrorBoundary>
      )}
    </section>
  )
}
