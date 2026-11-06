import { useEffect, useRef } from 'react'
import { attachTooltip } from './tooltip'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, Map as MlMap, MapMouseEvent } from 'maplibre-gl'
import { AIRNOW_CREDIT, fetchMonitorSites, isFresh, type MonitorParameter, type MonitorSite, type MonitorSitesResponse } from '../api/airnow'
import { aqiCategory } from '../lib/aqi'
import { describeError } from '../lib/fetch'
import { haversine } from '../lib/geo'
import { clock, readingAge } from '../lib/time'
import { U } from '../lib/units'
import { setResource, store, useApp, type SelectionReading } from '../state/store'
import { failed, loading, ready } from '../state/DataController'
import { labelLayer, useMap } from './MapView'
import { reducedMotion } from '../hooks/usePresence'

const SRC = 'air-monitors'
const CACHE_MS = 10 * 60_000
const STALE_STROKE = '#94a3b8'
/** Half the side of a dot's tap target: a 44 px square (fingertip size) centred on the dot. */
export const HIT_HALF_PX = 22

const PARAM_NAMES: Record<MonitorParameter, string> = { 'PM2.5': 'PM2.5', OZONE: 'ozone', PM10: 'PM10', NO2: 'NO₂', SO2: 'SO₂', CO: 'CO' }

/** The site's dot: the EPA colour of its worst reading under 2 h, or a grey outline when every reading is stale or missing. */
export function siteStyle(site: MonitorSite, now = Date.now()): { style: 'fresh' | 'stale'; color: string; aqi: number | null } {
  const fresh = site.readings.filter((r) => isFresh(r, now) && r.aqi != null)
  if (!fresh.length) return { style: 'stale', color: STALE_STROKE, aqi: null }
  const worst = fresh.reduce((a, b) => (b.aqi! > a.aqi! ? b : a))
  const cat = aqiCategory(worst.aqi)
  return { style: 'fresh', color: cat?.color ?? STALE_STROKE, aqi: worst.aqi }
}

/**
 * The tap card: what the site measures, each reading (AQI and category, raw value, the reading's local time
 * and age, stale past 2 h) as a text line and as a structured row for the sheet's colour badges, the
 * distance from the place, the agency.
 */
export function describeSite(site: MonitorSite, place: { lng: number; lat: number } | null, units: 'metric' | 'imperial', now = Date.now()): { lines: string[]; readings: SelectionReading[] } {
  const lines: string[] = []
  const readings: SelectionReading[] = []
  lines.push(`Measures: ${site.parameters.map((p) => PARAM_NAMES[p] ?? p).join(', ') || 'unknown'}`)
  for (const r of site.readings) {
    const cat = aqiCategory(r.aqi)
    const label = PARAM_NAMES[r.parameter] ?? r.parameter
    // A negative raw concentration is below the instrument's detection limit: say so instead of a number.
    const value = r.raw != null && r.raw < 0 ? 'below detection' : r.value != null ? `${r.value} ${r.unit}` : ''
    const stale = !isFresh(r, now)
    const line = `${label}: ${r.aqi != null ? `AQI ${Math.round(r.aqi)} ${cat?.name ?? ''}` : 'no AQI'}${value ? ` · ${value}` : ''} · ${clock(r.time)} · ${readingAge(r.time, now)}${stale ? ' (stale)' : ''}`
    lines.push(line)
    readings.push({ line, label, aqi: r.aqi, category: cat?.name ?? null, color: cat?.color ?? null, text: cat?.text ?? null, value, time: r.time, stale })
  }
  if (!site.readings.length) lines.push('No readings in the last report (offline)')
  if (place) lines.push(`${U.distance(haversine(place, site.lngLat), units)} from your place`)
  lines.push(`${site.agency}`)
  return { lines, readings }
}

/** The map, while the layer is mounted — for the ring pulse on the dot that was opened. */
let pulseMap: MlMap | null = null
const PULSE_MS = 300

/**
 * One ring pulse around the opened dot (300 ms, scale and opacity only; with Reduce Motion the CSS drops
 * the animation and the ring simply shows for the same 300 ms): a marker element that removes itself.
 */
function pulse(lngLat: { lng: number; lat: number }) {
  if (!pulseMap) return
  const el = document.createElement('div')
  el.className = 'dot-pulse'
  el.setAttribute('aria-hidden', 'true')
  const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lngLat.lng, lngLat.lat]).addTo(pulseMap)
  // Removed when its animation actually ends (a timer only as the fallback, e.g. with Reduce Motion, where there is no animation).
  let gone = false
  const remove = () => { if (!gone) { gone = true; marker.remove() } }
  el.addEventListener('animationend', remove)
  // With Reduce Motion there is no animation: the still ring goes after the same 300 ms. Otherwise the timer is a
  // late fallback only — the animation's own end removes the ring, even when a busy frame delays its start.
  window.setTimeout(remove, reducedMotion() ? PULSE_MS : PULSE_MS + 1500)
}

