import { useEffect, useMemo, useRef } from 'react'
import type { CanvasSource, Map as MlMap } from 'maplibre-gl'
import { CLOUD_STOPS, RAIN_STOPS } from '../lib/colors'
import { blockAt, blockKey, unionBBox } from '../lib/blocks'
import { useReducedMotion } from '../hooks/useMisc'
import { store, useApp, useVisibleBlocks } from '../state/store'
import { firstSymbolLayer, useMap } from './MapView'
import type { NowcastResult } from '../workers/client'

const RES = 8 // canvas pixels per grid cell
const srcId = (key: string) => `nowcast-${key}`

function parseRgba(c: string): [number, number, number, number] {
  const m = c.match(/rgba?\(([^)]+)\)/)
  if (!m) return [0, 0, 0, 0]
  const [r, g, b, a = '1'] = m[1].split(',').map((s) => s.trim())
  return [+r, +g, +b, Math.round(+a * 255)]
}
const cloudLUT = CLOUD_STOPS.map((s) => ({ v: s.value, c: parseRgba(s.color) }))
const rainLUT = RAIN_STOPS.map((s) => ({ v: s.value, c: parseRgba(s.color) }))
function lut(v: number, table: { v: number; c: [number, number, number, number] }[]): [number, number, number, number] {
  let c: [number, number, number, number] = [0, 0, 0, 0]
  for (const t of table) if (v >= t.v) c = t.c
  return c
}

/**
 * Paints each visible block's nowcast frame (clouds + rain cells) to its own
 * canvas source. Blocks share a frame origin (store.nowcastT0) so they animate
 * in lockstep. Wind particles live in <WindParticles/>.
 */
