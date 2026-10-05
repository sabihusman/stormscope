import { useEffect, useRef } from 'react'
import { satTileUrl } from '../api/gibs'
import { useApp } from '../state/store'
import { firstSymbolLayer, useMap } from './MapView'

const ID = 'gibs-sat'

/**
 * GOES satellite frames from NASA GIBS. Like the radar layer, every frame is
 * pre-added as its own raster source so scrubbing is an opacity flip and tiles
 * stay cached. Drawn beneath the radar so echoes read on top of the clouds.
 */
export function SatelliteLayer() {
  const map = useMap()
  const enabled = useApp((s) => s.layers.satellite)
  const sat = useApp((s) => s.satellite.data)
  const frame = useApp((s) => s.satFrame)
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
    if (!enabled || !sat) {
      remove()
      return
    }
    remove()
    // Below the radar frames (if present) and below labels.
    const radarBelow = map.getStyle().layers.find((l) => l.id.startsWith('rv-radar-'))?.id
    const before = radarBelow ?? firstSymbolLayer(map)
    sat.times.forEach((t, i) => {
      const id = `${ID}-${i}`
      map.addSource(id, {
        type: 'raster',
        tiles: [satTileUrl(sat.layer, t)],
        tileSize: 256,
        maxzoom: sat.layer.maxzoom,
        attribution: '<a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS / NOAA GOES</a>',
      })
      map.addLayer(
        { id, type: 'raster', source: id, paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 0 }, 'raster-fade-duration': 0 } },
        before,
      )
      added.current.push(id)
    })
    return remove
  }, [map, enabled, sat])

  useEffect(() => {
    if (!map || !enabled) return
    added.current.forEach((id, i) => {
      if (map.getLayer(id)) map.setPaintProperty(id, 'raster-opacity', i === frame ? 0.85 : 0)
    })
  }, [map, enabled, frame, sat])

  return null
}
