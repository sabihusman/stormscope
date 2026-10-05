import * as maplibregl from 'maplibre-gl'
import type { Map as MlMap, MapMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre 6 resolves its worker relative to import.meta.url, which breaks once
// Vite pre-bundles/chunks the library. Hand it a Vite-bundled worker URL instead.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

maplibregl.setWorkerUrl(maplibreWorkerUrl)
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { store, useApp } from '../state/store'
import { useReducedMotion } from '../hooks/useMisc'
import { haversine } from '../lib/geo'
import { blockKey, blocksForView, levelForZoom, MIN_BLOCK_ZOOM } from '../lib/blocks'

/** Pan further than this from the current data window (at a regional zoom or closer) and the data follows. */
const FOLLOW_DISTANCE_M = 25_000
const FOLLOW_MIN_ZOOM = 6.5

export const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron'
export const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

const MapCtx = createContext<MlMap | null>(null)
/** The MapLibre instance, or null until the style has loaded. */
export const useMap = () => useContext(MapCtx)

/** Order overlays consistently: everything goes below labels. */
export function firstSymbolLayer(map: MlMap): string | undefined {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id
}

export function MapView({ children }: { children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null)
  const [map, setMap] = useState<MlMap | null>(null)
  const is3D = useApp((s) => s.is3D)
  const place = useApp((s) => s.place)
  const recenterNonce = useApp((s) => s.recenterNonce)
  const reducedMotion = useReducedMotion()
  const placeMarker = useRef<maplibregl.Marker | null>(null)

  useEffect(() => {
    if (!container.current) return
    const m = new maplibregl.Map({
      container: container.current,
      // (A pixelRatio cap of 2 was measured Oct 6 on the laptop GPU: no frame-time change at DPR 3
      // emulation, so it is not applied; re-test on a real phone GPU before adding it.)
      style: BASEMAP_STYLE,
      center: [-98, 39],
      zoom: 3,
      minZoom: 2,
      maxZoom: 15,
      maxPitch: 70,
      attributionControl: { compact: true },
      pitchWithRotate: true,
      touchPitch: true,
      fadeDuration: 0,
    })
    // Debug/test handle (used by scripts/qa.mjs and scripts/e2e.mjs).
    ;(window as unknown as { __map: MlMap }).__map = m
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }), 'top-right')
    m.addControl(new maplibregl.ScaleControl({ maxWidth: 90 }), 'bottom-left')
    // Without a listener MapLibre console.errors every failed tile/style fetch. Offline those are
    // expected (the offline banner covers it); online they're worth a warning, not an error.
    m.on('error', (e) => {
      if (!navigator.onLine) return
      console.warn('[map]', (e as unknown as { error?: { message?: string } }).error?.message ?? e)
    })
    // First visit: the basemap style, sprite, glyphs and tiles were fetched before the service
    // worker existed, so none of it would be available offline until the next online visit. Once
    // the SW takes control, pull them through it (served from the HTTP cache, stored by the
    // Workbox runtime routes) and re-point the basemap/terrain sources so their tiles follow.
    if ('serviceWorker' in navigator && !navigator.serviceWorker.controller) {
      const warm = () => {
        const cacheable = /tiles\.openfreemap\.org|elevation-tiles-prod/
        const seen = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => cacheable.test(u))
        for (const u of new Set([BASEMAP_STYLE, ...seen])) fetch(u, { cache: 'force-cache' }).catch(() => {})
        try {
          for (const [id, s] of Object.entries(m.getStyle().sources)) {
            const src = m.getSource(id) as unknown as { setUrl?: (u: string) => void; setTiles?: (t: string[]) => void } | undefined
            if (!src) continue
            if ('url' in s && typeof s.url === 'string' && cacheable.test(s.url)) src.setUrl?.(s.url)
            else if ('tiles' in s && s.tiles?.length && cacheable.test(s.tiles[0])) src.setTiles?.(s.tiles)
          }
        } catch {
          /* style not loaded yet: its fetches will go through the SW anyway */
        }
      }
      navigator.serviceWorker.addEventListener('controllerchange', warm, { once: true })
    }
    m.on('load', () => {
      m.addSource('terrain-dem', {
        type: 'raster-dem',
        tiles: [TERRAIN_TILES],
        tileSize: 256,
        encoding: 'terrarium',
        maxzoom: 14,
        attribution:
          '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles (AWS)</a>',
      })
      m.addLayer(
        { id: 'hillshade', type: 'hillshade', source: 'terrain-dem', paint: { 'hillshade-exaggeration': 0.35 }, layout: { visibility: 'none' } },
        firstSymbolLayer(m),
      )
      setMap(m)
    })
    // Forecast blocks: which fixed tiles intersect the view (padded 15%), nearest first.
    const updateBlocks = () => {
      const z = m.getZoom()
      if (z < MIN_BLOCK_ZOOM) {
        if (store.get().visibleBlocks.length) store.set({ visibleBlocks: [] })
        return
      }
      const b = m.getBounds()
      const padX = (b.getEast() - b.getWest()) * 0.15
      const padY = (b.getNorth() - b.getSouth()) * 0.15
      const level = levelForZoom(z)
      const c = m.getCenter()
      const keys = blocksForView(
        { west: b.getWest() - padX, east: b.getEast() + padX, south: b.getSouth() - padY, north: b.getNorth() + padY },
        level,
        { lng: c.lng, lat: c.lat },
      )
        .map(blockKey)
        .sort()
      const cur = store.get()
      if (cur.blockLevel !== level || cur.visibleBlocks.join() !== keys.join()) store.set({ visibleBlocks: keys, blockLevel: level })
    }
    let blockTimer = 0
    m.on('moveend', () => {
      window.clearTimeout(blockTimer)
      blockTimer = window.setTimeout(updateBlocks, 500)
    })
    m.once('idle', updateBlocks)

    // Point data (rivers, station) follow the map centre once you've panned far enough.
    let followTimer = 0
    m.on('moveend', () => {
      window.clearTimeout(followTimer)
      followTimer = window.setTimeout(() => {
        if (m.getZoom() < FOLLOW_MIN_ZOOM) return
        const c = m.getCenter()
        const cur = store.get().focus
        if (!cur || haversine(cur, c) > FOLLOW_DISTANCE_M) store.set({ focus: { lng: c.lng, lat: c.lat }, selection: null })
      }, 700)
    })
    m.on('click', (e: MapMouseEvent) => {
      // Empty-map tap: offer to use this point as the location. Layer clicks
      // set their own selection and stop propagation via `defaultPrevented`.
      if (e.defaultPrevented) return
      const s = store.get()
      if (s.selection) {
        store.set({ selection: null })
        return
      }
      store.set({
        selection: {
          kind: 'point',
          lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
          title: 'Map point',
          lines: [`${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}`],
        },
      })
    })
    return () => {
      setMap(null)
      m.remove()
    }
  }, [])

  // 2D / 3D toggle. Terrain setup (mesh + framebuffers + hillshade) is deferred past the tap's
  // own frame so the button press paints immediately and the heavy work lands in the next task.
  useEffect(() => {
    if (!map) return
    const dur = reducedMotion ? 0 : 800
    let cancelled = false
    const apply = () => {
      if (cancelled) return
      const marks = (window as unknown as { __perfMarks?: boolean }).__perfMarks === true
      const m0 = marks ? performance.now() : 0
      if (marks) window.setTimeout(() => performance.measure('terrain-apply', { start: m0, end: performance.now() }), 0)
      if (is3D) {
        map.setTerrain({ source: 'terrain-dem', exaggeration: 1.4 })
        map.setLayoutProperty('hillshade', 'visibility', 'visible')
        if (map.getPitch() < 59) map.easeTo({ pitch: 60, duration: dur })
      } else {
        map.setTerrain(null)
        map.setLayoutProperty('hillshade', 'visibility', 'none')
        // Skip the no-op ease on mount: an easeTo cancels any camera animation already in flight.
        if (map.getPitch() > 0) map.easeTo({ pitch: 0, duration: dur })
      }
    }
    const raf = requestAnimationFrame(() => window.setTimeout(apply, 0))
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [map, is3D, reducedMotion])

  // "Back to my location": snap the data window to the place and fly there.
  useEffect(() => {
    if (!map || !place || recenterNonce === 0) return
    store.set({ focus: place.lngLat, selection: null })
    map.flyTo({ center: place.lngLat, zoom: Math.max(map.getZoom(), 9.5), duration: reducedMotion ? 0 : 1000, essential: true })
  }, [map, recenterNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fly to the place + marker.
  useEffect(() => {
    if (!map || !place) return
    const el = document.createElement('div')
    el.className = 'place-marker'
    el.setAttribute('aria-label', 'Selected location')
    if (!placeMarker.current) placeMarker.current = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(place.lngLat).addTo(map)
    else placeMarker.current.setLngLat(place.lngLat)
    // A planned journey owns the camera (RouteLayer fits the route); don't fly to the start and undo it.
    if (store.get().journey.routes.data?.routes.length) return
    map.flyTo({ center: place.lngLat, zoom: Math.max(map.getZoom(), 9.5), duration: reducedMotion ? 0 : 1400, essential: true })
  }, [map, place, reducedMotion])

  return (
    <div className="map-root">
      <div ref={container} className="map-container" role="application" aria-label="Weather map" />
      <MapCtx.Provider value={map}>{map ? children : null}</MapCtx.Provider>
    </div>
  )
}
