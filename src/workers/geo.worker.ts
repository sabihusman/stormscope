/// <reference lib="webworker" />
/**
 * Heavy geospatial work runs here, off the main thread:
 *  - terrain sampling (fetch + decode AWS terrarium DEM tiles)
 *  - geodesic distance to nearest NHD flowline
 *  - flood-risk scoring on a fine grid
 *  - rainfall accumulation polygons for the timeline
 *  - nowcast: semi-Lagrangian advection of cloud/rain fields by the wind
 *
 * Every job works on one fixed geographic block (see lib/blocks.ts); results
 * from neighbouring blocks tile seamlessly because all sampling is done in
 * degrees over the block's bbox and time keys are absolute.
 */
import { bboxAround, distancePointToPolyline, haversine, lngLatToTile, lngLatToWorldPx, metresPerDegree, type LngLat } from '../lib/geo'
import type { FloodCell, FloodResult, HourlyGrid } from '../types'
import type { Flowline } from '../api/nhd'

export type WorkerRequest =
  | { id: number; type: 'flood'; grid: HourlyGrid; flowlines: Flowline[] | null; horizonHours: number; n: number; terrainZoom: number; terrain?: boolean }
  | { id: number; type: 'rainfallCells'; grid: HourlyGrid }
  | { id: number; type: 'nowcast'; grid: HourlyGrid; frameMinutes: number; hours: number; n: number; t0: number }

export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }

const HOUR = 3_600_000
export const hourKey = (t: number) => Math.floor(t / HOUR)

// ---------------------------------------------------------------------------
// Bilinear sampling of the coarse Open-Meteo grid (degree space over the bbox)
// ---------------------------------------------------------------------------
type Sampler = (p: LngLat, field: Float32Array[], hourIdx: number) => number
function makeSampler(grid: HourlyGrid): Sampler {
  const { n, bbox } = grid.spec
  const w = bbox.east - bbox.west
  const h = bbox.north - bbox.south
  return (p, field, hi) => {
    const gx = ((p.lng - bbox.west) / w) * (n - 1)
    const gy = ((p.lat - bbox.south) / h) * (n - 1)
    const x0 = Math.max(0, Math.min(n - 2, Math.floor(gx)))
    const y0 = Math.max(0, Math.min(n - 2, Math.floor(gy)))
    const fx = Math.max(0, Math.min(1, gx - x0))
    const fy = Math.max(0, Math.min(1, gy - y0))
    const v = (r: number, c: number) => field[r * n + c][hi] ?? 0
    return v(y0, x0) * (1 - fx) * (1 - fy) + v(y0, x0 + 1) * fx * (1 - fy) + v(y0 + 1, x0) * (1 - fx) * fy + v(y0 + 1, x0 + 1) * fx * fy
  }
}

/** Ring for the cell [r, c] of an n×n split of the block. */
function cellRing(grid: HourlyGrid, n: number, r: number, c: number): [number, number][] {
  const { bbox } = grid.spec
  const dw = (bbox.east - bbox.west) / n
  const dh = (bbox.north - bbox.south) / n
  const w = bbox.west + c * dw
  const s = bbox.south + r * dh
  return [
    [w, s],
    [w + dw, s],
    [w + dw, s + dh],
    [w, s + dh],
    [w, s],
  ]
}
function cellCenter(grid: HourlyGrid, n: number, r: number, c: number): LngLat {
  const { bbox } = grid.spec
  return { lng: bbox.west + ((c + 0.5) * (bbox.east - bbox.west)) / n, lat: bbox.south + ((r + 0.5) * (bbox.north - bbox.south)) / n }
}

// ---------------------------------------------------------------------------
// Terrain: AWS Terrarium tiles decoded in-worker via OffscreenCanvas
// ---------------------------------------------------------------------------
const tileCache = new Map<string, Promise<Uint8ClampedArray | null>>()

