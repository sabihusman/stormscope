import { useEffect, useState } from 'react'
import { FLOOD_CATEGORY_COLORS, FLOOD_CATEGORY_LABELS, FLOOD_STOPS } from '../lib/colors'
import { floodHere, floodKeyFor, riskLabel, riskWord } from '../lib/floodHere'
import type { RainHorizon } from '../types'
import { haversine } from '../lib/geo'
import { clock, timeAgo } from '../lib/time'
import { U, type Units } from '../lib/units'
import { useNow, useReducedMotion, useWide } from '../hooks/useMisc'
import { compass, windLabel } from '../map/StationLayer'
import { describeGauge, openGauge, RISK_COLORS } from '../map/RiversLayer'
import { aggregate, forgetPlaces, go, removeRecent, setLayer, setSavePlacePref, setUnits, store, useApp, useVisibleBlocks, wantFlood, type Block } from '../state/store'
import { REFRESH } from '../state/DataController'
import { splitGauges } from '../lib/rivers'
import { OPEN_METEO_URL, openMeteoBudget, openMeteoCallsToday } from '../api/openMeteo'
import type { Resource } from '../types'

function Freshness({ r, now }: { r: Resource<unknown>; now: number }) {
  if (!r.freshness) return <small className="muted">{r.state === 'loading' ? 'Loading…' : r.error ? r.error : 'not loaded'}</small>
  return (
    <small className={`fresh ${r.stale ? 'stale' : ''}`}>
      {r.freshness.source} · updated {timeAgo(r.freshness.fetchedAt, now)}
      {r.stale ? ' · stale' : ''}
      {r.state === 'loading' ? ' · refreshing…' : ''}
      {r.error ? ` · last refresh failed: ${r.error}` : ''}
    </small>
  )
}

export function UnitsToggle() {
  const units = useApp((s) => s.units)
  return (
    <div className="segmented small" role="radiogroup" aria-label="Units">
      {(['metric', 'imperial'] as Units[]).map((u) => (
        <button key={u} role="radio" aria-checked={units === u} className={units === u ? 'on' : ''} onClick={() => setUnits(u)}>
          {u === 'metric' ? 'Metric · °C km mm' : 'Imperial · °F mi in'}
        </button>
      ))}
    </div>
  )
}

/** Location & privacy in one card: the saved place, the Remember toggle, Forget, and the recent places with × and Clear all. */
function PrivacyCard() {
  const place = useApp((s) => s.place)
  const label = useApp((s) => s.placeLabel)
  const saved = useApp((s) => s.savePlacePref)
  const recent = useApp((s) => s.recentPlaces)
  return (
    <div className="card privacy-card">
      <div className="panel-title">
        <strong>Location &amp; privacy</strong>
      </div>
      <small className="muted">
        {place ? `Current place: ${label ?? place.name}${saved ? ' · remembered on this device' : ' · not remembered (forgotten when you close the app)'}` : 'No place chosen.'} Location access itself is never stored.
      </small>
      <SavePlaceToggle />
      <ForgetControl />
      {recent.length > 0 && (
        <>
          <h4 className="strip-title">Recent places</h4>
          <ul className="recent-settings">
            {recent.map((r) => (
              <li key={r.name}>
                <span>{r.name}</span>
                <button className="btn small ghost" onClick={() => removeRecent(r.name)} aria-label={`Remove ${r.name.split(',')[0]} from recent places`}>
                  Remove ×
                </button>
              </li>
            ))}
          </ul>
          <button className="btn small" onClick={() => recent.forEach((r) => removeRecent(r.name))}>
            Clear all recent places
          </button>
        </>
      )}
    </div>
  )
}

/** "Forget my location and recent places" with a confirm step; back to the first-run choice afterwards. */
export function ForgetControl() {
  const hasAny = useApp((s) => !!s.place || s.recentPlaces.length > 0)
  const [confirming, setConfirming] = useState(false)
  if (!hasAny) return null
  return (
    <div className="forget-inline" role="group" aria-label="Forget my location and recent places">
      {confirming ? (
        <>
          <small className="muted">Forget the saved place and the recent places on this device? Units, layers and other settings stay.</small>
          <div className="prompt-actions row">
            <button className="btn small primary" onClick={forgetPlaces}>
              Forget
            </button>
            <button className="btn small" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button className="btn ghost small forget-link" onClick={() => setConfirming(true)}>
          Forget my location and recent places
        </button>
      )}
    </div>
  )
}

