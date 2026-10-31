import { useEffect, useRef, useState } from 'react'
import { useNow, useOnline, useWide } from '../hooks/useMisc'
import { useHorizontalScroll } from '../hooks/useHorizontalScroll'
import { haversine } from '../lib/geo'
import { AIRNOW_CREDIT, isServiceNotConfigured, type MonitorParameter } from '../api/airnow'
import { aqiCategory } from '../lib/aqi'
import { nearestMeasured } from '../lib/airnowHere'
import { floodHere, floodKeyFor, riskWord } from '../lib/floodHere'
import { clock, readingAge, timeAgo } from '../lib/time'
import { U } from '../lib/units'
import { currentUsgsOnly, reportingNoaa } from '../lib/rivers'
import { wmo } from '../lib/wmo'
import { compass } from '../map/StationLayer'
import { go, setHourlySpan, setLayer, setUnits, startPickOnMap, store, useApp, wantFlood, type HourlySpan } from '../state/store'
import { REPLAY_IN_URL } from '../state/DataController'
import type { DayPoint, NwsAlert } from '../types'
import { ErrorBoundary } from './ErrorBoundary'
import { PlaceRow } from './PlaceRow'

interface Props {
  onLocate: () => void
  locating: boolean
  /** The first-run "Where are you?" dialog is up: the column shows no prompt of its own (one prompt, not two). */
  promptOpen?: boolean
}

/**
 * Home: the answer for the place, in this order — active alerts, current conditions,
 * next 12 hours, a window onto the live map, then Trip and the reference tiles.
 */