async function loadTile(x: number, y: number, z: number): Promise<Uint8ClampedArray | null> {
  const key = `${z}/${x}/${y}`
  let p = tileCache.get(key)
  if (!p) {
    p = (async () => {
      try {
        // Bounded: a tile request that never answers must fail the sample (NaN → model elevation fallback), not hang the flood job.
        const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) return null
        const bmp = await createImageBitmap(await res.blob())
        const c = new OffscreenCanvas(256, 256)
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(bmp, 0, 0)
        bmp.close()
        return ctx.getImageData(0, 0, 256, 256).data
      } catch {
        return null
      }
    })()
    tileCache.set(key, p)
    // Bound the cache.
    if (tileCache.size > 400) tileCache.delete(tileCache.keys().next().value!)
  }
  return p
}

/** Elevation in metres from terrarium RGB. Returns NaN if the tile is missing. */
async function sampleElevation(p: LngLat, z: number): Promise<number> {
  const { x, y } = lngLatToTile(p.lng, p.lat, z)
  const data = await loadTile(x, y, z)
  if (!data) return NaN
  const { px, py } = lngLatToWorldPx(p.lng, p.lat, z)
  const ix = Math.min(255, Math.max(0, Math.floor(px - x * 256)))
  const iy = Math.min(255, Math.max(0, Math.floor(py - y * 256)))
  const o = (iy * 256 + ix) * 4
  return data[o] * 256 + data[o + 1] + data[o + 2] / 256 - 32768
}

// ---------------------------------------------------------------------------
// Flood risk
// ---------------------------------------------------------------------------
async function computeFlood(grid: HourlyGrid, flowlines: Flowline[] | null, horizonHours: number, n: number, terrainZoom: number, terrain = true): Promise<FloodResult> {
  const sample = makeSampler(grid)
  const nowIdx = Math.max(0, grid.times.findIndex((t) => t > Date.now()) - 1)
  const endIdx = nowIdx + horizonHours

  // 1. Cell centres + forecast rain over the horizon.
  const centers: LngLat[] = []
  const rain: number[] = []
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const p = cellCenter(grid, n, r, c)
      centers.push(p)
      let acc = 0
      for (let h = nowIdx; h < Math.min(endIdx, grid.times.length); h++) acc += sample(p, grid.precipitation, h)
      rain.push(acc)
    }

  // 2. Elevation from terrain tiles (fallback: model elevation from Open-Meteo).
  const elev = new Float32Array(n * n)
  const tl = lngLatToTile(grid.spec.bbox.west, grid.spec.bbox.north, terrainZoom)
  const br = lngLatToTile(grid.spec.bbox.east, grid.spec.bbox.south, terrainZoom)
  // The quick pass (terrain = false, while the drainage data loads) skips the tiles: model elevation only.
  const prefetch: Promise<unknown>[] = []
  if (terrain) for (let x = tl.x; x <= br.x; x++) for (let y = tl.y; y <= br.y; y++) prefetch.push(loadTile(x, y, terrainZoom))
  await Promise.all(prefetch)
  let missing = 0
  for (let i = 0; i < centers.length; i++) {
    const e = terrain ? await sampleElevation(centers[i], terrainZoom) : NaN
    if (Number.isFinite(e)) elev[i] = e
    else {
      elev[i] = NaN
      missing++
    }
  }
  if (missing) {
    const elevField = Array.from(grid.elevation, (v) => Float32Array.of(v))
    for (let i = 0; i < centers.length; i++) if (!Number.isFinite(elev[i])) elev[i] = sample(centers[i], elevField, 0)
  }

  // 3. Relative elevation: cell minus the mean of its 7×7 neighbourhood.
  const rel = new Float32Array(n * n)
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      let sum = 0
      let cnt = 0
      for (let dr = -3; dr <= 3; dr++)
        for (let dc = -3; dc <= 3; dc++) {
          const rr = r + dr
          const cc = c + dc
          if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue
          sum += elev[rr * n + cc]
          cnt++
        }
      rel[r * n + c] = elev[r * n + c] - sum / cnt
    }

  // 4. Geodesic distance to nearest drainage flowline (US only, when available).
  const drainageAvailable = !!flowlines && flowlines.length > 0
  const dist = new Float32Array(n * n).fill(NaN)
  if (drainageAvailable) {
    const boxes = flowlines!.map((l) => {
      let w = Infinity, s = Infinity, e = -Infinity, nn = -Infinity
      for (const [x, y] of l.coords) {
        if (x < w) w = x
        if (x > e) e = x
        if (y < s) s = y
        if (y > nn) nn = y
      }
      return { w, s, e, n: nn }
    })
    const cellM = haversine(centers[0], centers[1])
    const searchM = Math.max(cellM * 3, 3000)
    for (let i = 0; i < centers.length; i++) {
      const p = centers[i]
      const bb = bboxAround(p, searchM)
      let best = Infinity
      for (let k = 0; k < flowlines!.length; k++) {
        const b = boxes[k]
        if (b.e < bb.west || b.w > bb.east || b.n < bb.south || b.s > bb.north) continue
        const d = distancePointToPolyline(p, flowlines![k].coords)
        if (d < best) best = d
      }
      dist[i] = best === Infinity ? searchM * 2 : best
    }
  }

  // 5. Score. Rain gates everything; terrain and drainage modulate it.
  const raw = new Float32Array(n * n)
  for (let i = 0; i < centers.length; i++) {
    const fRain = Math.min(1, rain[i] / 25) // 25 mm over the horizon saturates
    const fLow = Math.min(1, Math.max(0, (-rel[i] - 2) / 20)) // ignore ±2 m noise; 22 m below neighbours saturates
    const fDrain = drainageAvailable && Number.isFinite(dist[i]) ? Math.max(0, 1 - dist[i] / 600) : 0
    const terrainW = drainageAvailable ? 0.3 : 0.45
    const drainW = drainageAvailable ? 0.25 : 0
    const risk = fRain * (0.45 + (drainageAvailable ? 0 : 0.1)) + fLow * terrainW + fDrain * drainW
    raw[i] = risk * Math.min(1, rain[i] / 4)
  }
  // 3×3 mean so flat terrain doesn't produce a checkerboard.
  const smooth = new Float32Array(n * n)
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      let sum = 0
      let cnt = 0
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr
          const cc = c + dc
          if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue
          sum += raw[rr * n + cc]
          cnt++
        }
      smooth[r * n + c] = sum / cnt
    }

  const cells: FloodCell[] = []
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const i = r * n + c
      cells.push({
        ring: cellRing(grid, n, r, c),
        center: centers[i],
        risk: +smooth[i].toFixed(3),
        rain24: +rain[i].toFixed(1),
        elevation: Math.round(elev[i]),
        relElevation: +rel[i].toFixed(1),
        drainageDistM: Number.isFinite(dist[i]) ? Math.round(dist[i]) : null,
      })
    }
  return { cells, drainageAvailable, flowlineCount: flowlines?.length ?? 0, computedAt: Date.now(), horizonHours }
}

