import { useEffect, useLayoutEffect, useRef } from 'react'
import { useNow, useOnline, useWide } from '../hooks/useMisc'
import { haversine } from '../lib/geo'
import { floodHere, floodKeyFor, riskWord } from '../lib/floodHere'
import { clock, timeAgo } from '../lib/time'
import { U } from '../lib/units'
import { wmo } from '../lib/wmo'
import { compass } from '../map/StationLayer'
import { go, setLayer, startPickOnMap, store, useApp, wantFlood } from '../state/store'
import { REPLAY_IN_URL } from '../state/DataController'
import type { NwsAlert } from '../types'
import { PlaceRow } from './PlaceRow'

interface Props {
  onLocate: () => void
  locating: boolean
}

/**
 * Home: the answer for the place, in this order — active alerts, current conditions,
 * next 12 hours, a window onto the live map, then Trip and the reference tiles.
 */
export function NowScreen({ onLocate, locating }: Props) {
  const place = useApp((s) => s.place)
  const online = useOnline()
  return (
    <section className="screen now" aria-label="Now">
      {!online && <div className="banner offline">Offline — showing the last saved data</div>}
      {!place ? (
        <NoPlace onLocate={onLocate} locating={locating} />
      ) : (
        <>
          <PlaceRow />
          <AlertsCard />
          <ConditionsCard />
          <HourlyCard />
          <MapWindow />
          <div className="now-actions">
            <button className="btn primary" onClick={() => go('trip')}>
              Plan a trip
            </button>
          </div>
          <Tiles />
        </>
      )}
    </section>
  )
}

function NoPlace({ onLocate, locating }: Props) {
  return (
    <div className="card now-card">
      <h2>Where are you?</h2>
      <p className="muted">Conditions, warnings and radar for your place. Your location stays on this device.</p>
      <div className="prompt-actions">
        <button className="btn primary" onClick={onLocate} disabled={locating}>
          {locating ? 'Locating…' : '◎ Use my location'}
        </button>
        <button className="btn" onClick={() => store.set({ pickerOpen: true })}>
          🔍 Search for a place
        </button>
        <button className="btn" onClick={startPickOnMap}>
          🗺 Pick a point on the map
        </button>
      </div>
    </div>
  )
}

const SEV_CLASS: Record<NwsAlert['severity'], string> = { Extreme: 'sev-extreme', Severe: 'sev-severe', Moderate: 'sev-moderate', Minor: 'sev-minor', Unknown: 'sev-minor' }

function AlertsCard() {
  const r = useApp((s) => s.alerts)
  const now = useNow()
  const retry = () => store.set((x) => ({ refreshNonce: x.refreshNonce + 1 }))
  if (r.state === 'loading' && !r.data) return <div className="card now-card alerts quiet" aria-busy="true">Checking NWS alerts…</div>
  if (!r.data) return <div className="card now-card alerts err">Alerts unavailable — {r.error ?? 'not loaded'} <button className="btn small" onClick={retry}>Retry</button></div>
  if (r.data.coverage === 'outside-us') return <div className="card now-card alerts quiet">Alerts unavailable outside the US (NWS covers US territory only)</div>
  const list = r.data.alerts
  if (!list.length)
    return (
      <div className="card now-card alerts quiet">
        No active NWS alerts for this place · checked {timeAgo(r.freshness?.fetchedAt, now)}
        {r.error ? ` · last refresh failed: ${r.error}` : ''}
      </div>
    )
  return (
    <div className="now-alerts" role="region" aria-label="Active alerts">
      {list.slice(0, 3).map((a) => (
        <details key={a.id} className={`card now-card alert ${SEV_CLASS[a.severity]}`}>
          <summary>
            <span className="alert-icon" aria-hidden="true">
              ⚠
            </span>
            <span className="alert-main">
              <strong>{a.event}</strong>
              <small>
                {a.ends ? `until ${clock(a.ends)}` : a.expires ? `expires ${clock(a.expires)}` : ''}
                {a.senderName ? ` · ${a.senderName.replace(/^NWS /, 'NWS ')}` : ''}
              </small>
            </span>
          </summary>
          <p className="alert-body">{a.headline}</p>
          {a.description && <p className="alert-body muted">{a.description.slice(0, 900)}{a.description.length > 900 ? '…' : ''}</p>}
          {a.instruction && <p className="alert-body"><strong>What to do:</strong> {a.instruction}</p>}
        </details>
      ))}
      {list.length > 3 && <small className="muted">+{list.length - 3} more active products</small>}
      <small className="muted">NWS · checked {timeAgo(r.freshness?.fetchedAt, now)}</small>
    </div>
  )
}

