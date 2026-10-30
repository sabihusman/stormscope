import { useEffect, useMemo, useRef } from 'react'
import { useNow, useOnline, useReducedMotion, useWide } from '../hooks/useMisc'
import { haversine } from '../lib/geo'
import { clock, HOUR, MIN, timeAgo } from '../lib/time'
import { aggregate, nearestFrame, setLayer, store, useApp, useVisibleBlocks, type AnimLayer } from '../state/store'
import { NOWCAST_FRAME_MIN, NOWCAST_FRAMES } from '../workers/client'
import type { RainHorizon } from '../types'
import { PlaybackScale } from './Legend'

/** Tick cadence while playing (ms per step; radar frames are 10 min apart, forecast hours step hourly). */
const STEP_MS = 450
/** Radar frames further than this from the clock are hidden (the clock has moved past the last nowcast frame). */
const RADAR_TOLERANCE = 12 * MIN

/**
 * One playback clock for the map: radar (or satellite) plus the active forecast overlay move together.
 * Wide layouts: the full bar docked along the bottom edge of the map (▶/❚❚ · time · scrubber · how far
 * ahead · a thin colour scale for the layer being scrubbed). Phones: a pill bottom-left (▶/❚❚ + time, a
 * thin progress line with a "now" mark) that expands into the full bar on tap and collapses with ✕.
 * Nothing at all when no layer animates (background None, no overlay).
 */