// ---------------------------------------------------------------------------
// Rainfall accumulation cells: one polygon per grid point with cumulative
// precipitation per *absolute hour* (`a<hourKey>`) so blocks fetched at
// different times still scrub in sync.
// ---------------------------------------------------------------------------
function rainfallCells(grid: HourlyGrid) {
  const { n } = grid.spec
  const nowIdx = Math.max(0, grid.times.findIndex((t) => t > Date.now()) - 1)
  const features = grid.spec.points.map((_, i) => {
    const r = Math.floor(i / n)
    const c = i % n
    const props: Record<string, number> = {}
    let acc = 0
    for (let h = 0; h < grid.times.length; h++) {
      const hk = hourKey(grid.times[h])
      if (h >= nowIdx) acc += grid.precipitation[i][h]
      props[`a${hk}`] = +acc.toFixed(2)
      props[`r${hk}`] = +grid.precipitation[i][h].toFixed(2)
    }
    // Cell centred on the sample point: shift the n×n ring grid by half a cell.
    const { bbox } = grid.spec
    const dw = (bbox.east - bbox.west) / (n - 1)
    const dh = (bbox.north - bbox.south) / (n - 1)
    const w = bbox.west + (c - 0.5) * dw
    const s = bbox.south + (r - 0.5) * dh
    const ring: [number, number][] = [
      [w, s],
      [w + dw, s],
      [w + dw, s + dh],
      [w, s + dh],
      [w, s],
    ]
    return { type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [ring] }, properties: props }
  })
  return { type: 'FeatureCollection' as const, features, firstHour: hourKey(grid.times[0]), lastHour: hourKey(grid.times[grid.times.length - 1]) }
}