function ConditionsCard() {
  const r = useApp((s) => s.conditions)
  const station = useApp((s) => s.station)
  const place = useApp((s) => s.place)
  const units = useApp((s) => s.units)
  const now = useNow()
  const retry = () => store.set((x) => ({ refreshNonce: x.refreshNonce + 1 }))
  const c = r.data?.current
  if (!c)
    return (
      <div className="card now-card conditions" aria-busy={r.state === 'loading'}>
        {r.state === 'loading' || r.state === 'idle' ? (
          <>
            <div className="skeleton w60" />
            <div className="skeleton tall w40" />
            <div className="skeleton w80" />
          </>
        ) : (
          <p className="err-text">
            Conditions unavailable — {r.error}{' '}
            <button className="btn small" onClick={retry}>
              Retry
            </button>
          </p>
        )}
      </div>
    )
  const w = wmo(c.code, c.isDay)
  // Observed line: only a real station reading that is fresh (< 30 min) and close (< 10 mi / 16 km).
  const o = station.data
  const observed = o && o.provider === 'weather.gov' && place && now - o.observedAt < 30 * 60_000 && haversine(place.lngLat, o.lngLat) < 16_093 && o.tempC != null ? o : null
  return (
    <div className={`card now-card conditions ${r.stale ? 'stale' : ''}`}>
      <div className="cond-main">
        <span className="cond-temp">{U.temp(c.tempC, units)}</span>
        <div className="cond-text">
          <strong>
            <span aria-hidden="true">{w.icon}</span> {w.label}
          </strong>
          <span className="muted">
            Feels like {U.temp(c.apparentC, units)} · wind {c.windDirDeg != null ? compass(c.windDirDeg) + ' ' : ''}
            {U.speed(c.windMs, units)}
            {c.gustMs != null && c.gustMs >= 11 ? `, gusts ${U.speed(c.gustMs, units)}` : ''}
            {c.precipMm ? ` · rain ${U.precip(c.precipMm, units)}/h` : ''}
            {c.humidityPct != null ? ` · humidity ${Math.round(c.humidityPct)} %` : ''}
          </span>
        </div>
      </div>
      {observed && (
        <div className="cond-observed">
          Observed {U.temp(observed.tempC, units)} at {observed.name}, {timeAgo(observed.observedAt, now)}
        </div>
      )}
      <small className="muted cond-foot">
        Open-Meteo model · updated {timeAgo(r.freshness?.fetchedAt, now)}
        {r.stale ? ' · stale' : ''}
        {r.error ? ` · last refresh failed: ${r.error}` : ''}
      </small>
    </div>
  )
}

function HourlyCard() {
  const r = useApp((s) => s.conditions)
  const units = useApp((s) => s.units)
  const h = r.data?.hourly ?? []
  const next12 = h.slice(0, 12)
  const rain24 = h.slice(0, 24).reduce((a, x) => a + (x.precipMm ?? 0), 0)
  const wide = useWide()
  // Opens the Map with the playback bar running over the next 24 h (on wide layouts the map is already beside this card).
  const openTimeline = () => {
    if (!store.get().layers.rainfall) setLayer('rainfall', true)
    store.set({ rainHorizon: 24, playing: true, playTime: null })
    if (!wide) go('map')
  }
  return (
    <div className="card now-card hourly">
      <h4>Next 12 hours</h4>
      {!next12.length ? (
        <div className="skeleton w100" />
      ) : (
        <ol className="hour-strip" aria-label="Hourly forecast">
          {next12.map((x, i) => {
            const w = wmo(x.code, true)
            return (
              <li key={x.time}>
                <span className="hour-t">{i === 0 ? 'Now' : clock(x.time).replace(/:00/, '')}</span>
                <span className="hour-i" aria-hidden="true">
                  {w.icon}
                </span>
                <span className="hour-temp">{U.temp(x.tempC, units)}</span>
                <span className="hour-p muted">{x.precipMm && x.precipMm >= 0.1 ? U.precip(x.precipMm, units, 1) : x.precipProb != null && x.precipProb >= 20 ? `${Math.round(x.precipProb)} %` : ''}</span>
              </li>
            )
          })}
        </ol>
      )}
      {h.length > 0 && (
        <button className="link-row" onClick={openTimeline}>
          Rain next 24 h: <strong>{U.precip(rain24, units)}</strong> · timeline ›
        </button>
      )}
    </div>
  )
}

/**
 * A window onto the live map: the map stays mounted full-size behind the Now screen and is
 * positioned into this box (App sets the CSS vars from the measured rect). Tap → Map.
 */
