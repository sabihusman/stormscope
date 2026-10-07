import { useEffect, useRef, useState } from 'react'
import { setFabCorner, setLayer, setSatProduct, store, useApp, type FabCorner } from '../state/store'
import type { LayerId } from '../types'

/** Forecast overlays are one at a time (they stack into an unreadable quilt otherwise). */
const OVERLAYS: { id: LayerId; label: string; icon: string }[] = [
  { id: 'rainfall', label: 'Rain next 24 h', icon: '🌧' },
  { id: 'flood', label: 'Flood risk', icon: '🌊' },
  { id: 'nowcast', label: 'Next 2 h wind & cloud', icon: '💨' },
]
const POINTS: { id: LayerId; label: string; icon: string }[] = [
  { id: 'rivers', label: 'River gauges', icon: '📈' },
  { id: 'station', label: 'Station', icon: '🌡' },
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
  const [open, setOpen] = useState(false)
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
    const left = e.clientX < window.innerWidth / 2
    const top = e.clientY < window.innerHeight / 2
    setFabCorner(top ? (left ? 'tl' : 'tr') : left ? 'bl' : 'br')
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

  const on = (id: LayerId) => pendingState[id] ?? layers[id]
  const imagery = on('radar') ? 'radar' : on('satellite') ? 'satellite' : 'none'
  const overlay = OVERLAYS.find((o) => on(o.id))?.id ?? 'none'

  return (
    <div className={`fab-stack ${open ? 'open' : ''} ${offset ? 'dragging' : ''}`}>
      {open && (
        <div className="fab-menu" role="group" aria-label="Map layers">
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
              <button key={l.id} role="radio" aria-checked={active} className={`fab-item ${active ? 'on' : ''} ${err ? 'err' : ''}`} onClick={() => toggle(l.id, !active)} title={err ? `Unavailable: ${err}. Tap to retry.` : undefined}>
                <span aria-hidden="true">{l.icon}</span>
                <span className="fab-label">
                  {l.label}
                  {err && <small className="fab-err"> · unavailable — {err}</small>}
                </span>
              </button>
            )
          })}
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
