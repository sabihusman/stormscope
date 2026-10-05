import { lazy, Suspense, useEffect, useRef } from 'react'
import { useNow, useOnline } from '../hooks/useMisc'
import { timeAgo } from '../lib/time'
import { haversine } from '../lib/geo'
import { aggregate, store, useApp, useVisibleBlocks, type PanelTab, type SheetMode } from '../state/store'
import { Timeline } from './Timeline'
import { FloodPanel, RiversPanel, SourcesPanel, StationPanel } from './Panels'

// The journey panel (and the routing/hazard/road code behind it) loads when the tab is first opened.
const JourneyPanel = lazy(() => import('./JourneyPanel').then((m) => ({ default: m.JourneyPanel })))

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'journey', label: 'Journey' },
  { id: 'station', label: 'Station' },
  { id: 'rivers', label: 'Rivers' },
  { id: 'flood', label: 'Flood' },
  { id: 'sources', label: 'Sources' },
]
const ORDER: SheetMode[] = ['peek', 'half', 'full']
const step = (m: SheetMode, d: 1 | -1): SheetMode => ORDER[Math.max(0, Math.min(ORDER.length - 1, ORDER.indexOf(m) + d))]

/**
 * Collapsible bottom sheet. The map stays visible and interactive above it in every mode.
 * Collapsing works four ways on a phone: drag the handle down, tap the handle, tap the ▼ button
 * (pinned outside the scrolling tab row, so it is on screen at every width), or — when the
 * content is scrolled to its top — drag the content itself down. Expanding also pushes a
 * history entry so the browser/Android back gesture collapses the sheet instead of leaving.
 */
export function BottomSheet() {
  const mode = useApp((s) => s.sheet)
  const tab = useApp((s) => s.tab)
  const online = useOnline()
  const drag = useRef<{ id: number; y: number; t: number } | null>(null)
  const bodyTouch = useRef<{ y: number; x: number; top: number; done: boolean } | null>(null)
  const pushed = useRef(false)
  const poppingOurs = useRef(false)
  const toggledAt = useRef(0)

  const setMode = (m: SheetMode) => store.set({ sheet: m })

  // ---- Handle: drag (pointer events, finished on window so a finger sliding off still counts) + tap ----
  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { id: e.pointerId, y: e.clientY, t: performance.now() }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* capture is a nicety; the window listeners below finish the gesture regardless */
    }
  }
  useEffect(() => {
    const finish = (e: PointerEvent) => {
      const d = drag.current
      if (!d || e.pointerId !== d.id) return
      drag.current = null
      const dy = e.clientY - d.y
      const dt = performance.now() - d.t
      const m = store.get().sheet
      if (Math.abs(dy) < 8 && dt < 400) {
        // Tap: expanded → collapse, collapsed → open.
        setMode(m === 'peek' ? 'half' : 'peek')
        return
      }
      if (dy < -30) setMode(step(m, 1))
      else if (dy > 30) setMode(step(m, -1))
    }
    const cancel = () => {
      drag.current = null
    }
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [])

  // ---- Content: a downward swipe that starts with the content scrolled to the top collapses one step ----
  const onBodyTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const t = e.touches[0]
    bodyTouch.current = { y: t.clientY, x: t.clientX, top: e.currentTarget.scrollTop, done: false }
  }
  const onBodyTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const b = bodyTouch.current
    if (!b || b.done || b.top > 0) return
    const t = e.touches[0]
    const dy = t.clientY - b.y
    const dx = Math.abs(t.clientX - b.x)
    if (dy > 48 && dx < dy / 2) {
      b.done = true
      setMode(step(store.get().sheet, -1))
    }
  }
  const onBodyTouchEnd = () => {
    bodyTouch.current = null
  }

  // ---- Back gesture: an expanded sheet owns one history entry ----
  useEffect(() => {
    const onPop = () => {
      if (poppingOurs.current) {
        // The pop we asked for when the UI collapsed the sheet: nothing to do (the sheet may already be open again).
        poppingOurs.current = false
        return
      }
      pushed.current = false
      if (store.get().sheet !== 'peek') store.set({ sheet: 'peek' })
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  useEffect(() => {
    if (mode !== 'peek' && !pushed.current) {
      pushed.current = true
      try {
        history.pushState({ ...(history.state ?? {}), sheet: true }, '')
      } catch {
        pushed.current = false
      }
    } else if (mode === 'peek' && pushed.current) {
      pushed.current = false
      poppingOurs.current = true
      history.back() // consumes our entry; the popstate handler ignores this one
    }
  }, [mode])

  return (
    <section className={`sheet ${mode}`} aria-label="Details panel">
      <div
        className="sheet-handle"
        onPointerDown={onPointerDown}
        role="button"
        tabIndex={0}
        aria-label="Resize panel"
        aria-expanded={mode !== 'peek'}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') setMode(step(mode, 1))
          if (e.key === 'ArrowDown' || e.key === 'Escape') setMode(step(mode, -1))
          if (e.key === 'Enter' || e.key === ' ') setMode(mode === 'peek' ? 'half' : 'peek')
        }}
      >
        <span className="grabber" />
      </div>
      <StatusStrip online={online} />
      <nav className="tabs">
        <div className="tablist" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => store.set({ tab: t.id, sheet: mode === 'peek' ? 'half' : mode })}>
              {t.label}
            </button>
          ))}
        </div>
        <button
          className="icon-btn sheet-toggle"
          // Pointer-up toggles directly: after a touch scroll/overscroll gesture Chromium can skip the
          // synthesized click for the next tap; the click handler then dedupes against it.
          onPointerUp={(e) => {
            if (e.pointerType === 'mouse') return
            toggledAt.current = performance.now()
            setMode(store.get().sheet === 'peek' ? 'half' : 'peek')
          }}
          onClick={() => {
            if (performance.now() - toggledAt.current < 600) return
            setMode(store.get().sheet === 'peek' ? 'half' : 'peek')
          }}
          aria-label={mode === 'peek' ? 'Expand panel' : 'Collapse panel'}
        >
          {mode === 'peek' ? '▲' : '▼'}
        </button>
      </nav>
      <div className="sheet-body" hidden={mode === 'peek'} onTouchStart={onBodyTouchStart} onTouchMove={onBodyTouchMove} onTouchEnd={onBodyTouchEnd} onTouchCancel={onBodyTouchEnd}>
        {tab === 'timeline' && <Timeline />}
        {tab === 'journey' && (
          <Suspense fallback={<p className="muted">Loading journey tools…</p>}>
            <JourneyPanel />
          </Suspense>
        )}
        {tab === 'station' && <StationPanel />}
        {tab === 'rivers' && <RiversPanel />}
        {tab === 'flood' && <FloodPanel />}
        {tab === 'sources' && <SourcesPanel />}
      </div>
    </section>
  )
}