function MapWindow() {
  const ref = useRef<HTMLDivElement>(null)
  const place = useApp((s) => s.place)
  useLayoutEffect(() => {
    const el = ref.current
    const app = el?.closest('.app') as HTMLElement | null
    if (!el || !app) return
    const apply = () => {
      const r = el.getBoundingClientRect()
      const a = app.getBoundingClientRect()
      app.style.setProperty('--mw-top', `${r.top - a.top}px`)
      app.style.setProperty('--mw-left', `${r.left - a.left}px`)
      app.style.setProperty('--mw-w', `${r.width}px`)
      app.style.setProperty('--mw-h', `${r.height}px`)
      app.classList.add('has-map-window')
    }
    // Cards above the window appear and grow as data lands, which moves the window without
    // resizing it, so a ResizeObserver on the window alone misses it. Re-measure every frame
    // while mounted; the vars are only written when the rect actually changed (cheap).
    let last = ''
    let raf = 0
    const tick = () => {
      const r = el.getBoundingClientRect()
      const key = `${r.top}|${r.left}|${r.width}|${r.height}`
      if (key !== last) {
        last = key
        apply()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      app.classList.remove('has-map-window')
    }
  }, [])
  useEffect(() => {
    // Centre the window on the place (unless a planned trip owns the camera).
    const m = (window as unknown as { __map?: { easeTo: (o: object) => void; getZoom: () => number } }).__map
    if (!m || !place || store.get().journey.routes.data) return
    m.easeTo({ center: [place.lngLat.lng, place.lngLat.lat], zoom: Math.max(m.getZoom(), 9), duration: 0 })
  }, [place])
  return (
    <div ref={ref} className="now-map-window" role="button" tabIndex={0} aria-label="Open the map" onClick={() => go('map')} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && go('map')}>
      <span className="chip map-open">Open map ›</span>
    </div>
  )
}

function Tiles() {
  const rivers = useApp((s) => s.rivers)
  const tier = useApp((s) => s.riversTier)
  const station = useApp((s) => s.station)
  const units = useApp((s) => s.units)
  const now = useNow()
  // Gauges and the flood screening are fetched only while these tiles are on screen (or their pages / map layers show them).
  const riversTile = useRef<HTMLButtonElement>(null)
  const floodTile = useRef<HTMLButtonElement>(null)
  const place = useApp((s) => s.place)
  const label = useApp((s) => s.placeLabel)
  // Replays drive Trip only: no live screening request for the tile while one is active.
  const replay = useApp((s) => !!s.replay) || REPLAY_IN_URL
  const floodKey = place && !replay ? floodKeyFor(place.lngLat) : null
  const flood = useApp((s) => (floodKey ? s.blocks[floodKey]?.flood : undefined))
  useEffect(() => {
    const el = riversTile.current
    const fl = floodTile.current
    if (!el || !fl || typeof IntersectionObserver === 'undefined') {
      store.set({ riversTileVisible: true })
      wantFlood('tile', floodKey)
      return () => {
        store.set({ riversTileVisible: false })
        wantFlood('tile', null)
      }
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.target === el) store.set({ riversTileVisible: e.isIntersecting })
          if (e.target === fl) wantFlood('tile', e.isIntersecting ? floodKey : null)
        }
      },
      { threshold: 0.5 },
    )
    io.observe(el)
    io.observe(fl)
    return () => {
      io.disconnect()
      store.set({ riversTileVisible: false })
      wantFlood('tile', null)
    }
  }, [floodKey])
  const here = place ? floodHere(flood, place.lngLat) : null
  const placeName = (label ?? place?.name ?? '').split(',')[0]
  const floodLine = here ? `${riskWord(here.risk)} at ${placeName}` : flood?.error ? flood.error : place && !replay ? 'computing…' : 'for this place ›'
  const high = rivers.data?.filter((g) => g.riskLevel === 'high' || g.riskLevel === 'flooding').length ?? 0
  const what = tier === 'full' ? 'gauges' : 'NOAA gauges'
  const riversLine = rivers.data
    ? rivers.data.length
      ? high
        ? `${high} of ${rivers.data.length} ${what} high`
        : `${rivers.data.length} ${what}, none high`
      : (rivers.error ?? 'no gauges nearby')
    : rivers.state === 'loading'
      ? 'loading…'
      : (rivers.error ?? 'nearby gauges ›')
  const o = station.data
  return (
    <div className="tiles">
      <button className="card tile" ref={riversTile} onClick={() => go('more', 'rivers')}>
        <small>📈 Rivers</small>
        <span className={high ? 'warn-text' : ''}>{riversLine}</span>
      </button>
      <button className={`card tile ${here ? `risk-${riskWord(here.risk).toLowerCase()}` : ''}`} ref={floodTile} onClick={() => go('more', 'flood')}>
        <small>🌊 Flood risk</small>
        <span className={here && here.risk >= 0.5 ? 'warn-text' : ''}>{floodLine}</span>
      </button>
      <button className="card tile" onClick={() => go('more', 'station')}>
        <small>🌡 Station</small>
        <span>{o ? `${o.name.split(/,| Airport/)[0]} · ${timeAgo(o.observedAt, now)}` : station.state === 'loading' ? 'loading…' : station.error ?? 'not loaded'}</span>
        {o && <small className="muted">{U.pressure(o.pressureHpa, units)} · {o.humidityPct != null ? `${Math.round(o.humidityPct)} %` : '—'}</small>}
      </button>
      <button className="card tile" onClick={() => go('more', 'settings')}>
        <small>ℹ Sources &amp; settings</small>
        <span>units, freshness ›</span>
      </button>
    </div>
  )
}
