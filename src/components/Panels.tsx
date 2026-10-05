import { FLOOD_CATEGORY_COLORS, FLOOD_CATEGORY_LABELS, FLOOD_STOPS } from '../lib/colors'
import { haversine } from '../lib/geo'
import { timeAgo } from '../lib/time'
import { U, type Units } from '../lib/units'
import { useNow, useReducedMotion } from '../hooks/useMisc'
import { compass, windLabel } from '../map/StationLayer'
import { describeGauge, RISK_COLORS } from '../map/RiversLayer'
import { aggregate, setUnits, store, useApp, useVisibleBlocks, type Aggregate, type Block } from '../state/store'
import { REFRESH } from '../state/DataController'
import { OPEN_METEO_URL, openMeteoBudget, openMeteoCallsToday } from '../api/openMeteo'
import type { Resource } from '../types'

function AggFreshness({ a, now, source }: { a: Aggregate; now: number; source: string }) {
  if (!a.fetchedAt) return <small className="muted">{a.state === 'loading' ? 'loading…' : a.error ? a.error : a.total === 0 ? 'zoom in to load blocks' : 'not loaded'}</small>
  return (
    <small className={`fresh ${a.stale ? 'stale' : ''}`}>
      {source} · {a.ready}/{a.total} blocks · updated {timeAgo(a.fetchedAt, now)}
      {a.stale ? ' · stale' : ''}
      {a.error ? ` · ${a.error}` : ''}
    </small>
  )
}

function Freshness({ r, now }: { r: Resource<unknown>; now: number }) {
  if (!r.freshness) return <small className="muted">{r.state === 'loading' ? 'loading…' : r.error ? r.error : 'not loaded'}</small>
  return (
    <small className={`fresh ${r.stale ? 'stale' : ''}`}>
      {r.freshness.source} · updated {timeAgo(r.freshness.fetchedAt, now)}
      {r.stale ? ' · stale' : ''}
      {r.error ? ` · last refresh failed: ${r.error}` : ''}
    </small>
  )
}

