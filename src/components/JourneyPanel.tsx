import { useRef, useState } from 'react'
import { useNow } from '../hooks/useMisc'
import { clock, dayClock, timeAgo } from '../lib/time'
import { U } from '../lib/units'
import { isCapped, SEVERITY_COLORS, type JourneySample } from '../lib/journey'
import { clearJourney, selectRoute, setDeparture, setJourneyTo, store, useApp } from '../state/store'
import { summarize, type HazardHit, type HazardReport, type SourceStatus } from '../lib/hazardEngine'
import { condText, effectiveCondition, type RoadReport, type RoadSample } from '../lib/roadIce'
import { PlaceSearch } from './PlaceSearch'
import { startPickOnMap } from '../state/store'

/** A clear sky at night is a moon, not a sun (M2); every other condition keeps its icon. */
const iconFor = (c: { code: string }, s: { isDay?: boolean }) => (c.code === 'clear' && s.isDay === false ? '🌙' : ICON[c.code])
const ICON: Record<string, string> = { clear: '☀️', rain: '🌧', 'heavy-rain': '⛈', snow: '🌨', 'heavy-snow': '❄️', ice: '🧊', fog: '🌫', wind: '💨', storm: '⛈' }

/** Journey tab: destination + departure → route → weather at ETA along the way. */
export function JourneyPanel() {
  const j = useApp((s) => s.journey)
  const place = useApp((s) => s.place)
  const units = useApp((s) => s.units)
  const now = useNow()
  const [custom, setCustom] = useState(false)
  const customRef = useRef<HTMLInputElement>(null)

  const chips: { label: string; ms: () => number }[] = [
    { label: 'Now', ms: () => Date.now() },
    { label: '+30 min', ms: () => Date.now() + 30 * 60_000 },
    { label: '+1 h', ms: () => Date.now() + 3_600_000 },
    { label: '+2 h', ms: () => Date.now() + 2 * 3_600_000 },
  ]
  // null departure = now: the "Now" chip. A picked time matches its chip within 90 s.
  const departure = j.departure ?? Date.now()
  const activeChip = j.departure == null ? 0 : chips.findIndex((c) => Math.abs(c.ms() - j.departure!) < 90_000)
  // Hooks stay above the early return: the panel can be open before the first location fix lands.
  const replay = useApp((s) => s.replay)

  if (!place)
    return (
      <div className="panel-empty">
        <p>Set your location first (allow location or search for a place) — the journey starts from there.</p>
      </div>
    )

  const routes = j.routes.data?.routes ?? []
  const route = routes[j.selected]
  const w = j.weather.data
  const arrival = route ? departure + route.durationS * 1000 : null
  // The timeline is anchored to the selected departure: while the forecast for a new departure is still loading,
  // the stops already shown keep their positions but read the new times (departure → arrival), matching the card.
  const shift = w ? departure - w.departureMs : 0
  const etaOf = (s: JourneySample) => s.eta + shift
  const refreshing = shift !== 0 && j.weather.state === 'loading'
  const road = j.road.data
  const roadByIdx = new Map<number, RoadSample>((road?.samples ?? []).map((r) => [r.idx, r]))
  const cond = (s: JourneySample) => effectiveCondition(s, roadByIdx.get(s.idx), units)
  const worst = w ? w.samples.reduce((acc, s) => (cond(s).severity > acc.severity ? cond(s) : acc), cond(w.samples[0])) : null

  return (
    <div className="panel">
      {replay && (
        <div className="replay-banner">
          <strong>Replay</strong> · {replay.label}
          <br />
          <small>Hazards come from archived NWS/SPC products; weather is ERA5 reanalysis, not a forecast.</small>
        </div>
      )}
      {route && isCapped(route) && (
        <div className="trip-cap-warning" role="alert">
          <strong>Over 24 h of driving ({fmtDur(route.durationS)}).</strong> The forecast covers the first 24 h; the arrival card shows the 24 h mark. Plan one driving day at a time.
        </div>
      )}
      <div className="trip-from">
        <small className="muted">From</small>
        <strong>{store.get().placeLabel ?? place.name}</strong>
        <button className="btn small ghost" onClick={() => store.set({ pickerOpen: true })} aria-label="Change place">
          Change
        </button>
      </div>

      {/* Destination */}
      {!j.to ? (
        <div className="journey-search">
          <small className="muted">To</small>
          <PlaceSearch placeholder="Destination" autoFocus={false} onPick={(r) => setJourneyTo({ name: r.name, lngLat: r.lngLat, source: 'search' })} />
          <button className="btn small" onClick={startPickOnMap}>
            🗺 Pick the destination on the map
          </button>
        </div>
      ) : (
        <div className="journey-dest">
          <span>
            <small className="muted">To</small> <strong>{j.to.name}</strong>
          </span>
          <button className="btn small" onClick={clearJourney}>
            Change
          </button>
        </div>
      )}

      {/* Departure */}
      <div className="segmented small" role="radiogroup" aria-label="Departure time">
        {chips.map((c, i) => (
          <button
            key={c.label}
            role="radio"
            aria-checked={!custom && activeChip === i}
            className={!custom && activeChip === i ? 'on' : ''}
            onClick={() => {
              setCustom(false)
              setDeparture(c.label === 'Now' ? null : c.ms())
            }}
          >
            {c.label}
          </button>
        ))}
        <button
          role="radio"
          aria-checked={custom}
          className={custom ? 'on' : ''}
          onClick={() => {
            setCustom(true)
            setTimeout(() => customRef.current?.focus(), 50)
          }}
        >
          Pick…
        </button>
      </div>
      <small className="muted leave-line">
        Leave · {j.departure == null ? 'now' : activeChip > 0 && !custom ? chips[activeChip].label : 'picked'} · <strong>{dayClock(departure)}</strong>
      </small>
      {custom && (
        <label className="datetime-row">
          <small className="muted">Departure (local time)</small>
          <input
            ref={customRef}
            type="datetime-local"
            className="text-input"
            defaultValue={toLocalInput(departure)}
            min={toLocalInput(Date.now() - 3_600_000)}
            max={toLocalInput(Date.now() + 6 * 86_400_000)}
            onChange={(e) => {
              const t = Date.parse(e.target.value)
              if (Number.isFinite(t)) setDeparture(t)
            }}
          />
          <small className="muted">Multi-day trips: plan one journey per driving day — overnight stops aren't modelled.</small>
        </label>
      )}

      {/* Route */}
      {j.to && (
        <>
          {j.routes.state === 'loading' && !route && <p className="muted">Routing…</p>}
          {j.routes.error && !route && <p className="err-text">Route unavailable: {j.routes.error}</p>}
          {route && (
            <div className="route-summary">
              <div>
                <strong>
                  {U.distance(route.distanceM, units)} · {fmtDur(route.durationS)}
                </strong>
                <br />
                <small className="muted">
                  {route.summary} · via {j.routes.data?.engine === 'valhalla' ? 'Valhalla' : 'OSRM'}
                  {j.routes.data?.fallbackReason ? ` · ${j.routes.data.fallbackReason}` : ''} · ETAs are estimates without traffic (±5–10 min)
                </small>
              </div>
              {routes.length > 1 && (
                <div className="segmented small" role="radiogroup" aria-label="Route alternative">
                  {routes.map((r, i) => (
                    <button key={i} role="radio" aria-checked={j.selected === i} className={j.selected === i ? 'on' : ''} onClick={() => selectRoute(i)}>
                      {i === 0 ? 'Fastest' : `Alt ${i}`} · {fmtDur(r.durationS)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Weather */}
          {route && j.weather.state === 'loading' && !w && <p className="muted">Fetching the forecast at every point of the route…</p>}
          {route && j.weather.error && !w && <p className="err-text">Forecast unavailable: {j.weather.error}</p>}
          {w && route && arrival && (
            <>
              <HazardsSection r={j.hazards} units={units} />
              <div className={`arrival-card sev-${cond(w.samples[w.samples.length - 1]).severity}`}>
                <small>{isCapped(route) ? `At the 24 h mark (arrive ${j.to.name.split(',')[0]} ${dayClock(arrival)})` : `Arrive ${j.to.name.split(',')[0]}`}</small>
                <strong>{isCapped(route) ? dayClock(etaOf(w.samples[w.samples.length - 1])) : dayClock(arrival)}</strong>
                <span>
                  {iconFor(cond(w.samples[w.samples.length - 1]), w.samples[w.samples.length - 1])} {cond(w.samples[w.samples.length - 1]).label} · {U.temp(w.samples[w.samples.length - 1].tempC, units)}
                  {w.samples[w.samples.length - 1].precipMm ? ` · ${U.precip(w.samples[w.samples.length - 1].precipMm, units)}/h` : ''}
                </span>
              </div>
              <div className={`worst-line sev-${worst!.severity}`}>
                Worst along the way: {ICON[worst!.code]} {worst!.label}
              </div>
              {refreshing && (
                <p className="muted trip-refreshing" role="status">
                  Updating the forecast for the new departure… times below already follow it.
                </p>
              )}
              <ol className="journey-strip">
                {thin(w.samples, 14).map((s) => (
                  <li key={s.idx} className={`sev-${cond(s).severity}`} onClick={() => store.set({ selection: sampleSelection({ ...s, eta: etaOf(s) }, units, roadByIdx.get(s.idx)) })}>
                    <span className="strip-time">{clock(etaOf(s))}</span>
                    <span className="strip-icon" aria-hidden="true">
                      {iconFor(cond(s), s)}
                    </span>
                    <span className="strip-main">
                      {cond(s).label}
                      <small className="muted">
                        {' '}
                        · {U.temp(s.tempC, units)}
                        {s.precipMm ? ` · ${U.precip(s.precipMm, units)}/h` : ''}
                        {s.gustKmh && s.gustKmh >= 40 ? ` · gusts ${U.speed(s.gustKmh / 3.6, units)}` : ''}
                        {s.resolution === 'minutely' ? ' · 15-min' : ''}
                      </small>
                    </span>
                    <span className="strip-dist muted">{U.distance(s.distM, units)}</span>
                  </li>
                ))}
              </ol>
              <small className="muted trip-foot">
                {w.samples.length > 14 ? `${Math.min(14, w.samples.length)} sampled stops from ${w.samples.length} forecast points` : `${w.samples.length} stops, one forecast point each`} · {w.provider} · fetched {timeAgo(w.fetchedAt, now)}
                {w.historical ? '' : ' · 15-minutely where HRRR / ICON-D2 / AROME cover'}
              </small>
              <RoadSection r={j.road} replay={!!replay} />
            </>
          )}
        </>
      )}
    </div>
  )
}

const TIER_LABEL: Record<string, string> = { warning: 'Warning', watch: 'Watch', advisory: 'Advisory', statement: 'Statement', outlook: 'Outlook' }

function SourceLine({ name, s }: { name: string; s: SourceStatus }) {
  return (
    <li className={`src-${s.state}`}>
      <span className="dot inline" /> {name}:{' '}
      {s.state === 'ok' ? `checked (${s.count} products in the area)${s.note ? ` — ${s.note}` : ''}` : s.state === 'unavailable' ? `unavailable — ${s.reason}` : `not applicable — ${s.reason}`}
    </li>
  )
}

function HitRow({ h, units }: { h: HazardHit; units: ReturnType<typeof store.get>['units'] }) {
  return (
    <li className={`hazard-hit tier-${h.hazard.tier}`} onClick={() => store.set({ selection: { kind: 'journey', lngLat: { lng: 0, lat: 0 }, title: h.hazard.event, lines: [] }, sheet: 'peek' })}>
      <span className="hazard-tier">{TIER_LABEL[h.hazard.tier]}</span>
      <div className="hazard-main">
        <strong>{h.hazard.event}</strong>
        {h.hazard.tags?.length ? <small> · {h.hazard.tags.join(' · ')}</small> : null}
        <br />
        <small className="muted">
          You'd be inside it {clock(h.firstEta)}–{clock(h.lastEta)} ({U.distance(h.firstDistM, units)}–{U.distance(h.lastDistM, units)} into the trip) · valid until {dayClock(h.hazard.validTo)} · {h.hazard.source}
        </small>
      </div>
    </li>
  )
}

/** Never says "clear": every source reports its own status, and anything unavailable is said so. */
function HazardsSection({ r, units }: { r: ReturnType<typeof store.get>['journey']['hazards']; units: ReturnType<typeof store.get>['units'] }) {
  const d: HazardReport | null = r.data
  if (!d)
    return (
      <div className="hazards">
        <div className="panel-title">
          <strong>Hazards on this route</strong>
        </div>
        <p className="muted">{r.state === 'loading' ? 'Checking warnings, watches and SPC outlooks along the route…' : r.error ? `Hazard check failed: ${r.error} — this is not an all-clear.` : 'Waiting for the route forecast…'}</p>
      </div>
    )
  const sum = summarize(d)
  const warn = d.hits.filter((h) => h.hazard.tier !== 'outlook')
  const outlooks = d.hits.filter((h) => h.hazard.tier === 'outlook')
  return (
    <div className="hazards">
      <div className="panel-title">
        <strong>Hazards on this route</strong>
      </div>
      <div className={`hazard-summary tone-${sum.tone}`}>{sum.headline}</div>
      {warn.length > 0 && (
        <ul className="hazard-list">
          {warn.map((h) => (
            <HitRow key={h.hazard.id} h={h} units={units} />
          ))}
        </ul>
      )}
      {outlooks.length > 0 && (
        <ul className="hazard-list outlooks">
          {outlooks.map((h) => (
            <HitRow key={h.hazard.id} h={h} units={units} />
          ))}
        </ul>
      )}
      {d.nearby.length > 0 && (
        <details className="hazard-nearby">
          <summary>
            {d.nearby.length} product{d.nearby.length > 1 ? 's' : ''} overlap the corridor but not at your ETA
          </summary>
          <ul>
            {d.nearby.map((n) => (
              <li key={n.hazard.id}>
                {n.hazard.event} — {n.reason === 'expired-before-eta' ? 'expired before you would get there' : 'starts after you would have passed'} (valid {clock(n.hazard.validFrom)}–{clock(n.hazard.validTo)})
              </li>
            ))}
          </ul>
        </details>
      )}
      {d.unresolved.length > 0 && <small className="muted">{d.unresolved.length} zone-based product(s) could not be placed on the map and were not checked.</small>}
      <ul className="hazard-sources">
        <SourceLine name="NWS warnings / advisories" s={d.sources.warnings} />
        <SourceLine name="SPC watches" s={d.sources.watches} />
        <SourceLine name="SPC outlooks (Day 1–3)" s={d.sources.outlooks} />
      </ul>
      <small className="muted">Checked {timeAgo(d.evaluatedAt)} · a sample counts when it is inside a polygon (or within 5 km of its edge) and its ETA is inside that polygon's own validity window.</small>
    </div>
  )
}

const STATE_LABEL: Record<string, string> = { ice: 'ICE', watch: 'Watch', wet: 'wet', dry: 'dry', unknown: 'no reading' }

/** RWIS station chips + what they mean for this trip. Stale or empty sensors are "unknown", never "no ice". */
function RoadSection({ r, replay }: { r: ReturnType<typeof store.get>['journey']['road']; replay: boolean }) {
  const units = useApp((s) => s.units)
  const d: RoadReport | null = r.data
  const now = useNow()
  return (
    <div className="hazards">
      <div className="panel-title">
        <strong>Road conditions (RWIS pavement sensors within {U.distance(5_000, units)} of the route)</strong>
      </div>
      {!d ? (
        <p className="muted">{r.state === 'loading' ? 'Reading pavement sensors near the route…' : r.error ? `Unavailable: ${r.error}` : 'Waiting for the route forecast…'}</p>
      ) : (
        <>
          {r.error && <p className="muted">{r.error}</p>}
          {d.stations.length === 0 ? (
            <p className="muted">No pavement sensor within {U.distance(5_000, units)} of this route — ice can only be "possible" (forecast), never confirmed.</p>
          ) : (
            <ul className="station-chips">
              {/* Sensors with a reading get a chip each; the ones without a reading collapse into one line below. */}
              {d.stations.filter((st) => st.obsTime != null).map((st) => (
                <li key={st.id} className={`chip-${st.stale ? 'stale' : st.state}`}>
                  <strong>{st.name}</strong>
                  <span>
                    {st.obsTime == null
                      ? 'no observation'
                      : `pavement ${st.pavementF != null ? U.temp(((st.pavementF - 32) * 5) / 9, units) : '—'}, ${condText(st.condition)} — ${replay ? `obs ${clock(st.obsTime)}` : st.ageMin! < 1 ? 'just now' : `${st.ageMin} min ago`}`}
                    {st.stale ? ' · stale/unknown' : ''}
                    {st.confirmsIce
                      ? ' · confirms ICY on this trip'
                      : st.watchOnTrip
                        ? ' · Watch at your ETA — possible ice, not confirmed'
                        : st.state === 'ice' && !st.stale
                          ? ` · ${STATE_LABEL.ice} reported`
                          : st.state === 'watch' && !st.stale
                            ? ` · ${STATE_LABEL.watch} reported (moisture at/below freezing)`
                            : ''}
                  </span>
                </li>
              ))}
              {d.stations.some((st) => st.obsTime == null) && (
                <li className="chip-unknown no-reading-line">
                  <strong>{d.stations.filter((st) => st.obsTime == null).length} sensor{d.stations.filter((st) => st.obsTime == null).length === 1 ? '' : 's'} without a reading</strong>
                  <span>{d.stations.filter((st) => st.obsTime == null).map((st) => st.name).join(', ')} — no observation, so neither ice nor its absence is confirmed</span>
                </li>
              )}
            </ul>
          )}
          <small className="muted">
            A sensor confirms "icy" only within {U.distance(5_000, units)} of the route and when your ETA is within 90 min of its observation
            {replay ? '' : '; readings older than 60 min are stale'}. Only "Warning", "Frost" and ice/snow statuses confirm; "Ice Watch" / "Snow Watch" (thin or spotty moisture at or below
            freezing) count as possible ice. Otherwise the forecast can only say "possible ice". Checked {timeAgo(d.evaluatedAt, now)}.
          </small>
        </>
      )}
    </div>
  )
}

export function sampleSelection(s: JourneySample, units: ReturnType<typeof store.get>['units'], road?: RoadSample) {
  const c = effectiveCondition(s, road, units)
  return {
    kind: 'journey' as const,
    lngLat: s.lngLat,
    title: `${clock(s.eta)} · ${c.label}`,
    lines: [
      ...(road?.station ? [`RWIS ${road.station.name}: ${condText(road.station.condition)}${road.station.pavementF != null ? `, pavement ${U.temp(((road.station.pavementF - 32) * 5) / 9, units)}` : ''} at ${clock(road.station.obsTime)} (${U.distance(road.station.distM, units)} from route)`] : []),
      `${U.distance(s.distM, units)} into the trip · ETA ${dayClock(s.eta)}`,
      `${U.temp(s.tempC, units)} · precip ${s.precipMm != null ? U.precip(s.precipMm, units) + '/h' : '—'}${s.snowCm ? ` · snow ${s.snowCm.toFixed(1)} cm/h` : ''}`,
      `Gusts ${U.speed(s.gustKmh != null ? s.gustKmh / 3.6 : null, units)} · visibility ${U.distance(s.visibilityM, units)} · cloud ${s.cloudPct ?? '—'} %`,
      `Resolution: ${s.resolution === 'minutely' ? '15-minutely (native)' : 'hourly'}`,
    ],
    source: 'Open-Meteo at ETA',
    updated: undefined,
  }
}

function thin<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr
  const out: T[] = []
  const step = (arr.length - 1) / (max - 1)
  for (let k = 0; k < max; k++) out.push(arr[Math.round(k * step)])
  return out
}
function fmtDur(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return h ? `${h} h ${m} min` : `${m} min`
}
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
export { SEVERITY_COLORS }