function StatusStrip({ online }: { online: boolean }) {
  const s = useApp((x) => x)
  const blocks = useVisibleBlocks()
  const now = useNow()
  const following = !!s.focus && (!s.place || haversine(s.focus, s.place.lngLat) > 1000)
  const g = aggregate(blocks, (b) => b.grid)
  const rain = { state: g.state, stale: g.stale, error: g.error, freshness: g.fetchedAt ? { fetchedAt: g.fetchedAt } : null }
  const items = [
    { k: 'Radar', r: s.radar, on: s.layers.radar },
    { k: 'Satellite', r: s.satellite, on: s.layers.satellite },
    { k: `Rain ${g.ready}/${g.total}`, r: rain, on: s.layers.rainfall || s.layers.flood || s.layers.nowcast },
    { k: 'Rivers', r: s.rivers, on: s.layers.rivers },
    { k: 'Station', r: s.station, on: s.layers.station },
  ].filter((i) => i.on)
  return (
    <div className="status-strip" aria-live="polite">
      {!online && <span className="pill offline">Offline — showing last saved data</span>}
      {following && (
        <button className="pill follow" onClick={() => store.set((x) => ({ recenterNonce: x.recenterNonce + 1 }))} disabled={!s.place} title={s.place ? 'Back to my location' : undefined}>
          Showing map area{s.place ? ' · back to my spot' : ''}
        </button>
      )}
      {items.map((i) => (
        <span key={i.k} className={`pill ${i.r.state === 'error' ? 'err' : i.r.stale ? 'warn' : i.r.state === 'loading' ? 'load' : 'ok'}`} title={i.r.error ?? undefined}>
          {i.k} {i.r.freshness ? timeAgo(i.r.freshness.fetchedAt, now) : i.r.state === 'loading' ? '…' : i.r.error ? '!' : '—'}
        </span>
      ))}
      {!s.place && !s.focus && <span className="pill">No location set — pan &amp; zoom in, or search</span>}
    </div>
  )
}
