import { useEffect, useMemo, useRef } from 'react'
import type { GeoJSONSource, LngLat, MapLayerMouseEvent } from 'maplibre-gl'
import { SEVERITY_COLORS, type Severity } from '../lib/journey'
import { effectiveCondition } from '../lib/roadIce'
import { sampleSelection } from '../components/JourneyPanel'
import { selectRoute, store, useApp } from '../state/store'
import { useMap } from './MapView'

const LINE = 'journey-line'
const ALT = 'journey-alt'
const PTS = 'journey-samples'
const DEST = 'journey-dest'

/** Route line coloured by the condition at ETA, alternates as dashed lines, sample points, destination pin. */
export function RouteLayer() {
  const map = useMap()
  const j = useApp((s) => s.journey)

  const routes = j.routes.data?.routes ?? []
  const route = routes[j.selected]
  const w = j.weather.data
  const roadByIdx = useMemo(() => new Map((j.road.data?.samples ?? []).map((r) => [r.idx, r])), [j.road.data])
  const sev = (s: { idx: number; condition: { severity: Severity } } & Parameters<typeof effectiveCondition>[0]) => effectiveCondition(s, roadByIdx.get(s.idx)).severity

  const line = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!route) return { type: 'FeatureCollection', features: [] }
    if (!w) return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: route.coords }, properties: { color: '#94a3b8' } }] }
    // One segment per pair of samples, coloured by the worse of the two.
    const feats: GeoJSON.Feature[] = []
    for (let k = 1; k < w.samples.length; k++) {
      const a = w.samples[k - 1]
      const b = w.samples[k]
      const sv = Math.max(sev(a), sev(b)) as Severity
      feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: route.coords.slice(a.idx, b.idx + 1) }, properties: { color: SEVERITY_COLORS[sv], sev: sv } })
    }
    return { type: 'FeatureCollection', features: feats }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, w, roadByIdx])
  const alts = useMemo<GeoJSON.FeatureCollection>(
    () => ({ type: 'FeatureCollection', features: routes.map((r, i) => ({ type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: r.coords }, properties: { i } })).filter((f) => f.properties.i !== j.selected) }),
    [routes, j.selected],
  )
  const pts = useMemo<GeoJSON.FeatureCollection>(
    () => ({ type: 'FeatureCollection', features: (w?.samples ?? []).map((s) => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [s.lngLat.lng, s.lngLat.lat] }, properties: { idx: s.idx, color: SEVERITY_COLORS[sev(s)], sev: sev(s) } })) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [w, roadByIdx],
  )
  const dest = useMemo<GeoJSON.FeatureCollection>(
    () => ({ type: 'FeatureCollection', features: j.to ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [j.to.lngLat.lng, j.to.lngLat.lat] }, properties: {} }] : [] }),
    [j.to],
  )

  useEffect(() => {
    if (!map) return
    map.addSource(ALT, { type: 'geojson', data: alts })
    map.addLayer({ id: ALT, type: 'line', source: ALT, paint: { 'line-color': '#64748b', 'line-width': 3, 'line-dasharray': [2, 2], 'line-opacity': 0.8 } })
    map.addSource(LINE, { type: 'geojson', data: line })
    map.addLayer({ id: `${LINE}-casing`, type: 'line', source: LINE, paint: { 'line-color': '#0b1220', 'line-width': 8, 'line-opacity': 0.6 }, layout: { 'line-cap': 'round', 'line-join': 'round' } })
    map.addLayer({ id: LINE, type: 'line', source: LINE, paint: { 'line-color': ['get', 'color'], 'line-width': 5 }, layout: { 'line-cap': 'round', 'line-join': 'round' } })
    map.addSource(PTS, { type: 'geojson', data: pts })
    map.addLayer({ id: PTS, type: 'circle', source: PTS, filter: ['>=', ['get', 'sev'], 1], paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.5 } })
    map.addSource(DEST, { type: 'geojson', data: dest })
    map.addLayer({ id: DEST, type: 'circle', source: DEST, paint: { 'circle-radius': 8, 'circle-color': '#e2e8f0', 'circle-stroke-color': '#a855f7', 'circle-stroke-width': 3 } })
    const onPt = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      const s = store.get()
      const sample = s.journey.weather.data?.samples.find((x) => x.idx === f?.properties?.idx)
      if (!sample) return
      e.preventDefault()
      store.set({ selection: sampleSelection(sample, s.units, s.journey.road.data?.samples.find((x) => x.idx === sample.idx)) })
    }
    const onAlt = (e: MapLayerMouseEvent) => {
      const i = e.features?.[0]?.properties?.i
      if (typeof i === 'number') {
        e.preventDefault()
        selectRoute(i)
      }
    }
    map.on('click', PTS, onPt)
    map.on('click', ALT, onAlt)
    return () => {
      map.off('click', PTS, onPt)
      map.off('click', ALT, onAlt)
      for (const id of [PTS, DEST, LINE, `${LINE}-casing`, ALT]) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [PTS, DEST, LINE, ALT]) if (map.getSource(id)) map.removeSource(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  useEffect(() => {
    if (!map) return
    ;(map.getSource(LINE) as GeoJSONSource | undefined)?.setData(line)
    ;(map.getSource(ALT) as GeoJSONSource | undefined)?.setData(alts)
    ;(map.getSource(PTS) as GeoJSONSource | undefined)?.setData(pts)
    ;(map.getSource(DEST) as GeoJSONSource | undefined)?.setData(dest)
  }, [map, line, alts, pts, dest])

  // Fit the map to a newly routed journey (once per route). The first attempt is deferred one
  // tick so it runs after the parent's mount effects (MapView's 2D/3D easeTo would otherwise
  // cancel an in-flight fit when a replay route is ready before the style loads). Re-runs for
  // the same route only re-attempt while nothing has moved yet, so dev double-mounts and
  // resource identity changes can't cancel a pending fit or restart a finished one.
  const fit = useRef<{ key: string; timers: number[]; done: boolean; from: { z: number; c: LngLat } | null }>({ key: '', timers: [], done: false, from: null })
  useEffect(() => {
    if (!map || !route) return
    const key = `${route.coords.length}:${route.distanceM}`
    if (fit.current.key !== key) fit.current = { key, timers: [], done: false, from: null }
    const cur = fit.current
    if (cur.done) return
    let w = 180,
      s = 90,
      e = -180,
      n = -90
    for (const [x, y] of route.coords) {
      if (x < w) w = x
      if (x > e) e = x
      if (y < s) s = y
      if (y > n) n = y
    }
    const bounds: [[number, number], [number, number]] = [
      [w, s],
      [e, n],
    ]
    // Padding from the map's own box, not the window: on desktop the trip dock sits beside the map (the map area can be
    // under 400 px wide there), so a fixed 440 px right margin left no room and MapLibre skipped the fit altogether.
    const box = map.getContainer().getBoundingClientRect()
    const side = (frac: number, max: number) => Math.min(max, Math.round(box.width * frac))
    const padding = window.innerWidth < 720
      ? { top: 80, bottom: Math.min(window.innerHeight * 0.46, 420) + 40, left: 40, right: 40 }
      : { top: Math.min(80, Math.round(box.height * 0.12)), bottom: Math.min(60, Math.round(box.height * 0.1)), left: side(0.08, 40), right: document.querySelector('.app.dock-open') ? side(0.08, 40) : side(0.35, 440) }
    // "Moved" is measured from the camera as it was right before our first fitBounds call, so an
    // in-flight programmatic animation (e.g. the fly-to-place) is taken over, not treated as the
    // user having moved on; retries only re-fit when that first call was cancelled before moving.
    const moved = () => !!cur.from && (Math.abs(map.getZoom() - cur.from.z) > 0.01 || map.getCenter().distanceTo(cur.from.c) > 1)
    let tries = 0
    const attempt = () => {
      if (moved() || tries++ >= 4) {
        cur.done = true
        return
      }
      if (!cur.from) cur.from = { z: map.getZoom(), c: map.getCenter() }
      map.fitBounds(bounds, { padding, duration: 600, pitch: store.get().is3D ? 60 : 0 })
      cur.timers.push(window.setTimeout(attempt, 1500))
    }
    cur.timers.push(window.setTimeout(attempt, 0))
    return () => {
      cur.timers.forEach((t) => window.clearTimeout(t))
      cur.timers = []
    }
  }, [map, route])

  return null
}
