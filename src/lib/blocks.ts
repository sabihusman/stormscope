/**
 * Fixed geographic blocks for the forecast grid — the same idea as map tiles.
 * A block is identified by (level, x, y) where level picks the block size in
 * degrees. Blocks never move: panning only loads the ones that are missing, and
 * already-loaded neighbours stay on the map.
 */
import { haversine, type BBox, type LngLat } from './geo'
import type { GridSpec } from '../types'

export type BlockLevel = 0 | 1 | 2
/** Block edge in degrees per level. */
export const LEVEL_DEG: Record<BlockLevel, number> = { 0: 0.5, 1: 1, 2: 2 }
/**
 * Open-Meteo sample points per block side (spacing ≈ 9 / 18 / 32 km). Every location
 * counts as one API call against the free tier (600/min, 10k/day), so this is kept small:
 * 49 calls per block at every level.
 */
export const GRID_N: Record<BlockLevel, number> = { 0: 7, 1: 7, 2: 7 }
/** Flood-risk cells per block side (≈ 2.3 / 4 / 7 km cells). */
export const FLOOD_N: Record<BlockLevel, number> = { 0: 24, 1: 28, 2: 32 }
/** Terrain tile zoom used for flood scoring — ~12 tiles per block at every level. */
export const TERRAIN_Z: Record<BlockLevel, number> = { 0: 11, 1: 10, 2: 9 }
/** Nowcast render cells per block side. */
export const NOWCAST_N = 24
/** Max blocks kept loaded for one view (protects the free APIs). */
export const MAX_VISIBLE_BLOCKS = 16
/** Below this zoom the blocks would be meaninglessly coarse; nothing is loaded. */
export const MIN_BLOCK_ZOOM = 5.5

export interface BlockId {
  level: BlockLevel
  x: number
  y: number
}

export const blockKey = (b: BlockId) => `${b.level}/${b.x}/${b.y}`
export function parseBlockKey(k: string): BlockId {
  const [l, x, y] = k.split('/').map(Number)
  return { level: l as BlockLevel, x, y }
}

export function levelForZoom(z: number): BlockLevel {
  return z >= 10.5 ? 0 : z >= 8.5 ? 1 : 2
}

export function blockBBox(b: BlockId): BBox {
  const d = LEVEL_DEG[b.level]
  return { west: b.x * d, east: (b.x + 1) * d, south: b.y * d, north: (b.y + 1) * d }
}

export function blockAt(p: LngLat, level: BlockLevel): BlockId {
  const d = LEVEL_DEG[level]
  return { level, x: Math.floor(p.lng / d), y: Math.floor(p.lat / d) }
}

export function blockCenter(b: BlockId): LngLat {
  const bb = blockBBox(b)
  return { lng: (bb.west + bb.east) / 2, lat: (bb.south + bb.north) / 2 }
}

/**
 * Blocks intersecting `bounds` at `level`, nearest-to-centre first, capped at `max`.
 * Latitude is clamped to ±80° (no forecast blocks over the poles).
 */
export function blocksForView(bounds: BBox, level: BlockLevel, center: LngLat, max = MAX_VISIBLE_BLOCKS): BlockId[] {
  const d = LEVEL_DEG[level]
  const x0 = Math.floor(bounds.west / d)
  const x1 = Math.floor(bounds.east / d)
  const y0 = Math.floor(Math.max(-80, bounds.south) / d)
  const y1 = Math.floor(Math.min(80, bounds.north) / d)
  const out: { b: BlockId; dist: number }[] = []
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      const b = { level, x, y }
      out.push({ b, dist: haversine(center, blockCenter(b)) })
    }
  out.sort((a, b) => a.dist - b.dist)
  return out.slice(0, max).map((o) => o.b)
}

/** n×n sample points spanning the block inclusive of its edges; row-major, south→north, west→east. */
export function blockGridSpec(b: BlockId): GridSpec {
  const bbox = blockBBox(b)
  const n = GRID_N[b.level]
  const points: LngLat[] = []
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      points.push({
        lng: +(bbox.west + ((bbox.east - bbox.west) * c) / (n - 1)).toFixed(4),
        lat: +(bbox.south + ((bbox.north - bbox.south) * r) / (n - 1)).toFixed(4),
      })
  return { key: blockKey(b), bbox, n, points }
}

/** Union bbox of several blocks (or null when empty). */
export function unionBBox(boxes: BBox[]): BBox | null {
  if (!boxes.length) return null
  return boxes.reduce((a, b) => ({
    west: Math.min(a.west, b.west),
    east: Math.max(a.east, b.east),
    south: Math.min(a.south, b.south),
    north: Math.max(a.north, b.north),
  }))
}
