import { useMemo, useSyncExternalStore } from 'react'
import type { FloodResult, HourlyGrid, LayerId, Place, RadarData, RainHorizon, Resource, RiverGauge, StationObs } from '../types'
import type { NowcastResult, RainfallCellsResult } from '../workers/client'
import type { Flowline } from '../api/nhd'
import { defaultUnits, type Units } from '../lib/units'
import type { BBox, LngLat } from '../lib/geo'
import { blockBBox, parseBlockKey, type BlockId, type BlockLevel } from '../lib/blocks'
import type { SatFrames, SatProduct } from '../api/gibs'
import type { RouteResult } from '../api/routing'
import type { JourneyWeather } from '../lib/journey'
import type { HazardReport } from '../lib/hazardEngine'
import type { RoadReport } from '../lib/roadIce'
import type { ReplayScenario } from '../api/hazards'

/** Minimal external store (zustand-style) so map layers can subscribe to slices. */
function createStore<T extends object>(initial: T) {
  let state = initial
  const listeners = new Set<() => void>()
  const get = () => state
  const set = (partial: Partial<T> | ((s: T) => Partial<T>)) => {
    const next = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...next }
    listeners.forEach((l) => l())
  }
  const subscribe = (l: () => void) => {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }
  function use<S>(selector: (s: T) => S): S {
    return useSyncExternalStore(subscribe, () => selector(state), () => selector(state))
  }
  return { get, set, subscribe, use }
}

export const emptyResource = <T>(): Resource<T> => ({ state: 'idle', data: null, error: null, freshness: null, stale: false })

export type FabCorner = 'br' | 'bl' | 'tl' | 'tr'
export type SheetMode = 'peek' | 'half' | 'full'
export type PanelTab = 'timeline' | 'journey' | 'station' | 'rivers' | 'flood' | 'sources'
export type AnimLayer = 'radar' | 'satellite' | 'rainfall' | 'nowcast'

export interface Selection {
  kind: 'gauge' | 'flood' | 'rain' | 'station' | 'point' | 'journey'
  lngLat: { lng: number; lat: number }
  title: string
  lines: string[]
  source?: string
  updated?: number
}

/** One fixed geographic block of forecast data and everything derived from it. */
export interface Block {
  key: string
  id: BlockId
  bbox: BBox
  grid: Resource<HourlyGrid>
  flowlines: Resource<{ lines: Flowline[]; truncated: boolean } | null>
  rainCells: Resource<RainfallCellsResult>
  flood: Resource<FloodResult>
  nowcast: Resource<NowcastResult>
  /** Last time this block was in view (for eviction). */
  lastSeen: number
}
export function newBlock(key: string): Block {
  const id = parseBlockKey(key)
  return {
    key,
    id,
    bbox: blockBBox(id),
    grid: emptyResource(),
    flowlines: emptyResource(),
    rainCells: emptyResource(),
    flood: emptyResource(),
    nowcast: emptyResource(),
    lastSeen: Date.now(),
  }
}

export interface Journey {
  to: Place | null
  /** Departure (ms epoch). */
  departure: number
  routes: Resource<{ routes: RouteResult[]; engine: 'valhalla' | 'osrm'; fallbackReason?: string }>
  selected: number
  weather: Resource<JourneyWeather>
  hazards: Resource<HazardReport>
  /** RWIS pavement sensors along the route (ice confirmation). */
  road: Resource<RoadReport>
}

export interface AppState {
  place: Place | null
  placeLabel: string | null
  /** Centre of the point-based data (rivers, station). Follows the map as the user pans; snaps back to `place` on recenter. */
  focus: LngLat | null
  /** Bumped by "back to my location". */
  recenterNonce: number
  layers: Record<LayerId, boolean>
  rainHorizon: RainHorizon
  is3D: boolean
  units: Units
  /** Which screen corner the layer button lives in. */
  fabCorner: FabCorner

