import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import { BASEMAP_STYLE } from '../map/MapView'
import { useOnline } from '../hooks/useMisc'
import { U } from '../lib/units'
import { go, setLiteLoaded, startFullLook, useApp, type LiteBlock } from '../state/store'
import { ErrorBoundary } from './ErrorBoundary'
import { PlaceRow } from './PlaceRow'
import { AirNowCard, AlertsCard, ConditionsCard, DailyCard, HourlyCard, NoPlace, NowSummary, UnitsChip } from './NowScreen'
import { FloodPanel, RiversPanel } from './Panels'

const JourneyPanel = lazy(() => import('./JourneyPanel').then((m) => ({ default: m.JourneyPanel })))

interface Props {
  onLocate: () => void
  locating: boolean
  /** The first-run "Where are you?" dialog is up: the column shows no prompt of its own. */
  promptOpen?: boolean
}

/**
 * Lite's home (the default mode): the answer for the place from what loads on open — the forecast (Now, 12 hours,
 * 7 days, rain next 24 h), NWS alerts and the nearest station's labelled reading — then a small basemap-only map
 * and the More row, where the heavy blocks load one at a time on a tap. No radar, satellite, gauges or layers.
 */
export function LiteScreen({ onLocate, locating, promptOpen = false }: Readonly<Props>) {
  const place = useApp((s) => s.place)
  const online = useOnline()
  return (
    <section className="screen now lite-home" aria-label="Now">
      {!online && <div className="banner offline">Offline — showing the last saved data</div>}
      {!place ? (
        !promptOpen && <NoPlace onLocate={onLocate} locating={locating} />
      ) : (
        <>
          <div className="now-head">
            <PlaceRow />
            <UnitsChip />
          </div>
          <AlertsCard />
          <ConditionsCard />
          <NowSummary />
          <HourlyCard fixedSpan={12} />
          <ErrorBoundary kind="panel" name="7-day forecast">
            <DailyCard />
          </ErrorBoundary>
          <RainCard />
          <ErrorBoundary kind="panel" name="Map">
            <LiteMap />
          </ErrorBoundary>
          <LiteMore />
          <small className="muted lite-foot">Loaded on open: the forecast, NWS alerts and the nearest station · no radar, satellite, gauges or layers</small>
        </>
      )}
    </section>
  )
}

/** Rain expected over the next 24 hours, from the same forecast response as the rest of the page. */
function RainCard() {
  const r = useApp((s) => s.conditions)
  const units = useApp((s) => s.units)
  if (!r.data) return null
  const total = r.data.hourly.slice(0, 24).reduce((a, x) => a + (x.precipMm ?? 0), 0)
  return (
    <div className="card now-card lite-rain">
      <h4>Rain next 24 h</h4>
      <span>
        Total expected <strong>{U.precip(total, units)}</strong>
      </span>
    </div>
  )
}

/**
 * A small live map of the place: the basemap's tiles only — no radar, no layers, no controls. It does not move with a
 * finger; a tap starts a one-time look at Full's map (the saved mode stays Lite).
 */
function LiteMap() {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const place = useApp((s) => s.place)
  const label = useApp((s) => s.placeLabel)
  const [loaded, setLoaded] = useState(false)
  const start = useRef(place)
  useEffect(() => {
    const el = box.current
    const at = start.current
    if (!el || !at) return
    const m = new maplibregl.Map({
      container: el,
      style: BASEMAP_STYLE,
      center: [at.lngLat.lng, at.lngLat.lat],
      zoom: 10,
      interactive: false,
      attributionControl: { compact: true },
      fadeDuration: 0,
    })
    map.current = m
    // Test handle (scripts/lite-check.mjs).
    ;(window as unknown as { __liteMap?: maplibregl.Map }).__liteMap = m
    m.once('load', () => setLoaded(true))
    m.on('error', (e) => {
      if (navigator.onLine) console.warn('[lite map]', (e as unknown as { error?: { message?: string } }).error?.message ?? e)
    })
    return () => {
      m.remove()
      map.current = null
      const w = window as unknown as { __liteMap?: maplibregl.Map }
      if (w.__liteMap === m) delete w.__liteMap
    }
  }, [])
  useEffect(() => {
    if (place) map.current?.jumpTo({ center: [place.lngLat.lng, place.lngLat.lat] })
  }, [place])
  const name = (label ?? place?.name ?? '').split(',')[0]
  return (
    <div className={`now-map-window lite-map ${loaded ? '' : 'loading'}`}>
      <div ref={box} className="lite-map-canvas" aria-hidden="true" />
      <span className="lite-map-pin" aria-hidden="true" />
      {!loaded && (
        <div className="map-loading" aria-live="polite">
          <span className="shimmer" aria-hidden="true" />
          <span className="map-loading-text">Loading map…</span>
        </div>
      )}
      <small className="map-asof">{name ? `${name} · ` : ''}map only, no radar</small>
      {/* The whole box is the button (a real one); the map's credits stay above it and tappable. */}
      <button type="button" className="lite-map-open" aria-label="Open full map (a one-time look at Full)" onClick={() => go('map')}>
        <span className="chip map-open">Open full map ›</span>
      </button>
    </div>
  )
}

