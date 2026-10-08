import { useEffect, useRef } from 'react'
import { radarTileUrl, RADAR_MAX_ZOOM, RADAR_TILE_SIZE } from '../api/rainviewer'
import { useApp } from '../state/store'
import { firstSymbolLayer, useMap } from './MapView'

const ID = 'rv-radar'

/**
 * RainViewer radar frames. Every frame is its own raster source, keyed by its time, so the 5-minute
 * refresh that adds a frame and drops the oldest touches only those two; the other frames' sources and
 * their cached tiles stay — loop 2+ of playback makes no request. Only the current frame (plus the next
 * two while playing) is a *visible* layer: a hidden layer at opacity 0 would still fetch and upload its
 * tiles on every pan/zoom (13–16× the tile work for one frame on screen). Hidden sources keep their
 * tiles in MapLibre's per-source cache, so re-showing a frame is a visibility flip.
 */
export function RadarLayer() {
  const map = useMap()
  const enabled = useApp((s) => s.layers.radar)
  const radar = useApp((s) => s.radar.data)
  const frame = useApp((s) => s.radarFrame)
  // One playback clock drives radar and the forecast overlay together.
  const playing = useApp((s) => s.playing)
  /** frame time (s) → layer/source id. */
  const ids = useRef(new Map<number, string>())

  useEffect(() => {
    if (!map) return
    if (!enabled || !radar) {
      for (const id of ids.current.values()) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
      }
      ids.current.clear()
      return
    }
    const want = new Map(radar.frames.map((f) => [f.time, f]))
    for (const [t, id] of [...ids.current]) {
      // A frame that changed path for the same time (nowcast → past) gets a fresh source.
      const f = want.get(t)
      if (!f || !id.endsWith(`-${f.kind}`)) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
        ids.current.delete(t)
      }
    }
    const before = firstSymbolLayer(map)
    for (const f of radar.frames) {
      if (ids.current.has(f.time)) continue
      const id = `${ID}-${f.time}-${f.kind}`
      map.addSource(id, {
        type: 'raster',
        tiles: [radarTileUrl(radar.host, f)],
        tileSize: RADAR_TILE_SIZE,
        maxzoom: RADAR_MAX_ZOOM,
        attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
      })
      map.addLayer({ id, type: 'raster', source: id, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 0 }, 'raster-fade-duration': 0 } }, before)
      ids.current.set(f.time, id)
    }
  }, [map, enabled, radar])

  // Unmount: remove everything.
  useEffect(() => {
    if (!map) return
    return () => {
      for (const id of ids.current.values()) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
      }
      ids.current.clear()
    }
  }, [map])

  useEffect(() => {
    if (!map || !enabled || !radar) return
    const n = radar.frames.length
    const keep = new Set<number>([frame])
    if (playing) for (let k = 1; k <= 2; k++) keep.add((frame + k) % Math.max(1, n))
    radar.frames.forEach((f, i) => {
      const id = ids.current.get(f.time)
      if (!id || !map.getLayer(id)) return
      const vis = keep.has(i) ? 'visible' : 'none'
      if (map.getLayoutProperty(id, 'visibility') !== vis) map.setLayoutProperty(id, 'visibility', vis)
      map.setPaintProperty(id, 'raster-opacity', i === frame ? 0.75 : 0)
    })
  }, [map, enabled, frame, playing, radar])

  return null
}
