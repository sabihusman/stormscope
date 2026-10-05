import { useEffect, useMemo } from 'react'
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl'
import { RAIN_STOPS, stepExpression } from '../lib/colors'
import { dayClock, HOUR } from '../lib/time'
import { U } from '../lib/units'
import { aggregate, store, useApp, useVisibleBlocks } from '../state/store'
import { firstSymbolLayer, useMap } from './MapView'

const SRC = 'rain-cells'
export const nowHourKey = () => Math.floor(Date.now() / HOUR)

/**
 * Accumulated-rainfall cells from every visible block, merged into one source.
 * Properties are keyed by absolute hour (`a<hour>`), so the frame index simply
 * selects `a<now + frame>` and blocks fetched at different times stay in sync.
 */
export function RainfallLayer() {
  const map = useMap()
  const enabled = useApp((s) => s.layers.rainfall)
  const blocks = useVisibleBlocks()
  const frame = useApp((s) => s.rainFrame)
  const horizon = useApp((s) => s.rainHorizon)

  const fc = useMemo<GeoJSON.FeatureCollection>(
    () => ({ type: 'FeatureCollection', features: blocks.flatMap((b) => b.rainCells.data?.features ?? []) }),
    [blocks],
  )

  useEffect(() => {
    if (!map || !enabled) return
    const hour = nowHourKey() + Math.min(frame, horizon)
    map.addSource(SRC, { type: 'geojson', data: fc })
    map.addLayer(
      {
        id: SRC,
        type: 'fill',
        source: SRC,
        paint: {
          'fill-color': stepExpression(['coalesce', ['get', `a${hour}`], 0], RAIN_STOPS) as never,
          'fill-opacity': 1,
          'fill-outline-color': 'rgba(255,255,255,0.08)',
          'fill-color-transition': { duration: 250 },
        },
      },
      firstSymbolLayer(map),
    )
    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      e.preventDefault()
      const s = store.get()
      const now = nowHourKey()
      const h = now + Math.min(s.rainFrame, s.rainHorizon)
      const p = f.properties as Record<string, number>
      const agg = aggregate(
        s.visibleBlocks.map((k) => s.blocks[k]).filter(Boolean),
        (b) => b.grid,
      )
      store.set({
        selection: {
          kind: 'rain',
          lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
          title: `Expected rainfall · ${s.rainHorizon} h`,
          lines: [
            `${U.precip(p[`a${h}`] ?? 0, s.units)} accumulated by ${dayClock(h * HOUR)}`,
            `${U.precip(p[`r${h}`] ?? 0, s.units)}/h falling at that hour`,
            `${U.precip(p[`a${now + s.rainHorizon}`] ?? 0, s.units)} total over ${s.rainHorizon} h`,
          ],
          source: 'Open-Meteo hourly precipitation',
          updated: agg.fetchedAt ?? undefined,
        },
      })
    }
    map.on('click', SRC, onClick)
    return () => {
      map.off('click', SRC, onClick)
      if (map.getLayer(SRC)) map.removeLayer(SRC)
      if (map.getSource(SRC)) map.removeSource(SRC)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, enabled])

  // Data changes: push into the existing source (no flicker, neighbours persist).
  useEffect(() => {
    if (!map || !enabled) return
    const src = map.getSource(SRC) as GeoJSONSource | undefined
    src?.setData(fc)
  }, [map, enabled, fc])

  useEffect(() => {
    if (!map || !enabled || !map.getLayer(SRC)) return
    const hour = nowHourKey() + Math.min(frame, horizon)
    map.setPaintProperty(SRC, 'fill-color', stepExpression(['coalesce', ['get', `a${hour}`], 0], RAIN_STOPS) as never)
  }, [map, enabled, frame, horizon])

  return null
}