/** "Save this place on this device" — the same choice as on the first-run screen. */
export function SavePlaceToggle() {
  const on = useApp((s) => s.savePlacePref)
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={on} onChange={(e) => setSavePlacePref(e.target.checked)} />
      <span>Remember this place on this device{on ? '' : ' (off: the place is forgotten when you close the app)'}</span>
    </label>
  )
}

export function StationPanel() {
  const r = useApp((s) => s.station)
  const units = useApp((s) => s.units)
  const now = useNow()
  const o = r.data
  if (!o)
    return (
      <div className="panel-empty">
        <p>{r.state === 'loading' ? 'Finding the nearest station…' : (r.error ?? 'Pick a location to load observations.')}</p>
      </div>
    )
  const trend = o.pressureTrendHpa3h
  return (
    <div className="panel">
      {/* The observation's age is the headline; when the app fetched it is the smaller line below. */}
      <div className="panel-title obs-head">
        <strong className="obs-headline">
          Observed {timeAgo(o.observedAt, now)} ({clock(o.observedAt)})
          {o.provider === 'weather.gov' ? ` at ${o.stationId}` : ' (model analysis)'}
        </strong>
        <small className="muted obs-station">
          {o.name}
          {o.provider === 'weather.gov' ? ` · ${U.distance(o.distanceM, units)} from your place` : ' · no station nearby'}
        </small>
        <small className="muted obs-fetched">Data fetched {timeAgo(r.freshness?.fetchedAt, now)}{r.freshness?.source ? ` from ${r.freshness.source}` : ''}{r.stale ? ' · stale' : ''}{r.error ? ` · last fetch failed: ${r.error}` : ''}</small>
      </div>
      {o.textDescription && <p className="muted">{o.textDescription}</p>}
      <div className="stat-grid">
        <div className="stat">
          <small>Pressure</small>
          <strong>{U.pressure(o.pressureHpa, units)}</strong>
          {trend != null && <small className="muted">{trend > 0.5 ? '↑ rising' : trend < -0.5 ? '↓ falling' : '→ steady'} over 3 h</small>}
        </div>
        <div className="stat">
          <small>Humidity</small>
          <strong>{o.humidityPct == null ? '—' : `${o.humidityPct.toFixed(0)} %`}</strong>
        </div>
        <div className="stat">
          <small>Wind{o.provider === 'weather.gov' ? ' · measured' : ' · model'}</small>
          <strong>{windLabel(o, units)}</strong>
          {o.windDirDeg != null && o.windSpeedMs != null && o.windSpeedMs >= 0.3 && (
            <small className="muted">
              {o.windDirDeg.toFixed(0)}° ({compass(o.windDirDeg)})
            </small>
          )}
        </div>
        <div className="stat">
          <small>Temperature{o.provider === 'weather.gov' ? ' · measured' : ' · model'}</small>
          <strong>{U.temp(o.tempC, units)}</strong>
        </div>
        <div className="stat wide">
          <small>Precipitation totals</small>
          {o.precip.lastHourMm == null && o.precip.last3hMm == null && o.precip.last6hMm == null && o.precip.last24hMm == null && (
            <small className="muted">Not reported by this station (usually means none fell)</small>
          )}
          <div className="precip-row">
            <span>
              <small className="muted">1 h</small> {U.precip(o.precip.lastHourMm, units)}
            </span>
            <span>
              <small className="muted">3 h</small> {U.precip(o.precip.last3hMm, units)}
            </span>
            <span>
              <small className="muted">6 h</small> {U.precip(o.precip.last6hMm, units)}
            </span>
            {o.precip.last24hMm != null && (
              <span>
                <small className="muted">24 h</small> {U.precip(o.precip.last24hMm, units)}
              </span>
            )}
          </div>
        </div>
      </div>
      <small className="muted">The app fetches every {REFRESH.station / 60000} min and when you return to it; the station itself reports about once an hour, so the observation above can be older than the last fetch.</small>
    </div>
  )
}