// ---------------------------------------------------------------------------
// Nowcast: advect cloud & rain fields by the hourly wind (semi-Lagrangian).
// Frames start at the shared `t0` so neighbouring blocks animate in lockstep.
// ---------------------------------------------------------------------------
function nowcast(grid: HourlyGrid, frameMinutes: number, hours: number, n: number, t0: number) {
  const sample = makeSampler(grid)
  const { bbox } = grid.spec
  const mpd = metresPerDegree((bbox.south + bbox.north) / 2)
  const frameCount = Math.floor((hours * 60) / frameMinutes) + 1

  const pts: LngLat[] = []
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      pts.push({ lng: bbox.west + ((bbox.east - bbox.west) * c) / (n - 1), lat: bbox.south + ((bbox.north - bbox.south) * r) / (n - 1) })

  const hourAt = (t: number) => {
    const idx = grid.times.findIndex((ht) => ht > t) - 1
    const i0 = Math.max(0, Math.min(grid.times.length - 2, idx))
    const f = Math.max(0, Math.min(1, (t - grid.times[i0]) / (grid.times[i0 + 1] - grid.times[i0])))
    return { i0, f }
  }
  const at = (p: LngLat, field: Float32Array[], t: number) => {
    const { i0, f } = hourAt(t)
    return sample(p, field, i0) * (1 - f) + sample(p, field, i0 + 1) * f
  }
  const windAt = (p: LngLat, t: number) => {
    const s = at(p, grid.windSpeed, t)
    const { i0, f } = hourAt(t)
    const d0 = (sample(p, grid.windDir, i0) * Math.PI) / 180
    const d1 = (sample(p, grid.windDir, i0 + 1) * Math.PI) / 180
    const ux = -(Math.sin(d0) * (1 - f) + Math.sin(d1) * f)
    const vy = -(Math.cos(d0) * (1 - f) + Math.cos(d1) * f)
    const l = Math.hypot(ux, vy) || 1
    return { u: (ux / l) * s, v: (vy / l) * s }
  }

  const frames: { time: number; cloud: Float32Array; rain: Float32Array; u: Float32Array; v: Float32Array }[] = []
  for (let k = 0; k < frameCount; k++) {
    const t = t0 + k * frameMinutes * 60000
    const dt = t - t0
    const cloud = new Float32Array(n * n)
    const rain = new Float32Array(n * n)
    const u = new Float32Array(n * n)
    const v = new Float32Array(n * n)
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const w = windAt(p, t)
      u[i] = w.u
      v[i] = w.v
      const steer = 1.6
      const back = Math.min(dt / 1000, 3 * 3600)
      const src = { lng: p.lng - (w.u * steer * back) / mpd.lng, lat: p.lat - (w.v * steer * back) / mpd.lat }
      const a = Math.min(0.7, dt / (3 * 3600 * 1000))
      cloud[i] = at(p, grid.cloudCover, t) * (1 - a) + at(src, grid.cloudCover, t) * a
      rain[i] = at(p, grid.precipitation, t) * (1 - a) + at(src, grid.precipitation, t) * a
    }
    frames.push({ time: t, cloud, rain, u, v })
  }
  return { n, bbox, points: pts, frames, t0, generatedAt: Date.now() }
}

// ---------------------------------------------------------------------------
self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data
  try {
    let result: unknown
    if (msg.type === 'flood') result = await computeFlood(msg.grid, msg.flowlines, msg.horizonHours, msg.n, msg.terrainZoom, msg.terrain ?? true)
    else if (msg.type === 'rainfallCells') result = rainfallCells(msg.grid)
    else if (msg.type === 'nowcast') result = nowcast(msg.grid, msg.frameMinutes, msg.hours, msg.n, msg.t0)
    const res: WorkerResponse = { id: msg.id, ok: true, result }
    self.postMessage(res)
  } catch (e) {
    const res: WorkerResponse = { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }
    self.postMessage(res)
  }
}
