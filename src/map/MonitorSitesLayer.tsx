import { useEffect, useRef } from 'react'
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl'
import { AIRNOW_CREDIT, fetchMonitorSites, isFresh, type MonitorParameter, type MonitorSite } from '../api/airnow'
import { aqiCategory } from '../lib/aqi'
import { describeError } from '../lib/fetch'
import { haversine } from '../lib/geo'
import { timeAgo } from '../lib/time'
import { U } from '../lib/units'
import { setResource, store, useApp } from '../state/store'
import { failed, loading, ready } from '../state/DataController'
import { useMap } from './MapView'

const SRC = 'air-monitors'
const CACHE_MS = 10 * 60_000
const STALE_STROKE = '#94a3b8'

const PARAM_NAMES: Record<MonitorParameter, string> = { 'PM2.5': 'PM2.5', OZONE: 'ozone', PM10: 'PM10', NO2: 'NO₂', SO2: 'SO₂', CO: 'CO' }

/** The site's dot: the EPA colour of its worst reading under 2 h, or a grey outline when every reading is stale or missing. */
export function siteStyle(site: MonitorSite, now = Date.now()): { style: 'fresh' | 'stale'; color: string; aqi: number | null } {
  const fresh = site.readings.filter((r) => isFresh(r, now) && r.aqi != null)
  if (!fresh.length) return { style: 'stale', color: STALE_STROKE, aqi: null }
  const worst = fresh.reduce((a, b) => (b.aqi! > a.aqi! ? b : a))
  const cat = aqiCategory(worst.aqi)
  return { style: 'fresh', color: cat?.color ?? STALE_STROKE, aqi: worst.aqi }
}

/** The tap card's lines: what the site measures, each reading with its age, the distance from the place. */
export function describeSite(site: MonitorSite, place: { lng: number; lat: number } | null, units: 'metric' | 'imperial', now = Date.now()): string[] {
  const lines: string[] = []
  lines.push(`Measures: ${site.parameters.map((p) => PARAM_NAMES[p] ?? p).join(', ') || 'unknown'}`)
  for (const r of site.readings) {
    const cat = aqiCategory(r.aqi)
    const age = timeAgo(r.time, now)
    lines.push(`${PARAM_NAMES[r.parameter] ?? r.parameter}: ${r.aqi != null ? `AQI ${Math.round(r.aqi)} ${cat?.name ?? ''}` : 'no AQI'}${r.value != null ? ` · ${r.value} ${r.unit}` : ''} · ${age}${isFresh(r, now) ? '' : ' (stale)'}`)
  }
  if (!site.readings.length) lines.push('No readings in the last report (offline)')
  if (place) lines.push(`${U.distance(haversine(place, site.lngLat), units)} from your place`)
  lines.push(`${site.agency}`)
  return lines
}

/**
 * Every EPA AirNow monitoring site in view (phase 2). Dots in the EPA colour of the site's freshest worst
 * reading (under 2 h), grey outlined when stale or offline so a broken monitor is visible. One request per
 * view through the monitor service, cached 10 min per view key.
 */
export function MonitorSitesLayer() {
  const map = useMap()
  // The sites load while the dots are on, or while the circles layer wants them (it draws from the same sites).
  const enabled = useApp((s) => s.layers.monitors || s.monitorsWanted)
  const dots = useApp((s) => s.layers.monitors)
  const nonce = useApp((s) => s.refreshNonce)
  const cache = useRef<Map<string, { at: number; sites: MonitorSite[] }>>(new Map())

  useEffect(() => {
    if (!map || !enabled) return
    map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map.addLayer({
      id: SRC,
      type: 'circle',
      source: SRC,
      layout: { visibility: store.get().layers.monitors ? 'visible' : 'none' },
      paint: {
        'circle-radius': 7,
        'circle-color': ['case', ['==', ['get', 'style'], 'fresh'], ['get', 'color'], 'rgba(0,0,0,0)'],
        'circle-stroke-color': ['case', ['==', ['get', 'style'], 'fresh'], '#0b1220', STALE_STROKE],
        'circle-stroke-width': ['case', ['==', ['get', 'style'], 'fresh'], 1.5, 2],
      },
    })
    let ctrl: AbortController | null = null
    let timer = 0
    const draw = (sites: MonitorSite[]) => {
      const src = map.getSource(SRC) as GeoJSONSource | undefined
      const now = Date.now()
      src?.setData({
        type: 'FeatureCollection',
        features: sites.map((s) => {
          const st = siteStyle(s, now)
          return { type: 'Feature', properties: { id: s.id, style: st.style, color: st.color, aqi: st.aqi }, geometry: { type: 'Point', coordinates: [s.lngLat.lng, s.lngLat.lat] } }
        }),
      })
    }
    const load = async () => {
      const b = map.getBounds()
      const bbox = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }
      const key = [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => (Math.round(v * 4) / 4).toFixed(2)).join(',')
      const hit = cache.current.get(key)
      if (hit && Date.now() - hit.at < CACHE_MS) {
        draw(hit.sites)
        return
      }
      ctrl?.abort()
      ctrl = new AbortController()
      const signal = ctrl.signal
      setResource('monitors', loading(store.get().monitors))
      store.set((s) => ({ layerErrors: { ...s.layerErrors, monitors: undefined } }))
      try {
        const res = await fetchMonitorSites(bbox, signal)
        if (signal.aborted) return
        cache.current.set(key, { at: Date.now(), sites: res.sites })
        setResource('monitors', ready(res, AIRNOW_CREDIT, '', res.fetchedAt))
        draw(res.sites)
      } catch (e) {
        if (signal.aborted) return
        setResource('monitors', failed(store.get().monitors, e))
        store.set((s) => ({ layerErrors: { ...s.layerErrors, monitors: describeError(e) } }))
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
      const id = (f.properties as { id: string }).id
      const site = store.get().monitors.data?.sites.find((s) => s.id === id)
      if (!site) return
      const s = store.get()
      store.set({
        selection: {
          kind: 'station',
          lngLat: site.lngLat,
          title: `${site.name} · air monitor`,
          lines: describeSite(site, s.place?.lngLat ?? null, s.units),
          source: AIRNOW_CREDIT,
          updated: s.monitors.freshness?.fetchedAt ?? undefined,
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, enabled, nonce])

  // The dots toggle shows / hides the dots; the data keeps loading while the circles want it.
  useEffect(() => {
    if (!map || !map.getLayer(SRC)) return
    map.setLayoutProperty(SRC, 'visibility', dots ? 'visible' : 'none')
  }, [map, dots, enabled])

  return null
}
