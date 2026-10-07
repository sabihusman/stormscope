import { useNow } from '../hooks/useMisc'
import { timeAgo } from '../lib/time'
import { store, useApp, type MorePage } from '../state/store'
import { ErrorBoundary } from './ErrorBoundary'
import { FloodPanel, RiversPanel, SourcesPanel, StationPanel } from './Panels'
import { PlaceRow } from './PlaceRow'

const PAGES: { id: MorePage; icon: string; title: string }[] = [
  { id: 'flood', icon: '🌊', title: 'Flood risk' },
  { id: 'rivers', icon: '📈', title: 'Rivers & gauges' },
  { id: 'station', icon: '🌡', title: 'Station observations' },
  { id: 'settings', icon: 'ℹ', title: 'Sources, freshness & settings' },
]

/** More: reference views for the place, each a page with the place row on top. */
export function MoreScreen() {
  const page = useApp((s) => s.morePage)
  if (!page) return <MoreList />
  const meta = PAGES.find((p) => p.id === page)!
  return (
    <section className="screen more" aria-label={meta.title}>
      <div className="screen-head">
        <button className="btn small ghost" onClick={() => store.set({ morePage: null })} aria-label="Back to More">
          ‹ More
        </button>
        <h2>{meta.title}</h2>
      </div>
      {page !== 'settings' && <PlaceRow />}
      <ErrorBoundary key={page} kind="panel" name={meta.title}>
        <div className="page-body">
          {page === 'flood' && <FloodPanel />}
          {page === 'rivers' && <RiversPanel />}
          {page === 'station' && <StationPanel />}
          {page === 'settings' && <SourcesPanel />}
        </div>
      </ErrorBoundary>
    </section>
  )
}

function MoreList() {
  const rivers = useApp((s) => s.rivers)
  const station = useApp((s) => s.station)
  const units = useApp((s) => s.units)
  const now = useNow()
  const high = rivers.data?.filter((g) => g.riskLevel === 'high' || g.riskLevel === 'flooding').length ?? 0
  const sub: Record<NonNullable<MorePage>, string> = {
    flood: 'Screening for a place: rain + terrain + drainage',
    rivers: rivers.data ? (high ? `${high} of ${rivers.data.length} gauges high` : `${rivers.data.length} gauges nearby`) : rivers.state === 'loading' ? 'loading…' : 'Gauges and flood stages nearby',
    station: station.data ? `${station.data.name} · ${timeAgo(station.data.observedAt, now)}` : station.state === 'loading' ? 'loading…' : 'not loaded',
    settings: `${units === 'imperial' ? 'Imperial' : 'Metric'} · motion · data budget`,
  }
  return (
    <section className="screen more" aria-label="More">
      <div className="screen-head">
        <h2>More</h2>
      </div>
      <ul className="more-list">
        {PAGES.map((p) => (
          <li key={p.id}>
            <button className="card more-row" onClick={() => store.set({ morePage: p.id })}>
              <span className="more-icon" aria-hidden="true">
                {p.icon}
              </span>
              <span className="more-main">
                <strong>{p.title}</strong>
                <small className="muted">{sub[p.id!]}</small>
              </span>
              <span className="muted" aria-hidden="true">
                ›
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
