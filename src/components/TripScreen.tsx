import { lazy, Suspense } from 'react'
import { go, store, useApp } from '../state/store'
import { ErrorBoundary } from './ErrorBoundary'

const JourneyPanel = lazy(() => import('./JourneyPanel').then((m) => ({ default: m.JourneyPanel })))

/** Trip: the journey planner as a full page (from = the place, to = search or a map pick). */
export function TripScreen() {
  const place = useApp((s) => s.place)
  const hasRoute = useApp((s) => !!s.journey.routes.data)
  return (
    <section className="screen trip" aria-label="Trip">
      <div className="screen-head">
        <h2>Trip</h2>
        {hasRoute && (
          <button className="btn small" onClick={() => go('map')}>
            Show on map
          </button>
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
