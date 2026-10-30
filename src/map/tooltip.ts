import * as maplibregl from 'maplibre-gl'
import type { Map as MlMap, MapLayerMouseEvent } from 'maplibre-gl'

/**
 * A hover tooltip for a point layer (desktop): a small popup with the point's name while the pointer is over it.
 * Touch devices never fire mouseenter without a tap, so phones are unaffected. `label` returns the text for a
 * feature, or null to show nothing.
 */
export function attachTooltip(map: MlMap, layerId: string, label: (props: Record<string, unknown>) => string | null): () => void {
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'map-tip' })
  const move = (e: MapLayerMouseEvent) => {
    const f = e.features?.[0]
    const text = f ? label(f.properties as Record<string, unknown>) : null
    if (!text || !f || f.geometry.type !== 'Point') {
      popup.remove()
      return
    }
    const [lng, lat] = f.geometry.coordinates as [number, number]
    popup.setLngLat([lng, lat]).setText(text).addTo(map)
  }
  const leave = () => popup.remove()
  map.on('mousemove', layerId, move)
  map.on('mouseleave', layerId, leave)
  return () => {
    map.off('mousemove', layerId, move)
    map.off('mouseleave', layerId, leave)
    popup.remove()
  }
}