export function PlaybackBar() {
  const layers = useApp((s) => s.layers)
  const playing = useApp((s) => s.playing)
  const playTime = useApp((s) => s.playTime)
  const radar = useApp((s) => s.radar.data)
  const satellite = useApp((s) => s.satellite.data)
  const nowcastT0 = useApp((s) => s.nowcastT0)
  const horizon = useApp((s) => s.rainHorizon)
  const place = useApp((s) => s.place)
  const label = useApp((s) => s.placeLabel)
  const imageryLag = useApp((s) => s.imageryLag)
  const expandedPref = useApp((s) => s.playbarExpanded)
  const placeInView = useApp((s) => s.placeInView)
  const blocks = useVisibleBlocks()
  const reduced = useReducedMotion()
  const wide = useWide()
  const now = useNow(30_000)

  const overlay: AnimLayer | null = layers.rainfall ? 'rainfall' : layers.nowcast ? 'nowcast' : null
  const imagery: AnimLayer | null = layers.radar ? 'radar' : layers.satellite ? 'satellite' : null
  const overlayAgg = aggregate(blocks, (b) => (overlay === 'rainfall' ? b.rainCells : b.nowcast))
  const overlayReady = !!overlay && overlayAgg.ready > 0
  const noBlocks = !!overlay && blocks.length === 0
  const nothingOn = !imagery && !overlay
  const expanded = wide || expandedPref

  // The time axis: every imagery frame time plus every forecast frame time, sorted.
  const ticks = useMemo(() => {
    const t = new Set<number>()
    if (imagery === 'radar') for (const f of radar?.frames ?? []) t.add(f.time * 1000)
    if (imagery === 'satellite') for (const x of satellite?.times ?? []) t.add(x)
    if (overlayReady && overlay === 'rainfall') {
      const h0 = Math.floor(now / HOUR) * HOUR
      for (let i = 0; i <= horizon; i++) t.add(h0 + i * HOUR)
    }
    if (overlayReady && overlay === 'nowcast' && nowcastT0) for (let i = 0; i < NOWCAST_FRAMES; i++) t.add(nowcastT0 + i * NOWCAST_FRAME_MIN * MIN)
    return [...t].sort((a, b) => a - b)
  }, [imagery, radar, satellite, overlay, overlayReady, horizon, nowcastT0, now])

  const nowIdx = ticks.length ? nearestFrame(ticks, now)! : 0
  const shown = playTime ?? now
  const idx = ticks.length ? nearestFrame(ticks, shown)! : 0
  const pct = (i: number) => (i / Math.max(1, ticks.length - 1)) * 100

  // Clock → each layer's frame. Live (null) leaves the imagery on its newest observed frame (the controller lands there).
  useEffect(() => {
    const s = store.get()
    const patch: Partial<typeof s> = {}
    if (playTime != null) {
      if (s.radar.data?.frames.length) {
        const times = s.radar.data.frames.map((f) => f.time * 1000)
        const i = nearestFrame(times, playTime)!
        patch.radarFrame = Math.abs(times[i] - playTime) <= RADAR_TOLERANCE ? i : -1
      }
      if (s.satellite.data?.times.length) {
        // GOES lands ~1 h behind real time: the frame nearest the clock, or the newest when nothing is
        // within 10 min (the controller's carry-over adds the lag note in that case); never hidden.
        const times = s.satellite.data.times
        const i = nearestFrame(times, playTime)!
        patch.satFrame = Math.abs(times[i] - playTime) <= 10 * MIN ? i : times.length - 1
      }
      patch.rainFrame = Math.max(0, Math.min(s.rainHorizon, Math.round((playTime - Math.floor(Date.now() / HOUR) * HOUR) / HOUR)))
      if (s.nowcastT0) patch.nowcastFrame = Math.max(0, Math.min(NOWCAST_FRAMES - 1, Math.round((playTime - s.nowcastT0) / (NOWCAST_FRAME_MIN * MIN))))
    } else {
      patch.rainFrame = 0
      patch.nowcastFrame = 0
      if (s.radar.data?.frames.length) {
        const lastPast = Math.max(0, s.radar.data.frames.filter((f) => f.kind === 'past').length - 1)
        if (s.radarFrame < 0 || s.radarFrame >= s.radar.data.frames.length) patch.radarFrame = lastPast
      }
    }
    store.set(patch)
  }, [playTime, radar, satellite, nowcastT0, horizon])

  // Playback loop: step to the next tick, wrap to the first.
  useEffect(() => {
    if (!playing || ticks.length < 2) return
    const t = setInterval(() => {
      const cur = store.get().playTime ?? Date.now()
      const i = nearestFrame(ticks, cur)!
      store.set({ playTime: ticks[(i + 1) % ticks.length] })
    }, STEP_MS * (reduced ? 2 : 1))
    return () => clearInterval(t)
  }, [playing, ticks, reduced])

  // Floating controls (layer button, zoom, chip, toasts) stack above the control via --playbar-h on .app.
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = ref.current
    const app = el?.closest('.app') as HTMLElement | null
    if (!el || !app) {
      document.querySelector<HTMLElement>('.app')?.style.setProperty('--playbar-h', '0px')
      return
    }
    const apply = () => app.style.setProperty('--playbar-h', `${el.offsetHeight}px`)
    apply()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null
    ro?.observe(el)
    return () => {
      ro?.disconnect()
      app.style.setProperty('--playbar-h', '0px')
    }
  }, [expanded, nothingOn])

  if (nothingOn) return null

  // Every frame reads its clock time (past radar and forecast alike); the Now boundary is marked and labelled separately.
  const timeLabel = (t: number) => clock(t)
  const current = ticks.length ? timeLabel(ticks[idx]) : '—'
  const isFuture = ticks.length ? ticks[idx] - now > 5 * MIN : false
  const boundary = (
    <small className="playbar-boundary" aria-label={`Now ${clock(now)}: radar up to now, forecast after`}>
      <i className="boundary-mark" aria-hidden="true" /> Now {clock(now)} · radar up to now, forecast after
    </small>
  )
  const name = (label ?? place?.name ?? 'my place').split(',')[0]
  const zoomToPlace = () => {
    if (!place) return
    const m = (window as unknown as { __map?: { easeTo: (o: object) => void } }).__map
    m?.easeTo({ center: [place.lngLat.lng, place.lngLat.lat], zoom: 9, duration: 700 })
  }
  const pickHorizon = (h: RainHorizon) => {
    store.set({ rainHorizon: h })
    if (!layers.rainfall) setLayer('rainfall', true)
  }
  const scaleLayer: AnimLayer = overlay ?? imagery!
  const playButton = (
    <button className="icon-btn round big play" onClick={() => store.set({ playing: !playing })} aria-label={playing ? 'Pause' : 'Play'} aria-pressed={playing} disabled={ticks.length < 2}>
      {playing ? '❚❚' : '▶'}
    </button>
  )

  if (!expanded)
    return (
      <section className="playdock" aria-label="Playback" ref={ref}>
        <StatusStrip />
        <div className="playpill">
          {playButton}
          <button className="pill-label" onClick={() => store.set({ playbarExpanded: true })} aria-label={`Show controls (${current}${isFuture ? ', forecast' : ''})`} aria-expanded={false}>
            {current}
            {isFuture && <small className="pill-kind">forecast</small>}
          </button>
          <div className="pill-progress" aria-hidden="true" style={{ ['--now-pct' as string]: `${pct(nowIdx)}%` }}>
            <i className="pill-now" style={{ left: `${pct(nowIdx)}%` }} />
            <i className="pill-pos" style={{ left: `${pct(idx)}%` }} />
          </div>
        </div>
      </section>
    )

  return (
    <section className="playbar" aria-label="Playback" ref={ref}>
      <StatusStrip />
      <div className="playbar-row">
        {playButton}
        <strong className="playbar-time" aria-live="polite">
          {current}
          {isFuture && <small className="time-kind">forecast</small>}
        </strong>
        <input
          className="scrubber"
          type="range"
          min={0}
          max={Math.max(0, ticks.length - 1)}
          value={idx}
          disabled={ticks.length < 2}
          onChange={(e) => store.set({ playing: false, playTime: ticks[+e.target.value] ?? null, imageryLag: null })}
          aria-label="Playback time"
          aria-valuetext={current}
          style={{ ['--now-pct' as string]: `${pct(nowIdx)}%` }}
        />
        <div className="segmented small horizon" role="radiogroup" aria-label="How far ahead">
          {([6, 12, 24, 48] as RainHorizon[]).map((h) => (
            <button key={h} role="radio" aria-checked={layers.rainfall && horizon === h} className={layers.rainfall && horizon === h ? 'on' : ''} onClick={() => pickHorizon(h)}>
              {h} h
            </button>
          ))}
        </div>
        {!wide && (
          <button className="icon-btn playbar-close" onClick={() => store.set({ playbarExpanded: false })} aria-label="Hide controls">
            ✕
          </button>
        )}
      </div>
      {boundary}
      <PlaybackScale layer={scaleLayer} />
      {/* "Zoom to <place>" only once the map has actually been moved away from the place (never while it lands on it after a reload). */}
      {(noBlocks || (place && !placeInView)) && (
        <div className="playbar-note" role="status">
          {noBlocks && <span>Zoom in to see the forecast</span>}
          {place && !placeInView && (
            <button className="btn small" onClick={zoomToPlace}>
              Zoom to {name}
            </button>
          )}
        </div>
      )}
      {imageryLag && (
        <small className="playbar-note lag-note" role="status">
          {imageryLag.layer === 'satellite' ? 'Satellite' : 'Radar'}: {clock(imageryLag.landed)} — {Math.round(Math.abs(imageryLag.viewed - imageryLag.landed) / MIN)} min{' '}
          {imageryLag.landed < imageryLag.viewed ? 'earlier' : 'later'} than the {imageryLag.layer === 'satellite' ? 'radar' : 'satellite'} time you were on ({clock(imageryLag.viewed)}).
          {imageryLag.layer === 'satellite' ? ' GIBS publishes GOES ~1 h behind real time.' : ''}
        </small>
      )}
    </section>
  )
}

