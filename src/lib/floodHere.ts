import { FLOOD_STOPS } from './colors'
import { haversine, type LngLat } from './geo'
import { blockAt, blockKey } from './blocks'
import type { FloodCell, FloodResult, Resource } from '../types'

/** Block key the place's flood screening lives in (the finest level). */
export const floodKeyFor = (p: LngLat) => blockKey(blockAt(p, 0))

/** "low" | "moderate" | "high" … from a 0..1 risk score, per the legend stops. */
export const riskLabel = (r: number) => [...FLOOD_STOPS].reverse().find((s) => r >= s.value)?.label ?? 'low'
export const riskWord = (r: number) => {
  const l = riskLabel(r)
  return l[0].toUpperCase() + l.slice(1)
}

/** The screened cell nearest the place, if the block's flood job has produced one. */
export function floodHere(flood: Resource<FloodResult> | undefined, at: LngLat): FloodCell | null {
  const cells = flood?.data?.cells ?? []
  if (!cells.length) return null
  return cells.reduce((best, c) => (haversine(c.center, at) < haversine(best.center, at) ? c : best), cells[0])
}
