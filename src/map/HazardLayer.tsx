import { useEffect, useMemo } from 'react'
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl'
import { clock, dayClock } from '../lib/time'
import { store, useApp } from '../state/store'
import { firstSymbolLayer, useMap } from './MapView'

const HITS = 'hazard-hits'
const NEAR = 'hazard-nearby'
const TIER_COLOR: Record<string, string> = { warning: '#ef4444', watch: '#f97316', advisory: '#facc15', statement: '#94a3b8', outlook: '#a855f7' }

/** Hazard polygons that intersect the journey at ETA (solid) and those that only overlap in space (dashed). */
export function HazardLayer() {
  const map = useMap()
  const report = useApp((s) => s.journey.hazards.data)

  const hits = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: (report?.hits ?? [])
        .filter((h) => h.hazard.geometry)
        .map((h) => ({
          type: 'Feature' as const,
          geometry: h.hazard.geometry!,
          properties: { id: h.hazard.id, tier: h.hazard.tier, color: TIER_COLOR[h.hazard.tier], event: h.hazard.event, from: h.hazard.validFrom, to: h.hazard.validTo, firstEta: h.firstEta, lastEta: h.lastEta, tags: (h.hazard.tags ?? []).join(' · '), outlook: h.hazard.tier === 'outlook' ? 1 : 0 },
        })),
    }),
    [report],
  )
  const near = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: (report?.nearby ?? [])
        .filter((h) => h.hazard.geometry && h.hazard.tier !== 'outlook')
        .map((h) => ({ type: 'Feature' as const, geometry: h.hazard.geometry!, properties: { id: h.hazard.id, event: h.hazard.event, reason: h.reason, from: h.hazard.validFrom, to: h.hazard.validTo } })),
    }),
    [report],
  )

  useEffect(() => {
    if (!map) return
    const before = firstSymbolLayer(map)
    map.addSource(NEAR, { type: 'geojson', data: near })
    map.addLayer({ id: NEAR, type: 'line', source: NEAR, paint: { 'line-color': '#94a3b8', 'line-width': 1.5, 'line-dasharray': [2, 2], 'line-opacity': 0.8 } }, before)
    map.addSource(HITS, { type: 'geojson', data: hits })
    map.addLayer({ id: `${HITS}-fill`, type: 'fill', source: HITS, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['==', ['get', 'outlook'], 1], 0.08, 0.2] } }, before)
    map.addLayer({ id: HITS, type: 'line', source: HITS, paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['==', ['get', 'outlook'], 1], 1.5, 3] } }, before)
    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      e.preventDefault()
      const p = f.properties as { event: string; from: number; to: number; firstEta: number; lastEta: number; tags: string; tier: string }
      store.set({
        selection: {
          kind: 'journey',
          lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
          title: p.event,
          lines: [
            `${p.tier} · valid ${dayClock(p.from)} → ${dayClock(p.to)}`,
            `You'd be inside it ${clock(p.firstEta)}–${clock(p.lastEta)}`,
            ...(p.tags ? [p.tags] : []),
          ],
          source: 'See journey panel for the source',
        },
      })
    }
    const onNear = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      e.preventDefault()
      const p = f.properties as { event: string; from: number; to: number; reason: string }
      store.set({
        selection: {
          kind: 'journey',
          lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
          title: `${p.event} — not at your ETA`,
          lines: [`Polygon valid ${dayClock(p.from)} → ${dayClock(p.to)}`, p.reason === 'expired-before-eta' ? 'Expired before you would reach it' : 'Starts after you would have passed'],
        },
      })
    }
    map.on('click', `${HITS}-fill`, onClick)
    map.on('click', NEAR, onNear)
    return () => {
      map.off('click', `${HITS}-fill`, onClick)
      map.off('click', NEAR, onNear)
      for (const id of [HITS, `${HITS}-fill`, NEAR]) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [HITS, NEAR]) if (map.getSource(id)) map.removeSource(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  useEffect(() => {
    if (!map) return
    ;(map.getSource(HITS) as GeoJSONSource | undefined)?.setData(hits)
    ;(map.getSource(NEAR) as GeoJSONSource | undefined)?.setData(near)
  }, [map, hits, near])

  return null
}
