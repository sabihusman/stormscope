import { useMemo } from 'react'
import { useNow } from '../hooks/useMisc'
import { usePointForecast } from '../hooks/usePointForecast'
import { wmo } from '../lib/wmo'
import { haversine } from '../lib/geo'
import { bearingLabel, sampleBlocks } from '../lib/gridSample'
import { clock, timeAgo } from '../lib/time'
import { U } from '../lib/units'
import { compass } from '../map/StationLayer'
import { openMonitor, siteStyle } from '../map/MonitorSitesLayer'
import { aqiCategory } from '../lib/aqi'
import { go, setJourneyTo, setPlace, store, useApp, useVisibleBlocks, type Selection } from '../state/store'

/** Headline for the chip, by selection kind. */
function headline(sel: Selection): { icon: string; main: string; sub: string } {
  switch (sel.kind) {
    case 'gauge':
      return { icon: '📈', main: sel.title, sub: sel.lines[0] ?? '' }
    case 'station':
      return { icon: '🌡', main: sel.title, sub: sel.lines.slice(1, 3).join(' · ') }
    case 'flood':
      return { icon: '🌊', main: sel.title, sub: sel.lines[0] ?? '' }
    case 'journey':
      return { icon: '🚗', main: sel.title, sub: sel.lines[0] ?? '' }
    case 'rain':
    case 'point':
    default:
      return { icon: '📍', main: sel.title, sub: sel.lines[0] ?? '' }
  }
}

/**
 * One tap model for the map: a small chip above the sheet with the headline for whatever was
 * tapped, and a Details control that expands the sheet. Nothing opens by itself.
 */
