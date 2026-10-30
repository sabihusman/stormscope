import { useMemo, useSyncExternalStore } from 'react'
import type { AlertsData, FloodResult, HourlyGrid, LayerId, Place, PlaceForecast, RadarData, RainHorizon, Resource, RiverGauge, StationObs } from '../types'
import type { MonitorSitesResponse } from '../api/airnow'
import type { NowcastResult, RainfallCellsResult } from '../workers/client'
export type { LayerId } from '../types'
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
/** Top-level destinations (bottom nav on a phone, rail on wider screens). */
export type Screen = 'now' | 'map' | 'trip' | 'more'
export type MorePage = 'flood' | 'rivers' | 'station' | 'settings' | 'about'
export interface RecentPlace {
  name: string
  lngLat: LngLat
}
export type HourlySpan = 12 | 24 | 48
export type AnimLayer = 'radar' | 'satellite' | 'rainfall' | 'nowcast'

/** One pollutant reading of a tapped air monitor, for the details sheet (the AQI badge in its EPA colour, the local time and age). */
export interface SelectionReading {
  /** The same reading as text, as it appears in `lines` (the chip shows it; the sheet shows the badge row instead). */
  line: string
  label: string
  aqi: number | null
  category: string | null
  /** EPA category colour and a legible text colour on it; null without an AQI. */
  color: string | null
  text: string | null
  /** Raw value with its unit, or ''. */
  value: string
  time: number
  stale: boolean
}

export interface Selection {
  kind: 'gauge' | 'flood' | 'rain' | 'station' | 'point' | 'journey'
  lngLat: { lng: number; lat: number }
  title: string
  lines: string[]
  /** Air-monitor readings as structured rows (the sheet renders them with colour badges in place of their text lines). */
  readings?: SelectionReading[]
  source?: string
  updated?: number
}

/** One fixed geographic block of forecast data and everything derived from it. */
export interface Block {
  key: string
  id: BlockId
  bbox: BBox
  grid: Resource<HourlyGrid>
  /** USGS NHD drainage for the block; `saved` = served from the device's 30-day store (no request), with its size. */
  flowlines: Resource<{ lines: Flowline[]; truncated: boolean; saved?: boolean; bytes?: number } | null>
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
  /** Departure, ms epoch; null = now (the default — resolved when the trip is planned, not when the app was opened). */
  departure: number | null
  routes: Resource<{ routes: RouteResult[]; engine: 'valhalla' | 'osrm'; fallbackReason?: string }>
  selected: number
  weather: Resource<JourneyWeather>
  hazards: Resource<HazardReport>
  /** RWIS pavement sensors along the route (ice confirmation). */
  road: Resource<RoadReport>
  /** Bumped by every change of destination / route / clear: a loader started under an older value must not write its result. */
  gen: number
}

export interface AppState {
  place: Place | null
  placeLabel: string | null
  /** Centre of the point-based data (rivers, station). Follows the map as the user pans; snaps back to `place` on recenter. */
  focus: LngLat | null
  /** Bumped by "back to my location". */
  recenterNonce: number
  /** The selected place is inside the map's current view (false once the map has been moved away from it). */
  placeInView: boolean
  /** "Save this place on this device": off by default on a first visit; nothing about the place is stored until it is on. */
  savePlacePref: boolean
  /** Forgetting a place (or a first visit) asks for a place again: the first-run choice is shown while this is set and no place is chosen. */
  askPlace: boolean
  layers: Record<LayerId, boolean>
  /** Layers that threw and were switched off by their error boundary, with the reason (cleared on re-enable). */
  layerErrors: Partial<Record<string, string>>
  rainHorizon: RainHorizon
  /** The Now tab's "Next N hours" span (12 / 24 / 48), remembered. */
  hourlySpan: HourlySpan
  is3D: boolean
  units: Units
  /** Which screen corner the layer button lives in (phones). */
  fabCorner: FabCorner
  /** Its corner of the map area on wide layouts (default: under the zoom column, top-right); remembered separately. */
  fabCornerWide: FabCorner