  radar: Resource<RadarData>
  /** GOES frames from NASA GIBS. */
  satellite: Resource<SatFrames>
  satProduct: SatProduct
  satFrame: number
  rivers: Resource<RiverGauge[]>
  station: Resource<StationObs>

  /** Forecast blocks by key. Blocks persist across pans; only missing ones are fetched. */
  blocks: Record<string, Block>
  /** Block keys that intersect the current view (nearest first). */
  visibleBlocks: string[]
  blockLevel: BlockLevel
  /** Shared nowcast frame origin (ms epoch); 0 until the first nowcast runs. */
  nowcastT0: number

  /** Which animated layer the shared timeline controls. */
  animLayer: AnimLayer
  radarFrame: number
  rainFrame: number
  nowcastFrame: number
  playing: boolean

  sheet: SheetMode
  tab: PanelTab
  legendOpen: boolean
  selection: Selection | null
  toast: { id: number; text: string; kind: 'info' | 'warn' | 'error' } | null
  /** Bumped by "Refresh all" to force every poller to re-run. */
  refreshNonce: number
  journey: Journey
  /** Active replay scenario (from ?replay=<id>), or null for live data. */
  replay: ReplayScenario | null
  /** Pending time carry-over after switching imagery: apply when the target layer's frames arrive. */
  imageryCarry: { to: 'radar' | 'satellite'; time: number } | null
  /** Set when the target layer had no frame within 10 min of the carried time (e.g. GIBS lag). */
  imageryLag: { layer: 'radar' | 'satellite'; viewed: number; landed: number } | null
  /** Time of the imagery frame most recently shown (ms); the carry-over source when a layer is being switched. */
  lastImageryTime: number | null
}

const savedLayers = (() => {
  try {
    const raw = localStorage.getItem('stormscope.layers')
    return raw ? (JSON.parse(raw) as Partial<Record<LayerId, boolean>>) : null
  } catch {
    return null
  }
})()

export const store = createStore<AppState>({
  place: null,
  placeLabel: null,
  focus: null,
  recenterNonce: 0,
  layers: {
    radar: true,
    satellite: false,
    rainfall: false,
    flood: false,
    rivers: true,
    station: true,
    nowcast: false,
    ...savedLayers,
  },
  rainHorizon: 24,
  is3D: false,
  units: defaultUnits(),
  fabCorner: ((): FabCorner => {
    try {
      const v = localStorage.getItem('stormscope.fabCorner')
      return v === 'bl' || v === 'tl' || v === 'tr' ? v : 'br'
    } catch {
      return 'br'
    }
  })(),
  radar: emptyResource(),
  satellite: emptyResource(),
  satProduct: ((): SatProduct => {
    try {
      return localStorage.getItem('stormscope.satProduct') === 'ir' ? 'ir' : 'geocolor'
    } catch {
      return 'geocolor'
    }
  })(),
  satFrame: 0,
  rivers: emptyResource(),
  station: emptyResource(),
  blocks: {},
  visibleBlocks: [],
  blockLevel: 1,
  nowcastT0: 0,
  animLayer: 'radar',
  radarFrame: 0,
  rainFrame: 0,
  nowcastFrame: 0,
  playing: false,
  sheet: 'peek',
  tab: 'timeline',
  legendOpen: true,
  selection: null,
  toast: null,
  refreshNonce: 0,
  journey: { to: null, departure: Date.now(), routes: emptyResource(), selected: 0, weather: emptyResource(), hazards: emptyResource(), road: emptyResource() },
  replay: null,
  imageryCarry: null,
  imageryLag: null,
  lastImageryTime: null,
})

// Debug/test handle (used by scripts/*.mjs).
;(globalThis as unknown as { __store: typeof store }).__store = store

export const useApp = store.use

/** Visible blocks as an array (memoised so effects can depend on it). */
export function useVisibleBlocks(): Block[] {
  const blocks = useApp((s) => s.blocks)
  const keys = useApp((s) => s.visibleBlocks)
  return useMemo(() => keys.map((k) => blocks[k]).filter((b): b is Block => !!b), [blocks, keys])
}

