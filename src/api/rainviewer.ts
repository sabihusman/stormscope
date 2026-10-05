import { fetchJSON } from '../lib/fetch'
import type { RadarData, RadarFrame } from '../types'

export const RAINVIEWER_URL = 'https://api.rainviewer.com/public/weather-maps.json'

interface RvFrame {
  time: number
  path: string
}
interface RvResponse {
  version: string
  generated: number
  host: string
  radar: { past: RvFrame[]; nowcast: RvFrame[] }
}

export async function fetchRadar(signal?: AbortSignal): Promise<RadarData> {
  const j = await fetchJSON<RvResponse>(RAINVIEWER_URL, { signal })
  const frames: RadarFrame[] = [
    ...j.radar.past.map((f) => ({ ...f, kind: 'past' as const })),
    ...j.radar.nowcast.map((f) => ({ ...f, kind: 'nowcast' as const })),
  ]
  return { host: j.host, generated: j.generated, frames }
}

/**
 * Tile URL template for a frame: 512px tiles, colour scheme 2 (universal blue),
 * smooth=1, snow=1. See https://www.rainviewer.com/api/color-schemes.html
 * Public tiles are only served up to zoom 7 (higher zooms return a
 * "Zoom Level Not Supported" placeholder), so the source is capped at
 * RADAR_MAX_ZOOM and MapLibre overzooms beyond it.
 */
export const RADAR_MAX_ZOOM = 7
export const RADAR_TILE_SIZE = 512
export function radarTileUrl(host: string, frame: RadarFrame, scheme = 2): string {
  return `${host}${frame.path}/${RADAR_TILE_SIZE}/{z}/{x}/{y}/${scheme}/1_1.png`
}