export function NowcastLayer() {
  const map = useMap()
  const enabled = useApp((s) => s.layers.nowcast)
  const blocks = useVisibleBlocks()
  const frame = useApp((s) => s.nowcastFrame)
  const canvases = useRef(new Map<string, HTMLCanvasElement>())

  // Blocks with nowcast data, keyed so the effect only re-runs when the set changes.
  const ready = useMemo(() => blocks.filter((b) => b.nowcast.data), [blocks])
  const setKey = ready.map((b) => `${b.key}@${b.nowcast.data!.generatedAt}`).join('|')

  useEffect(() => {
    if (!map || !enabled) return
    const want = new Set(ready.map((b) => b.key))
    // Remove sources for blocks that left the view.
    for (const [key, canvas] of canvases.current) {
      if (want.has(key)) continue
      if (map.getLayer(srcId(key))) map.removeLayer(srcId(key))
      if (map.getSource(srcId(key))) map.removeSource(srcId(key))
      canvases.current.delete(key)
      void canvas
    }
    // Add sources for new blocks.
    for (const b of ready) {
      if (canvases.current.has(b.key)) continue
      const nc = b.nowcast.data!
      const canvas = document.createElement('canvas')
      canvas.width = nc.n * RES
      canvas.height = nc.n * RES
      canvases.current.set(b.key, canvas)
      const { west, east, south, north } = nc.bbox
      // animate:false — animate:true forces MapLibre to repaint every frame; we upload per nowcast frame.
      map.addSource(srcId(b.key), {
        type: 'canvas',
        canvas,
        animate: false,
        coordinates: [
          [west, north],
          [east, north],
          [east, south],
          [west, south],
        ],
      })
      map.addLayer({ id: srcId(b.key), type: 'raster', source: srcId(b.key), paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 0 } }, firstSymbolLayer(map))
    }
    redraw(map, ready, canvases.current, store.get().nowcastFrame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, enabled, setKey])

  // Tear everything down when the layer is turned off.
  useEffect(() => {
    if (!map) return
    if (enabled) return
    for (const key of canvases.current.keys()) {
      if (map.getLayer(srcId(key))) map.removeLayer(srcId(key))
      if (map.getSource(srcId(key))) map.removeSource(srcId(key))
    }
    canvases.current.clear()
  }, [map, enabled])
  useEffect(() => {
    const c = canvases.current
    return () => {
      if (!map) return
      for (const key of c.keys()) {
        if (map.getLayer(srcId(key))) map.removeLayer(srcId(key))
        if (map.getSource(srcId(key))) map.removeSource(srcId(key))
      }
      c.clear()
    }
  }, [map])

  // Redraw on frame change.
  useEffect(() => {
    if (!map || !enabled) return
    redraw(map, ready, canvases.current, frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, enabled, frame])

  return null
}

function redraw(map: MlMap, ready: { key: string; nowcast: { data: NowcastResult | null } }[], canvases: Map<string, HTMLCanvasElement>, frame: number) {
  let any = false
  for (const b of ready) {
    const canvas = canvases.get(b.key)
    if (!canvas || !b.nowcast.data) continue
    drawFrame(canvas, b.nowcast.data, frame)
    const src = map.getSource(srcId(b.key)) as CanvasSource | undefined
    if (!src) continue
    // play() marks the texture dirty for the next paint; pause right after so the map idles again.
    src.play()
    map.once('render', () => src.pause())
    any = true
  }
  if (any) map.triggerRepaint()
}

// One scratch canvas per grid size: the worker already rasterized every frame, so a frame change
// is a putImageData + one scaled drawImage, no per-pixel JavaScript on the main thread.
const scratch = new Map<number, OffscreenCanvas>()
function drawFrame(canvas: HTMLCanvasElement, nc: NowcastResult, frame: number) {
  const n = nc.n
  const f = nc.frames[Math.max(0, Math.min(nc.frames.length - 1, frame))]
  if (!f) return
  let small = scratch.get(n)
  if (!small) {
    small = new OffscreenCanvas(n, n)
    scratch.set(n, small)
  }
  const sctx = small.getContext('2d')!
  if (f.rgba) sctx.putImageData(new ImageData(f.rgba as Uint8ClampedArray<ArrayBuffer>, n, n), 0, 0)
  else {
    // Older worker result without pixels (hot reload): rasterize here once.
    const img = sctx.createImageData(n, n)
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const gi = (n - 1 - r) * n + c
        const cloud = lut(f.cloud[gi], cloudLUT)
        const rain = lut(f.rain[gi], rainLUT)
        const ra = rain[3] / 255
        const ca = cloud[3] / 255
        const a = ra + ca * (1 - ra)
        const o = (r * n + c) * 4
        img.data[o] = a ? (rain[0] * ra + cloud[0] * ca * (1 - ra)) / a : 0
        img.data[o + 1] = a ? (rain[1] * ra + cloud[1] * ca * (1 - ra)) / a : 0
        img.data[o + 2] = a ? (rain[2] * ra + cloud[2] * ca * (1 - ra)) / a : 0
        img.data[o + 3] = Math.round(a * 255)
      }
    }
    sctx.putImageData(img, 0, 0)
  }
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height)
}

// ---------------------------------------------------------------------------
// Wind particle overlay (HTML canvas on top of the map; pointer-events: none)
// Samples the wind field of whichever block a particle is in.
// ---------------------------------------------------------------------------
interface Particle {
  lng: number
  lat: number
  age: number
  px: number
  py: number
}