function LayerOff({ what, id }: { what: string; id: 'station' | 'rivers' | 'flood' }) {
  return (
    <div className="panel-empty">
      <p>The {what} layer is off.</p>
      <button className="btn small" onClick={() => store.set((s) => ({ layers: { ...s.layers, [id]: true } }))}>
        Turn on {what}
      </button>
    </div>
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

export function StationPanel() {
  const r = useApp((s) => s.station)
  const enabled = useApp((s) => s.layers.station)
  const units = useApp((s) => s.units)
  const focus = useApp((s) => s.focus)
  const place = useApp((s) => s.place)
  const now = useNow()
  const following = !!focus && (!place || haversine(focus, place.lngLat) > 1000)
  if (!enabled) return <LayerOff what="station" id="station" />
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
      <div className="panel-title">
        <strong>{o.name}</strong>
        <small className="muted">
          {o.provider === 'weather.gov' ? `${o.stationId} · ${U.distance(o.distanceM, units)} from ${following ? 'the map centre' : 'you'}` : 'Model analysis (no station nearby)'} · observed{' '}
          {timeAgo(o.observedAt, now)}
        </small>
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
          <small>Wind</small>
          <strong>{windLabel(o, units)}</strong>
          {o.windDirDeg != null && o.windSpeedMs != null && o.windSpeedMs >= 0.3 && (
            <small className="muted">
              {o.windDirDeg.toFixed(0)}° ({compass(o.windDirDeg)})
            </small>
          )}
        </div>
        <div className="stat">
          <small>Temperature</small>
          <strong>{U.temp(o.tempC, units, 1)}</strong>
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
      <Freshness r={r} now={now} />
      <small className="muted">Auto-refreshes every {REFRESH.station / 60000} min and when you return to the app.</small>
    </div>
  )
}

export function RiversPanel() {
  const r = useApp((s) => s.rivers)
  const place = useApp((s) => s.place)
  const enabled = useApp((s) => s.layers.rivers)
  const units = useApp((s) => s.units)
  const now = useNow()
  if (!enabled) return <LayerOff what="rivers" id="rivers" />
  const list = r.data
  return (
    <div className="panel">
      <div className="panel-title">
        <strong>River gauges nearby</strong>
        <Freshness r={r} now={now} />
      </div>
      {!list ? (
        <p className="muted">{r.state === 'loading' ? 'Loading gauges…' : (r.error ?? 'Pick a location.')}</p>
      ) : list.length === 0 ? (
        <p className="muted">{r.error ?? `No stream gauges within ${U.distance(40_000, units)}.`}</p>
      ) : (
        <ul className="gauge-list">
          {list.map((g) => (
            <li key={g.id}>
              <button
                className="gauge-row"
                onClick={() =>
                  store.set({
                    selection: {
                      kind: 'gauge',
                      lngLat: g.lngLat,
                      title: g.name,
                      lines: [`${FLOOD_CATEGORY_LABELS[g.floodCategory] ?? g.floodCategory} · risk: ${g.riskLevel}`, ...describeGauge(g, units)],
                      source: g.sources.join(' + '),
                      updated: r.freshness?.fetchedAt,
                    },
                    sheet: 'peek',
                  })
                }
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
      )}
    </div>
  )
}

export function FloodPanel() {
  const blocks = useVisibleBlocks()
  const enabled = useApp((s) => s.layers.flood)
  const horizon = useApp((s) => s.rainHorizon)
  const units = useApp((s) => s.units)
  const now = useNow()
  if (!enabled) return <LayerOff what="flood risk" id="flood" />
  const agg = aggregate(blocks, (b) => b.flood)
  const gridAgg = aggregate(blocks, (b) => b.grid)
  const first = blocks.find((b) => b.flood.data)
  const d = first
    ? {
        cells: blocks.flatMap((b) => b.flood.data?.cells ?? []),
        horizonHours: first.flood.data!.horizonHours,
        drainageAvailable: blocks.some((b) => b.flood.data?.drainageAvailable),
        flowlineCount: blocks.reduce((n, b) => n + (b.flood.data?.flowlineCount ?? 0), 0),
      }
    : null
  const fl = { error: blocks.find((b) => b.flowlines.error)?.flowlines.error ?? null }
  const counts = d
    ? FLOOD_STOPS.slice(1).map((s, i, arr) => ({
        label: s.label,
        color: s.color,
        n: d.cells.filter((c) => c.risk >= s.value && (i + 1 >= arr.length || c.risk < arr[i + 1].value)).length,
      }))
    : []
  const maxRain = d ? Math.max(0, ...d.cells.map((c) => c.rain24)) : 0
  return (
    <div className="panel">
      <div className="panel-title">
        <strong>Flood-risk screening</strong>
        <AggFreshness a={agg} now={now} source="Derived: Open-Meteo rain + AWS terrain + USGS NHD" />
      </div>
      {!d ? (
        <p className="muted">
          {blocks.length === 0
            ? 'Zoom in to a region to load forecast blocks.'
            : agg.state === 'loading' || gridAgg.state === 'loading'
              ? 'Computing terrain, drainage and rainfall…'
              : (agg.error ?? gridAgg.error ?? 'Pick a location.')}
        </p>
      ) : (
        <>
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
          {counts.every((c) => c.n === 0) && (
            <p className="muted">
              No cells reach the elevated threshold — the most rain forecast anywhere in the box over the next {d.horizonHours} h is {U.precip(maxRain, units)}.
            </p>
          )}
          <p className="muted">
            Next <strong>{d.horizonHours} h</strong> across {agg.ready} forecast block{agg.ready === 1 ? '' : 's'} ({d.cells.length.toLocaleString()} cells of ≈{U.distance(2300, units)}–{U.distance(7000, units)}) from: forecast
            rainfall (Open-Meteo), elevation relative to the surroundings (AWS terrain tiles) and geodesic distance to mapped drainage ({d.drainageAvailable ? `${d.flowlineCount} USGS NHD flowlines` : 'not available here — terrain + rain only'}).
            {fl.error && !d.drainageAvailable ? ` ${fl.error}.` : ''} The horizon follows the Rainfall timeline (now {horizon} h). Indicative screening only — not an official
            flood warning.
          </p>
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
  ]
  return (
    <div className="panel">
      <div className="panel-title">
        <strong>Settings</strong>
      </div>
      <UnitsToggle />
      <small className="muted">Motion: {reduced ? 'reduced (from your system setting) — animations are simplified' : 'full — set “reduce motion” in your OS to simplify animations'}</small>

      <div className="panel-title" style={{ marginTop: 8 }}>
        <strong>Data sources &amp; freshness</strong>
        <button className="btn small" onClick={() => store.set((x) => ({ refreshNonce: x.refreshNonce + 1 }))}>
          Refresh all now
        </button>
      </div>
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