export function RiversPanel() {
  const r = useApp((s) => s.rivers)
  const tier = useApp((s) => s.riversTier)
  const place = useApp((s) => s.place)
  const units = useApp((s) => s.units)
  const now = useNow()
  // Both sources in (the full tier) before any count is published: the summary tier alone would show a number that jumps.
  const list = tier === 'full' ? r.data : null
  const { current, stale } = splitGauges(list, now)
  // NOAA's gauges while USGS and NOAA's details load (no count yet: it would jump when the full list lands).
  const provisional = !list && tier === 'summary' && r.data?.length ? splitGauges(r.data, now).current : null
  const high = current.filter((g) => g.riskLevel === 'high' || g.riskLevel === 'flooding').length
  const sources = list ? [...new Set(list.flatMap((g) => g.sources))].map((s) => s.replace('NOAA NWPS', 'NOAA')).join(' + ') : ''
  const gaugeRows = (gs: typeof current) => (
    <ul className="gauge-list">
      {gs.map((g) => (
            <li key={g.id}>
              <button
                className="gauge-row"
                onClick={() => openGauge(g, true)}
              >
                <i className="dot" style={{ background: RISK_COLORS[g.riskLevel] }} />
                <div className="gauge-main">
                  <span>{g.name}</span>
                  <small className="muted">
                    {place ? U.distance(haversine(place.lngLat, g.lngLat), units) : ''} · {g.sources.join(' + ')} ·{' '}
                    <span style={{ color: FLOOD_CATEGORY_COLORS[g.floodCategory] }}>{FLOOD_CATEGORY_LABELS[g.floodCategory] ?? g.floodCategory}</span>
                  </small>
                  <small className="muted">{describeGauge(g, units)[0]}</small>
                </div>
              </button>
            </li>
      ))}
    </ul>
  )
  return (
    <div className="panel">
      <div className="panel-title">
        <strong>River gauges nearby</strong>
        <Freshness r={r} now={now} />
      </div>
      {!list && provisional ? (
        <>
          <p className="gauge-headline muted" aria-busy="true">
            NOAA gauges below · adding USGS gauges and NOAA flood stages…
          </p>
          {gaugeRows(provisional)}
        </>
      ) : !list ? (
        <p className="muted" aria-busy="true">{r.state === 'loading' || (r.data && tier !== 'full') ? 'Loading gauges (NOAA and USGS)…' : (r.error ?? 'Pick a location.')}</p>
      ) : list.length === 0 ? (
        <p className="muted">{r.error ?? `No stream gauges within ${U.distance(40_000, units)}.`}</p>
      ) : (
        <>
          <p className="gauge-headline">
            <strong>{current.length} current gauge{current.length === 1 ? '' : 's'}</strong> ({sources}) · {high ? `${high} high` : 'none high'}
            {stale.length ? <span className="muted"> · {stale.length} stale or out of service below</span> : ''}
          </p>
          {gaugeRows(current)}
          {stale.length > 0 && (
            <>
              <h4 className="strip-title gauge-stale-title">Stale or out of service ({stale.length})</h4>
              <small className="muted">No reading in the last 24 hours, or marked out of service — not in the count above.</small>
              {gaugeRows(stale)}
            </>
          )}
        </>
      )}
    </div>
  )
}

/** The note after "computed …": still refining, drainage missing here, or the drainage request failed (said as such). */
function floodNote(d: { preliminary?: boolean; drainageAvailable: boolean }, flowlinesError: string | null | undefined): string {
  if (d.preliminary) return ' · refining… (rain only while the terrain and drainage data load)'
  if (d.drainageAvailable) return ''
  if (flowlinesError && !flowlinesError.includes('only available in the US')) return ` · stream data unavailable right now (${flowlinesError}) — this score is terrain + rain only`
  return ' · drainage not available here — terrain + rain only'
}

