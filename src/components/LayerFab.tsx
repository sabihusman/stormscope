import { useEffect, useRef, useState } from 'react'
import { usePresence } from '../hooks/usePresence'
import { useWide } from '../hooks/useMisc'
import { setAqPollutant, setFabCorner, setFabCornerWide, setLayer, setSatProduct, store, useApp, type FabCorner } from '../state/store'
import { LegendRows } from './Legend'
import type { LayerId } from '../types'

/** The last Now-screen "Map layers" tap this module has acted on (the component remounts with the Map screen). */
let handledLayersNonce = 0

/** Forecast overlays are one at a time (they stack into an unreadable quilt otherwise). */
const OVERLAYS: { id: LayerId; label: string; icon: string }[] = [
  { id: 'rainfall', label: 'Rain next 24 h', icon: '🌧' },
  { id: 'flood', label: 'Flood risk', icon: '🌊' },
  { id: 'nowcast', label: 'Next 2 h wind & cloud', icon: '💨' },
]
const POINTS: { id: LayerId; label: string; icon: string }[] = [
  { id: 'rivers', label: 'River gauges', icon: '📈' },
  { id: 'station', label: 'Station', icon: '🌡' },
  { id: 'monitors', label: 'Air monitors (AirNow)', icon: '🏭' },
]

const CORNER_ORDER: FabCorner[] = ['br', 'bl', 'tl', 'tr']
const DRAG_THRESHOLD_PX = 12

/**
 * Layers only: background imagery (radar | satellite | none), one forecast overlay at a time,
 * point layers, 3D terrain. Units and motion live in More → Settings; the legend has its own chip.
 * The ☰ button can be dragged to any screen corner so it never sits over what you're looking at.
 */
