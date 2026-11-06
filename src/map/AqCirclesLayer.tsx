import { useEffect, useRef } from 'react'
import type { CanvasSource } from 'maplibre-gl'

import { AQI_CATEGORIES, aqiCategory } from '../lib/aqi'
import { freshMonitors, MEASURED_WITHIN_M } from '../lib/airnowHere'
import { store, useApp } from '../state/store'
import { firstSymbolLayer, useMap } from './MapView'

const SRC = 'aq-circles'
// 0.45 painted the whole map one solid wash at PM2.5 (Nov 6 audit); 0.3 keeps streets and labels readable.
const OPACITY = 0.3
const MAX_PX = 2048

/** Web Mercator metres. */
const R = 6_378_137
const mx = (lng: number) => (R * lng * Math.PI) / 180
const my = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
const lngOf = (x: number) => (x / R) * (180 / Math.PI)
const latOf = (y: number) => ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI

/**
 * Measured air quality on the map: for every AirNow monitor with a reading of the selected pollutant under
 * two hours old, a 25 km disc in the EPA colour of that reading, semi-transparent. Nothing anywhere else —
 * no estimate, no interpolation. Where discs overlap, the overlap shows the MORE SEVERE EPA category: the
 * discs are painted in ascending category rank (Good … Hazardous) with plain source-over at full alpha, so
 * the worse disc covers the better one, and the whole canvas is shown at one opacity — an overlap looks
 * exactly like the worse disc alone, and a same-category overlap is identical to a single disc. Drawn once
 * per data change on a Mercator canvas covering the discs, shown as a canvas source under the symbol
 * layers; it pans with the map.
 */
export function AqCirclesLayer() {
  const map = useMap()
  const enabled = useApp((s) => s.layers.aqcircles)
  const pollutant = useApp((s) => s.aqPollutant)
  const sites = useApp((s) => s.monitors.data?.sites ?? null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!map || !enabled) return
    const canvas = canvasRef.current ?? document.createElement('canvas')
    canvasRef.current = canvas
    canvas.className = 'aq-circles-canvas'
    // Ascending category rank: the worse reading is painted last and wins every overlap.
    const rank = (aqi: number | null) => { const c = aqiCategory(aqi); return c ? AQI_CATEGORIES.indexOf(c) : -1 }
    const list = freshMonitors(sites ?? [], pollutant).sort((a, b) => rank(a.reading.aqi) - rank(b.reading.aqi))
    ;(window as unknown as { __aqCircles?: object }).__aqCircles = { pollutant, discs: list.map((m) => ({ id: m.site.id, aqi: m.reading.aqi, rank: rank(m.reading.aqi), color: aqiCategory(m.reading.aqi)?.color ?? null })) }
    if (!list.length) {
      if (map.getLayer(SRC)) map.removeLayer(SRC)
      if (map.getSource(SRC)) map.removeSource(SRC)
      return
    }
    // Mercator extent of all discs (radius scaled by 1/cos(lat) in Mercator metres), with a margin.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    const discs = list.map((m) => {
      const lat = m.site.lngLat.lat
      const rM = MEASURED_WITHIN_M / Math.cos((lat * Math.PI) / 180)
      const x = mx(m.site.lngLat.lng), y = my(lat)
      x0 = Math.min(x0, x - rM); x1 = Math.max(x1, x + rM); y0 = Math.min(y0, y - rM); y1 = Math.max(y1, y + rM)
      return { x, y, rM, color: aqiCategory(m.reading.aqi)?.color ?? '#94a3b8' }
    })
    const pad = 2_000
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad
    const span = Math.max(x1 - x0, y1 - y0)
    const res = Math.max(100, span / MAX_PX) // metres per pixel
    const w = Math.ceil((x1 - x0) / res), h = Math.ceil((y1 - y0) / res)
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
    for (const d of discs) {
      ctx.fillStyle = d.color
      ctx.beginPath()
      ctx.arc((d.x - x0) / res, (y1 - d.y) / res, d.rM / res, 0, Math.PI * 2)
      ctx.fill()
    }
    const coords: [[number, number], [number, number], [number, number], [number, number]] = [
      [lngOf(x0), latOf(y1)],
      [lngOf(x1), latOf(y1)],
      [lngOf(x1), latOf(y0)],
      [lngOf(x0), latOf(y0)],
    ]
    const existing = map.getSource(SRC) as CanvasSource | undefined
    if (existing) {
      existing.setCoordinates(coords)
      existing.play()
      map.once('render', () => existing.pause())
      map.triggerRepaint()
    } else {
      map.addSource(SRC, { type: 'canvas', canvas, animate: false, coordinates: coords })
      map.addLayer({ id: SRC, type: 'raster', source: SRC, paint: { 'raster-opacity': OPACITY, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, firstSymbolLayer(map))
    }
    ;(window as unknown as { __aqCirclesCanvas?: HTMLCanvasElement; __aqCirclesExtent?: object }).__aqCirclesCanvas = canvas
    ;(window as unknown as { __aqCirclesExtent?: object }).__aqCirclesExtent = { x0, x1, y0, y1, res, w, h }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, enabled, pollutant, sites])

  useEffect(() => {
    if (!map) return
    if (enabled) return
    if (map.getLayer(SRC)) map.removeLayer(SRC)
    if (map.getSource(SRC)) map.removeSource(SRC)
    delete (window as unknown as { __aqCircles?: object }).__aqCircles
  }, [map, enabled])
  useEffect(() => {
    return () => {
      if (!map) return
      if (map.getLayer(SRC)) map.removeLayer(SRC)
      if (map.getSource(SRC)) map.removeSource(SRC)
    }
  }, [map])

  // The discs come from the monitor sites in view: the sites layer loads them; when it is off, load them here.
  useEffect(() => {
    if (!enabled) return
    if (!store.get().layers.monitors) store.set({ monitorsWanted: true })
    return () => store.set({ monitorsWanted: false })
  }, [enabled])

  return null
}