export function NowScreen({ onLocate, locating, promptOpen = false }: Props) {
  const place = useApp((s) => s.place)
  const online = useOnline()
  return (
    <section className="screen now" aria-label="Now">
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
          <HourlyCard />
          <ErrorBoundary kind="panel" name="7-day forecast">
            <DailyCard />
          </ErrorBoundary>
          <ErrorBoundary kind="panel" name="Air quality">
            <AirNowCard />
          </ErrorBoundary>
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

/** One-tap °C / °F on the Now screen — the same setting as Sources & settings (client-side conversion only). */
function UnitsChip() {
  const units = useApp((s) => s.units)
  return (
    <div className="segmented small units-chip" role="radiogroup" aria-label="Temperature units">
      <button role="radio" aria-checked={units === 'metric'} className={units === 'metric' ? 'on' : ''} onClick={() => setUnits('metric')}>
        °C
      </button>
      <button role="radio" aria-checked={units === 'imperial'} className={units === 'imperial' ? 'on' : ''} onClick={() => setUnits('imperial')}>
        °F
      </button>
    </div>
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

/** How long the conditions card waits on skeletons before saying what it is waiting for. */
const SLOW_LOAD_MS = 10_000

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
  // A first load that sits on skeletons: after 10 s say what it is waiting for, with a retry.
  const waiting = !c && (r.state === 'loading' || r.state === 'idle')
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!waiting) {
      setSlow(false)
      return
    }
    const t = setTimeout(() => setSlow(true), SLOW_LOAD_MS)
    return () => clearTimeout(t)
  }, [waiting])
  if (!c)
    return (
      <div className="card now-card conditions" aria-busy={r.state === 'loading'}>
        {r.state === 'loading' || r.state === 'idle' ? (
          <>
            <small className="muted loading-label">Loading current conditions…</small>
            <div className="skeleton w60" />
            <div className="skeleton tall w40" />
            <div className="skeleton w80" />
            {slow && (
              <p className="muted slow-note" role="status">
                Still waiting for the forecast service (Open-Meteo) — it is answering slowly.{' '}
                <button className="btn small" onClick={retry}>
                  Retry
                </button>
              </p>
            )}
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
  // Observed line: only a real station reading under an hour old and close (< 10 mi / 16 km); it goes once the
  // reading passes the hour and returns with the next reading under it (the station polls every 10 min).
  const o = station.data
  const observed = o && o.provider === 'weather.gov' && place && now - o.observedAt < 60 * 60_000 && haversine(place.lngLat, o.lngLat) < 16_093 && o.tempC != null ? o : null
  // The moment this card describes, in the place's own zone ("Now · Sat 24 Oct, 10:30 AM").
  let stamp = ''
  try {
    stamp = new Intl.DateTimeFormat([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: r.data!.timezone }).format(new Date(now))
  } catch {
    stamp = new Date(now).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
  }
  return (
    <div className={`card now-card conditions ${r.stale ? 'stale' : ''}`}>
      <small className="muted cond-stamp">Now · {stamp}</small>
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

/**
 * One line that answers "anything to worry about?": active alerts first, else rain expected in the next 24 h, else
 * all clear — with the place's flood screening appended once it has been computed. Reads only what is already loaded.
 */
function NowSummary() {
  const r = useApp((s) => s.conditions)
  const alerts = useApp((s) => s.alerts.data?.alerts.length ?? 0)
  const place = useApp((s) => s.place)
  const flood = useApp((s) => (place ? s.blocks[floodKeyFor(place.lngLat)]?.flood : undefined))
  const units = useApp((s) => s.units)
  // Its slot is reserved while the forecast loads, so nothing below moves when the line appears.
  if (!r.data) return <p className="now-summary placeholder" aria-busy="true" aria-hidden="true" />
  const hours = r.data.hourly.slice(0, 24)
  const rain24 = hours.reduce((a, x) => a + (x.precipMm ?? 0), 0)
  // "Wet" weather codes (WMO): drizzle 51–57, rain 61–67, rain showers 80–82, thunderstorm 95–99.
  const wetCode = (c: number | null | undefined) => c != null && ((c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95)
  const cur = r.data.current
  const first = hours[0]
  // Raining now: any precipitation in the current reading or the current hour, or a wet weather code for either.
  const rainingNow = (cur.precipMm ?? 0) > 0 || (first?.precipMm ?? 0) > 0 || wetCode(cur.code) || wetCode(first?.code)
  // Rain later: any hour with ≥ 0.1 mm, or a ≥ 50 % chance, in the next 24 h.
  const wetHours = hours.filter((x) => (x.precipMm ?? 0) >= 0.1 || (x.precipProb ?? 0) >= 50)
  const here = place ? floodHere(flood, place.lngLat) : null
  const floodNote = here ? ` · Flood screening: ${riskWord(here.risk)}` : ''
  const total = rain24 >= 0.05 ? ` · about ${U.precip(rain24, units)} over the next 24 h` : ''
  if (alerts > 0)
    return (
      <p className="now-summary amber" role="status">
        ⚠ <strong>{alerts} active NWS alert{alerts === 1 ? '' : 's'}</strong> for this place — details above{floodNote}
      </p>
    )
  if (rainingNow)
    return (
      <p className="now-summary amber" role="status">
        🌧 <strong>{rain24 < 2.5 ? 'Light rain now.' : 'Raining now.'}</strong>
        {total}
        {floodNote}
      </p>
    )
  if (wetHours.length)
    return (
      <p className="now-summary amber" role="status">
        🌦 <strong>{rain24 < 2.5 ? 'Light rain likely' : 'Rain on the way'}</strong> from about {hourOfDay(wetHours[0].time, r.data.timezone)}
        {total}
        {floodNote}
      </p>
    )
  return (
    <p className="now-summary green" role="status">
      ✓ <strong>All clear for now.</strong> No rain now and none expected in the next 24 h{floodNote}
    </p>
  )
}

/** "3 PM" for a moment in an IANA zone (the device's zone if the name is unknown). */
function hourOfDay(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat([], { hour: 'numeric', timeZone }).format(new Date(ms))
  } catch {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric' })
  }
}

/** Local calendar date (YYYY-MM-DD) of a moment in an IANA zone. */
function localDate(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}
/** Day label for a local date: Today, Tomorrow, then the weekday (the date string is read as a calendar date, no zone shift). */
function dayLabel(day: DayPoint, today: string): string {
  const [y, m, d] = day.date.split('-').map(Number)
  const asUtc = Date.UTC(y, m - 1, d)
  if (day.date === today) return 'Today'
  if (asUtc - Date.UTC(...(today.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)) as [number, number, number])) === 86_400_000) return 'Tomorrow'
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(asUtc))
}

/** Seven days from today in the place's zone, from the same Open-Meteo call as the current conditions. */
function DailyCard() {
  const r = useApp((s) => s.conditions)
  const units = useApp((s) => s.units)
  const now = useNow()
  const retry = () => store.set((x) => ({ refreshNonce: x.refreshNonce + 1 }))
  const days = r.data?.daily ?? []
  const loading = (r.state === 'loading' || r.state === 'idle') && !r.data
  const today = r.data ? localDate(now, r.data.timezone) : ''
  const traceMm = 0.1
  return (
    <div className={`card now-card daily ${r.stale ? 'stale' : ''}`} aria-busy={loading}>
      <h4>Next 7 days</h4>
      {loading ? (
        <>
          <small className="muted loading-label">Loading the 7-day forecast…</small>
          <div className="skeleton w100" />
          <div className="skeleton w80" />
          <div className="skeleton w90" />
        </>
      ) : !r.data ? (
        <p className="err-text">
          7-day forecast unavailable — {r.error ?? 'not loaded'}{' '}
          <button className="btn small" onClick={retry}>
            Retry
          </button>
        </p>
      ) : !days.length ? (
        <p className="err-text">
          7-day forecast unavailable — no daily data in the response{' '}
          <button className="btn small" onClick={retry}>
            Retry
          </button>
        </p>
      ) : (
        <ol className="day-rows" aria-label="Daily forecast">
          {days.slice(0, 7).map((d) => {
            const w = wmo(d.code, true)
            const amount = d.precipMm != null && d.precipMm >= traceMm ? U.precip(d.precipMm, units, units === 'imperial' ? 2 : 1) : ''
            return (
              <li key={d.date} data-date={d.date}>
                <span className="day-name">{dayLabel(d, today)}</span>
                <span className="day-i" aria-hidden="true" title={w.label}>
                  {w.icon}
                </span>
                <span className="day-hl">
                  <strong>{U.temp(d.maxC, units)}</strong> <span className="lo">/ {U.temp(d.minC, units)}</span>
                </span>
                <span className="day-p">{d.precipProb != null ? `${Math.round(d.precipProb)} %` : ''}</span>
                <span className="day-amt">{amount}</span>
              </li>
            )
          })}
        </ol>
      )}
      {r.data && <small className="muted">Open-Meteo daily · days in {r.data.timezone.replace(/_/g, ' ')} time</small>}
    </div>
  )
}

const SPANS: HourlySpan[] = [12, 24, 48]

/**
 * The next 12 / 24 / 48 hours (a remembered switch in the header): every hour for 12 and 24 h, every third
 * hour for 48 h, from the same forecast request (it already carries 48 hours — `forecast_hours=48` — so the
 * switch never fetches). A card past midnight shows its day ("Tue 3 AM"). The rain line sums the same span.
 */
function HourlyCard() {
  const r = useApp((s) => s.conditions)
  const units = useApp((s) => s.units)
  const span = useApp((s) => s.hourlySpan)
  const h = r.data?.hourly ?? []
  const inSpan = h.slice(0, span)
  // Every hour the forecast carries, for every span (Open-Meteo's hourly block runs the full 48 h; were an hour
  // missing, the strip would simply skip it).
  const cards = inSpan.filter((x) => x.tempC != null || x.code != null)
  const stripRef = useRef<HTMLOListElement>(null)
  useHorizontalScroll(stripRef, cards.length > 0)
  const rain = inSpan.reduce((a, x) => a + (x.precipMm ?? 0), 0)
  // Card clocks and days in the place's time zone (the one the forecast resolved), like the 7-day list.
  const tz = r.data?.timezone || 'UTC'
  const fmt = (t: number, opts: Intl.DateTimeFormatOptions) => {
    try {
      return new Date(t).toLocaleString([], { ...opts, timeZone: tz })
    } catch {
      return new Date(t).toLocaleString([], opts)
    }
  }
  const hourOf = (t: number) => fmt(t, { hour: 'numeric' })
  const weekdayOf = (t: number) => fmt(t, { weekday: 'short' })
  const firstDay = cards.length ? localDate(cards[0].time, tz) : ''
  const wide = useWide()
  // Opens the Map with the playback bar running over the same span (on wide layouts the map is already beside this card).
  const openTimeline = () => {
    if (!store.get().layers.rainfall) setLayer('rainfall', true)
    store.set({ rainHorizon: span, playing: true, playTime: null })
    if (!wide) go('map')
  }
  return (
    <div className="card now-card hourly" aria-busy={!cards.length} data-span={span}>
      <div className="card-head">
        <h4>Next {span} hours</h4>
        <div className="segmented small span-switch" role="radiogroup" aria-label="Hours ahead">
          {SPANS.map((n) => (
            <button key={n} type="button" role="radio" aria-checked={n === span} data-span={n} className={n === span ? 'on' : ''} onClick={() => setHourlySpan(n)}>
              {n} h
            </button>
          ))}
        </div>
      </div>
      {!cards.length ? (
        <>
          <small className="muted loading-label">Loading the hourly forecast…</small>
          <div className="skeleton w100" />
        </>
      ) : (
        <ol ref={stripRef} className="hour-strip" aria-label={`Forecast for the next ${span} hours`}>
          {cards.map((x, i) => {
            const w = wmo(x.code, x.isDay)
            const crossed = localDate(x.time, tz) !== firstDay
            return (
              <li key={x.time} data-time={x.time} data-day={crossed ? weekdayOf(x.time) : undefined} data-tz={tz}>
                <span className="hour-t">{i === 0 ? 'Now' : `${crossed ? weekdayOf(x.time) + ' ' : ''}${hourOf(x.time)}`}</span>
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
        <button className="link-row" onClick={openTimeline} data-rain-span={span}>
          Rain next {span} h: <strong>{U.precip(rain, units)}</strong> · timeline ›
        </button>
      )}
    </div>
  )
}

type MapHandle = {
  getCanvas: () => HTMLCanvasElement
  getContainer: () => HTMLElement
  easeTo: (o: object) => void
  getZoom: () => number
  triggerRepaint: () => void
  on: (ev: string, fn: () => void) => void
  off: (ev: string, fn: () => void) => void
}

/**
 * A still of the live map for the Now tab (phones). The map stays mounted full-size behind the Now
 * screen, centred on the place; this box holds a copy of the map's centre, redrawn only when the
 * map has finished rendering something new (its `idle` event — a new place, tiles, a layer), never
 * on scroll. The still is an ordinary element in the page's flow, so it scrolls with the page on
 * the compositor: nothing measures, moves or redraws anything per frame or per scroll event.
 * (Until Oct 18 the live map itself was positioned into this box by a requestAnimationFrame loop
 * that re-measured the box every frame; on iPhones the map landed a frame behind the page while
 * scrolling and visibly shifted.) The window is not interactive: a tap opens the Map.
 */
function MapWindow() {
  const ref = useRef<HTMLCanvasElement>(null)
  const place = useApp((s) => s.place)
  // When the still was last drawn (null until the first one): the box shows a shimmer and "Loading map…"
  // until then, and the time of the still ("Map as of 9:42 PM") afterwards.
  const [drawnAt, setDrawnAt] = useState<number | null>(null)
  useEffect(() => {
    const canvas = ref.current
    const m = (window as unknown as { __map?: MapHandle }).__map
    if (!canvas || !m) return
    let drawn = 0
    // Copy the centre of the map canvas into the still, at the still's size and the screen's pixel
    // ratio. Called from the map's own `idle` event, in the same task as its WebGL draw, so the
    // drawing buffer is still intact (no preserveDrawingBuffer needed).
    const draw = () => {
      const src = m.getCanvas()
      const box = canvas.getBoundingClientRect()
      const cw = m.getContainer().clientWidth || src.width
      if (!box.width || !box.height || !src.width || !src.height) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.round(box.width * dpr), h = Math.round(box.height * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      const k = src.width / cw // map canvas pixels per CSS pixel
      const sw = Math.min(src.width, box.width * k), sh = Math.min(src.height, box.height * k)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, w, h)
      drawn++
      const at = Date.now()
      ;(window as unknown as { __mapWindow?: object }).__mapWindow = { drawn, at, w, h }
      setDrawnAt(at)
    }
    m.on('idle', draw)
    // The first still: ask for one render (→ idle → draw). A size change (rotation) asks again.
    m.triggerRepaint()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => m.triggerRepaint()) : null
    ro?.observe(canvas)
    return () => {
      m.off('idle', draw)
      ro?.disconnect()
    }
  }, [])
  useEffect(() => {
    // Centre the map on the place (unless a planned trip owns the camera); its idle redraws the still.
    const m = (window as unknown as { __map?: MapHandle }).__map
    if (!m || !place || store.get().journey.routes.data) return
    m.easeTo({ center: [place.lngLat.lng, place.lngLat.lat], zoom: Math.max(m.getZoom(), 9), duration: 0 })
  }, [place])
  return (
    <div className={`now-map-window ${drawnAt ? '' : 'loading'}`} role="button" tabIndex={0} aria-label="Open the map" onClick={() => go('map')} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && go('map')}>
      <canvas ref={ref} className="now-map-still" aria-hidden="true" />
      {!drawnAt && (
        <div className="map-loading" aria-live="polite">
          <span className="shimmer" aria-hidden="true" />
          <span className="map-loading-text">Loading map…</span>
        </div>
      )}
      {drawnAt && <small className="map-asof">Map as of {clock(drawnAt)}</small>}
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
  // Gauges are fetched only while the rivers tile is on screen (or the Rivers page / map layer shows them).
  // The flood screening (one 49-location block, terrain tiles and a slow NHD query per place) is computed on
  // demand: when the Flood page opens, or when this tile is on screen *after the user has scrolled the Now
  // screen* — the tiles row sits at the bottom edge of a 390 × 844 phone on a fresh open, so "visible" alone
  // would still fire on every first load. Once computed, the block is cached for the place until the next
  // forecast refresh (30 min), so the level stays on the tile at no further cost.
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
      return () => store.set({ riversTileVisible: false })
    }
    let floodVisible = false
    let scrolled = false
    const ask = () => wantFlood('tile', floodVisible && scrolled ? floodKey : null)
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.target === el) store.set({ riversTileVisible: e.isIntersecting })
          if (e.target === fl) {
            floodVisible = e.isIntersecting
            ask()
          }
        }
      },
      { threshold: 0.5 },
    )
    io.observe(el)
    io.observe(fl)
    const screen = fl.closest('.screen')
    const onScroll = () => {
      scrolled = true
      ask()
    }
    screen?.addEventListener('scroll', onScroll, { passive: true, once: true })
    return () => {
      io.disconnect()
      screen?.removeEventListener('scroll', onScroll)
      store.set({ riversTileVisible: false })
      wantFlood('tile', null)
    }
  }, [floodKey])
  const here = place ? floodHere(flood, place.lngLat) : null
  const placeName = (label ?? place?.name ?? '').split(',')[0]
  const floodLine = here ? `${riskWord(here.risk)} at ${placeName}${flood?.data?.preliminary ? ' · refining…' : ''}` : flood?.error ? flood.error : flood && flood.state === 'loading' ? 'computing…' : 'Check flood risk ›'
  // The tile counts the NOAA forecast points whatever tier is loaded (the Rivers page adds the USGS-only sites to
  // its list): the same count and wording on every load, before and after that page.
  // …and of those, only the ones reporting (a reading within 24 h, in service) make the headline count.
  const noaa = rivers.data ? reportingNoaa(rivers.data, now) : null
  const high = noaa?.filter((g) => g.riskLevel === 'high' || g.riskLevel === 'flooding').length ?? 0
  // Once the Rivers page has loaded the USGS sites too, the tile notes how many current ones it has (the count itself stays NOAA-only).
  const usgs = tier === 'full' ? currentUsgsOnly(rivers.data, now).length : 0
  const usgsNote = usgs ? ` (+${usgs} USGS on the Rivers page)` : ''
  const riversLine = noaa
    ? noaa.length
      ? high
        ? `${high} of ${noaa.length} reporting NOAA gauges high${usgsNote}`
        : `${noaa.length} NOAA gauges reporting, none high${usgsNote}`
      : (rivers.error ?? (rivers.data?.length ? 'no NOAA gauge reporting nearby' : 'no gauges nearby'))
    : rivers.state === 'loading'
      ? 'Loading gauges…'
      : (rivers.error ?? 'nearby gauges ›')
  const o = station.data
  const openLayers = () => {
    store.set((s) => ({ openLayersNonce: s.openLayersNonce + 1 }))
    go('map')
  }
  return (
    <div className="tiles">
      <button className="card tile" ref={riversTile} onClick={() => go('more', 'rivers')}>
        <small>📈 River gauges</small>
        <span className={high ? 'warn-text' : ''}>{riversLine}</span>
      </button>
      <button className={`card tile ${here ? `risk-${riskWord(here.risk).toLowerCase()}` : ''}`} ref={floodTile} onClick={() => go('more', 'flood')}>
        <small>🌊 Flood risk</small>
        <span className={here && here.risk >= 0.5 ? 'warn-text' : ''}>{floodLine}</span>
      </button>
      <button className="card tile" onClick={() => go('more', 'station')}>
        <small>🌡 Station observations</small>
        <span>{o ? `${o.name.split(/,| Airport/)[0]} · observed ${timeAgo(o.observedAt, now)}` : station.state === 'loading' ? 'Loading station…' : station.error ?? 'not loaded'}</span>
        {o && <small className="muted">{U.pressure(o.pressureHpa, units)} · {o.humidityPct != null ? `${Math.round(o.humidityPct)} %` : '—'}</small>}
      </button>
      <button className="card tile" onClick={openLayers}>
        <small>🗺 Map layers</small>
        <span>radar, satellite, rain, flood, air quality ›</span>
      </button>
      <button className="card tile tile-wide" onClick={() => go('more', 'settings')}>
        <small>⚙ Settings &amp; data sources</small>
        <span>units, saved place, freshness ›</span>
      </button>
    </div>
  )
}