/** Roll many per-block resources up into one status for pills, panels and the timeline. */
export interface Aggregate {
  state: Resource<unknown>['state']
  error: string | null
  stale: boolean
  fetchedAt: number | null
  ready: number
  total: number
}
export function aggregate(blocks: Block[], pick: (b: Block) => Resource<unknown>, maxAgeMs = 60 * 60_000): Aggregate {
  const rs = blocks.map(pick)
  const ready = rs.filter((r) => r.state === 'ready' && r.data != null).length
  const loading = rs.some((r) => r.state === 'loading')
  const errs = rs.filter((r) => r.error).map((r) => r.error as string)
  const fetched = rs.map((r) => r.freshness?.fetchedAt ?? 0).filter(Boolean)
  const newest = fetched.length ? Math.max(...fetched) : null
  const oldest = fetched.length ? Math.min(...fetched) : null
  const state: Aggregate['state'] = rs.length === 0 ? 'idle' : ready > 0 ? 'ready' : loading ? 'loading' : errs.length === rs.length ? 'error' : 'idle'
  return {
    state,
    error: errs.length && ready === 0 ? errs[0] : null,
    stale: rs.some((r) => r.stale) || (oldest != null && Date.now() - oldest > maxAgeMs),
    fetchedAt: newest,
    ready,
    total: rs.length,
  }
}

export function updateBlock(key: string, patch: Partial<Block> | ((b: Block) => Partial<Block>)) {
  store.set((s) => {
    const cur = s.blocks[key] ?? newBlock(key)
    const p = typeof patch === 'function' ? patch(cur) : patch
    return { blocks: { ...s.blocks, [key]: { ...cur, ...p } } }
  })
}

/** Time currently shown by the active imagery layer (ms), if any. */
export function viewedImageryTime(s: AppState): number | null {
  if (s.layers.radar && s.radar.data?.frames.length) {
    const f = s.radar.data.frames
    return f[Math.min(Math.max(0, s.radarFrame), f.length - 1)].time * 1000
  }
  if (s.layers.satellite && s.satellite.data?.times.length) {
    const t = s.satellite.data.times
    return t[Math.min(Math.max(0, s.satFrame), t.length - 1)]
  }
  return s.lastImageryTime
}
/** Nearest frame index to `time`; null when the list is empty. */
export function nearestFrame(times: number[], time: number): number | null {
  if (!times.length) return null
  let best = 0
  for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - time) < Math.abs(times[best] - time)) best = i
  return best
}
/** Land on the frame nearest the carried time, or the newest + a lag note when nothing is within 10 min. */
export function applyImageryCarry(layer: 'radar' | 'satellite', times: number[]): { frame: number; lag: AppState['imageryLag'] } | null {
  const c = store.get().imageryCarry
  if (!c || c.to !== layer || !times.length) return null
  const i = nearestFrame(times, c.time)!
  if (Math.abs(times[i] - c.time) <= 10 * 60_000) return { frame: i, lag: null }
  const newest = times.length - 1
  return { frame: newest, lag: { layer, viewed: c.time, landed: times[newest] } }
}