export function WindParticles() {
  const map = useMap()
  const enabled = useApp((s) => s.layers.nowcast)
  const level = useApp((s) => s.blockLevel)
  const blocks = useVisibleBlocks()
  const frame = useApp((s) => s.nowcastFrame)
  const reduced = useReducedMotion()
  const ref = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef(frame)
  frameRef.current = frame

  // Union of the blocks that have nowcast data; the particle field lives inside it.
  const union = useMemo(() => unionBBox(blocks.filter((b) => b.nowcast.data).map((b) => b.bbox)), [blocks])
  const unionKey = union ? `${union.west},${union.south},${union.east},${union.north}` : ''
  const hasData = !!union

  useEffect(() => {
    const canvas = ref.current
    if (!map || !canvas || !enabled || !union) return
    const ctx = canvas.getContext('2d')!
    const container = map.getContainer()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const resize = () => {
      canvas.width = container.clientWidth * dpr
      canvas.height = container.clientHeight * dpr
      canvas.style.width = `${container.clientWidth}px`
      canvas.style.height = `${container.clientHeight}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const { west, east, south, north } = union

    // Wind at a point from the block that contains it (latest data from the store).
    const sampleUV = (lng: number, lat: number): [number, number] | null => {
      const key = blockKey(blockAt({ lng, lat }, level))
      const nc = store.get().blocks[key]?.nowcast.data
      if (!nc) return null
      const f = nc.frames[Math.min(nc.frames.length - 1, frameRef.current)]
      if (!f) return null
      const n = nc.n
      const gx = ((lng - nc.bbox.west) / (nc.bbox.east - nc.bbox.west)) * (n - 1)
      const gy = ((lat - nc.bbox.south) / (nc.bbox.north - nc.bbox.south)) * (n - 1)
      const x0 = Math.max(0, Math.min(n - 2, Math.floor(gx)))
      const y0 = Math.max(0, Math.min(n - 2, Math.floor(gy)))
      const fx = Math.max(0, Math.min(1, gx - x0))
      const fy = Math.max(0, Math.min(1, gy - y0))
      const at = (arr: Float32Array, r: number, c: number) => arr[r * n + c]
      const bl = (arr: Float32Array) =>
        at(arr, y0, x0) * (1 - fx) * (1 - fy) + at(arr, y0, x0 + 1) * fx * (1 - fy) + at(arr, y0 + 1, x0) * (1 - fx) * fy + at(arr, y0 + 1, x0 + 1) * fx * fy
      return [bl(f.u), bl(f.v)]
    }
    const mPerDegLat = 111_320
    const mPerDegLng = mPerDegLat * Math.cos((((south + north) / 2) * Math.PI) / 180)
    // Project the four corners of the union once per frame and bilinearly interpolate:
    // far cheaper than map.project() per particle, exact when unpitched.
    let cSW = { x: 0, y: 0 }, cSE = { x: 0, y: 0 }, cNW = { x: 0, y: 0 }, cNE = { x: 0, y: 0 }
    const refreshCorners = () => {
      cSW = map.project([west, south])
      cSE = map.project([east, south])
      cNW = map.project([west, north])
      cNE = map.project([east, north])
    }
    refreshCorners()
    const projectFast = (lng: number, lat: number) => {
      const fx = (lng - west) / (east - west)
      const fy = (lat - south) / (north - south)
      const sx = cSW.x + (cSE.x - cSW.x) * fx
      const sy = cSW.y + (cSE.y - cSW.y) * fx
      const nx = cNW.x + (cNE.x - cNW.x) * fx
      const ny = cNW.y + (cNE.y - cNW.y) * fx
      return { x: sx + (nx - sx) * fy, y: sy + (ny - sy) * fy }
    }
    // Spawn inside the part of the union that is on screen.
    const spawnBox = () => {
      const b = map.getBounds()
      return {
        west: Math.max(west, b.getWest()),
        east: Math.min(east, b.getEast()),
        south: Math.max(south, b.getSouth()),
        north: Math.min(north, b.getNorth()),
      }
    }
    let sb = spawnBox()

    if (reduced) {
      // Static arrows on a coarse lattice, re-drawn on move.
      const draw = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.strokeStyle = 'rgba(15,23,42,0.75)'
        ctx.fillStyle = 'rgba(15,23,42,0.75)'
        ctx.lineWidth = 1.5
        const cols = 14
        const rows = Math.max(4, Math.round((cols * container.clientHeight) / container.clientWidth))
        const b = map.getBounds()
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < cols; c++) {
            const lng = b.getWest() + ((c + 0.5) / cols) * (b.getEast() - b.getWest())
            const lat = b.getSouth() + ((r + 0.5) / rows) * (b.getNorth() - b.getSouth())
            const uv = sampleUV(lng, lat)
            if (!uv) continue
            const { x, y } = map.project([lng, lat])
            const sp = Math.hypot(uv[0], uv[1])
            const len = Math.min(26, 6 + sp * 2.2)
            const ang = Math.atan2(-uv[1], uv[0])
            const ex = x + Math.cos(ang) * len
            const ey = y + Math.sin(ang) * len
            ctx.beginPath()
            ctx.moveTo(x, y)
            ctx.lineTo(ex, ey)
            ctx.stroke()
            ctx.beginPath()
            ctx.moveTo(ex, ey)
            ctx.lineTo(ex - Math.cos(ang - 0.5) * 6, ey - Math.sin(ang - 0.5) * 6)
            ctx.lineTo(ex - Math.cos(ang + 0.5) * 6, ey - Math.sin(ang + 0.5) * 6)
            ctx.closePath()
            ctx.fill()
          }
      }
      draw()
      map.on('move', draw)
      map.on('resize', resize)
      map.on('resize', draw)
      return () => {
        map.off('move', draw)
        map.off('resize', resize)
        map.off('resize', draw)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      }
    }

    // Animated particles.
    const area = container.clientWidth * container.clientHeight
    const COUNT = Math.round(Math.min(1800, Math.max(400, area / 600)))
    const particles: Particle[] = []
    const spawn = (p?: Particle): Particle => {
      const q = p ?? ({} as Particle)
      q.lng = sb.west + Math.random() * Math.max(1e-6, sb.east - sb.west)
      q.lat = sb.south + Math.random() * Math.max(1e-6, sb.north - sb.south)
      q.age = Math.floor(Math.random() * 200)
      const s = projectFast(q.lng, q.lat)
      q.px = s.x
      q.py = s.y
      return q
    }
    for (let i = 0; i < COUNT; i++) particles.push(spawn())
    let raf = 0
    let last = performance.now()
    let moving = false
    const onMoveStart = () => {
      moving = true
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
    const onMoveEnd = () => {
      moving = false
      refreshCorners()
      sb = spawnBox()
      for (const p of particles) {
        const s = projectFast(p.lng, p.lat)
        p.px = s.x
        p.py = s.y
      }
    }
    const loop = (t: number) => {
      const dt = Math.min(50, t - last) / 1000
      last = t
      raf = requestAnimationFrame(loop)
      if (moving || document.hidden) return
      ctx.globalCompositeOperation = 'destination-out'
      // Tail length follows zoom (short ticks at z5, long streaks at z12) and is
      // frame-rate independent (fade per 16.7 ms, converted with this frame's dt).
      const z = map.getZoom()
      const fadePerTick = Math.min(0.12, Math.max(0.015, 0.12 - (z - 5) * 0.015))
      const fade = 1 - Math.pow(1 - fadePerTick, (dt * 1000) / 16.7)
      ctx.fillStyle = `rgba(0,0,0,${fade.toFixed(4)})`
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineWidth = 1.6
      ctx.lineCap = 'round'
      const scale = 360 // 1 real second ≈ 6 minutes of drift
      for (const p of particles) {
        const uv = sampleUV(p.lng, p.lat)
        if (!uv || p.age++ > 220) {
          spawn(p)
          continue
        }
        const nlng = p.lng + (uv[0] * dt * scale) / mPerDegLng
        const nlat = p.lat + (uv[1] * dt * scale) / mPerDegLat
        const s = projectFast(nlng, nlat)
        const sp = Math.hypot(uv[0], uv[1])
        const alpha = Math.min(0.9, 0.25 + sp / 12)
        ctx.strokeStyle = `rgba(15,23,42,${alpha})`
        ctx.beginPath()
        ctx.moveTo(p.px, p.py)
        ctx.lineTo(s.x, s.y)
        ctx.stroke()
        p.lng = nlng
        p.lat = nlat
        p.px = s.x
        p.py = s.y
      }
    }
    raf = requestAnimationFrame(loop)
    map.on('movestart', onMoveStart)
    map.on('moveend', onMoveEnd)
    map.on('resize', resize)
    map.on('resize', refreshCorners)
    return () => {
      cancelAnimationFrame(raf)
      map.off('resize', refreshCorners)
      map.off('movestart', onMoveStart)
      map.off('moveend', onMoveEnd)
      map.off('resize', resize)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, enabled, reduced, unionKey, level])

  if (!enabled || !hasData) return null
  return <canvas ref={ref} className="wind-canvas" aria-hidden="true" />
}