  radar: Resource<RadarData>
  /** GOES frames from NASA GIBS. */
  satellite: Resource<SatFrames>
  satProduct: SatProduct
  satFrame: number
  rivers: Resource<RiverGauge[]>
  /** What `rivers` holds: 'summary' = NOAA forecast points with flood category (one request); 'full' = plus flood-stage thresholds and USGS sites (the Rivers page). */
  riversTier: 'summary' | 'full' | null
  /** The Now screen's Rivers tile is on screen (gauges are only loaded while something shows them). */
  riversTileVisible: boolean
  station: Resource<StationObs>
  /** Current conditions + 48 h hourly for the place (the Now screen). */
  conditions: Resource<PlaceForecast>
  /** Active NWS alerts for the place. */
  alerts: Resource<AlertsData>
  /** EPA AirNow sites around the place (±0.3°), for the Now tab's measured air-quality lines. */
  monitorsNear: Resource<MonitorSitesResponse>
  /** The pollutant the 25 km monitor circles show: ozone or smoke (PM2.5), one at a time. */
  aqPollutant: 'OZONE' | 'PM2.5'
  /** The circles layer needs the sites in view even when the dots toggle is off. */
  monitorsWanted: boolean
  /** More than one air-monitor dot under a tap: the chooser lists them (ids into `monitors.data.sites`) instead of guessing. */
  dotChooser: { lngLat: { lng: number; lat: number }; ids: string[] } | null
  /** EPA AirNow monitoring sites in the map view, with their latest readings (the Air monitors layer). */
  monitors: Resource<MonitorSitesResponse>

  /** Forecast blocks by key. Blocks persist across pans; only missing ones are fetched. */
  blocks: Record<string, Block>
  /** Block keys that intersect the current view (nearest first). */
  visibleBlocks: string[]
  blockLevel: BlockLevel
  /** Shared nowcast frame origin (ms epoch); 0 until the first nowcast runs. */
  nowcastT0: number

  /** Which animated layer the shared timeline controls. */
  animLayer: AnimLayer
  /** Playback clock (ms epoch) shared by radar / satellite and the active forecast overlay; null = live ("Now"). */
  playTime: number | null
  /** Phones: the playback control is a pill until expanded into the full bar (wide layouts are always expanded). */
  playbarExpanded: boolean
  /** The map's credits panel (the (i) button). */
  creditsOpen: boolean
  /** Bumped by the Now screen's "Map layers" entry: the layers panel opens when the Map shows. */
  openLayersNonce: number
  /** Bumped by Escape: every open panel (layers, credits, picker, chooser, details sheet) closes. */
  closePanelsNonce: number
  /** Wide layouts: the content column folded away for a full-map view. */
  columnCollapsed: boolean
  radarFrame: number
  rainFrame: number
  nowcastFrame: number
  playing: boolean