export function setLayer(id: LayerId, on: boolean) {
  store.set((s) => {
    const layers = { ...s.layers, [id]: on }
    // Radar and satellite are one imagery slot: turning one on turns the other off and
    // carries the time you were looking at across to the other layer.
    let extra: Partial<AppState> = {}
    if (on && (id === 'radar' || id === 'satellite')) {
      const other: LayerId = id === 'radar' ? 'satellite' : 'radar'
      const viewed = viewedImageryTime(s)
      if (import.meta.env.DEV || (globalThis as { __trace?: boolean }).__trace) console.debug('[imagery] switch →', id, 'viewed', viewed ? new Date(viewed).toISOString() : null, 'otherOn', s.layers[other], 'frames', id === 'radar' ? s.radar.data?.frames.length : s.satellite.data?.times.length)
      layers[other] = false
      extra = { animLayer: id, imageryLag: null, imageryCarry: viewed != null ? { to: id, time: viewed } : null }
      const times = id === 'radar' ? (s.radar.data?.frames.map((f) => f.time * 1000) ?? []) : (s.satellite.data?.times ?? [])
      if (viewed != null && times.length) {
        const i = nearestFrame(times, viewed)!
        if (Math.abs(times[i] - viewed) <= 10 * 60_000) extra = { ...extra, imageryCarry: null, [id === 'radar' ? 'radarFrame' : 'satFrame']: i }
        else extra = { ...extra, imageryCarry: null, [id === 'radar' ? 'radarFrame' : 'satFrame']: times.length - 1, imageryLag: { layer: id, viewed, landed: times[times.length - 1] } }
      }
    }
    try {
      localStorage.setItem('stormscope.layers', JSON.stringify(layers))
    } catch {
      /* ignore */
    }
    // Keep the timeline pointed at an enabled animated layer.
    let animLayer = (extra.animLayer as AnimLayer | undefined) ?? s.animLayer
    if (!layers[animLayer]) animLayer = (['radar', 'satellite', 'rainfall', 'nowcast'] as AnimLayer[]).find((l) => layers[l]) ?? animLayer
    return { ...extra, layers, animLayer }
  })
}

export function setJourneyTo(to: Place) {
  store.set((s) => ({ journey: { ...s.journey, to, routes: emptyResource(), weather: emptyResource(), hazards: emptyResource(), road: emptyResource(), selected: 0 }, tab: 'journey', sheet: s.sheet === 'peek' ? 'half' : s.sheet }))
}
export function setDeparture(ms: number) {
  store.set((s) => ({ journey: { ...s.journey, departure: ms } }))
}
export function selectRoute(i: number) {
  store.set((s) => ({ journey: { ...s.journey, selected: i, weather: emptyResource(), hazards: emptyResource(), road: emptyResource() } }))
}
export function clearJourney() {
  store.set((s) => ({ journey: { ...s.journey, to: null, routes: emptyResource(), weather: emptyResource(), hazards: emptyResource(), road: emptyResource(), selected: 0 }, selection: null }))
}
export function patchJourney(p: Partial<Journey>) {
  store.set((s) => ({ journey: { ...s.journey, ...p } }))
}

export function setFabCorner(fabCorner: FabCorner) {
  store.set({ fabCorner })
  try {
    localStorage.setItem('stormscope.fabCorner', fabCorner)
  } catch {
    /* ignore */
  }
}

export function setSatProduct(satProduct: SatProduct) {
  store.set({ satProduct, satellite: emptyResource(), satFrame: 0 })
  try {
    localStorage.setItem('stormscope.satProduct', satProduct)
  } catch {
    /* ignore */
  }
}

export function setUnits(units: Units) {
  store.set({ units })
  try {
    localStorage.setItem('stormscope.units', units)
  } catch {
    /* ignore */
  }
}

/** Persist the last place so a returning user lands where they left off. */
export function savePlace(p: Place | null, label: string | null) {
  try {
    if (p) localStorage.setItem('stormscope.place', JSON.stringify({ ...p, label }))
  } catch {
    /* ignore */
  }
}
export function loadPlace(): { place: Place; label: string | null } | null {
  try {
    const raw = localStorage.getItem('stormscope.place')
    if (!raw) return null
    const { label = null, ...place } = JSON.parse(raw) as Place & { label?: string | null }
    return { place: { ...place, source: 'search' as const }, label }
  } catch {
    return null
  }
}

let toastSeq = 0
export function toast(text: string, kind: 'info' | 'warn' | 'error' = 'info') {
  const id = ++toastSeq
  store.set({ toast: { id, text, kind } })
  setTimeout(() => {
    if (store.get().toast?.id === id) store.set({ toast: null })
  }, 5000)
}

export function setResource<K extends keyof AppState>(key: K, r: AppState[K]) {
  store.set({ [key]: r } as Partial<AppState>)
}
