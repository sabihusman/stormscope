import { CLOUD_STOPS, FLOOD_STOPS, RAIN_STOPS } from '../lib/colors'
import { U } from '../lib/units'
import { store, useApp } from '../state/store'
import { RISK_COLORS } from '../map/RiversLayer'

function Ramp({ stops, title }: { stops: { color: string; label: string }[]; title: string }) {
  return (
    <div className="legend-row">
      <div className="legend-title">{title}</div>
      <div className="legend-ramp">
        {stops.map((s, i) => (
          <div key={i} className="legend-swatch" title={s.label}>
            <i style={{ background: s.color }} />
            <small>{s.label}</small>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Legend for every enabled overlay. Collapses to a small chip so it never hogs a phone screen. */
export function Legend() {
  const layers = useApp((s) => s.layers)
  const open = useApp((s) => s.legendOpen)
  const rainHorizon = useApp((s) => s.rainHorizon)
  const units = useApp((s) => s.units)
  const satProduct = useApp((s) => s.satProduct)
  const anyOverlay = layers.radar || layers.satellite || layers.rainfall || layers.flood || layers.rivers || layers.nowcast
  if (!anyOverlay) return null
  if (!open)
    return (
      <button className="legend-chip" onClick={() => store.set({ legendOpen: true })} aria-label="Show legend">
        Legend
      </button>
    )
  const rainStops = RAIN_STOPS.map((s) => ({ color: s.color, label: s.value === RAIN_STOPS[0].value ? 'trace' : U.precipLabel(s.value, units) + (s === RAIN_STOPS[RAIN_STOPS.length - 1] ? '+' : '') }))
  return (
    <aside className="legend card" aria-label="Map legend">
      <div className="legend-head">
        <strong>Legend</strong>
        <button className="icon-btn" onClick={() => store.set({ legendOpen: false })} aria-label="Hide legend">
          ×
        </button>
      </div>
      {layers.radar && (
        <div className="legend-row">
          <div className="legend-title">Radar (RainViewer)</div>
          <div className="legend-bar radar-bar" aria-hidden="true" />
          <div className="legend-ends">
            <small>light rain</small>
            <small>heavy / hail</small>
          </div>
        </div>
      )}
      {layers.satellite && (
        <div className="legend-row">
          <div className="legend-title">Satellite (GOES · NASA GIBS)</div>
          <small className="muted">{satProduct === 'geocolor' ? 'GeoColor: true colour by day, IR-tinted clouds at night.' : 'Band 13 IR: brighter = colder, higher cloud tops.'}</small>
        </div>
      )}
      {layers.rainfall && <Ramp stops={rainStops} title={`Rain next ${rainHorizon} h (${U.precipUnit(units)})`} />}
      {layers.flood && <Ramp stops={FLOOD_STOPS.slice(1)} title="Flood risk" />}
      {layers.rivers && (
        <div className="legend-row">
          <div className="legend-title">River gauges</div>
          <div className="legend-ramp dots">
            {(Object.keys(RISK_COLORS) as (keyof typeof RISK_COLORS)[]).map((k) => (
              <div key={k} className="legend-swatch">
                <i className="dot" style={{ background: RISK_COLORS[k] }} />
                <small>{k}</small>
              </div>
            ))}
          </div>
        </div>
      )}
      {layers.nowcast && (
        <>
          <Ramp stops={CLOUD_STOPS.slice(1)} title="Nowcast cloud" />
          <div className="legend-row">
            <div className="legend-title">Wind</div>
            <small className="muted">Streaks drift with the wind; longer &amp; darker = stronger. Rain cells use the rain colours.</small>
          </div>
        </>
      )}
    </aside>
  )
}