/**
 * Measured air quality at the place from EPA AirNow monitors: one line per pollutant. Measured = a monitor
 * measuring it within 25 km with a reading under 2 h (the AQI, category and colour, "at <station>, N km away,
 * N min ago"); otherwise "No monitor within 25 km" and no number — never an estimate.
 */
function AirNowCard() {
  const r = useApp((s) => s.monitorsNear)
  const place = useApp((s) => s.place)
  const units = useApp((s) => s.units)
  const now = useNow()
  const retry = () => store.set((x) => ({ refreshNonce: x.refreshNonce + 1 }))
  const rows: { key: MonitorParameter; label: string }[] = [
    { key: 'OZONE', label: 'Ozone' },
    { key: 'PM2.5', label: 'Smoke (PM2.5)' },
  ]
  const notSet = isServiceNotConfigured(r.error)
  return (
    <div className={`card now-card airnow ${r.stale ? 'stale' : ''}`} aria-busy={r.state === 'loading' && !r.data}>
      <h4>Air quality · measured (EPA AirNow)</h4>
      {!r.data && (r.state === 'loading' || r.state === 'idle') ? (
        <>
          <small className="muted loading-label">Loading air quality…</small>
          <div className="skeleton w80" />
        </>
      ) : !r.data ? (
        <p className={notSet ? 'muted' : 'err-text'}>
          {notSet ? r.error : `Monitors unavailable — ${r.error ?? 'not loaded'}`}{' '}
          {!notSet && (
            <button className="btn small" onClick={retry}>
              Retry
            </button>
          )}
        </p>
      ) : (
        <ul className="aq-lines" aria-label="Measured air quality">
          {rows.map((p) => {
            const m = place ? nearestMeasured(r.data!.sites, p.key, place.lngLat, now) : null
            const cat = m ? aqiCategory(m.reading.aqi) : null
            return (
              <li key={p.key} data-pollutant={p.key} data-state={m ? 'measured' : 'none'}>
                <span className="aq-label">{p.label}</span>
                {m && cat ? (
                  <span className="aq-value">
                    <b className="aqi-badge" style={{ background: cat.color, color: cat.text }}>
                      {Math.round(m.reading.aqi!)}
                    </b>{' '}
                    {cat.name} <small className="muted">at {m.site.name}, {U.distance(m.distanceM, units)} away, {readingAge(m.reading.time, now)}</small>
                  </span>
                ) : (
                  <span className="aq-value muted">No monitor within 25 km</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <small className="muted aqi-attrib">
        {AIRNOW_CREDIT}
        {r.freshness?.fetchedAt ? ` · data fetched ${timeAgo(r.freshness.fetchedAt, now)}` : ''}
        {' · each reading shows its own observation time; monitors report hourly averages once the hour ends'}
      </small>
    </div>
  )
}
