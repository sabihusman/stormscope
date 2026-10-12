import { useEffect, useRef } from 'react'
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl'
import { fetchAirQualityGrid, type AirQualityPoint } from '../api/airQuality'
import { AQI_ATTRIBUTION, AQI_CATEGORIES, aqiCategory, POLLUTANTS } from '../lib/aqi'
import { describeError } from '../lib/fetch'
import { timeAgo } from '../lib/time'
import { store, useApp } from '../state/store'
import { firstSymbolLayer, useMap } from './MapView'

const SRC = 'aqi-cells'
/** CAMS global grid: 0.4° ≈ 45 km. Sampling finer than the model buys nothing and costs quota. */
export const AQI_SPACING_DEG = 0.4
/** Never more than this many locations in one request (one map load). */
export const AQI_MAX_POINTS = 64
const CACHE_MS = 30 * 60_000

interface Cell {
  lng: number
  lat: number
  spacing: number
  point: AirQualityPoint
}
interface GridState {
  key: string
  spacing: number
  cells: Cell[]
  fetchedAt: number
}

/**
 * Modeled US AQI shading over the visible map: one request of ≤ 64 locations per view, sampled on the
 * model's own ~0.4° grid (coarser when the view is wide, so the cap holds), cached 30 min per view key.
 * Cells are drawn in the EPA category colour; a tap shows the value, the dominant pollutant and the attribution.
 */
export function AirQualityLayer() {
  const map = useMap()
  const enabled = useApp((s) => s.layers.airquality)
  const nonce = useApp((s) => s.refreshNonce)
  const cache = useRef<Map<string, GridState>>(new Map())
  const current = useRef<GridState | null>(null)

  useEffect(() => {
    if (!map || !enabled) return
    map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map.addLayer(
      {
        id: SRC,
        type: 'fill',
        source: SRC,
        paint: {
          'fill-color': ['match', ['get', 'cat'], ...AQI_CATEGORIES.flatMap((c) => [c.key, c.color]), 'rgba(0,0,0,0)'] as never,
          'fill-opacity': 0.5,
          'fill-outline-color': 'rgba(255,255,255,0.12)',
        },
      },
      firstSymbolLayer(map),
    )
    let ctrl: AbortController | null = null
    let timer = 0
    const draw = (g: GridState) => {
      current.current = g
      const src = map.getSource(SRC) as GeoJSONSource | undefined
      src?.setData({
        type: 'FeatureCollection',
        features: g.cells.map((c) => {
          const h = c.spacing / 2
          const cat = aqiCategory(c.point.aqi)
          return {
            type: 'Feature',
            properties: { aqi: c.point.aqi, cat: cat?.key ?? '', lng: c.lng, lat: c.lat },
            geometry: { type: 'Polygon', coordinates: [[[c.lng - h, c.lat - h], [c.lng + h, c.lat - h], [c.lng + h, c.lat + h], [c.lng - h, c.lat + h], [c.lng - h, c.lat - h]]] },
          }
        }),
      })
      ;(window as unknown as { __aqGrid?: object }).__aqGrid = { points: g.cells.length, spacing: g.spacing, key: g.key, fetchedAt: g.fetchedAt }
    }
    const plan = () => {
      const b = map.getBounds()
      const west = Math.max(-180, b.getWest())
      const east = Math.min(180, b.getEast())
      const south = Math.max(-85, b.getSouth())
      const north = Math.min(85, b.getNorth())
      // Spacing: the model's 0.4°, doubled until the view needs ≤ 64 samples.
      let spacing = AQI_SPACING_DEG
      const count = (s: number) => (Math.floor(east / s) - Math.ceil(west / s) + 1) * (Math.floor(north / s) - Math.ceil(south / s) + 1)
      while (count(spacing) > AQI_MAX_POINTS) spacing *= 2
      const pts: { lng: number; lat: number }[] = []
      for (let y = Math.ceil(south / spacing); y <= Math.floor(north / spacing); y++) for (let x = Math.ceil(west / spacing); x <= Math.floor(east / spacing); x++) pts.push({ lng: x * spacing, lat: y * spacing })
      return { spacing, pts, key: `${spacing}:${Math.ceil(west / spacing)},${Math.ceil(south / spacing)},${Math.floor(east / spacing)},${Math.floor(north / spacing)}` }
    }
    const load = async () => {
      const { spacing, pts, key } = plan()
      const hit = cache.current.get(key)
      if (hit && Date.now() - hit.fetchedAt < CACHE_MS) return draw(hit)
      ctrl?.abort()
      ctrl = new AbortController()
      const signal = ctrl.signal
      store.set((s) => ({ layerErrors: { ...s.layerErrors, airquality: undefined } }))
      try {
        const points = await fetchAirQualityGrid(pts, signal)
        if (signal.aborted) return
        const g: GridState = { key, spacing, cells: points.map((p, i) => ({ lng: pts[i].lng, lat: pts[i].lat, spacing, point: p })), fetchedAt: Date.now() }
        cache.current.set(key, g)
        draw(g)
      } catch (e) {
        if (signal.aborted) return
        store.set((s) => ({ layerErrors: { ...s.layerErrors, airquality: describeError(e) } }))
      }
    }
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(load, 400)
    }
    schedule()
    map.on('moveend', schedule)
    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      e.preventDefault()
      const p = f.properties as { aqi: number | null; lng: number; lat: number }
      const cell = current.current?.cells.find((c) => c.lng === p.lng && c.lat === p.lat)
      const cat = aqiCategory(p.aqi)
      const dom = cell?.point.dominant ? POLLUTANTS.find((x) => x.key === cell.point.dominant) : null
      store.set({
        selection: {
          kind: 'point',
          lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
          title: `Air quality · ${cat ? `${Math.round(p.aqi!)} ${cat.name}` : 'no value'}`,
          lines: [
            'US AQI, modeled (an estimate, not a measurement)',
            dom ? `Dominant pollutant: ${dom.name}` : 'Dominant pollutant: unknown',
            cell ? `Model time ${timeAgo(cell.point.time)} · ~45 km grid cell` : '',
          ].filter(Boolean),
          source: AQI_ATTRIBUTION,
          updated: current.current?.fetchedAt,
        },
      })
    }
    map.on('click', SRC, onClick)
    return () => {
      window.clearTimeout(timer)
      ctrl?.abort()
      map.off('moveend', schedule)
      map.off('click', SRC, onClick)
      if (map.getLayer(SRC)) map.removeLayer(SRC)
      if (map.getSource(SRC)) map.removeSource(SRC)
      delete (window as unknown as { __aqGrid?: object }).__aqGrid
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, enabled, nonce])

  return null
}
