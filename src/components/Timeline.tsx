import { useEffect, useMemo } from 'react'
import { clock, dayClock, HOUR, relOffset } from '../lib/time'
import { useReducedMotion } from '../hooks/useMisc'
import { aggregate, store, useApp, useVisibleBlocks, type AnimLayer } from '../state/store'
import { NOWCAST_FRAME_MIN, NOWCAST_FRAMES } from '../workers/client'
import type { RainHorizon } from '../types'

const SPEED: Record<AnimLayer, number> = { radar: 450, satellite: 350, rainfall: 550, nowcast: 220 }
const NAMES: Record<AnimLayer, string> = { radar: 'Radar', satellite: 'Satellite', rainfall: 'Rainfall', nowcast: 'Nowcast' }

/** One shared play/pause/step/scrub control for every animated layer. */
export function Timeline() {
  const layers = useApp((s) => s.layers)
  const animLayer = useApp((s) => s.animLayer)
  const playing = useApp((s) => s.playing)
  const radar = useApp((s) => s.radar)
  const satellite = useApp((s) => s.satellite)
  const satFrame = useApp((s) => s.satFrame)
  const imageryLag = useApp((s) => s.imageryLag)
  const blocks = useVisibleBlocks()
  const nowcastT0 = useApp((s) => s.nowcastT0)
  const radarFrame = useApp((s) => s.radarFrame)
  const rainFrame = useApp((s) => s.rainFrame)
  const nowcastFrame = useApp((s) => s.nowcastFrame)
  const horizon = useApp((s) => s.rainHorizon)
  const reduced = useReducedMotion()

  const available = (['radar', 'satellite', 'rainfall', 'nowcast'] as AnimLayer[]).filter((l) => layers[l])

  // Frame model for the active layer.
  const model = useMemo(() => {
    if (animLayer === 'radar') {
      const frames = radar.data?.frames ?? []
      return {
        count: frames.length,
        frame: radarFrame,
        set: (i: number) => store.set({ radarFrame: i, imageryLag: null }),
        label: (i: number) => (frames[i] ? `${clock(frames[i].time * 1000)}${frames[i].kind === 'nowcast' ? ' (forecast)' : ''}` : '—'),
        sub: (i: number) => (frames[i] ? relOffset(Date.now(), frames[i].time * 1000) : ''),
        nowIdx: Math.max(0, frames.filter((f) => f.kind === 'past').length - 1),
        state: radar.state,
        error: radar.error,
      }
    }
    if (animLayer === 'satellite') {
      const times = satellite.data?.times ?? []
      return {
        count: times.length,
        frame: satFrame,
        set: (i: number) => store.set({ satFrame: i, imageryLag: null }),
        label: (i: number) => (times[i] ? clock(times[i]) : '—'),
        sub: (i: number) => (times[i] ? relOffset(Date.now(), times[i]) : ''),
        nowIdx: Math.max(0, times.length - 1),
        state: satellite.state,
        error: satellite.error,
      }
    }
    if (animLayer === 'rainfall') {
      const agg = aggregate(blocks, (b) => b.rainCells)
      const gridAgg = aggregate(blocks, (b) => b.grid)
      const nowHour = Math.floor(Date.now() / HOUR)
      const count = agg.ready > 0 ? horizon + 1 : 0
      return {
        count,
        frame: rainFrame,
        set: (i: number) => store.set({ rainFrame: i }),
        label: (i: number) => dayClock((nowHour + i) * HOUR),
        sub: (i: number) => (i === 0 ? 'now' : `+${i} h accumulated`),
        nowIdx: 0,
        state: agg.state === 'idle' ? gridAgg.state : agg.state,
        error: agg.error ?? gridAgg.error,
      }
    }
    const agg = aggregate(blocks, (b) => b.nowcast)
    const gridAgg = aggregate(blocks, (b) => b.grid)
    const count = agg.ready > 0 && nowcastT0 ? NOWCAST_FRAMES : 0
    return {
      count,
      frame: nowcastFrame,
      set: (i: number) => store.set({ nowcastFrame: i }),
      label: (i: number) => clock(nowcastT0 + i * NOWCAST_FRAME_MIN * 60_000),
      sub: (i: number) => relOffset(nowcastT0, nowcastT0 + i * NOWCAST_FRAME_MIN * 60_000),
      nowIdx: 0,
      state: agg.state === 'idle' ? gridAgg.state : agg.state,
      error: agg.error ?? gridAgg.error,
    }
  }, [animLayer, radar, satellite, satFrame, blocks, nowcastT0, radarFrame, rainFrame, nowcastFrame, horizon])

  // Remember the imagery time on screen so a layer switch can carry it even if indices shift underneath.
  useEffect(() => {
    if (animLayer === 'radar' && radar.data?.frames.length) {
      const f = radar.data.frames[Math.min(radarFrame, radar.data.frames.length - 1)]
      if (f) store.set({ lastImageryTime: f.time * 1000 })
    } else if (animLayer === 'satellite' && satellite.data?.times.length) {
      const t = satellite.data.times[Math.min(satFrame, satellite.data.times.length - 1)]
      if (t) store.set({ lastImageryTime: t })
    }
  }, [animLayer, radar.data, radarFrame, satellite.data, satFrame])

  // Playback loop.
  useEffect(() => {
    if (!playing || model.count === 0) return
    const t = setInterval(() => {
      const s = store.get()
      const cur = s.animLayer === 'radar' ? s.radarFrame : s.animLayer === 'satellite' ? s.satFrame : s.animLayer === 'rainfall' ? s.rainFrame : s.nowcastFrame
      model.set((cur + 1) % model.count)
    }, SPEED[animLayer] * (reduced ? 2 : 1))
    return () => clearInterval(t)
  }, [playing, animLayer, model, reduced])

  // Clamp frame if data shrank — a system correction, not a user scrub, so it must not clear the lag note.
  useEffect(() => {
    if (!model.count || model.frame < model.count) return
    const key = animLayer === 'radar' ? 'radarFrame' : animLayer === 'satellite' ? 'satFrame' : animLayer === 'rainfall' ? 'rainFrame' : 'nowcastFrame'
    store.set({ [key]: model.count - 1 })
  }, [model, animLayer])

  if (!available.length)
    return (
      <div className="panel-empty">
        <p>No animated layer is on. Turn on Radar, Rainfall or Nowcast from the layer menu (☰).</p>
        <button className="btn small" onClick={() => store.set({ layers: { ...layers, radar: true }, animLayer: 'radar' })}>
          Turn on radar
        </button>
      </div>
    )

  const frame = Math.min(model.frame, Math.max(0, model.count - 1))
  const noBlocks = animLayer !== 'radar' && blocks.length === 0
  return (
    <div className="timeline">
      {available.length > 1 && (
        <div className="segmented" role="tablist" aria-label="Animated layer">
          {available.map((l) => (
            <button key={l} role="tab" aria-selected={animLayer === l} className={animLayer === l ? 'on' : ''} onClick={() => store.set({ animLayer: l })}>
              {NAMES[l]}
            </button>
          ))}
        </div>
      )}
      {animLayer === 'rainfall' && (
        <div className="segmented small" role="radiogroup" aria-label="Rainfall horizon">
          {([6, 12, 24, 48] as RainHorizon[]).map((h) => (
            <button key={h} role="radio" aria-checked={horizon === h} className={horizon === h ? 'on' : ''} onClick={() => store.set({ rainHorizon: h, rainFrame: 0 })}>
              {h} h
            </button>
          ))}
        </div>
      )}
      {model.count === 0 ? (
        <p className="muted">
          {noBlocks
            ? 'Zoom in to a region (past zoom 5.5) to load forecast blocks.'
            : model.state === 'loading' || model.state === 'idle'
              ? `Loading ${NAMES[animLayer].toLowerCase()}…`
              : (model.error ?? 'No frames available.')}
        </p>
      ) : (
        <>
          <div className="timeline-readout" aria-live="polite">
            <strong>{model.label(frame)}</strong>
            <span className="muted">{model.sub(frame)}</span>
          </div>
          {imageryLag && imageryLag.layer === animLayer && (
            <small className="lag-note" role="status">
              {animLayer === 'satellite' ? 'Satellite' : 'Radar'}: {clock(imageryLag.landed)} — {Math.round(Math.abs(imageryLag.viewed - imageryLag.landed) / 60_000)} min{' '}
              {imageryLag.landed < imageryLag.viewed ? 'earlier' : 'later'} than the {animLayer === 'satellite' ? 'radar' : 'satellite'} time you were on ({clock(imageryLag.viewed)}).
              {animLayer === 'satellite' ? ' GIBS publishes GOES ~1 h behind real time.' : ''}
            </small>
          )}
          <div className="timeline-controls">
            <button className="icon-btn round" onClick={() => model.set((frame - 1 + model.count) % model.count)} aria-label="Previous frame">
              ⏮
            </button>
            <button className="icon-btn round big" onClick={() => store.set({ playing: !playing })} aria-label={playing ? 'Pause' : 'Play'} aria-pressed={playing}>
              {playing ? '❚❚' : '▶'}
            </button>
            <button className="icon-btn round" onClick={() => model.set((frame + 1) % model.count)} aria-label="Next frame">
              ⏭
            </button>
            <input
              className="scrubber"
              type="range"
              min={0}
              max={model.count - 1}
              value={frame}
              onChange={(e) => {
                store.set({ playing: false })
                model.set(+e.target.value)
              }}
              aria-label={`${NAMES[animLayer]} frame`}
              aria-valuetext={model.label(frame)}
              style={{ ['--now-pct' as string]: `${(model.nowIdx / Math.max(1, model.count - 1)) * 100}%` }}
            />
          </div>
        </>
      )}
    </div>
  )
}
