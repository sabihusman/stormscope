import { useEffect, useRef } from 'react'
import { satTileUrl } from '../api/gibs'
import { useApp } from '../state/store'
import { firstSymbolLayer, useMap } from './MapView'

const ID = 'gibs-sat'

/**
 * GOES satellite frames from NASA GIBS. Every frame is its own raster source, keyed by its time, so a
 * 5-minute refresh that adds one frame and drops the oldest touches only those two — the other frames'
 * sources (and their cached tiles) stay as they are, which is what keeps loop 2+ of playback free of
 * requests. Only the current frame (plus the next two while playing) is a *visible* layer; the rest sit at
 * visibility none, their tiles retained in MapLibre's per-source cache. Drawn beneath the radar.
 */
export function SatelliteLayer() {
  const map = useMap()
  const enabled = useApp((s) => s.layers.satellite)
  const sat = useApp((s) => s.satellite.data)
  const frame = useApp((s) => s.satFrame)
  const playing = useApp((s) => s.playing)
  /** time (ms) → layer/source id, in frame order. */
  const ids = useRef(new Map<number, string>())

  useEffect(() => {
    if (!map) return
    const removeAll = () => {
      for (const id of ids.current.values()) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
      }
      ids.current.clear()
    }
    if (!enabled || !sat) {
      removeAll()
      return
    }
    const want = new Set(sat.times)
    // Drop frames no longer listed; the layer/source ids carry the frame time, so a product switch (a
    // different tile URL for the same time) is handled by the product being part of the id.
    for (const [t, id] of [...ids.current]) {
      if (!want.has(t) || !id.endsWith(`-${sat.layer.id}`)) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
        ids.current.delete(t)
      }
    }
    // Add the new ones below the radar frames (if present) and below labels.
    const radarBelow = map.getStyle().layers.find((l) => l.id.startsWith('rv-radar-'))?.id
    const before = radarBelow ?? firstSymbolLayer(map)
    for (const t of sat.times) {
      if (ids.current.has(t)) continue
      const id = `${ID}-${t}-${sat.layer.id}`
      map.addSource(id, {
        type: 'raster',
        tiles: [satTileUrl(sat.layer, t)],
        tileSize: 256,
        maxzoom: sat.layer.maxzoom,
        attribution: '<a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS / NOAA GOES</a>',
      })
      map.addLayer({ id, type: 'raster', source: id, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 0 }, 'raster-fade-duration': 0 } }, before)
      ids.current.set(t, id)
    }
  }, [map, enabled, sat])

  // Unmount / disable: remove everything.
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
    if (!map || !enabled || !sat) return
    const n = sat.times.length
    const keep = new Set<number>([frame])
    if (playing) for (let k = 1; k <= 2; k++) keep.add((frame + k) % Math.max(1, n))
    sat.times.forEach((t, i) => {
      const id = ids.current.get(t)
      if (!id || !map.getLayer(id)) return
      const vis = keep.has(i) ? 'visible' : 'none'
      if (map.getLayoutProperty(id, 'visibility') !== vis) map.setLayoutProperty(id, 'visibility', vis)
      map.setPaintProperty(id, 'raster-opacity', i === frame ? 0.85 : 0)
    })
  }, [map, enabled, frame, playing, sat])

  return null
}