/** Open a monitor's chip (the tap's result, or the chooser's pick): the station selection with its readings. */
export function openMonitor(site: MonitorSite) {
  pulse(site.lngLat)
  const s = store.get()
  const { lines, readings } = describeSite(site, s.place?.lngLat ?? null, s.units)
  store.set({
    dotChooser: null,
    selection: {
      kind: 'station',
      lngLat: site.lngLat,
      title: `${site.name} · air monitor`,
      lines,
      readings,
      source: AIRNOW_CREDIT,
      updated: s.monitors.freshness?.fetchedAt ?? undefined,
    },
  })
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
  const cache = useRef<Map<string, { at: number; sites: MonitorSite[]; res: MonitorSitesResponse }>>(new Map())
  // "Refresh all now" reloads the sites in place: the layer, its source and the dots stay while the new answer is on its
  // way (until Oct 19 a refresh re-created the layer with an empty source, so for the fetch's duration there were no dots
  // to tap and a tap fell through to the map's point chip).
  const reloadRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!map || !enabled) return
    pulseMap = map
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
    }, labelLayer(map))
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
        // A view seen in the last 10 min: the store must get these sites too — the circles layer and the chooser read
        // `monitors.data`, and until Oct 19 only the dots were redrawn here, so coming back to a place (Denver → Johnston)
        // left the store on the other view's sites and the map blank until a fresh view loaded (H3).
        setResource('monitors', ready(hit.res, AIRNOW_CREDIT, '', hit.res.fetchedAt))
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
        cache.current.set(key, { at: Date.now(), sites: res.sites, res })
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
    reloadRef.current = () => {
      cache.current.clear()
      schedule()
    }
    schedule()
    map.on('moveend', schedule)
    // A tap anywhere within the 44 px square around a dot opens it (a dot is 15 px wide; a fingertip is
    // not that precise — on Oct 17 taps 12 px off the centre fell through to the map's point chip). One
    // dot in the square opens; more than one (neighbours under 44 px apart, e.g. Carpenter and East High
    // in Des Moines at the place zoom) opens the chooser listing them, nearest first — never a guess.
    const onClick = (e: MapMouseEvent) => {
      if (!map.getLayer(SRC) || map.getLayoutProperty(SRC, 'visibility') === 'none') return
      const { x, y } = e.point
      const hits = map.queryRenderedFeatures([[x - HIT_HALF_PX, y - HIT_HALF_PX], [x + HIT_HALF_PX, y + HIT_HALF_PX]], { layers: [SRC] })
      if (!hits.length) return
      const sites = store.get().monitors.data?.sites ?? []
      const under: { site: MonitorSite; d: number }[] = []
      for (const f of hits) {
        const id = (f.properties as { id: string }).id
        if (under.some((u) => u.site.id === id)) continue
        const site = sites.find((s) => s.id === id)
        if (!site) continue
        const p = map.project([site.lngLat.lng, site.lngLat.lat])
        under.push({ site, d: Math.hypot(p.x - x, p.y - y) })
      }
      if (!under.length) return
      e.preventDefault()
      under.sort((a, b) => a.d - b.d)
      if (under.length === 1) openMonitor(under[0].site)
      else store.set({ selection: null, dotChooser: { lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat }, ids: under.map((u) => u.site.id) } })
    }
    const enter = () => (map.getCanvas().style.cursor = 'pointer')
    const leave = () => (map.getCanvas().style.cursor = '')
    map.on('click', onClick)
    map.on('mouseenter', SRC, enter)
    map.on('mouseleave', SRC, leave)
    const tip = attachTooltip(map, SRC, (p) => { const site = store.get().monitors.data?.sites.find((x) => x.id === p.id); return site ? `${site.name}${p.aqi != null && p.aqi !== '' ? ` · AQI ${p.aqi}` : ''}` : null })
    return () => {
      window.clearTimeout(timer)
      ctrl?.abort()
      map.off('moveend', schedule)
      map.off('click', onClick)
      map.off('mouseenter', SRC, enter)
      map.off('mouseleave', SRC, leave)
      tip()
      if (pulseMap === map) pulseMap = null
      if (map.getLayer(SRC)) map.removeLayer(SRC)
      if (map.getSource(SRC)) map.removeSource(SRC)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, enabled])

  // A refresh (the nonce) reloads the data without touching the layer.
  useEffect(() => {
    if (nonce > 0) reloadRef.current?.()
  }, [nonce])

  // The dots toggle shows / hides the dots; the data keeps loading while the circles want it.
  useEffect(() => {
    if (!map || !map.getLayer(SRC)) return
    map.setLayoutProperty(SRC, 'visibility', dots ? 'visible' : 'none')
  }, [map, dots, enabled])

  return null
}
