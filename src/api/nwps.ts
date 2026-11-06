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

/**
 * Gauge details are metadata — the linked USGS site and the flood stages — not readings (those come from the list
 * and USGS), so they are kept between visits for a week: a repeat visit skips the 20 detail requests (4 rounds of
 * 5) that held the full gauge list back (Nov 6 audit: 12–15 s).
 */
const DETAIL_KEY = 'stormscope.nwpsDetails.v1'
const DETAIL_MAX_AGE_MS = 7 * 24 * 3_600_000
type KeptDetail = Pick<NwpsGaugeDetail, 'lid' | 'usgsId' | 'flood'> & { at: number }
const detailCache = new Map<string, NwpsGaugeDetail>(
  (() => {
    try {
      const kept = JSON.parse(localStorage.getItem(DETAIL_KEY) ?? '{}') as Record<string, KeptDetail>
      return Object.values(kept)
        .filter((d) => d?.lid && Date.now() - d.at < DETAIL_MAX_AGE_MS)
        .map((d) => [d.lid, { lid: d.lid, usgsId: d.usgsId, flood: d.flood } as NwpsGaugeDetail] as [string, NwpsGaugeDetail])
    } catch {
      return []
    }
  })(),
)
function keepDetails(ds: NwpsGaugeDetail[]) {
  if (!ds.length) return
  try {
    const kept = JSON.parse(localStorage.getItem(DETAIL_KEY) ?? '{}') as Record<string, KeptDetail>
    for (const d of ds) kept[d.lid] = { lid: d.lid, usgsId: d.usgsId, flood: d.flood, at: Date.now() }
    // At most 200 gauges kept (a few places' worth), oldest out first.
    const all = Object.values(kept).sort((a, b) => b.at - a.at).slice(0, 200)
    localStorage.setItem(DETAIL_KEY, JSON.stringify(Object.fromEntries(all.map((d) => [d.lid, d]))))
  } catch {
    /* storage full or blocked: kept in memory for this visit */
  }
}

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
    fetched.push(d)
  })
  const fetched: NwpsGaugeDetail[] = []
  await pLimitAll(tasks, 5)
  keepDetails(fetched)
  return out
}

/** Sentinel values NWPS uses for "not set". */
export const nwpsValid = (v: number | undefined | null): v is number =>
  v != null && Number.isFinite(v) && v > -999
