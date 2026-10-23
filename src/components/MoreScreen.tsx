import { useState } from 'react'
import { useNow } from '../hooks/useMisc'
import { Credits } from './Credits'
import { timeAgo } from '../lib/time'
import { forgetPlaces, store, useApp, type MorePage } from '../state/store'
import { ErrorBoundary } from './ErrorBoundary'
import { FloodPanel, RiversPanel, SourcesPanel, StationPanel } from './Panels'
import { PlaceRow } from './PlaceRow'

const PAGES: { id: MorePage; icon: string; title: string }[] = [
  { id: 'flood', icon: '🌊', title: 'Flood risk' },
  { id: 'rivers', icon: '📈', title: 'Rivers & gauges' },
  { id: 'station', icon: '🌡', title: 'Station observations' },
  { id: 'settings', icon: 'ℹ', title: 'Sources, freshness & settings' },
  { id: 'about', icon: '©', title: 'About / Credits' },
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
      {page !== 'settings' && page !== 'about' && <PlaceRow />}
      <ErrorBoundary key={page} kind="panel" name={meta.title}>
        <div className="page-body">
          {page === 'flood' && <FloodPanel />}
          {page === 'rivers' && <RiversPanel />}
          {page === 'station' && <StationPanel />}
          {page === 'settings' && <SourcesPanel />}
          {page === 'about' && <AboutPanel />}
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
  // The same NOAA count as the Now tile (the page itself lists the USGS-only sites as well).
  const noaa = rivers.data?.filter((g) => !!g.lid) ?? null
  const high = noaa?.filter((g) => g.riskLevel === 'high' || g.riskLevel === 'flooding').length ?? 0
  const sub: Record<NonNullable<MorePage>, string> = {
    flood: 'Screening for a place: rain + terrain + drainage',
    rivers: noaa ? (high ? `${high} of ${noaa.length} NOAA gauges high` : `${noaa.length} NOAA gauges nearby`) : rivers.state === 'loading' ? 'loading…' : 'Gauges and flood stages nearby',
    station: station.data ? `${station.data.name} · ${timeAgo(station.data.observedAt, now)}` : station.state === 'loading' ? 'loading…' : 'not loaded',
    settings: `${units === 'imperial' ? 'Imperial' : 'Metric'} · motion · data budget`,
    about: 'Map and data sources, with credits',
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
      <ForgetRow />
    </section>
  )
}

/** Forget the saved place and the recent places on this device, with a short confirm step. */
function ForgetRow() {
  const [confirming, setConfirming] = useState(false)
  const hasAny = useApp((s) => !!s.place || s.recentPlaces.length > 0)
  if (!hasAny) return null
  return (
    <div className="card forget-row" role="group" aria-label="Forget my location and recent places">
      {confirming ? (
        <>
          <p className="muted">Forget the saved place and the recent places on this device? Units, layers and other settings stay. Your browser's own location permission is not changed.</p>
          <div className="prompt-actions row">
            <button className="btn primary" onClick={forgetPlaces}>
              Forget
            </button>
            <button className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button className="btn ghost" onClick={() => setConfirming(true)}>
          Forget my location and recent places
        </button>
      )}
    </div>
  )
}

/** About / Credits: what StormScope is and every source it draws on. */
function AboutPanel() {
  return (
    <div className="card">
      <p className="muted">StormScope shows measured and forecast weather, water and air data from the public services below. Map data © OpenStreetMap contributors.</p>
      <Credits />
    </div>
  )
}