export function PointChip() {
  const sel = useApp((s) => s.selection)
  const sheet = useApp((s) => s.sheet)
  const place = useApp((s) => s.place)
  const units = useApp((s) => s.units)
  const blocks = useVisibleBlocks()
  const now = useNow()
  const isPoint = !!sel && (sel.kind === 'point' || sel.kind === 'rain')
  const sample = useMemo(() => (sel && isPoint ? sampleBlocks(blocks, sel.lngLat, now) : null), [sel, isPoint, blocks, now])
  const pf = usePointForecast(sel && isPoint ? sel.lngLat : null)
  if (!sel || sheet !== 'peek') return null
  const h = headline(sel)
  const dist = place ? haversine(place.lngLat, sel.lngLat) : null
  const rel = place ? (dist! < 100 ? `at ${(store.get().placeLabel ?? place.name).split(',')[0]}` : `${U.distance(dist, units)} ${bearingLabel(place.lngLat, sel.lngLat)} of ${(store.get().placeLabel ?? place.name).split(',')[0]}`) : `${sel.lngLat.lat.toFixed(3)}, ${sel.lngLat.lng.toFixed(3)}`
  const c = pf.data?.current
  const w = c ? wmo(c.code, c.isDay) : null
  const rain24 = pf.data ? pf.data.hourly.slice(0, 24).reduce((a, x) => a + (x.precipMm ?? 0), 0) : sample?.rain24Mm
  const main = isPoint
    ? c && w
      ? `${U.temp(c.tempC, units)} · ${w.label} · wind ${c.windDirDeg != null ? compass(c.windDirDeg) + ' ' : ''}${U.speed(c.windMs, units)}`
      : sample
        ? `${sample.precipNowMm >= 0.1 ? `${U.precip(sample.precipNowMm, units, 1)}/h now` : sample.cloudPct >= 70 ? 'Cloudy' : sample.cloudPct >= 30 ? 'Partly cloudy' : 'Clear'} · wind ${compass(sample.windDirDeg)} ${U.speed(sample.windMs, units)}`
        : pf.error
          ? `Conditions unavailable — ${pf.error}`
          : 'Loading conditions…'
    : h.main
  const sub = isPoint ? (rain24 != null ? `Rain next 24 h ${U.precip(rain24, units)} · ${rel}` : rel) : h.sub
  return (
    <div className="point-chip" role="status" aria-label={`${main}. ${sub}`} aria-busy={isPoint && pf.loading}>
      <span className="chip-ico" aria-hidden="true">
        {isPoint ? (w ? w.icon : '📍') : h.icon}
      </span>
      <div className="chip-body">
        <strong>{main}</strong>
        <small className="muted">{sub}</small>
      </div>
      <button className="btn small" onClick={() => store.set({ sheet: 'half' })}>
        Details
      </button>
      <button className="icon-btn" onClick={() => store.set({ selection: null })} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}

/**
 * More than one monitor dot under a tap (neighbours closer than the 44 px target): a small list in the
 * chip's place — name, the worst reading under 2 h with its EPA badge, the distance from the place — nearest
 * to the tap first. Picking one opens its chip; × or a map tap dismisses it.
 */
export function MonitorChooser() {
  const chooser = useApp((s) => s.dotChooser)
  const sites = useApp((s) => s.monitors.data?.sites)
  const place = useApp((s) => s.place)
  const units = useApp((s) => s.units)
  const now = useNow()
  if (!chooser) return null
  const list = chooser.ids.map((id) => sites?.find((x) => x.id === id)).filter((x): x is NonNullable<typeof x> => !!x)
  if (!list.length) return null
  return (
    <div className="dot-chooser" role="dialog" aria-label="Monitors under your tap">
      <div className="chooser-title">
        <strong>{list.length} monitors here</strong>
        <button className="icon-btn" onClick={() => store.set({ dotChooser: null })} aria-label="Dismiss">
          ×
        </button>
      </div>
      <ul>
        {list.map((site) => {
          const st = siteStyle(site, now)
          const cat = aqiCategory(st.aqi)
          return (
            <li key={site.id}>
              <button className="chooser-row" data-site={site.id} onClick={() => openMonitor(site)}>
                <b className={`aqi-badge${st.aqi == null ? ' none' : ''}`} style={cat ? { background: cat.color, color: cat.text } : undefined}>
                  {st.aqi == null ? '—' : Math.round(st.aqi)}
                </b>
                <span className="chooser-body">
                  <strong>{site.name}</strong>
                  <small className="muted">
                    {cat ? `${cat.name} · ` : 'no reading under 2 h · '}
                    {place ? `${U.distance(haversine(place.lngLat, site.lngLat), units)} from your place` : site.agency}
                  </small>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * A tapped air monitor in the sheet: the "Measures" line, one row per reading with the AQI badge in its EPA
 * colour, the category, the raw value, the reading's local time and age (stale past 2 h), then the distance
 * and the agency. The readings' text lines stay in `lines` for the chip.
 */
function MonitorRows({ sel, now }: { sel: Selection; now: number }) {
  const readings = sel.readings ?? []
  const rest = sel.lines.filter((l) => !readings.some((r) => r.line === l))
  return (
    <>
      <ul className="popup-lines">{rest.slice(0, 1).map((l, i) => <li key={i}>{l}</li>)}</ul>
      <ul className="popup-readings" aria-label="Readings">
        {readings.map((r) => (
          <li key={r.label} data-reading={r.label} data-stale={r.stale ? 'true' : undefined}>
            <b className={`aqi-badge${r.aqi == null ? ' none' : ''}`} style={r.color ? { background: r.color, color: r.text ?? undefined } : undefined}>
              {r.aqi == null ? '—' : Math.round(r.aqi)}
            </b>
            <span>
              <strong>{r.label}</strong> {r.category ?? 'no AQI'}
              {r.value ? ` · ${r.value}` : ''}
            </span>
            <small className="muted">
              {clock(r.time)} · {timeAgo(r.time, now)}
              {r.stale ? ' (stale)' : ''}
            </small>
          </li>
        ))}
      </ul>
      <ul className="popup-lines">{rest.slice(1).map((l, i) => <li key={i}>{l}</li>)}</ul>
    </>
  )
}

/** The sheet body for a selection: point conditions + 24 h strip, or the tapped object's facts, plus actions. */
export function PointDetails() {
  const sel = useApp((s) => s.selection)
  const place = useApp((s) => s.place)
  const units = useApp((s) => s.units)
  const blocks = useVisibleBlocks()
  const now = useNow()
  const sample = useMemo(() => (sel ? sampleBlocks(blocks, sel.lngLat, now) : null), [sel, blocks, now])
  const pf = usePointForecast(sel ? sel.lngLat : null)
  if (!sel) return null
  const isPoint = sel.kind === 'point' || sel.kind === 'rain'
  const c = pf.data?.current
  const w = c ? wmo(c.code, c.isDay) : null
  const hours = pf.data?.hourly.slice(0, 24) ?? null
  const rain24 = hours ? hours.reduce((a, x) => a + (x.precipMm ?? 0), 0) : sample?.rain24Mm
  const dist = place ? haversine(place.lngLat, sel.lngLat) : null
  const rel = place ? (dist! < 100 ? `at ${(store.get().placeLabel ?? place.name).split(',')[0]}` : `${U.distance(dist, units)} ${bearingLabel(place.lngLat, sel.lngLat)} of ${(store.get().placeLabel ?? place.name).split(',')[0]}`) : ''
  return (
    <div className="panel point-details">
      <div className="panel-title">
        <strong>{isPoint ? 'This point' : sel.title}</strong>
        <small className="muted">
          {sel.lngLat.lat.toFixed(3)}, {sel.lngLat.lng.toFixed(3)}
          {rel ? ` · ${rel}` : ''}
        </small>
      </div>
      {!isPoint && !sel.readings?.length && (
        <ul className="popup-lines">
          {sel.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {!isPoint && !!sel.readings?.length && <MonitorRows sel={sel} now={now} />}
      {c && w && (
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
            </span>
          </div>
        </div>
      )}
      {!c && pf.loading && <div className="skeleton tall w60" />}
      {!c && pf.error && <p className="err-text">Conditions unavailable — {pf.error}</p>}
      {hours ? (
        <>
          <h4 className="strip-title">Next 24 h · rain {U.precip(rain24 ?? 0, units)}</h4>
          <ol className="hour-strip" aria-label="Hourly forecast at this point">
            {hours.map((x, i) => {
              const hw = wmo(x.code, true)
              return (
                <li key={x.time} className={(x.precipMm ?? 0) >= 0.1 ? 'wet' : ''}>
                  <span className="hour-t">{i === 0 ? 'Now' : clock(x.time).replace(/:00/, '')}</span>
                  <span className="hour-i" aria-hidden="true">
                    {hw.icon}
                  </span>
                  <span className="hour-temp">{U.temp(x.tempC, units)}</span>
                  <span className="hour-p muted">{x.precipMm && x.precipMm >= 0.1 ? U.precip(x.precipMm, units, 1) : ''}</span>
                </li>
              )
            })}
          </ol>
          <small className="muted">Open-Meteo model for this point · model hour {clock(pf.data!.current.time)}</small>
        </>
      ) : sample ? (
        <>
          <h4 className="strip-title">Rain, next 24 h · {U.precip(sample.rain24Mm, units)}</h4>
          <ol className="hour-strip rain" aria-label="Hourly rain at this point">
            {sample.hourly.map((x, i) => (
              <li key={x.time} className={x.precipMm >= 0.1 ? 'wet' : ''}>
                <span className="hour-t">{i === 0 ? 'Now' : clock(x.time).replace(/:00/, '')}</span>
                <span className="hour-temp">{x.precipMm >= 0.05 ? U.precip(x.precipMm, units, 1).replace(/ (in|mm)$/, '') : '·'}</span>
              </li>
            ))}
          </ol>
          <small className="muted">Open-Meteo forecast grid · updated {timeAgo(sample.fetchedAt, now)}</small>
        </>
      ) : null}
      {(sel.source || sel.updated) && (
        <small className="muted">
          {sel.source ? `Source: ${sel.source}` : ''}
          {sel.updated ? ` · updated ${timeAgo(sel.updated, now)}` : ''}
        </small>
      )}
      <div className="popup-actions">
        <button className="btn small" onClick={() => setPlace({ name: 'Map point', lngLat: sel.lngLat, source: 'map' })}>
          Use as my place
        </button>
        <button className="btn small" onClick={() => setJourneyTo({ name: `Map point ${sel.lngLat.lat.toFixed(3)}, ${sel.lngLat.lng.toFixed(3)}`, lngLat: sel.lngLat, source: 'map' })}>
          Trip here
        </button>
        {sel.kind === 'gauge' && (
          <button className="btn small" onClick={() => go('more', 'rivers')}>
            All gauges
          </button>
        )}
        {sel.kind === 'station' && (
          <button className="btn small" onClick={() => go('more', 'station')}>
            Full observation
          </button>
        )}
        {(sel.kind === 'flood' || isPoint) && (
          <button className="btn small" onClick={() => go('more', 'flood')}>
            Flood risk
          </button>
        )}
      </div>
    </div>
  )
}