export function LayerFab() {
  const layers = useApp((s) => s.layers)
  const is3D = useApp((s) => s.is3D)
  const corner = useApp((s) => s.fabCorner)
  const layerErrors = useApp((s) => s.layerErrors)
  const satProduct = useApp((s) => s.satProduct)
  const aqPollutant = useApp((s) => s.aqPollutant)
  const rainHorizon = useApp((s) => s.rainHorizon)
  const [open, setOpen] = useState(false)
  const wide = useWide()
  // "Map layers" on the Now screen opens the panel as the Map appears — once per tap, not on every remount.
  const openNonce = useApp((s) => s.openLayersNonce)
  useEffect(() => {
    if (openNonce > handledLayersNonce) {
      handledLayersNonce = openNonce
      setOpen(true)
    }
  }, [openNonce])
  // The panel fades and slides in and out (150 ms, opacity and transform only); it stays mounted while closing.
  const panel = usePresence(open)
  // Wide layouts: the panel is tied to the button; when the space between the button and the playback bar
  // is below the panel's minimum useful height (measured: down to the third forecast overlay), it is lifted
  // to the control column's top instead (CSS .lifted). A phone in landscape is the usual case.
  const [lifted, setLifted] = useState(false)
  const stackRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = stackRef.current
    if (!open || !el) {
      setLifted(false)
      return
    }
    const measure = () => {
      const app = document.querySelector('.app')
      // The lift (to the control column's top) only applies under the zoom column, the wide default corner.
      if (!app?.classList.contains('wide') || store.get().fabCornerWide !== 'tr') {
        setLifted(false)
        return
      }
      const bar = document.querySelector('.playbar')
      const bottomEdge = bar ? bar.getBoundingClientRect().top : window.innerHeight
      const room = bottomEdge - el.getBoundingClientRect().top - 8
      // The minimum useful height is measured from the rendered panel: its top down to the bottom of the third
      // forecast-overlay button, plus the panel's bottom padding (so all three overlays show without scrolling).
      const menu = el.querySelector<HTMLElement>('.fab-menu')
      const third = menu?.querySelector<HTMLElement>('[data-overlay="nowcast"]')
      const min = menu && third ? third.getBoundingClientRect().bottom - menu.getBoundingClientRect().top + menu.scrollTop + parseFloat(getComputedStyle(menu).paddingBottom) : 0
      const lift = room < min
      ;(window as unknown as { __layersPanel?: object }).__layersPanel = { room: Math.round(room), min: Math.round(min), lifted: lift }
      setLifted(lift)
    }
    measure()
    window.addEventListener('resize', measure)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(document.body)
    return () => {
      window.removeEventListener('resize', measure)
      ro?.disconnect()
    }
  }, [open])
  const timers = useRef<Partial<Record<LayerId, number>>>({})
  const [pendingState, setPending] = useState<Partial<Record<LayerId, boolean>>>({})

  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const justDragged = useRef(false)
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null)

  // Debounced so mashing a button doesn't thrash sources/fetches.
  const toggle = (id: LayerId, force?: boolean) => {
    const next = force ?? !(pendingState[id] ?? layers[id])
    setPending((p) => ({ ...p, [id]: next }))
    window.clearTimeout(timers.current[id])
    timers.current[id] = window.setTimeout(() => {
      setLayer(id, next)
      setPending((p) => {
        const c = { ...p }
        delete c[id]
        return c
      })
    }, 250)
  }
  useEffect(() => {
    const t = timers.current
    return () => Object.values(t).forEach((x) => window.clearTimeout(x))
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    d.moved = true
    if (open) setOpen(false)
    setOffset({ x: dx, y: dy })
  }
  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    drag.current = null
    setOffset(null)
    if (!d?.moved) return
    justDragged.current = true
    // Halves of the map area, not of the window: on wide layouts the map starts right of the rail and the column.
    const area = document.querySelector('.map-root')?.getBoundingClientRect()
    const left = area ? e.clientX < area.left + area.width / 2 : e.clientX < window.innerWidth / 2
    const top = area ? e.clientY < area.top + area.height / 2 : e.clientY < window.innerHeight / 2
    const c: FabCorner = top ? (left ? 'tl' : 'tr') : left ? 'bl' : 'br'
    if (wide) setFabCornerWide(c)
    else setFabCorner(c)
  }
  const onClick = () => {
    if (justDragged.current) {
      justDragged.current = false
      return
    }
    setOpen((o) => !o)
  }
  void CORNER_ORDER
  void corner

  // Desktop places ☰ directly under the map's zoom / compass column: publish that column's real height
  // as --map-ctrl-h on .app (the CSS default is a fallback), like --topbar-h and --playbar-h.
  useEffect(() => {
    const app = document.querySelector<HTMLElement>('.app')
    const col = document.querySelector<HTMLElement>('.maplibregl-ctrl-top-right')
    if (!app || !col) return
    const apply = () => app.style.setProperty('--map-ctrl-h', `${col.offsetHeight}px`)
    apply()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null
    ro?.observe(col)
    return () => {
      ro?.disconnect()
      app.style.removeProperty('--map-ctrl-h')
    }
  }, [])

  const on = (id: LayerId) => pendingState[id] ?? layers[id]
  const imagery = on('radar') ? 'radar' : on('satellite') ? 'satellite' : 'none'
  const overlay = OVERLAYS.find((o) => on(o.id))?.id ?? 'none'

  return (
    <div ref={stackRef} className={`fab-stack ${open ? 'open' : ''} ${offset ? 'dragging' : ''} ${lifted ? 'lifted' : ''}`}>
      {panel.mounted && (
        <div className="fab-menu pop" data-state={panel.state} onTransitionEnd={panel.onTransitionEnd} role="group" aria-label="Map layers">
          <div className="fab-group-label">Background</div>
          <div className="segmented small imagery" role="radiogroup" aria-label="Background imagery">
            {(['radar', 'satellite', 'none'] as const).map((id) => (
              <button
                key={id}
                role="radio"
                aria-checked={imagery === id}
                className={imagery === id ? 'on' : ''}
                onClick={() => {
                  if (id === 'none') {
                    if (on('radar')) toggle('radar', false)
                    if (on('satellite')) toggle('satellite', false)
                  } else toggle(id, true)
                }}
              >
                <span aria-hidden="true">{id === 'radar' ? '📡' : id === 'satellite' ? '🛰' : '○'}</span> {id === 'radar' ? 'Radar' : id === 'satellite' ? 'Satellite' : 'None'}
              </button>
            ))}
          </div>
          {on('satellite') && (
            <button className="fab-item sub" onClick={() => setSatProduct(satProduct === 'geocolor' ? 'ir' : 'geocolor')} aria-label={`Satellite product: ${satProduct === 'geocolor' ? 'GeoColor' : 'Infrared'}. Switch`}>
              <span aria-hidden="true">↳</span>
              <span className="fab-label">{satProduct === 'geocolor' ? 'GeoColor (true colour)' : 'Infrared (band 13)'}</span>
            </button>
          )}
          <div className="fab-group-label">Forecast overlay (one at a time)</div>
          {OVERLAYS.map((l) => {
            const err = layerErrors[l.id]
            const active = overlay === l.id
            return (
              <button key={l.id} role="radio" aria-checked={active} data-overlay={l.id} className={`fab-item ${active ? 'on' : ''} ${err ? 'err' : ''}`} onClick={() => toggle(l.id, !active)} title={err ? `Unavailable: ${err}. Tap to retry.` : undefined}>
                <span aria-hidden="true">{l.icon}</span>
                <span className="fab-label">
                  {l.id === 'rainfall' ? `Rain next ${rainHorizon} h` : l.label}
                  {err && <small className="fab-err"> · unavailable — {err}</small>}
                </span>
              </button>
            )
          })}
          <div className="fab-group-label">Air quality (AirNow monitors, measured)</div>
          <div className="segmented small" role="radiogroup" aria-label="Air quality pollutant">
            {([
              ['off', 'Off'],
              ['OZONE', 'Ozone'],
              ['PM2.5', 'Smoke (PM2.5)'],
            ] as const).map(([id, label]) => {
              const active = id === 'off' ? !on('aqcircles') : on('aqcircles') && aqPollutant === id
              return (
                <button key={id} role="radio" aria-checked={active} data-aq={id} className={active ? 'on' : ''} onClick={() => setAqPollutant(id === 'off' ? null : id)}>
                  {label}
                </button>
              )
            })}
          </div>
          {layerErrors.aqcircles && <small className="fab-err">unavailable — {layerErrors.aqcircles}</small>}
          <div className="fab-group-label">Points</div>
          {POINTS.map((l) => {
            const err = layerErrors[l.id]
            return (
              <button key={l.id} className={`fab-item ${on(l.id) ? 'on' : ''} ${err ? 'err' : ''}`} onClick={() => toggle(l.id)} aria-pressed={on(l.id)} title={err ? `Unavailable: ${err}. Tap to retry.` : undefined}>
                <span aria-hidden="true">{l.icon}</span>
                <span className="fab-label">
                  {l.label}
                  {err && <small className="fab-err"> · unavailable — {err}</small>}
                </span>
              </button>
            )
          })}
          <div className="fab-sep" />
          <button className={`fab-item ${is3D ? 'on' : ''}`} onClick={() => store.set({ is3D: !is3D })} aria-pressed={is3D}>
            <span aria-hidden="true">⛰</span>
            <span className="fab-label">{is3D ? '3D terrain on' : '3D terrain off'}</span>
          </button>
          <div className="fab-sep" />
          <div className="fab-group-label">Legend (layers that are on)</div>
          <LegendRows />
          <small className="fab-hint">Tip: drag ☰ to any corner</small>
        </div>
      )}
      <button
        className="fab-main"
        style={offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
        aria-expanded={open}
        aria-label={open ? 'Close layer menu' : 'Open layer menu'}
        title="Layers — drag to move"
      >
        {open ? '×' : '☰'}
      </button>
    </div>
  )
}