  /** Map details sheet (timeline / point details). */
  sheet: SheetMode
  screen: Screen
  /** Page inside More, or null for the list. */
  morePage: MorePage | null
  /** The shared place picker (use my location / search / pick on map). */
  pickerOpen: boolean
  /** Open the picker straight on its search box (first-run prompt → Search). */
  pickerMode: 'menu' | 'search'
  /** Map "pick a point" mode: crosshair + confirm; `pickReturn` is where to go afterwards. */
  pickMode: boolean
  pickReturn: Screen
  recentPlaces: RecentPlace[]
  /** Block key the Flood page wants computed for the place (independent of map zoom / layer). */
  floodFor: string | null
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
  placeInView: true,
  // Returning users who saved a place before the toggle existed keep saving (the saved place is the opt-in).
  savePlacePref: ((): boolean => {
    try {
      const v = localStorage.getItem('stormscope.savePlace')
      return v === null ? !!localStorage.getItem('stormscope.place') : v === '1'
    } catch {
      return false
    }
  })(),
  // No saved place (a first visit, or Save off): ask on every open, never pick a city silently.
  askPlace: ((): boolean => {
    try {
      return !localStorage.getItem('stormscope.place')
    } catch {
      return true
    }
  })(),
  layers: {
    radar: true,
    satellite: false,
    rainfall: false,
    flood: false,
    rivers: true,
    station: true,
    nowcast: false,
    aqcircles: false,
    monitors: false,
    ...savedLayers,
  },
  rainHorizon: 24,
  hourlySpan: ((): HourlySpan => {
    try {
      const v = Number(localStorage.getItem('stormscope.hourlySpan'))
      return v === 24 || v === 48 ? v : 12
    } catch {
      return 12
    }
  })(),
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
  fabCornerWide: ((): FabCorner => {
    try {
      const v = localStorage.getItem('stormscope.fabCornerWide')
      return v === 'bl' || v === 'tl' || v === 'br' ? v : 'tr'
    } catch {
      return 'tr'
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
  riversTier: null,
  riversTileVisible: false,
  station: emptyResource(),
  conditions: emptyResource(),
  alerts: emptyResource(),
  monitorsNear: emptyResource(),
  aqPollutant: 'PM2.5',
  monitorsWanted: false,
  dotChooser: null,
  monitors: emptyResource(),
  blocks: {},
  visibleBlocks: [],
  blockLevel: 1,
  nowcastT0: 0,
  animLayer: 'radar',
  playTime: null,
  playbarExpanded: false,
  creditsOpen: false,
  openLayersNonce: 0,
  closePanelsNonce: 0,
  columnCollapsed: false,
  radarFrame: 0,
  rainFrame: 0,
  nowcastFrame: 0,
  playing: false,
  sheet: 'peek',
  screen: 'now',
  morePage: null,
  pickerOpen: false,
  pickerMode: 'menu',
  pickMode: false,
  pickReturn: 'now',
  recentPlaces: ((): RecentPlace[] => {
    try {
      return JSON.parse(localStorage.getItem('stormscope.recent') ?? '[]') as RecentPlace[]
    } catch {
      return []
    }
  })(),
  floodFor: null,
  legendOpen: false,
  selection: null,
  toast: null,
  layerErrors: {},
  refreshNonce: 0,
  journey: { to: null, departure: null, routes: emptyResource(), selected: 0, weather: emptyResource(), hazards: emptyResource(), road: emptyResource(), gen: 0 },
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
    // Turning a layer on again after it was contained is the retry: forget its error.
    let layerErrors = s.layerErrors
    if (on && layerErrors[id]) {
      layerErrors = { ...layerErrors }
      delete layerErrors[id]
    }
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
    // Forecast overlays (rain / flood / nowcast / air quality) are one at a time: they stack into an unreadable quilt.
    const OVERLAYS: LayerId[] = ['rainfall', 'flood', 'nowcast']
    if (on && OVERLAYS.includes(id)) {
      for (const other of OVERLAYS) if (other !== id) layers[other] = false
      if (id === 'rainfall' || id === 'nowcast') extra = { ...extra, animLayer: id }
    }
    // Keep the timeline pointed at an enabled animated layer.
    let animLayer = (extra.animLayer as AnimLayer | undefined) ?? s.animLayer
    if (!layers[animLayer]) animLayer = (['radar', 'satellite', 'rainfall', 'nowcast'] as AnimLayer[]).find((l) => layers[l]) ?? animLayer
    return { ...extra, layers, animLayer, layerErrors }
  })
}

/** The measured air-quality circles: a pollutant turns them on (one at a time), null turns them off. */
export function setAqPollutant(p: 'OZONE' | 'PM2.5' | null) {
  if (p) store.set({ aqPollutant: p })
  setLayer('aqcircles', !!p)
}

export function setJourneyTo(to: Place) {
  store.set((s) => ({ journey: { ...s.journey, to, routes: emptyResource(), weather: emptyResource(), hazards: emptyResource(), road: emptyResource(), selected: 0, gen: s.journey.gen + 1 }, screen: 'trip', selection: null }))
}

/** Navigate. `more` pages take the current place as their input. Playback keeps its state (the bar is always on screen on wide layouts). */
export function go(screen: Screen, morePage: MorePage | null = null) {
  store.set((s) => ({ screen, morePage: screen === 'more' ? morePage : s.morePage, pickerOpen: false, selection: screen === 'map' ? s.selection : null }))
}

/**
 * Who needs the place's flood screening right now (the Flood page, the Now tile while it is on screen).
 * `floodFor` is the block the controller fetches and screens; it is set while anyone wants it.
 */
const floodWants = new Map<string, string>()
export function wantFlood(who: string, key: string | null) {
  if (key) floodWants.set(who, key)
  else floodWants.delete(who)
  const next = floodWants.size ? [...floodWants.values()].at(-1)! : null
  if (store.get().floodFor !== next) store.set({ floodFor: next })
}

/** Set the place from any picker path and remember it in recents (search/map picks only). */
export function setPlace(place: Place, label?: string) {
  store.set((s) => {
    const name = label ?? place.name
    let recentPlaces = s.recentPlaces
    if (place.source !== 'geolocation') {
      recentPlaces = [{ name, lngLat: place.lngLat }, ...s.recentPlaces.filter((r) => r.name !== name)].slice(0, 5)
      try {
        localStorage.setItem('stormscope.recent', JSON.stringify(recentPlaces))
      } catch {
        /* ignore */
      }
    }
    return { place, placeLabel: label ?? (place.source === 'search' ? place.name : s.placeLabel), selection: null, pickerOpen: false, pickMode: false, recentPlaces, askPlace: false }
  })
}

/** Enter "pick a point on the map": the map screen shows a crosshair and a confirm button. */
export function startPickOnMap() {
  store.set((s) => ({ pickMode: true, pickReturn: s.screen === 'map' ? 'now' : s.screen, screen: 'map', pickerOpen: false, selection: null }))
}
export function endPickOnMap(cancel: boolean) {
  store.set((s) => ({ pickMode: false, screen: cancel ? s.pickReturn : s.pickReturn === 'map' ? 'now' : s.pickReturn }))
}
export function setDeparture(ms: number | null) {
  store.set((s) => ({ journey: { ...s.journey, departure: ms } }))
}
export function selectRoute(i: number) {
  store.set((s) => ({ journey: { ...s.journey, selected: i, weather: emptyResource(), hazards: emptyResource(), road: emptyResource(), gen: s.journey.gen + 1 } }))
}
export function clearJourney() {
  store.set((s) => ({ journey: { ...s.journey, to: null, routes: emptyResource(), weather: emptyResource(), hazards: emptyResource(), road: emptyResource(), selected: 0, gen: s.journey.gen + 1 }, selection: null }))
}
/**
 * Merge into the journey. With `gen`, the patch is dropped when the journey has since been changed or cleared
 * (Oct 9: a live hazards / road response landing after Change repopulated the panel for good).
 */
export function patchJourney(p: Partial<Journey>, gen?: number) {
  store.set((s) => (gen !== undefined && s.journey.gen !== gen ? {} : { journey: { ...s.journey, ...p } }))
}

export function setFabCorner(fabCorner: FabCorner) {
  store.set({ fabCorner })
  try {
    localStorage.setItem('stormscope.fabCorner', fabCorner)
  } catch {
    /* ignore */
  }
}
/** The wide-layout corner (a separate preference: the phone's corner is not the desktop's). */
export function setFabCornerWide(fabCornerWide: FabCorner) {
  store.set({ fabCornerWide })
  try {
    localStorage.setItem('stormscope.fabCornerWide', fabCornerWide)
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

/**
 * "Forget my location and recent places": the saved place, the recent list and the first-run flag go from this
 * device; units, layers and the other settings stay. The app returns to Now and asks for a place again, as on a
 * first visit (the first-run choice screen, not a silently chosen default).
 */
export function forgetPlaces() {
  for (const k of ['stormscope.place', 'stormscope.recent', 'stormscope.geo.asked']) {
    try {
      localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  }
  store.set({ place: null, placeLabel: null, focus: null, recentPlaces: [], selection: null, screen: 'now', morePage: null, pickerOpen: false, askPlace: true, journey: { ...store.get().journey, to: null, routes: emptyResource(), weather: emptyResource(), hazards: emptyResource(), road: emptyResource(), selected: 0, gen: store.get().journey.gen + 1 } })
}

/** Escape: close whatever panel is open (the layers panel listens to the nonce; the rest are store flags). */
export function closeAllPanels() {
  store.set((s) => ({ closePanelsNonce: s.closePanelsNonce + 1, creditsOpen: false, pickerOpen: false, pickerMode: 'menu', dotChooser: null, legendOpen: false, sheet: s.selection ? 'peek' : s.sheet }))
}

/** The "Save this place on this device" choice; turning it off removes the saved place at once. */
export function setSavePlacePref(on: boolean) {
  store.set({ savePlacePref: on })
  try {
    localStorage.setItem('stormscope.savePlace', on ? '1' : '0')
    if (on) savePlace(store.get().place, store.get().placeLabel)
    else localStorage.removeItem('stormscope.place')
  } catch {
    /* ignore */
  }
}

/** Remove one entry from the recent places. */
export function removeRecent(name: string) {
  store.set((s) => {
    const recentPlaces = s.recentPlaces.filter((r) => r.name !== name)
    try {
      localStorage.setItem('stormscope.recent', JSON.stringify(recentPlaces))
    } catch {
      /* ignore */
    }
    return { recentPlaces }
  })
}

/** Persist the last place so a returning user lands where they left off — only with "Save this place" on. */
export function savePlace(p: Place | null, label: string | null) {
  try {
    if (p && store.get().savePlacePref) localStorage.setItem('stormscope.place', JSON.stringify({ ...p, label }))
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

/** The Now tab's hourly span; remembered on this device. */
export function setHourlySpan(hourlySpan: HourlySpan) {
  store.set({ hourlySpan })
  try {
    localStorage.setItem('stormscope.hourlySpan', String(hourlySpan))
  } catch {
    /* private mode */
  }
}
