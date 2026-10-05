import { fetchJSON } from '../lib/fetch'
import type { BBox } from '../lib/geo'

/**
 * USGS National Hydrography Dataset flowlines, served by The National Map
 * (ArcGIS MapServer, layer 6 = NHDFlowline). US-only.
 * https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer
 */
export const NHD_URL = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query'

export interface Flowline {
  name: string | null
  coords: [number, number][]
}
interface Gj {
  features: { geometry: { type: string; coordinates: unknown }; properties: { gnis_name: string | null; ftype: number } }[]
  exceededTransferLimit?: boolean
}

export async function fetchFlowlines(bbox: BBox, signal?: AbortSignal): Promise<{ lines: Flowline[]; truncated: boolean }> {
  const params = new URLSearchParams({
    geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'gnis_name,ftype',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '4',
    resultRecordCount: '1500',
    // 460 = StreamRiver, 558 = ArtificialPath (river centreline through waterbodies), 336 = CanalDitch
    where: 'ftype IN (460,558,336)',
    f: 'geojson',
  })
  const j = await fetchJSON<Gj>(`${NHD_URL}?${params}`, { signal, timeoutMs: 30_000 })
  const lines: Flowline[] = []
  for (const f of j.features ?? []) {
    const g = f.geometry
    if (!g) continue
    if (g.type === 'LineString') lines.push({ name: f.properties.gnis_name, coords: g.coordinates as [number, number][] })
    else if (g.type === 'MultiLineString')
      for (const part of g.coordinates as [number, number][][]) lines.push({ name: f.properties.gnis_name, coords: part })
  }
  return { lines, truncated: !!j.exceededTransferLimit }
}