const BLOCKS: { id: LiteBlock; title: string; text: string }[] = [
  { id: 'rivers', title: 'Rivers', text: 'Gauges and flood stages nearby' },
  { id: 'flood', title: 'Flood risk', text: 'Scoring + drainage data' },
  { id: 'trip', title: 'Trip', text: 'Routing + road-surface readings' },
  { id: 'air', title: 'Air quality', text: 'EPA monitors, PM2.5 + ozone' },
]

/**
 * The More row: Rivers, Flood, Trip and Air, none loaded until its Load is tapped. A loaded block shows below the
 * row, on this page; Hide unloads it again (its requests stop). The "Full" link is a one-time look at Full.
 */
function LiteMore() {
  const loaded = useApp((s) => s.liteLoaded)
  const any = Object.values(loaded).some(Boolean)
  const [open, setOpen] = useState(any)
  return (
    <>
      <div className="card now-card lite-more">
        <div className="lite-more-head">
          <button type="button" className="lite-more-toggle" aria-expanded={open} aria-controls="lite-more-list" onClick={() => setOpen(!open)}>
            <strong>More: Rivers / Flood / Trip / Air</strong>
            <span className="muted" aria-hidden="true">
              {open ? '⌄' : '›'}
            </span>
          </button>
          <button type="button" className="btn small ghost lite-full-link" onClick={startFullLook} aria-label="Full: a one-time look at the full version (your mode stays Lite)">
            Full ›
          </button>
        </div>
        {open && (
          <div id="lite-more-list">
            <small className="muted">Not loaded yet — tap Load on one. Nothing here makes a request until you do.</small>
            <ul className="lite-blocks">
              {BLOCKS.map((b) => (
                <li key={b.id} data-block={b.id}>
                  <span className="lite-block-main">
                    <strong>{b.title}</strong>
                    <small className="muted">{b.text}</small>
                  </span>
                  <button type="button" className={`btn small ${loaded[b.id] ? '' : 'primary'}`} aria-pressed={loaded[b.id]} aria-label={`${loaded[b.id] ? 'Hide' : 'Load'} ${b.title}`} onClick={() => setLiteLoaded(b.id, !loaded[b.id])}>
                    {loaded[b.id] ? 'Hide' : 'Load'}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {BLOCKS.filter((b) => loaded[b.id]).map((b) => (
        <ErrorBoundary key={b.id} kind="panel" name={b.title}>
          <LoadedBlock id={b.id} title={b.title} />
        </ErrorBoundary>
      ))}
    </>
  )
}

/** A block loaded from the More row, shown with the same panel Full uses for it. */
function LoadedBlock({ id, title }: Readonly<{ id: LiteBlock; title: string }>) {
  if (id === 'air') return <AirNowCard />
  return (
    <section className="card now-card lite-block" aria-label={title} data-block={id}>
      <h4>{title}</h4>
      {id === 'rivers' && <RiversPanel />}
      {id === 'flood' && <FloodPanel />}
      {id === 'trip' && (
        <Suspense fallback={<p className="muted">Loading trip tools…</p>}>
          <JourneyPanel />
        </Suspense>
      )}
    </section>
  )
}
