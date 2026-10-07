import { useEffect, useRef } from 'react'
import { RADAR_MAX_ZOOM, RADAR_TILE_SIZE, radarTileUrl } from '../api/rainviewer'
import { useApp } from '../state/store'
import { firstSymbolLayer, useMap } from './MapView'

const ID = 'rv-radar'

/**
 * One raster source/layer per RainViewer frame, all pre-added so the animation
 * is a cheap opacity flip and tiles are already cached. Only the current frame
 * is visible; neighbours are kept at 0 opacity (loaded, not painted).
 */
export function RadarLayer() {
  const map = useMap()
  const enabled = useApp((s) => s.layers.radar)
  const radar = useApp((s) => s.radar.data)
  const frame = useApp((s) => s.radarFrame)
  // One playback clock drives radar and the forecast overlay together.
  const playing = useApp((s) => s.playing)
  const added = useRef<string[]>([])

  useEffect(() => {
    if (!map) return
    const remove = () => {
      for (const id of added.current) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
      }
      added.current = []
    }
    if (!enabled || !radar) {
      remove()
      return
    }
    remove()
    const before = firstSymbolLayer(map)
    radar.frames.forEach((f, i) => {
      const id = `${ID}-${i}`
      map.addSource(id, {
        type: 'raster',
        tiles: [radarTileUrl(radar.host, f)],
        tileSize: RADAR_TILE_SIZE,
        maxzoom: RADAR_MAX_ZOOM,
        attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
      })
      map.addLayer(
        {
          id,
          type: 'raster',
          source: id,
          layout: { visibility: 'none' },
          paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 0 }, 'raster-fade-duration': 0 },
        },
        before,
      )
      added.current.push(id)
    })
    return remove
  }, [map, enabled, radar])

  // Only the current frame (and, while playing, the next two so their tiles are ready) is a
  // *visible* layer. A hidden layer at opacity 0 still makes MapLibre fetch and upload its tiles
  // on every pan/zoom — with 13–16 frames that was 13–16× the tile work for one frame on screen.
  useEffect(() => {
    if (!map || !enabled) return
    const n = added.current.length
    const keep = new Set<number>([frame])
    if (playing) for (let k = 1; k <= 2; k++) keep.add((frame + k) % Math.max(1, n))
    added.current.forEach((id, i) => {
      if (!map.getLayer(id)) return
      const vis = keep.has(i) ? 'visible' : 'none'
      if (map.getLayoutProperty(id, 'visibility') !== vis) map.setLayoutProperty(id, 'visibility', vis)
      map.setPaintProperty(id, 'raster-opacity', i === frame ? 0.75 : 0)
    })
  }, [map, enabled, frame, playing, radar])

  return null
}