/** Data status chips: offline, "showing map area", and one per layer with its age. They wrap; nothing scrolls off. */
function StatusStrip() {
  const online = useOnline()
  // Narrow subscriptions: the bar is always mounted, so it must not re-render on every frame tick or block update.
  const radar = useApp((s) => s.radar)
  const satellite = useApp((s) => s.satellite)
  const layers = useApp((s) => s.layers)
  const hasPlace = useApp((s) => !!s.place)
  const following = useApp((s) => !!s.focus && (!s.place || haversine(s.focus, s.place.lngLat) > 1000))
  const blocks = useVisibleBlocks()
  const now = useNow()
  const g = aggregate(blocks, (b) => b.grid)
  const rain = { state: g.state, stale: g.stale, error: g.error, freshness: g.fetchedAt ? { fetchedAt: g.fetchedAt } : null }
  const items = [
    { k: 'Radar', r: radar, on: layers.radar },
    { k: 'Satellite', r: satellite, on: layers.satellite },
    { k: `Rain ${g.ready}/${g.total}`, r: rain, on: layers.rainfall || layers.flood || layers.nowcast },
  ].filter((i) => i.on)
  if (online && !following && !items.length) return null
  return (
    <div className="status-strip playbar-status" aria-live="polite">
      {!online && <span className="pill offline">Offline</span>}
      {following && (
        <button className="pill follow" onClick={() => store.set((x) => ({ recenterNonce: x.recenterNonce + 1 }))} disabled={!hasPlace} title={hasPlace ? 'Back to my place' : undefined}>
          Showing map area{hasPlace ? ' · back to my place' : ''}
        </button>
      )}
      {items.map((i) => (
        <span key={i.k} className={`pill ${i.r.state === 'error' ? 'err' : i.r.stale ? 'warn' : i.r.state === 'loading' ? 'load' : 'ok'}`} title={i.r.error ?? undefined}>
          {i.k} {i.r.freshness ? timeAgo(i.r.freshness.fetchedAt, now) : i.r.state === 'loading' ? '…' : i.r.error ? '!' : '—'}
        </span>
      ))}
    </div>
  )
}