export function FloodPanel() {
  const place = useApp((s) => s.place)
  const label = useApp((s) => s.placeLabel)
  const floodFor = useApp((s) => s.floodFor)
  const block = useApp((s) => (s.floodFor ? s.blocks[s.floodFor] : undefined))
  const horizon = useApp((s) => s.rainHorizon)
  const units = useApp((s) => s.units)
  const floodOnMap = useApp((s) => s.layers.flood)
  const wide = useWide()
  const now = useNow()
  // Ask the controller for the place's finest block while this page is open.
  const wantKey = place ? floodKeyFor(place.lngLat) : null
  useEffect(() => {
    wantFlood('panel', wantKey)
    return () => wantFlood('panel', null)
  }, [wantKey])
  if (!place)
    return (
      <div className="panel-empty">
        <p>Pick a place to screen it for flood risk.</p>
        <button className="btn small" onClick={() => store.set({ pickerOpen: true })}>
          Pick a place
        </button>
      </div>
    )
  const d = block?.flood.data
  const grid = block?.grid
  const cells = d?.cells ?? []
  const here = floodHere(block?.flood, place.lngLat)
  const counts = FLOOD_STOPS.slice(1).map((s, i, arr) => ({ label: s.label, color: s.color, n: cells.filter((c) => c.risk >= s.value && (i + 1 >= arr.length || c.risk < arr[i + 1].value)).length }))
  const name = (label ?? place.name).split(',')[0]
  // A switch, not a door: the flood layer goes on (one forecast overlay at a time) or off, the button says which,
  // and the panel stays open. "Open the map" is its own button; the map's Layers menu has the same switch.
  const toggleFloodLayer = () => {
    if (floodOnMap) setLayer('flood', false)
    else store.set((s) => ({ layers: { ...s.layers, flood: true, rainfall: false, nowcast: false } }))
  }
  const openMap = () => {
    go('map')
    const m = (window as unknown as { __map?: { easeTo: (o: object) => void } }).__map
    m?.easeTo({ center: [place.lngLat.lng, place.lngLat.lat], zoom: 11, duration: 600 })
  }
  return (
    <div className="panel flood-page">
      {!here ? (
        <p className="muted" aria-busy="true">
          {block?.flood.error || grid?.error ? `Unavailable — ${block?.flood.error ?? grid?.error}` : floodFor && !block ? 'Preparing…' : 'Computing terrain, drainage and rainfall for this place…'}
        </p>
      ) : (
        <>
          <div className={`card now-card flood-here risk-${riskLabel(here.risk)}`}>
            <div className="cond-main">
              <span className="cond-temp flood-word">{riskWord(here.risk)}</span>
              <div className="cond-text">
                <strong>at {name}</strong>
                <span className="muted">
                  {U.precip(here.rain24, units)} rain next {d!.horizonHours} h ·{' '}
                  {Math.abs(here.relElevation) < 2
                    ? `level with the surrounding ${U.distance(16_100, units)}`
                    : `${here.relElevation < 0 ? 'low ground' : 'high ground'}: ${U.height(Math.abs(here.relElevation), units)} ${here.relElevation < 0 ? 'below' : 'above'} the average of the surrounding ${U.distance(16_100, units)}`}
                  {here.drainageDistM != null ? ` · ${U.distance(here.drainageDistM, units)} to a mapped stream` : ''}
                </span>
              </div>
            </div>
            {/* Why this result, as three plain rows, then the elevation figure explained in words. */}
            <dl className="flood-why-rows">
              <div>
                <dt>Rain</dt>
                <dd>{U.precip(here.rain24, units)} in the next {d!.horizonHours} h</dd>
              </div>
              <div>
                <dt>Ground height</dt>
                <dd>{Math.abs(here.relElevation) < 2 ? 'level with nearby ground' : `about ${U.height(Math.abs(here.relElevation), units)} ${here.relElevation < 0 ? 'lower' : 'higher'} than the average nearby ground`}</dd>
              </div>
              <div>
                <dt>Nearest mapped stream</dt>
                <dd>{here.drainageDistM != null ? `${U.distance(here.drainageDistM, units)} away` : d!.drainageAvailable ? 'none within the screened area' : 'drainage data not available here'}</dd>
              </div>
            </dl>
            <p className="muted flood-why">
              {Math.abs(here.relElevation) < 2
                ? `${name} sits level with the land around it: "surroundings" means the average elevation of the ${U.distance(16_100, units)} around the place. Level ground neither sheds nor collects water, so the figure neither raises nor lowers the risk.`
                : here.relElevation < 0
                  ? `"Surroundings" means the average elevation of the ${U.distance(16_100, units)} around the place; ${name} sits ${U.height(Math.abs(here.relElevation), units)} below it. Rain runs downhill and collects on low ground, so a place this far below its surroundings floods more easily — that is why the figure raises the risk.`
                  : `"Surroundings" means the average elevation of the ${U.distance(16_100, units)} around the place; ${name} sits ${U.height(here.relElevation, units)} above it. Rain runs off high ground rather than collecting on it, so the figure lowers the risk.`}
            </p>
            <small className="muted cond-foot">
              Indicative screening, not an official flood warning · computed {timeAgo(d!.computedAt, now)}
              {floodNote(d!, block?.flowlines.error)}
            </small>
          </div>
          <div className="segmented small" role="radiogroup" aria-label="Rain horizon">
            {([6, 12, 24, 48] as RainHorizon[]).map((h) => (
              <button key={h} role="radio" aria-checked={horizon === h} className={horizon === h ? 'on' : ''} onClick={() => store.set({ rainHorizon: h, rainFrame: 0 })}>
                next {h} h
              </button>
            ))}
          </div>
          <h4 className="strip-title">Around {name} (≈{U.distance(55_000, units)} box)</h4>
          <div className="stat-grid three">
            {counts.map((c) => (
              <div className="stat" key={c.label}>
                <small>
                  <i className="dot inline" style={{ background: c.color }} /> {c.label}
                </small>
                <strong>{c.n}</strong>
                <small className="muted">cells</small>
              </div>
            ))}
          </div>
          <div className="map-toggle-row">
            <button className={`btn small map-toggle ${floodOnMap ? 'on' : ''}`} aria-pressed={floodOnMap} data-toggle="flood" onClick={toggleFloodLayer}>
              Flood layer on map: {floodOnMap ? 'On' : 'Off'}
            </button>
            {!wide && floodOnMap && (
              <button className="btn small" onClick={openMap}>
                Open the map ›
              </button>
            )}
          </div>
          <details className="method">
            <summary>How this is scored</summary>
            <p className="muted">
              Cells of ≈{U.distance(2300, units)} from: forecast rainfall over the horizon (Open-Meteo), elevation relative to the surroundings (AWS terrain tiles) and geodesic distance to mapped drainage (
              {d!.drainageAvailable ? `${d!.flowlineCount} USGS NHD flowlines` : 'not available here — terrain + rain only'}). Rain gates everything; terrain and drainage modulate it. The horizon follows the Rain timeline.
              {block?.flowlines.data?.bytes != null ? ` Drainage for this place is saved on this device (${Math.max(1, Math.round(block.flowlines.data.bytes / 1024))} KB, kept 30 days${block.flowlines.data.saved ? ', used on this load' : ''}).` : ''}
            </p>
          </details>
        </>
      )}
    </div>
  )
}

