import { fetchJSON, pLimitAll } from '../lib/fetch'
import type { BBox } from '../lib/geo'

/** NOAA National Water Prediction Service. Docs: https://api.water.noaa.gov/nwps/v1/docs/ */
export const NWPS_URL = 'https://api.water.noaa.gov/nwps/v1'

interface NwpsStatus {
  primary: number
  primaryUnit: string
  secondary: number
  secondaryUnit: string
  floodCategory: string
  validTime: string
}
export interface NwpsGaugeSummary {
  lid: string
  name: string
  latitude: number
  longitude: number
  status: { observed: NwpsStatus; forecast: NwpsStatus }
}
interface NwpsListResponse {
  gauges: NwpsGaugeSummary[]
}
export interface NwpsGaugeDetail extends NwpsGaugeSummary {
  usgsId: string
  flood: {
    stageUnits: string
    flowUnits: string
    categories: Record<'action' | 'minor' | 'moderate' | 'major', { stage: number; flow: number }>
  }
}

export async function fetchNwpsGauges(bbox: BBox, signal?: AbortSignal): Promise<NwpsGaugeSummary[]> {
  const url =
    `${NWPS_URL}/gauges?bbox.xmin=${bbox.west.toFixed(3)}&bbox.ymin=${bbox.south.toFixed(3)}` +
    `&bbox.xmax=${bbox.east.toFixed(3)}&bbox.ymax=${bbox.north.toFixed(3)}&srid=EPSG_4326`
  const j = await fetchJSON<NwpsListResponse>(url, { signal, timeoutMs: 25_000 })
  return j.gauges ?? []
}

const detailCache = new Map<string, NwpsGaugeDetail>()

/** Flood categories (and USGS id) require a per-gauge call; cached for the session. */
export async function fetchNwpsDetails(lids: string[], signal?: AbortSignal): Promise<Map<string, NwpsGaugeDetail>> {
  const out = new Map<string, NwpsGaugeDetail>()
  const tasks = lids.map((lid) => async () => {
    const cached = detailCache.get(lid)
    if (cached) {
      out.set(lid, cached)
      return
    }
    const d = await fetchJSON<NwpsGaugeDetail>(`${NWPS_URL}/gauges/${encodeURIComponent(lid)}`, {
      signal,
      timeoutMs: 20_000,
    })
    detailCache.set(lid, d)
    out.set(lid, d)
  })
  await pLimitAll(tasks, 5)
  return out
}

/** Sentinel values NWPS uses for "not set". */
export const nwpsValid = (v: number | undefined | null): v is number =>
  v != null && Number.isFinite(v) && v > -999
