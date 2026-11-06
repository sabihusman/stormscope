import { fetchJSON } from '../lib/fetch'
import type { BBox } from '../lib/geo'

/**
 * USGS Water Data OGC API (the legacy waterservices.usgs.gov/nwis/iv endpoint
 * was decommissioned; this is its replacement).
 * Docs: https://api.waterdata.usgs.gov/docs/ogcapi/
 */
export const USGS_OGC = 'https://api.waterdata.usgs.gov/ogcapi/v0'

interface OgcFeature<P> {
  id: string
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: P
}
interface OgcCollection<P> {
  features: OgcFeature<P>[]
  numberReturned: number
}

interface LatestProps {
  monitoring_location_id: string
  parameter_code: '00060' | '00065' | string
  time: string
  value: string
  unit_of_measure: string
  approval_status: string
}

export interface UsgsLatest {
  usgsId: string
  lngLat: { lng: number; lat: number }
  stage?: { value: number; unit: string; time: number }
  flow?: { value: number; unit: string; time: number; source?: string }
}

/** Latest gage height (00065) and discharge (00060) for every site in bbox. */
export async function fetchUsgsLatest(bbox: BBox, signal?: AbortSignal): Promise<UsgsLatest[]> {
  const url =
    `${USGS_OGC}/collections/latest-continuous/items?f=json&limit=400` +
    `&bbox=${bbox.west.toFixed(3)},${bbox.south.toFixed(3)},${bbox.east.toFixed(3)},${bbox.north.toFixed(3)}` +
    `&parameter_code=00060,00065`
  const j = await fetchJSON<OgcCollection<LatestProps>>(url, { signal, timeoutMs: 25_000 })
  const map = new Map<string, UsgsLatest>()
  for (const f of j.features) {
    const p = f.properties
    const id = p.monitoring_location_id
    let s = map.get(id)
    if (!s) {
      s = { usgsId: id, lngLat: { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] } }
      map.set(id, s)
    }
    const v = Number(p.value)
    if (!Number.isFinite(v)) continue
    const rec = { value: v, unit: p.unit_of_measure, time: Date.parse(p.time) }
    // The endpoint can return several records for one site and parameter (Nov 6, 2026: USGS-05484900 carried a
    // 1996 gage height of 2.18 ft beside today's 10.33 ft); the newest wins, whatever order they arrive in.
    if (p.parameter_code === '00065' && (!s.stage || rec.time > s.stage.time)) s.stage = rec
    else if (p.parameter_code === '00060' && (!s.flow || rec.time > s.flow.time)) s.flow = { ...rec, source: 'USGS' }
  }
  return [...map.values()]
}

interface LocProps {
  monitoring_location_number: string
  monitoring_location_name: string
  site_type_code: string
}
/**
 * Names / site types for every USGS monitoring location in the box. No `site_type_code` filter: the OGC
 * endpoint answers that filter with an empty collection (checked live Oct 19, 2026 — 0 features with it, all
 * 30 sites without), which left every USGS-only gauge named by its id.
 */
export async function fetchUsgsNames(bbox: BBox, signal?: AbortSignal): Promise<Map<string, { name: string; type: string }>> {
  const url =
    `${USGS_OGC}/collections/monitoring-locations/items?f=json&limit=400` +
    `&bbox=${bbox.west.toFixed(3)},${bbox.south.toFixed(3)},${bbox.east.toFixed(3)},${bbox.north.toFixed(3)}`
  const j = await fetchJSON<OgcCollection<LocProps>>(url, { signal, timeoutMs: 25_000 })
  const m = new Map<string, { name: string; type: string }>()
  for (const f of j.features)
    m.set(`USGS-${f.properties.monitoring_location_number}`, {
      name: f.properties.monitoring_location_name,
      type: f.properties.site_type_code,
    })
  return m
}

interface DailyProps {
  monitoring_location_id: string
  time: string
  value: string
}
/**
 * Median of the last `days` daily-mean discharge values for the wanted sites. Used to flag
 * "elevated flow" for sites that have no NOAA flood categories. One bbox request for all
 * sites (the API rate-limits per IP; the previous one-request-per-site version was the main
 * reason a single gauge load cost ~27 USGS calls).
 */
export async function fetchUsgsRecentMedianFlow(bbox: BBox, ids: string[], days = 10, signal?: AbortSignal): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!ids.length) return out
  const end = new Date()
  const start = new Date(end.getTime() - days * 86_400_000)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const url =
    `${USGS_OGC}/collections/daily/items?f=json&limit=4000` +
    `&bbox=${bbox.west.toFixed(3)},${bbox.south.toFixed(3)},${bbox.east.toFixed(3)},${bbox.north.toFixed(3)}` +
    `&parameter_code=00060&statistic_id=00003&datetime=${iso(start)}/${iso(end)}`
  const j = await fetchJSON<OgcCollection<DailyProps>>(url, { signal, timeoutMs: 25_000 })
  const wanted = new Set(ids)
  const by = new Map<string, number[]>()
  for (const f of j.features) {
    const id = f.properties.monitoring_location_id
    if (!wanted.has(id)) continue
    const v = Number(f.properties.value)
    if (!Number.isFinite(v) || v < 0) continue
    const arr = by.get(id) ?? []
    arr.push(v)
    by.set(id, arr)
  }
  for (const [id, vals] of by) {
    if (vals.length < 3) continue
    vals.sort((a, b) => a - b)
    out.set(id, vals[Math.floor(vals.length / 2)])
  }
  return out
}
