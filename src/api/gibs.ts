import { fetchJSON } from '../lib/fetch'

/**
 * NASA GIBS WMTS — geostationary satellite imagery (GOES-East / GOES-West ABI)
 * at 10-minute cadence, keyless, CORS-enabled. Tiles are Web Mercator PNGs
 * addressed by layer + ISO time. https://nasa-gibs.github.io/gibs-api-docs/
 */
export const GIBS_WMTS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'
const CAPABILITIES = `${GIBS_WMTS}/1.0.0/WMTSCapabilities.xml`

export type SatProduct = 'geocolor' | 'ir'
export interface SatLayerDef {
  id: string
  tms: string
  maxzoom: number
  label: string
}
/** GOES-East covers the Americas east of ~-105°; GOES-West the Pacific side. Picked by longitude. */
export const SAT_LAYERS: Record<'east' | 'west', Record<SatProduct, SatLayerDef>> = {
  east: {
    geocolor: { id: 'GOES-East_ABI_GeoColor', tms: 'GoogleMapsCompatible_Level7', maxzoom: 7, label: 'GOES-East GeoColor' },
    ir: { id: 'GOES-East_ABI_Band13_Clean_Infrared', tms: 'GoogleMapsCompatible_Level6', maxzoom: 6, label: 'GOES-East IR (band 13)' },
  },
  west: {
    geocolor: { id: 'GOES-West_ABI_GeoColor', tms: 'GoogleMapsCompatible_Level7', maxzoom: 7, label: 'GOES-West GeoColor' },
    ir: { id: 'GOES-West_ABI_Band13_Clean_Infrared', tms: 'GoogleMapsCompatible_Level6', maxzoom: 6, label: 'GOES-West IR (band 13)' },
  },
}
export const satelliteFor = (lng: number): 'east' | 'west' => (lng < -105 ? 'west' : 'east')

export interface SatFrames {
  layer: SatLayerDef
  /** Frame times (ms epoch), oldest → newest, 10-min steps. */
  times: number[]
  /** When GIBS says the newest frame is valid. */
  latest: number
  fetchedAt: number
}

/**
 * Read the layer's time dimension from the WMTS capabilities. GIBS advertises the
 * available range as `<Value>start/end/PT10M</Value>` (possibly several ranges);
 * we expose the last ~3 h of frames so the timeline can scrub back to the radar.
 */
export async function fetchSatFrames(layer: SatLayerDef, hoursBack = 3, signal?: AbortSignal): Promise<SatFrames> {
  const res = await fetch(CAPABILITIES, { signal })
  if (!res.ok) throw new Error(`GIBS capabilities ${res.status}`)
  const xml = await res.text()
  const i = xml.indexOf(`<ows:Identifier>${layer.id}</ows:Identifier>`)
  if (i < 0) throw new Error(`GIBS layer ${layer.id} not found`)
  const block = xml.slice(i, i + 12_000)
  const dim = block.match(/<Dimension>[\s\S]*?<\/Dimension>/)?.[0] ?? ''
  const values = [...dim.matchAll(/<Value>([^<]*)<\/Value>/g)].map((m) => m[1])
  if (!values.length) throw new Error('GIBS layer has no time dimension')
  // Ranges look like 2026-09-30T02:40:00Z/2026-09-30T06:50:00Z/PT10M; single values are plain timestamps.
  const times: number[] = []
  for (const v of values) {
    const [start, end, period] = v.split('/')
    if (!end) {
      times.push(Date.parse(start))
      continue
    }
    const stepMin = Number(period?.match(/PT(\d+)M/)?.[1] ?? 10)
    for (let t = Date.parse(start); t <= Date.parse(end); t += stepMin * 60_000) times.push(t)
  }
  times.sort((a, b) => a - b)
  const latest = times[times.length - 1]
  const cutoff = latest - hoursBack * 3_600_000
  return { layer, times: times.filter((t) => t >= cutoff), latest, fetchedAt: Date.now() }
}

/** Tile URL template for one frame. */
export function satTileUrl(layer: SatLayerDef, timeMs: number): string {
  const iso = new Date(timeMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return `${GIBS_WMTS}/${layer.id}/default/${iso}/${layer.tms}/{z}/{y}/{x}.png`
}

// Re-exported so callers can share the JSON helper's error semantics if needed.
export { fetchJSON as _fetchJSON }
