import { useEffect, useMemo } from 'react'
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl'
import { FLOOD_STOPS, stepExpression } from '../lib/colors'
import { U } from '../lib/units'
import { store, useApp, useVisibleBlocks } from '../state/store'
import { firstSymbolLayer, useMap } from './MapView'

const SRC = 'flood-cells'
const LINES = 'nhd-flowlines'

/** Flood-risk cells and NHD flowlines from every visible block, merged. */
export function FloodLayer() {
  const map = useMap()
  const enabled = useApp((s) => s.layers.flood)
  const blocks = useVisibleBlocks()

  const cells = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: blocks.flatMap((b) =>
        (b.flood.data?.cells ?? [])
          .filter((c) => c.risk >= FLOOD_STOPS[0].value)
          .map((c) => ({
            type: 'Feature' as const,
            geometry: { type: 'Polygon' as const, coordinates: [c.ring] },
            properties: { risk: c.risk, rain: c.rain24, elev: c.elevation, rel: c.relElevation, drain: c.drainageDistM ?? -1, horizon: b.flood.data!.horizonHours, at: b.flood.data!.computedAt },
          })),
      ),
    }),
    [blocks],
  )
  const lines = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: blocks.flatMap((b) =>
        (b.flowlines.data?.lines ?? []).map((l) => ({
          type: 'Feature' as const,
          geometry: { type: 'LineString' as const, coordinates: l.coords },
          properties: { name: l.name ?? '' },
        })),
      ),
    }),
    [blocks],
  )

  useEffect(() => {
    if (!map || !enabled) return
    map.addSource(LINES, { type: 'geojson', data: lines })
    map.addLayer(
      {
        id: LINES,
        type: 'line',
        source: LINES,
        paint: { 'line-color': '#0ea5e9', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 13, 1.8], 'line-opacity': 0.7 },
      },
      firstSymbolLayer(map),
    )
    map.addSource(SRC, { type: 'geojson', data: cells })
    map.addLayer(
      {
        id: SRC,
        type: 'fill',
        source: SRC,
        paint: { 'fill-color': stepExpression(['get', 'risk'], FLOOD_STOPS) as never, 'fill-outline-color': 'rgba(0,0,0,0.12)' },
      },
      LINES,
    )
    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      e.preventDefault()
      const p = f.properties as { risk: number; rain: number; elev: number; rel: number; drain: number; horizon: number; at: number }
      const label = FLOOD_STOPS.slice().reverse().find((s) => p.risk >= s.value)?.label ?? 'low'
      const units = store.get().units
      store.set({
        selection: {
          kind: 'flood',
          lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
          title: `Flood risk: ${label}`,
          lines: [
            `Score ${(p.risk * 100).toFixed(0)} / 100`,
            `${U.precip(p.rain, units)} of rain forecast over ${p.horizon} h`,
            `Elevation ${U.height(p.elev, units)} (${p.rel >= 0 ? '+' : '−'}${U.height(Math.abs(p.rel), units)} vs surroundings)`,
            p.drain >= 0 ? `${U.distance(p.drain, units)} to the nearest mapped stream` : 'Drainage distance unavailable here',
          ],
          source: 'Open-Meteo + AWS terrain + USGS NHD',
          updated: p.at,
        },
      })
    }
    map.on('click', SRC, onClick)
    return () => {
      map.off('click', SRC, onClick)
      for (const id of [SRC, LINES]) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, enabled])

  useEffect(() => {
    if (!map || !enabled) return
    ;(map.getSource(SRC) as GeoJSONSource | undefined)?.setData(cells)
    ;(map.getSource(LINES) as GeoJSONSource | undefined)?.setData(lines)
  }, [map, enabled, cells, lines])

  return null
}
