import { useEffect, useRef, useState } from 'react'
import { setFabCorner, setLayer, setSatProduct, setUnits, store, useApp, type FabCorner } from '../state/store'
import type { LayerId } from '../types'

const LAYERS: { id: LayerId; label: string; icon: string }[] = [
  { id: 'rainfall', label: 'Rainfall', icon: '🌧' },
  { id: 'flood', label: 'Flood risk', icon: '🌊' },
  { id: 'rivers', label: 'Rivers', icon: '📈' },
  { id: 'station', label: 'Station', icon: '🌡' },
  { id: 'nowcast', label: 'Nowcast', icon: '💨' },
]

const CORNER_ORDER: FabCorner[] = ['br', 'bl', 'tl', 'tr']
const CORNER_NAMES: Record<FabCorner, string> = { br: 'bottom-right', bl: 'bottom-left', tl: 'top-left', tr: 'top-right' }
const DRAG_THRESHOLD_PX = 12

/**
 * Thumb-reachable layer toggles. The ☰ button can be dragged to any screen
 * corner (or moved from the menu) so it never sits over what you're looking at.
 * Layer toggles are debounced so mashing a button doesn't thrash sources/fetches.
 */
export function LayerFab() {
  const layers = useApp((s) => s.layers)
  const is3D = useApp((s) => s.is3D)
  const legendOpen = useApp((s) => s.legendOpen)
  const units = useApp((s) => s.units)
  const corner = useApp((s) => s.fabCorner)
  const satProduct = useApp((s) => s.satProduct)
  const [open, setOpen] = useState(false)
  const timers = useRef<Partial<Record<LayerId, number>>>({})
  const [pendingState, setPending] = useState<Partial<Record<LayerId, boolean>>>({})

  // Drag-to-corner state for the main button.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  // Set when a drag just ended so the trailing click event does not toggle the menu.
  const justDragged = useRef(false)
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null)

  const toggle = (id: LayerId) => {
    const next = !(pendingState[id] ?? layers[id])
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
    // Snap to whichever corner the pointer ended nearest to.
    const left = e.clientX < window.innerWidth / 2
    const top = e.clientY < window.innerHeight / 2
    setFabCorner(top ? (left ? 'tl' : 'tr') : left ? 'bl' : 'br')
  }
  const onClick = () => {
    // A drag that ended here must not also toggle the menu.
    if (justDragged.current) {
      justDragged.current = false
      return
    }
    setOpen((o) => !o)
  }
  const nextCorner = CORNER_ORDER[(CORNER_ORDER.indexOf(corner) + 1) % CORNER_ORDER.length]

  return (
    <div className={`fab-stack ${open ? 'open' : ''} ${offset ? 'dragging' : ''}`}>
      {open && (
        <div className="fab-menu" role="group" aria-label="Map layers">
          <div className="fab-group-label">Imagery (one at a time)</div>
          <div className="segmented small imagery" role="radiogroup" aria-label="Imagery">
            {(['radar', 'satellite'] as const).map((id) => {
              const on = pendingState[id] ?? layers[id]
              return (
                <button key={id} role="radio" aria-checked={on} className={on ? 'on' : ''} onClick={() => toggle(id)} title={on ? 'Tap again to turn imagery off' : undefined}>
                  <span aria-hidden="true">{id === 'radar' ? '📡' : '🛰'}</span> {id === 'radar' ? 'Radar' : 'Satellite'}
                </button>
              )
            })}
          </div>
          {LAYERS.map((l) => {
            const on = pendingState[l.id] ?? layers[l.id]
            return (
              <button key={l.id} className={`fab-item ${on ? 'on' : ''}`} onClick={() => toggle(l.id)} aria-pressed={on}>
                <span aria-hidden="true">{l.icon}</span>
                <span className="fab-label">{l.label}</span>
              </button>
            )
          })}
          {layers.satellite && (
            <button className="fab-item sub" onClick={() => setSatProduct(satProduct === 'geocolor' ? 'ir' : 'geocolor')} aria-label={`Satellite product: ${satProduct === 'geocolor' ? 'GeoColor' : 'Infrared'}. Switch`}>
              <span aria-hidden="true">↳</span>
              <span className="fab-label">{satProduct === 'geocolor' ? 'GeoColor (true colour)' : 'Infrared (band 13)'}</span>
            </button>
          )}
          <div className="fab-sep" />
          <button className={`fab-item ${is3D ? 'on' : ''}`} onClick={() => store.set({ is3D: !is3D })} aria-pressed={is3D}>
            <span aria-hidden="true">⛰</span>
            <span className="fab-label">{is3D ? '3D terrain on' : '3D terrain off'}</span>
          </button>
          <button className={`fab-item ${legendOpen ? 'on' : ''}`} onClick={() => store.set({ legendOpen: !legendOpen })} aria-pressed={legendOpen}>
            <span aria-hidden="true">🗂</span>
            <span className="fab-label">Legend</span>
          </button>
          <button
            className="fab-item"
            onClick={() => setUnits(units === 'metric' ? 'imperial' : 'metric')}
            aria-label={`Units: ${units}. Switch to ${units === 'metric' ? 'imperial' : 'metric'}`}
          >
            <span aria-hidden="true">📏</span>
            <span className="fab-label">{units === 'metric' ? 'Metric °C · km' : 'Imperial °F · mi'}</span>
          </button>
          <div className="fab-sep" />
          <button className="fab-item" onClick={() => setFabCorner(nextCorner)} aria-label={`Move this button to the ${CORNER_NAMES[nextCorner]} corner`}>
            <span aria-hidden="true">↔</span>
            <span className="fab-label">Move to {CORNER_NAMES[nextCorner]}</span>
          </button>
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