export function SourcesPanel() {
  const radar = useApp((s) => s.radar)
  const satellite = useApp((s) => s.satellite)
  const blocks = useVisibleBlocks()
  const rivers = useApp((s) => s.rivers)
  const station = useApp((s) => s.station)
  const alerts = useApp((s) => s.alerts)
  const conditions = useApp((s) => s.conditions)
  const monitorsNear = useApp((s) => s.monitorsNear)
  const reduced = useReducedMotion()
  const now = useNow()
  // Block products are rolled up into one synthetic resource each.
  const roll = (pick: (b: Block) => Resource<unknown>, source: string, url: string): Resource<unknown> => {
    const a = aggregate(blocks, pick)
    return {
      state: a.state,
      data: a.ready ? true : null,
      error: a.error,
      stale: a.stale,
      freshness: a.fetchedAt ? { fetchedAt: a.fetchedAt, source: `${source} (${a.ready}/${a.total} blocks)`, sourceUrl: url } : null,
    }
  }
  const rows: { name: string; r: Resource<unknown>; cadence?: number }[] = [
    { name: 'Radar', r: radar, cadence: REFRESH.radar },
    { name: 'Satellite (GOES)', r: satellite, cadence: REFRESH.satellite },
    { name: 'Forecast blocks (rain / cloud / wind)', r: roll((b) => b.grid, 'Open-Meteo', OPEN_METEO_URL), cadence: REFRESH.grid },
    { name: 'Rainfall accumulation', r: roll((b) => b.rainCells, 'Open-Meteo, derived', OPEN_METEO_URL) },
    { name: 'Nowcast', r: roll((b) => b.nowcast, 'Open-Meteo, advected in-app', OPEN_METEO_URL) },
    { name: 'Drainage (NHD)', r: roll((b) => b.flowlines, 'USGS NHD', 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer') },
    { name: 'Flood risk', r: roll((b) => b.flood, 'Derived: rain + terrain + NHD', 'https://registry.opendata.aws/terrain-tiles/') },
    { name: 'River gauges', r: rivers, cadence: REFRESH.rivers },
    { name: 'Station', r: station, cadence: REFRESH.station },
    // What Now shows besides the station and gauges, so the status row's "everything on Now checked within …" can
    // be checked here, row by row.
    { name: 'NWS alerts', r: alerts, cadence: REFRESH.alerts },
    { name: 'Forecast for the place (Now)', r: conditions, cadence: REFRESH.conditions },
    { name: 'Air monitors near the place', r: monitorsNear, cadence: REFRESH.monitorsNear },
  ]
  return (
    <div className="panel">
      <div className="panel-title">
        <strong>Settings</strong>
      </div>
      <UnitsToggle />
      <small className="muted">Motion: {reduced ? 'reduced (from your system setting) — animations are simplified' : 'full — set “reduce motion” in your OS to simplify animations'}</small>

      <PrivacyCard />

      <div className="panel-title" style={{ marginTop: 8 }}>
        <strong>Data sources &amp; freshness</strong>
        <button className="btn small" onClick={() => store.set((x) => ({ refreshNonce: x.refreshNonce + 1 }))}>
          Refresh all now
        </button>
      </div>
      <small className="muted fresh-key">“Fetched” is when the app asked; “observed” or “reading” is when the measurement itself was taken. The first never stands in for the second.</small>
      <ul className="source-list">
        {rows.map(({ name, r, cadence }) => (
          <li key={name}>
            <i className={`dot ${r.state === 'error' ? 'err' : r.stale ? 'warn' : r.state === 'ready' ? 'ok' : r.state === 'loading' ? 'load' : ''}`} />
            <div>
              <span>{name}</span>
              <br />
              {r.freshness ? (
                <small className="muted">
                  <a href={r.freshness.sourceUrl.split(' ')[0]} target="_blank" rel="noopener noreferrer">
                    {r.freshness.source}
                  </a>{' '}
                  · fetched {timeAgo(r.freshness.fetchedAt, now)}
                  {r.freshness.dataTime ? ` · data time ${timeAgo(r.freshness.dataTime, now)}` : ''}
                  {cadence ? ` · every ${cadence / 60000} min` : ''}
                  {r.error ? ` · ${r.error}` : ''}
                </small>
              ) : (
                <small className="muted">{r.state === 'loading' ? 'loading…' : (r.error ?? 'off / not loaded')}</small>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="muted">
        Open-Meteo budget (free tier, per IP): <strong>{openMeteoCallsToday().toLocaleString()}</strong> / 10 000 calls today from this browser · {openMeteoBudget()} in the last minute (limit 600).
        Every forecast location counts as one call; a full 16-block view is 784 and refreshes every 30 min while the tab is visible.
      </p>
      <p className="muted">
        Basemap ©{' '}
        <a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer">
          OpenFreeMap
        </a>{' '}
        / OpenStreetMap contributors. Terrain: AWS Terrain Tiles (Mapzen). Geocoding: Open-Meteo &amp; Nominatim.
      </p>
    </div>
  )
}
