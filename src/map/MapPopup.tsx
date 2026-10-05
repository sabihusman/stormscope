import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { timeAgo } from '../lib/time'
import { setJourneyTo, store, useApp } from '../state/store'
import { useNow } from '../hooks/useMisc'
import { useMap } from './MapView'

const MARGIN = 8

/**
 * Tap popup rendered in React (not MapLibre's Popup) so it can be clamped to
 * the viewport: it follows the tapped point but never leaves the screen, and
 * its text wraps inside `min(92vw, 340px)`.
 */
export function MapPopup() {
  const map = useMap()
  const sel = useApp((s) => s.selection)
  const now = useNow()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; arrow: 'up' | 'down'; arrowX: number } | null>(null)

  const place = () => {
    if (!map || !sel || !ref.current) return
    const container = map.getContainer()
    const W = container.clientWidth
    const H = container.clientHeight
    const pt = map.project([sel.lngLat.lng, sel.lngLat.lat])
    const box = ref.current.getBoundingClientRect()
    const w = box.width
    const h = box.height
    // Prefer above the point; flip below if it would clip the top.
    let top = pt.y - h - 14
    let arrow: 'up' | 'down' = 'down'
    if (top < MARGIN + 56) {
      top = pt.y + 14
      arrow = 'up'
    }
    top = Math.min(Math.max(MARGIN, top), H - h - MARGIN)
    let left = pt.x - w / 2
    left = Math.min(Math.max(MARGIN, left), W - w - MARGIN)
    const arrowX = Math.min(Math.max(14, pt.x - left), w - 14)
    setPos({ left, top, arrow, arrowX })
  }

  useLayoutEffect(place, [map, sel]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!map || !sel) return
    map.on('move', place)
    map.on('resize', place)
    return () => {
      map.off('move', place)
      map.off('resize', place)
    }
  }) // re-subscribe each render so `place` sees the latest selection

  if (!sel) return null
  const close = () => store.set({ selection: null })
  return (
    <div
      ref={ref}
      className={`map-popup ${pos ? '' : 'measuring'} arrow-${pos?.arrow ?? 'down'}`}
      style={pos ? { left: pos.left, top: pos.top, ['--arrow-x' as string]: `${pos.arrowX}px` } : undefined}
      role="dialog"
      aria-label={sel.title}
    >
      <div className="popup-head">
        <strong>{sel.title}</strong>
        <button className="icon-btn" onClick={close} aria-label="Close popup">
          ×
        </button>
      </div>
      <ul className="popup-lines">
        {sel.lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {(sel.source || sel.updated) && (
        <div className="popup-meta">
          {sel.source && <span>Source: {sel.source}</span>}
          {sel.updated && <span> · updated {timeAgo(sel.updated, now)}</span>}
        </div>
      )}
      <div className="popup-actions">
        {sel.kind === 'point' && (
          <button
            className="btn small"
            onClick={() => {
              store.set({ place: { name: 'Map point', lngLat: sel.lngLat, source: 'map' }, selection: null })
            }}
          >
            Use as my location
          </button>
        )}
        {sel.kind === 'point' && (
          <button className="btn small" onClick={() => setJourneyTo({ name: `Map point ${sel.lngLat.lat.toFixed(3)}, ${sel.lngLat.lng.toFixed(3)}`, lngLat: sel.lngLat, source: 'map' })}>
            Set as destination
          </button>
        )}
        {sel.kind === 'gauge' && (
          <button className="btn small" onClick={() => store.set({ tab: 'rivers', sheet: 'half', selection: null })}>
            All gauges
          </button>
        )}
        {sel.kind === 'flood' && (
          <button className="btn small" onClick={() => store.set({ tab: 'flood', sheet: 'half', selection: null })}>
            How this is scored
          </button>
        )}
        {sel.kind === 'station' && (
          <button className="btn small" onClick={() => store.set({ tab: 'station', sheet: 'half', selection: null })}>
            Full observation
          </button>
        )}
        {sel.kind === 'rain' && (
          <button className="btn small" onClick={() => store.set({ tab: 'timeline', animLayer: 'rainfall', sheet: 'half', selection: null })}>
            Scrub timeline
          </button>
        )}
      </div>
    </div>
  )
}
