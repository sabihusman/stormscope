import type { WorkerRequest, WorkerResponse } from './geo.worker'
import type { FloodResult, HourlyGrid } from '../types'
import type { Flowline } from '../api/nhd'
import type { BBox, LngLat } from '../lib/geo'

export interface RainfallCellsResult {
  type: 'FeatureCollection'
  features: GeoJSON.Feature<GeoJSON.Polygon, Record<string, number>>[]
  /** Absolute hour keys (ms epoch / 3.6e6) covered by the `a<hour>` / `r<hour>` properties. */
  firstHour: number
  lastHour: number
}
export interface NowcastFrame {
  time: number
  cloud: Float32Array
  rain: Float32Array
  u: Float32Array
  v: Float32Array
  /** n×n RGBA pixels (north row first) if rasterized in the worker (WORKER_RASTER; off, no gain). */
  rgba?: Uint8ClampedArray
}
export interface NowcastResult {
  n: number
  bbox: BBox
  points: LngLat[]
  frames: NowcastFrame[]
  /** Shared frame origin (ms epoch) so neighbouring blocks stay in lockstep. */
  t0: number
  generatedAt: number
}

export const NOWCAST_FRAME_MIN = 10
export const NOWCAST_HOURS = 6
export const NOWCAST_FRAMES = (NOWCAST_HOURS * 60) / NOWCAST_FRAME_MIN + 1

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./geo.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const p = pending.get(ev.data.id)
      if (!p) return
      pending.delete(ev.data.id)
      if (ev.data.ok) p.resolve(ev.data.result)
      else p.reject(new Error(ev.data.error))
    }
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Worker crashed'))
      pending.clear()
      worker = null
    }
  }
  return worker
}

type Req = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never
function call<T>(req: Req): Promise<T> {
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    getWorker().postMessage({ ...req, id })
  })
}

export const geoWorker = {
  flood: (grid: HourlyGrid, flowlines: Flowline[] | null, horizonHours: number, n: number, terrainZoom: number, terrain = true) =>
    call<FloodResult>({ type: 'flood', grid, flowlines, horizonHours, n, terrainZoom, terrain }),
  rainfallCells: (grid: HourlyGrid) => call<RainfallCellsResult>({ type: 'rainfallCells', grid }),
  nowcast: (grid: HourlyGrid, n: number, t0: number) =>
    call<NowcastResult>({ type: 'nowcast', grid, frameMinutes: NOWCAST_FRAME_MIN, hours: NOWCAST_HOURS, n, t0 }),
}
