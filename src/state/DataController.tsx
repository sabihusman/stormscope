import { useEffect, useRef } from 'react'
import { fetchRadar, RAINVIEWER_URL } from '../api/rainviewer'
import { fetchSatFrames, GIBS_WMTS, SAT_LAYERS, satelliteFor, type SatFrames, type SatLayerDef } from '../api/gibs'
import { fetchHourlyGrid, fetchOpenMeteoCurrent, fetchPlaceForecast, OPEN_METEO_URL } from '../api/openMeteo'
import { AIRNOW_CREDIT, fetchMonitorSites } from '../api/airnow'
import { fetchFlowlines, NHD_URL } from '../api/nhd'
import { loadDrainage, saveDrainage } from '../lib/drainageStore'
import { fetchNwpsDetails, fetchNwpsGauges, NWPS_URL, nwpsValid, type NwpsGaugeDetail, type NwpsGaugeSummary } from '../api/nwps'
import { fetchUsgsLatest, fetchUsgsNames, fetchUsgsRecentMedianFlow, USGS_OGC, type UsgsLatest } from '../api/usgsWater'
import { fetchActiveAlerts, fetchNwsNearestObservation, NWS_URL, OutsideNwsCoverage } from '../api/nws'
import { reverseGeocode } from '../api/geocode'
import type { RouteResult } from '../api/routing'
import type { OmPoint } from '../lib/journey'
import type { Hazard, HazardReport, SourceStatus } from '../lib/hazardEngine'
// Routing, forecast-at-ETA, hazards and pavement sensors are loaded on demand (their own chunk).
import { loadJourney } from '../lib/journeyBundle'
import { BLOCK_APPLY_PER_FRAME } from '../lib/perfFlags'
import { describeError, limitTier } from '../lib/fetch'
import { bboxAround, haversine, inBBox, type LngLat } from '../lib/geo'
import { MIN } from '../lib/time'
import { blockCenter, blockGridSpec, FLOOD_N, NOWCAST_N, TERRAIN_Z } from '../lib/blocks'
import { floodKeyFor } from '../lib/floodHere'
import { usePolling } from '../hooks/usePolling'
import { useWide } from '../hooks/useMisc'
import { geoWorker } from '../workers/client'
import { applyImageryCarry, emptyResource, nearestFrame, newBlock, patchJourney, setResource, store, toast, updateBlock, useApp, type Block } from './store'
import type { AlertsData, Resource, RiverGauge } from '../types'

// Refresh cadences (ms).
export const REFRESH = {
  radar: 5 * MIN,
  satellite: 5 * MIN,
  grid: 30 * MIN,
  rivers: 15 * MIN,
  station: 10 * MIN,
  /** Current conditions + hourly for the place. */
  conditions: 10 * MIN,
  /** Active NWS alerts for the place: refreshed while the app is open, not only on place change. */
  alerts: 3 * MIN,
  /** EPA AirNow sites around the place: the map's monitor cadence (its view cache is 10 min), so the Now tab refreshes as the map does. */
  monitorsNear: 10 * MIN,
}

/** Replays are known from the URL before the bootstrap lands in the store. */
export const REPLAY_IN_URL = typeof location !== 'undefined' && new URLSearchParams(location.search).has('replay')
const RIVER_RADIUS_M = 40_000
/** Blocks kept in memory (visible + recently seen). */
const MAX_CACHED_BLOCKS = 30
/** Concurrent Open-Meteo block fetches. */
const GRID_CONCURRENCY = 4
/** Concurrent NHD flowline queries (large responses; keep them from starving the grid fetches). */
const NHD_CONCURRENCY = 2

// Rough continental-US envelope (plus AK/HI) used to skip NHD/NWS calls elsewhere.
const US_BOXES = [
  { west: -125, south: 24, east: -66, north: 50 },
  { west: -170, south: 51, east: -129, north: 72 },
  { west: -161, south: 18, east: -154, north: 23 },
]
export const likelyUS = (p: LngLat) => US_BOXES.some((b) => inBBox(p, b))

export function ready<T>(data: T, source: string, sourceUrl: string, dataTime?: number): Resource<T> {
  // Served while offline ⇒ it came from the service-worker cache: flag it stale straight away.
  return { state: 'ready', data, error: null, stale: !navigator.onLine, freshness: { fetchedAt: Date.now(), dataTime, source, sourceUrl } }
}
export function failed<T>(prev: Resource<T>, e: unknown): Resource<T> {
  return { ...prev, state: prev.data ? 'ready' : 'error', error: describeError(e), stale: !!prev.data }
}
export function loading<T>(prev: Resource<T>): Resource<T> {
  // A retry with no data yet keeps the last error visible (e.g. "Rate limited") instead of a blank spinner.
  return { ...prev, state: prev.data ? 'ready' : 'loading', error: prev.data ? null : prev.error }
}

// ---- Rivers: NOAA NWPS + USGS, in two tiers ----
// 'summary' = one NWPS bbox request: the nearest 20 forecast points with their observed/forecast flood
// category — enough for the Now tile ("N gauges, M high") and the map dots. 'full' = plus one NWPS
// detail request per gauge (flood-stage thresholds + USGS id; cached per gauge for the session) and
// three USGS bbox requests (latest readings, site names, 10-day medians) for the USGS-only sites —
// only the Rivers page shows those. NWPS has no area query for the thresholds: in the v1 swagger
// (/nwps/v1/docs/swagger.json) the /gauges list carries `status` only, and /gauges/{id} is the sole
// source of `flood.categories` and `usgsId`; POST /gauges/raag returns flood statements, not stages.
export type RiversTier = 'summary' | 'full'
const NWPS_NEAREST = 20
function nwpsGauge(g: NwpsGaugeSummary, d: NwpsGaugeDetail | undefined, usgsById: Map<string, UsgsLatest>): RiverGauge {
  const obs = g.status?.observed
  const usgsId = d?.usgsId ? `USGS-${d.usgsId}` : undefined
  const u = usgsId ? usgsById.get(usgsId) : undefined
  const cats = d?.flood?.categories
  return {
    id: g.lid,
    lid: g.lid,
    usgsId,
    name: g.name,
    lngLat: { lng: g.longitude, lat: g.latitude },
    floodCategory: obs?.floodCategory ?? 'unknown',
    stage: obs && nwpsValid(obs.primary) ? { value: obs.primary, unit: obs.primaryUnit, time: Date.parse(obs.validTime) } : markElevation(u?.stage),
    flow: oneFlow(u?.flow, obs && nwpsValid(obs.secondary) ? nwpsFlow(obs.secondary, obs.secondaryUnit, Date.parse(obs.validTime)) : undefined),
    categories: cats
      ? {
          action: nwpsValid(cats.action?.stage) ? cats.action.stage : undefined,
          minor: nwpsValid(cats.minor?.stage) ? cats.minor.stage : undefined,
          moderate: nwpsValid(cats.moderate?.stage) ? cats.moderate.stage : undefined,
          major: nwpsValid(cats.major?.stage) ? cats.major.stage : undefined,
          unit: d?.flood?.stageUnits ?? 'ft',
        }
      : undefined,
    forecast:
      g.status?.forecast && nwpsValid(g.status.forecast.primary)
        ? { value: g.status.forecast.primary, unit: g.status.forecast.primaryUnit, time: Date.parse(g.status.forecast.validTime), floodCategory: g.status.forecast.floodCategory }
        : undefined,
    riskLevel: 'unknown',
    sources: ['NOAA NWPS', ...(u ? ['USGS'] : [])],
  }
}
/** NOAA's observed flow in ft³/s, by the unit NOAA states (kcfs × 1000, cfs as is); unknown units are not shown. */
function nwpsFlow(v: number, unit: string | undefined, time: number): RiverGauge['flow'] {
  const u = (unit ?? '').toLowerCase()
  const cfs = u === 'kcfs' ? v * 1000 : u === 'cfs' || u === 'ft^3/s' ? v : null
  return cfs == null ? undefined : { value: cfs, unit: 'ft^3/s', time, source: 'NOAA NWPS' }
}
/** One flow for a gauge: the newer reading of USGS's measurement and NOAA's, so the list, the map and the sheet agree. */
function oneFlow(usgs: RiverGauge['flow'], noaa: RiverGauge['flow']): RiverGauge['flow'] {
  if (usgs && noaa) return noaa.time > usgs.time ? noaa : usgs
  return usgs ?? noaa
}
/** Iowa Flood Center sensors report the water surface above sea level (hundreds of feet); no stream stage there reaches 200 ft. */
const ELEVATION_STAGE_FT = 200
function markElevation(stage: RiverGauge['stage']): RiverGauge['stage'] {
  return stage && /ft/i.test(stage.unit) && stage.value > ELEVATION_STAGE_FT ? { ...stage, basis: 'elevation' } : stage
}

function classifyRisk(g: RiverGauge) {
  const c = g.floodCategory
  if (c === 'major' || c === 'moderate' || c === 'minor') g.riskLevel = 'flooding'
  else if (c === 'action') g.riskLevel = 'high'
  else if (g.categories?.minor && g.stage && g.stage.value >= g.categories.minor * 0.75) g.riskLevel = 'elevated'
  else if (g.flowRatio != null) g.riskLevel = g.flowRatio >= 3 ? 'high' : g.flowRatio >= 1.75 ? 'elevated' : 'normal'
  else if (c === 'no_flooding') g.riskLevel = 'normal'
  // Stale readings shouldn't claim "normal".
  const t = g.stage?.time ?? g.flow?.time
  if (t && Date.now() - t > 12 * 3600_000 && g.riskLevel === 'normal') g.riskLevel = 'unknown'
}
const nearestNwps = (at: LngLat, nwps: NwpsGaugeSummary[]) =>
  nwps
    .map((g) => ({ g, d: haversine(at, { lng: g.longitude, lat: g.latitude }) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, NWPS_NEAREST)
    .map((x) => x.g)
type RiversCacheEntry = { tier: RiversTier; at: number; resource: Resource<RiverGauge[]>; nwps: NwpsGaugeSummary[] }
/**
 * The last full gauge lists (3 places) kept between visits, so the Rivers page opens on them at once, marked stale
 * with their age, while the refresh runs (Nov 6 audit: 12–15 s of "Loading gauges" on every visit).
 */
const RIVERS_KEY = 'stormscope.rivers.v1'
const RIVERS_KEEP = 3
const RIVERS_SAVED_MAX_AGE_MS = 24 * 3_600_000
function loadSavedRivers(): [string, RiversCacheEntry][] {
  try {
    const j = JSON.parse(localStorage.getItem(RIVERS_KEY) ?? '[]') as [string, RiversCacheEntry][]
    // Kept as stale: `at` 0 makes the first poll refresh it, the list stays on screen meanwhile.
    return j
      .filter(([, e]) => e?.resource?.data && Date.now() - (e.resource.freshness?.fetchedAt ?? 0) < RIVERS_SAVED_MAX_AGE_MS)
      .map(([k, e]) => [k, { ...e, at: 0, resource: { ...e.resource, stale: true } }])
  } catch {
    return []
  }
}
function saveRivers(key: string, entry: RiversCacheEntry) {
  try {
    const rest = loadSavedRivers().filter(([k]) => k !== key)
    // The NOAA list for the whole box is not kept (it is refetched with the refresh); the gauges are.
    localStorage.setItem(RIVERS_KEY, JSON.stringify([[key, { ...entry, nwps: [] }], ...rest].slice(0, RIVERS_KEEP)))
  } catch {
    /* storage full or blocked: the in-memory cache still works for this visit */
  }
}

/** The last frame list per satellite layer, kept between visits (only its times: the layer definition is code). */
const SAT_KEY = 'stormscope.satFrames.v1'
/** GIBS publishes a GOES frame some 20–40 min after its time; estimated frames stop this far back so they exist. */
const SAT_ESTIMATE_LAG_MS = 50 * 60_000
const SAT_STEP_MS = 10 * 60_000
function saveSatFrames(f: SatFrames) {
  try {
    const all = JSON.parse(localStorage.getItem(SAT_KEY) ?? '{}') as Record<string, { times: number[]; latest: number; fetchedAt: number }>
    all[f.layer.id] = { times: f.times, latest: f.latest, fetchedAt: f.fetchedAt }
    localStorage.setItem(SAT_KEY, JSON.stringify(all))
  } catch {
    /* storage blocked: the estimate is used next time */
  }
}
/**
 * Frame times to play while GIBS's list loads: the last visit's list (if under 6 h old) extended in 10-min steps,
 * else the last 3 h at 10-min steps ending 50 min ago. fetchedAt 0 = never fetched (an estimate, shown as stale).
 */
function estimatedSatFrames(layer: SatLayerDef): SatFrames {
  const end = Math.floor((Date.now() - SAT_ESTIMATE_LAG_MS) / SAT_STEP_MS) * SAT_STEP_MS
  let saved: { times: number[]; latest: number; fetchedAt: number } | undefined
  try {
    saved = (JSON.parse(localStorage.getItem(SAT_KEY) ?? '{}') as Record<string, typeof saved>)[layer.id]
  } catch {
    saved = undefined
  }
  const times = saved && Date.now() - saved.fetchedAt < 6 * 3_600_000 ? saved.times.slice() : []
  let t = times.length ? times[times.length - 1] + SAT_STEP_MS : end - 3 * 3_600_000
  for (; t <= end; t += SAT_STEP_MS) times.push(t)
  const latest = Math.max(times[times.length - 1] ?? end, saved?.latest ?? 0)
  return { layer, times: times.filter((x) => x >= latest - 3 * 3_600_000), latest, fetchedAt: saved?.fetchedAt ?? 0 }
}

/** Loads one tier for a place; `nwpsList` reuses the summary tier's list when upgrading to full. */
/** A gauge reading older than this is not shown (USGS keeps the last value of series that ended decades ago). */
export const RIVER_READING_MAX_AGE_MS = 7 * 24 * 3_600_000

async function loadRivers(at: LngLat, tier: RiversTier, nwpsList?: NwpsGaugeSummary[]): Promise<{ resource: Resource<RiverGauge[]>; nwps: NwpsGaugeSummary[] }> {
  const bbox = bboxAround(at, RIVER_RADIUS_M)
  const byDistance = (gs: Iterable<RiverGauge>) => [...gs].sort((a, b) => haversine(at, a.lngLat) - haversine(at, b.lngLat))
  if (tier === 'summary') {
    const nwps = nwpsList ?? (await fetchNwpsGauges(bbox))
    const gauges = nearestNwps(at, nwps).map((g) => nwpsGauge(g, undefined, new Map()))
    gauges.forEach(classifyRisk)
    return { resource: ready(byDistance(gauges), 'NOAA NWPS', NWPS_URL), nwps }
  }
  // USGS site names need only the box: asked for alongside everything else rather than after NOAA's details.
  const namesP = fetchUsgsNames(bbox).catch(() => new Map<string, { name: string; type: string }>())
  const [nwpsRes, usgsRes] = await Promise.allSettled([nwpsList ? Promise.resolve(nwpsList) : fetchNwpsGauges(bbox), fetchUsgsLatest(bbox)])
  if (nwpsRes.status === 'rejected' && usgsRes.status === 'rejected') throw nwpsRes.reason
  const nwps = nwpsRes.status === 'fulfilled' ? nwpsRes.value : []
  // USGS "latest" carries the last value of discontinued series too (readings from 1993–2009 around Des Moines):
  // a reading older than the limit is dropped, so a gauge shows "No recent readings" rather than "10897 d ago".
  const recent = <T extends { time: number }>(x: T | undefined) => (x && Date.now() - x.time <= RIVER_READING_MAX_AGE_MS ? x : undefined)
  const usgs = (usgsRes.status === 'fulfilled' ? usgsRes.value : []).map((u) => ({ ...u, stage: recent(u.stage), flow: recent(u.flow) }))
  // One source down is still a usable (but partial) list — say so in the source line
  // instead of presenting it as the full USGS + NWPS picture.
  const sourceLabel =
    nwpsRes.status === 'rejected'
      ? `USGS Water Data only (NOAA NWPS unavailable: ${describeError(nwpsRes.reason)})`
      : usgsRes.status === 'rejected'
        ? `NOAA NWPS only (USGS Water Data unavailable: ${describeError(usgsRes.reason)})`
        : 'USGS Water Data + NOAA NWPS'
  // Nearest 20 NWPS gauges get full detail (flood categories + USGS id).
  const near = nearestNwps(at, nwps)
  const details = await fetchNwpsDetails(near.map((g) => g.lid))
  const gauges = new Map<string, RiverGauge>()
  const usgsById = new Map(usgs.map((u) => [u.usgsId, u]))
  for (const g of near) {
    const rg = nwpsGauge(g, details.get(g.lid), usgsById)
    gauges.set(rg.id, rg)
    if (rg.usgsId) usgsById.delete(rg.usgsId)
  }
  // USGS-only sites (no NOAA forecast point): nearest 25.
  const names = await namesP
  const usgsOnly = [...usgsById.values()]
    .filter((u) => u.flow || u.stage)
    .map((u) => ({ u, d: haversine(at, u.lngLat) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 25)
  const medians = await fetchUsgsRecentMedianFlow(bbox, usgsOnly.filter((x) => x.u.flow).map((x) => x.u.usgsId), 10).catch(() => new Map<string, number>())
  for (const { u } of usgsOnly) {
    const med = medians.get(u.usgsId)
    gauges.set(u.usgsId, {
      id: u.usgsId,
      usgsId: u.usgsId,
      name: names.get(u.usgsId)?.name ?? u.usgsId,
      lngLat: u.lngLat,
      stage: markElevation(u.stage),
      flow: u.flow,
      floodCategory: 'not_defined',
      flowRatio: med && u.flow ? u.flow.value / Math.max(med, 0.01) : undefined,
      riskLevel: 'unknown',
      sources: ['USGS'],
    })
  }
  for (const g of gauges.values()) classifyRisk(g)
  return { resource: ready(byDistance(gauges.values()), sourceLabel, `${USGS_OGC} · ${NWPS_URL}`), nwps }
}

/** Headless component: owns every fetch, cadence and worker job. */
export function DataController() {
  const place = useApp((s) => s.place)
  const layers = useApp((s) => s.layers)
  const rainHorizon = useApp((s) => s.rainHorizon)
  const nonce = useApp((s) => s.refreshNonce)
  const focus = useApp((s) => s.focus)
  const visibleBlocks = useApp((s) => s.visibleBlocks)
  const floodFor = useApp((s) => s.floodFor)
  const satProduct = useApp((s) => s.satProduct)
  const placeKey = place ? `${place.lngLat.lat.toFixed(3)},${place.lngLat.lng.toFixed(3)}` : ''
  // Replays are known from the URL before the bootstrap lands in the store (the geolocated place would otherwise fire one live call first).
  const replayActive = useApp((s) => !!s.replay) || REPLAY_IN_URL

  // A new place (geolocation, search, map tap) always re-centres the point data on it.
  useEffect(() => {
    if (place) store.set({ focus: place.lngLat })
  }, [place])

  // ---- Radar (global, place-independent) ----
  usePolling(
    async () => {
      const prev = store.get().radar
      const prevFrames = prev.data?.frames ?? []
      const prevLastPast = prevFrames.filter((f) => f.kind === 'past').length - 1
      setResource('radar', loading(prev))
      try {
        const data = await fetchRadar()
        setResource('radar', ready(data, 'RainViewer', RAINVIEWER_URL, data.generated * 1000))
        const times = data.frames.map((f) => f.time * 1000)
        const lastPast = Math.max(0, data.frames.filter((f) => f.kind === 'past').length - 1)
        // Where is the playhead NOW (the user may have scrubbed while the fetch was in flight)?
        // Resolve it against the OLD frame list it was pointing into.
        const curFrame = store.get().radarFrame
        const prevTime = (prevFrames[curFrame]?.time ?? 0) * 1000
        const wasOnNewest = !prev.data || curFrame >= prevLastPast
        // Priority: a pending carry-over (just switched from satellite) → the time the user was
        // viewing (if they had scrubbed away from "newest") → the newest past frame.
        const carried = applyImageryCarry('radar', times)
        if (carried) store.set({ radarFrame: carried.frame, imageryLag: carried.lag, imageryCarry: null })
        // Lag-pinned to newest: keep the lag note's "landed" time in step with the frame now shown.
        else if (store.get().imageryLag?.layer === 'radar') store.set((s) => ({ radarFrame: lastPast, imageryLag: s.imageryLag && { ...s.imageryLag, landed: times[lastPast] } }))
        else if (!store.get().playing && prevTime && !wasOnNewest) store.set({ radarFrame: nearestFrame(times, prevTime) ?? lastPast })
        else store.set((s) => ({ radarFrame: s.playing ? Math.min(s.radarFrame, times.length - 1) : lastPast }))
      } catch (e) {
        setResource('radar', failed(prev, e))
      }
    },
    REFRESH.radar,
    layers.radar,
    [nonce],
  )

  // ---- Satellite frames (GOES via NASA GIBS; East/West picked by where the data window is) ----
  const satSide = satelliteFor(focus?.lng ?? place?.lngLat.lng ?? -90)
  usePolling(
    async () => {
      const layer = SAT_LAYERS[satSide][store.get().satProduct]
      let prev = store.get().satellite
      // The frame list comes from GIBS's capabilities document, the slowest request in the app (~15 s in the Nov 6
      // audit, with the play button disabled throughout). Until it lands, playback runs on the frames known from
      // the last visit, or on times estimated from the clock — the layer loads, the controls stay usable.
      if (prev.data?.layer.id !== layer.id) {
        const est = estimatedSatFrames(layer)
        prev = { ...ready(est, `NASA GIBS · ${layer.label} · frame times estimated until the frame list loads`, GIBS_WMTS, est.latest), stale: true, freshness: { fetchedAt: est.fetchedAt, dataTime: est.latest, source: `NASA GIBS · ${layer.label} · frame times estimated until the frame list loads`, sourceUrl: GIBS_WMTS } }
        setResource('satellite', prev)
        store.set({ satFrame: est.times.length - 1 })
      }
      const prevTimes = prev.data?.times ?? []
      setResource('satellite', loading(prev))
      try {
        const data = await fetchSatFrames(layer, 3)
        saveSatFrames(data)
        setResource('satellite', ready(data, `NASA GIBS · ${layer.label}`, GIBS_WMTS, data.latest))
        const newest = data.times.length - 1
        // Playhead position at completion time, resolved against the old frame list.
        const curFrame = store.get().satFrame
        const prevTime = prevTimes[curFrame] ?? 0
        const wasOnNewest = !prev.data || curFrame >= prevTimes.length - 1
        // Same priority as radar: carry-over → the time the user was viewing → newest frame.
        const carried = applyImageryCarry('satellite', data.times)
        if (carried) store.set({ satFrame: carried.frame, imageryLag: carried.lag, imageryCarry: null })
        // Lag-pinned to newest: a refresh that brings newer frames moves the playhead, so move the note's "landed" time too.
        else if (store.get().imageryLag?.layer === 'satellite') store.set((s) => ({ satFrame: newest, imageryLag: s.imageryLag && { ...s.imageryLag, landed: data.times[newest] } }))
        else if (!store.get().playing && prevTime && !wasOnNewest) store.set({ satFrame: nearestFrame(data.times, prevTime) ?? newest })
        else store.set((s) => ({ satFrame: s.playing && s.animLayer === 'satellite' ? Math.min(s.satFrame, newest) : newest }))
      } catch (e) {
        setResource('satellite', failed(prev, e))
      }
    },
    REFRESH.satellite,
    layers.satellite,
    [nonce, satProduct, satSide],
  )

  // ---- Reverse geocode label ----
  useEffect(() => {
    if (!place) return
    if (place.source === 'search') {
      store.set({ placeLabel: place.name })
      return
    }
    const ctrl = new AbortController()
    store.set({ placeLabel: place.name })
    reverseGeocode(place.lngLat, ctrl.signal).then((n) => {
      if (n && !ctrl.signal.aborted) store.set({ placeLabel: n })
    })
    return () => ctrl.abort()
  }, [place])

  // ---- Forecast blocks (feed rainfall, flood, nowcast) --------------------
  // Blocks are fixed tiles; `reconcile` makes sure every visible block has a fresh
  // grid and whatever derived products the enabled layers need, fetching only what
  // is missing. It is idempotent and guarded against duplicate in-flight work.
  const inflight = useRef(new Set<string>())
  const lastNonce = useRef(nonce)
  const gridQueue = useRef<{ running: number; waiting: (() => void)[] }>({ running: 0, waiting: [] })
  const nhdQueue = useRef<{ running: number; waiting: (() => void)[] }>({ running: 0, waiting: [] })

  const withSlot = async <T,>(q: { running: number; waiting: (() => void)[] }, limit: number, fn: () => Promise<T>): Promise<T> => {
    if (q.running >= limit) await new Promise<void>((res) => q.waiting.push(res))
    q.running++
    try {
      return await fn()
    } finally {
      q.running--
      q.waiting.shift()?.()
    }
  }

  const ensureGrid = async (b: Block, force: boolean) => {
    const age = b.grid.freshness ? Date.now() - b.grid.freshness.fetchedAt : Infinity
    if (!force && b.grid.data && age < REFRESH.grid) return
    const tag = `${b.key}:grid`
    if (inflight.current.has(tag)) return
    inflight.current.add(tag)
    updateBlock(b.key, (cur) => ({ grid: loading(cur.grid) }))
    try {
      const data = await withSlot(gridQueue.current, GRID_CONCURRENCY, () => fetchHourlyGrid(blockGridSpec(b.id), 49))
      updateBlock(b.key, { grid: ready(data, 'Open-Meteo', OPEN_METEO_URL, data.times[0]) })
    } catch (e) {
      const tier = limitTier(e)
      if (tier === 'hour' || tier === 'day') quotaBackoffUntil.current = Date.now() + 10 * MIN
      updateBlock(b.key, (cur) => ({ grid: failed(cur.grid, e) }))
    } finally {
      inflight.current.delete(tag)
    }
  }

  const ensureFlowlines = async (b: Block) => {
    if (b.flowlines.state !== 'idle') return
    const tag = `${b.key}:nhd`
    if (inflight.current.has(tag)) return
    if (!likelyUS(blockCenter(b.id))) {
      updateBlock(b.key, { flowlines: { ...ready(null, 'USGS NHD', NHD_URL), error: 'NHD drainage data is only available in the US' } })
      return
    }
    inflight.current.add(tag)
    updateBlock(b.key, (cur) => ({ flowlines: loading(cur.flowlines) }))
    try {
      // Saved on this device from an earlier load (30 days): no request at all.
      const saved = await loadDrainage(b.key)
      if (saved) {
        updateBlock(b.key, { flowlines: ready({ lines: saved.lines, truncated: saved.truncated, saved: true, bytes: saved.bytes }, 'USGS NHD flowlines (saved on this device)', NHD_URL, saved.at) })
        return
      }
      const r = await withSlot(nhdQueue.current, NHD_CONCURRENCY, () => fetchFlowlines(b.bbox))
      const row = await saveDrainage(b.key, r.lines, r.truncated)
      updateBlock(b.key, { flowlines: ready({ ...r, saved: false, bytes: row?.bytes }, 'USGS NHD flowlines', NHD_URL) })
    } catch (e) {
      updateBlock(b.key, (cur) => ({ flowlines: { ...failed(cur.flowlines, e), data: null, state: 'ready' } }))
    } finally {
      inflight.current.delete(tag)
    }
  }

  // Worker results land in bursts (several blocks finish together) and each store update redraws
  // every block layer, so applying them as they arrive stacked seconds of main-thread work behind
  // one tap. Results are queued and applied one block per animation frame instead.
  const patchQueue = useRef<{ key: string; patch: Partial<Block> }[]>([])
  const pumpScheduled = useRef(false)
  const pump = () => {
    pumpScheduled.current = false
    const next = patchQueue.current.shift()
    if (!next) return
    updateBlock(next.key, next.patch)
    if (patchQueue.current.length) schedulePump()
  }
  const schedulePump = () => {
    if (pumpScheduled.current) return
    pumpScheduled.current = true
    if (document.hidden) window.setTimeout(pump, 50)
    else requestAnimationFrame(() => window.setTimeout(pump, 0)) // after this frame paints
  }
  const queueBlockPatch = (key: string, patch: Partial<Block>) => {
    if (!BLOCK_APPLY_PER_FRAME) {
      updateBlock(key, patch)
      return
    }
    patchQueue.current.push({ key, patch })
    schedulePump()
  }

  const deriveBlock = async (key: string) => {
    const s = store.get()
    const b = s.blocks[key]
    const grid = b?.grid.data
    if (!b || !grid) return
    const gridAt = b.grid.freshness?.fetchedAt ?? 0
    const jobs: Promise<unknown>[] = []

    if (s.layers.rainfall && (!b.rainCells.data || (b.rainCells.freshness?.fetchedAt ?? 0) < gridAt)) {
      const tag = `${key}:rain`
      if (!inflight.current.has(tag)) {
        inflight.current.add(tag)
        updateBlock(key, (cur) => ({ rainCells: loading(cur.rainCells) }))
        jobs.push(
          geoWorker
            .rainfallCells(grid)
            .then((r) => queueBlockPatch(key, { rainCells: ready(r, 'Open-Meteo (hourly precipitation)', OPEN_METEO_URL, grid.times[0]) }))
            .catch((e) => updateBlock(key, (cur) => ({ rainCells: failed(cur.rainCells, e) })))
            .finally(() => inflight.current.delete(tag)),
        )
      }
    }

    if (s.layers.nowcast) {
      const t0 = s.nowcastT0
      if (t0 && (!b.nowcast.data || b.nowcast.data.t0 !== t0 || (b.nowcast.freshness?.fetchedAt ?? 0) < gridAt)) {
        const tag = `${key}:nowcast`
        if (!inflight.current.has(tag)) {
          inflight.current.add(tag)
          updateBlock(key, (cur) => ({ nowcast: loading(cur.nowcast) }))
          jobs.push(
            geoWorker
              .nowcast(grid, NOWCAST_N, t0)
              .then((r) => queueBlockPatch(key, { nowcast: ready(r, 'Open-Meteo hourly wind/cloud/precip, advected in-app', OPEN_METEO_URL, r.generatedAt) }))
              .catch((e) => updateBlock(key, (cur) => ({ nowcast: failed(cur.nowcast, e) })))
              .finally(() => inflight.current.delete(tag)),
          )
        }
      }
    }

    if (s.layers.flood || key === s.floodFor) {
      const horizon = Math.min(s.rainHorizon, 48)
      const flowlinesDone = ensureFlowlines(b)
      // While the drainage data is still loading (a live NHD query took 12–31 s), a quick rain-only pass (model
      // elevation, no terrain tiles, no drainage) shows the level at once, marked preliminary; the full pass replaces it.
      const pre = store.get().blocks[key]
      if (pre && pre.flowlines.state === 'loading' && (!pre.flood.data || pre.flood.data.horizonHours !== horizon || (pre.flood.freshness?.fetchedAt ?? 0) < gridAt)) {
        const qtag = `${key}:flood-quick`
        if (!inflight.current.has(qtag)) {
          inflight.current.add(qtag)
          updateBlock(key, (c) => ({ flood: loading(c.flood) }))
          await geoWorker
            .flood(grid, null, horizon, FLOOD_N[b.id.level], TERRAIN_Z[b.id.level], false)
            .then((r) => {
              // Only while the full pass has not landed meanwhile.
              const now = store.get().blocks[key]
              if (now && now.flowlines.state === 'loading') updateBlock(key, { flood: ready({ ...r, preliminary: true }, 'Derived: Open-Meteo rain + model elevation (quick pass, refining)', OPEN_METEO_URL, r.computedAt) })
            })
            .catch(() => {})
            .finally(() => inflight.current.delete(qtag))
        }
      }
      await flowlinesDone
      const cur = store.get().blocks[key]
      const fl = cur?.flowlines
      if (cur && fl && fl.state !== 'loading') {
        const flAt = fl.freshness?.fetchedAt ?? 0
        const needs =
          !cur.flood.data || cur.flood.data.preliminary || cur.flood.data.horizonHours !== horizon || (cur.flood.freshness?.fetchedAt ?? 0) < Math.max(gridAt, flAt)
        const tag = `${key}:flood`
        if (needs && !inflight.current.has(tag)) {
          inflight.current.add(tag)
          updateBlock(key, (c) => ({ flood: loading(c.flood) }))
          jobs.push(
            geoWorker
              .flood(grid, fl.data?.lines ?? null, horizon, FLOOD_N[b.id.level], TERRAIN_Z[b.id.level])
              .then((r) =>
                queueBlockPatch(key, {
                  flood: ready(r, 'Derived: Open-Meteo rain + AWS terrain + USGS NHD', 'https://registry.opendata.aws/terrain-tiles/', r.computedAt),
                }),
              )
              .catch((e) => updateBlock(key, (c) => ({ flood: failed(c.flood, e) })))
              .finally(() => inflight.current.delete(tag)),
          )
        }
      }
    }
    await Promise.all(jobs)
  }

  const quotaBackoffUntil = useRef(0)
  const reconcile = async () => {
    const s = store.get()
    const overlayOn = s.layers.rainfall || s.layers.flood || s.layers.nowcast
    const need = overlayOn || !!s.floodFor
    // The Flood page's block for the place is computed whatever the map shows. With no overlay on, that
    // block is the ONLY one fetched (the visible blocks would cost 49 locations each for nothing).
    const base = !overlayOn ? (s.floodFor ? [s.floodFor] : []) : s.floodFor && !s.visibleBlocks.includes(s.floodFor) ? [...s.visibleBlocks, s.floodFor] : s.visibleBlocks
    // With the rain overlay on, the place's own block is always loaded (one 49-location request), so the playback
    // forecast reaches its full horizon at any zoom — zoomed out, the map shows no forecast blocks of its own.
    const placeBlock = s.layers.rainfall && s.place ? floodKeyFor(s.place.lngLat) : null
    const want = placeBlock && !base.includes(placeBlock) ? [...base, placeBlock] : base
    // Nothing is fetched while the tab is hidden: the 30-min refresh only counts visible time.
    if (!need || !want.length || document.hidden) return
    if (Date.now() < quotaBackoffUntil.current) return
    const force = lastNonce.current !== s.refreshNonce
    lastNonce.current = s.refreshNonce
    const now = Date.now()

    // Make sure every visible block exists, stamp it, and evict the oldest hidden ones.
    store.set((st) => {
      const blocks = { ...st.blocks }
      for (const k of want) blocks[k] = { ...(blocks[k] ?? newBlock(k)), lastSeen: now }
      const hidden = Object.values(blocks)
        .filter((b) => !want.includes(b.key))
        .sort((a, b) => a.lastSeen - b.lastSeen)
      while (Object.keys(blocks).length > MAX_CACHED_BLOCKS && hidden.length) delete blocks[hidden.shift()!.key]
      return { blocks }
    })

    // One shared nowcast origin; renewed every 30 min so neighbours stay aligned.
    if (s.layers.nowcast && (!s.nowcastT0 || now - s.nowcastT0 > REFRESH.grid)) {
      store.set({ nowcastT0: Math.floor(now / 60_000) * 60_000, nowcastFrame: 0 })
    }

    // Nearest blocks first; grids fetch through a small concurrency gate.
    await Promise.all(
      want.map(async (k) => {
        const b = store.get().blocks[k]
        if (!b) return
        await ensureGrid(b, force)
        await deriveBlock(k)
      }),
    )
  }

  const reconcileRef = useRef(reconcile)
  reconcileRef.current = reconcile
  useEffect(() => {
    void reconcileRef.current()
  }, [visibleBlocks, layers.rainfall, layers.flood, layers.nowcast, rainHorizon, nonce, floodFor, placeKey])
  // Periodic freshness pass (also fires when the tab returns to the foreground).
  useEffect(() => {
    const t = setInterval(() => void reconcileRef.current(), 60_000)
    const onVisible = () => document.visibilityState === 'visible' && void reconcileRef.current()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // ---- Journey: route (Valhalla → OSRM) then forecast at ETA for every sample ----
  const jTo = useApp((s) => s.journey.to)
  const jDeparture = useApp((s) => s.journey.departure)
  const jSelected = useApp((s) => s.journey.selected)
  const jRoutes = useApp((s) => s.journey.routes.data)
  const fromKey = place ? `${place.lngLat.lat.toFixed(4)},${place.lngLat.lng.toFixed(4)}` : ''
  useEffect(() => {
    if (!jTo || !place) return
    const ctrl = new AbortController()
    patchJourney({ routes: loading(store.get().journey.routes) })
    // Replays ship the recorded route so they make no routing call (demo servers are per-IP fair use).
    const rp = store.get().replay
    const planned: Promise<{ routes: RouteResult[]; engine: 'valhalla' | 'osrm'; fallbackReason?: string; cached: boolean }> = loadJourney().then((J) =>
      rp && !rp.live && rp.files.route
        ? J.fetchReplayFile<{ engine: 'valhalla' | 'osrm'; routes: RouteResult[] }>(rp, rp.files.route).then((r) => ({ engine: r.engine, routes: r.routes, cached: true }))
        : J.route(place.lngLat, jTo.lngLat, ctrl.signal).then((r) => ({ ...r, cached: false })),
    )
    planned
      .then((r) => {
        if (ctrl.signal.aborted) return
        const src = (r.engine === 'valhalla' ? 'Valhalla (FOSSGIS demo)' : 'OSRM demo') + (r.cached ? ' · route cached in the fixture, no live call' : '')
        patchJourney({ routes: ready({ routes: r.routes, engine: r.engine, fallbackReason: r.fallbackReason }, src, r.engine === 'valhalla' ? 'https://valhalla1.openstreetmap.de' : 'https://router.project-osrm.org'), selected: 0, weather: { ...store.get().journey.weather, data: null, state: 'idle' }, hazards: { ...store.get().journey.hazards, data: null, state: 'idle' }, road: { ...store.get().journey.road, data: null, state: 'idle' } })
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return
        patchJourney({ routes: failed(store.get().journey.routes, e) })
      })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jTo, fromKey, nonce])

  // Forecast: debounced, and at most once per minute for the same route + departure.
  const lastWeather = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  useEffect(() => {
    const r = jRoutes?.routes[jSelected]
    if (!r) return
    // A null departure means "now": resolved here, when the trip is planned (H5: it used to be the app's load time).
    const departAt = jDeparture ?? Date.now()
    const key = `${r.coords.length}:${r.distanceM}:${Math.round(departAt / 60_000)}`
    const timer = window.setTimeout(async () => {
      if (lastWeather.current.key === key && Date.now() - lastWeather.current.at < 60_000 && store.get().journey.weather.data) return
      lastWeather.current = { key, at: Date.now() }
      const gen = store.get().journey.gen
      patchJourney({ weather: loading(store.get().journey.weather) })
      const J = await loadJourney()
      try {
        // Replays ship the recorded Open-Meteo response: zero live locations against the shared quota.
        const rp = store.get().replay
        let cached: OmPoint | OmPoint[] | undefined
        if (rp && !rp.live && rp.files.weatherCache) {
          try {
            cached = (await J.fetchReplayFile<{ response: OmPoint | OmPoint[] }>(rp, rp.files.weatherCache)).response
          } catch (e) {
            toast(`Replay weather cache missing (${describeError(e)}) — using a live Open-Meteo call`, 'warn')
          }
        }
        const w = await J.fetchJourneyWeather(r, departAt, undefined, rp?.weather ?? 'auto', cached)
        patchJourney({ weather: ready(w, 'Open-Meteo (hourly + 15-minutely) at ETA', OPEN_METEO_URL, w.fetchedAt) }, gen)
      } catch (e) {
        const prev = store.get().journey.weather
        patchJourney({ weather: { ...failed(prev, e), error: J.isRateLimited(e) ? `${describeError(e)} — journey forecast unavailable until then` : describeError(e) } }, gen)
      }
    }, 800)
    return () => window.clearTimeout(timer)
  }, [jRoutes, jSelected, jDeparture, nonce])

  // ---- Replay bootstrap (?replay=<id>): fixed place, destination and departure from the fixture ----
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('replay')
    if (!id) return
    loadJourney()
      .then((J) => J.fetchReplayIndex())
      .then((list) => {
        const sc = list.find((x) => x.id === id)
        if (!sc) {
          toast(`Unknown replay "${id}"`, 'warn')
          return
        }
        const from = { name: sc.from.name, lngLat: { lng: sc.from.lng, lat: sc.from.lat }, source: 'search' as const }
        store.set((s) => ({
          replay: { ...sc, live: new URLSearchParams(window.location.search).get('live') === '1' },
          place: from,
          placeLabel: sc.from.name,
          focus: from.lngLat,
          journey: { ...s.journey, to: { name: sc.to.name, lngLat: { lng: sc.to.lng, lat: sc.to.lat }, source: 'search' }, departure: Date.parse(sc.departure), routes: { ...s.journey.routes, data: null, state: 'idle' }, weather: { ...s.journey.weather, data: null, state: 'idle' }, hazards: { ...s.journey.hazards, data: null, state: 'idle' }, road: { ...s.journey.road, data: null, state: 'idle' } },
          screen: 'trip',
        }))
      })
      .catch((e) => toast(`Replay index failed: ${describeError(e)}`, 'error'))
  }, [])

  // ---- Hazards: warnings / watches / outlooks intersected with the route at ETA ----
  const jWeather = useApp((s) => s.journey.weather.data)
  const replay = useApp((s) => s.replay)
  const hazardsRef = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  const runHazards = async (force = false) => {
    const s = store.get()
    const w = s.journey.weather.data
    const r = s.journey.routes.data?.routes[s.journey.selected]
    if (!w || !r) return
    const key = `${w.fetchedAt}:${s.replay?.id ?? 'live'}`
    if (!force && hazardsRef.current.key === key && Date.now() - hazardsRef.current.at < 2 * MIN) return
    hazardsRef.current = { key, at: Date.now() }
    const gen = s.journey.gen
    patchJourney({ hazards: loading(s.journey.hazards) })
    try {
      const { loadReplayHazards, evaluateHazards, statesForBBox, fetchNwsHazards, fetchWatches, fetchOutlooks, resolveZones } = await loadJourney()
      let report: HazardReport
      if (s.replay) {
        const { hazards, sources } = await loadReplayHazards(s.replay)
        report = evaluateHazards(w.samples, hazards, sources, { now: s.journey.departure ?? Date.now() })
      } else {
        let west = 180, south = 90, east = -180, north = -90
        for (const [x, y] of r.coords) {
          if (x < west) west = x
          if (x > east) east = x
          if (y < south) south = y
          if (y > north) north = y
        }
        const bbox = { west: west - 0.3, south: south - 0.3, east: east + 0.3, north: north + 0.3 }
        const states = statesForBBox(bbox)
        const sources: Record<'warnings' | 'watches' | 'outlooks', SourceStatus> = {
          warnings: { state: 'not-applicable', reason: 'route is outside the US' },
          watches: { state: 'not-applicable', reason: 'route is outside the US' },
          outlooks: { state: 'not-applicable', reason: 'route is outside the US' },
        }
        const hazards: Hazard[] = []
        if (states.length) {
          const [nws, watches, outlooks] = await Promise.allSettled([fetchNwsHazards(states), fetchWatches(), fetchOutlooks(bbox)])
          const now = Date.now()
          if (watches.status === 'fulfilled') {
            hazards.push(...watches.value)
            sources.watches = { state: 'ok', count: watches.value.length, fetchedAt: now }
          } else sources.watches = { state: 'unavailable', reason: describeError(watches.reason) }
          if (nws.status === 'fulfilled') {
            // IEM already gave SPC watch polygons; drop NWS's zone-based copies unless IEM failed.
            const list = watches.status === 'fulfilled' ? nws.value.filter((h) => !/^(Tornado|Severe Thunderstorm) Watch/.test(h.event)) : nws.value
            // Resolve zone geometry for county/zone-based products (capped).
            let zoneBudget = 60
            let zoneFailures = 0
            for (const h of list) {
              if (h.geometry || !h.zones?.length || zoneBudget <= 0) {
                hazards.push(h)
                continue
              }
              // A zone lookup that fails must not discard the whole check: keep the product without
              // geometry (the engine reports it as unresolved) and say so on the source line.
              try {
                const resolved = await resolveZones(h, Math.min(30, zoneBudget))
                hazards.push(resolved)
              } catch {
                zoneFailures++
                hazards.push(h)
              }
              zoneBudget -= Math.min(h.zones.length, 30)
            }
            sources.warnings = { state: 'ok', count: list.length, fetchedAt: now, ...(zoneFailures ? { note: `${zoneFailures} zone lookup${zoneFailures > 1 ? 's' : ''} failed — those products are listed as unresolved` } : {}) }
          } else sources.warnings = { state: 'unavailable', reason: describeError(nws.reason) }
          if (outlooks.status === 'fulfilled') {
            hazards.push(...outlooks.value)
            sources.outlooks = { state: 'ok', count: outlooks.value.length, fetchedAt: now }
          } else sources.outlooks = { state: 'unavailable', reason: describeError(outlooks.reason) }
        }
        report = evaluateHazards(w.samples, hazards, sources)
      }
      patchJourney({ hazards: ready(report, s.replay ? 'Replay fixture' : 'NWS alerts + SPC (IEM) + SPC outlooks', 'https://api.weather.gov/alerts', report.evaluatedAt) }, gen)
    } catch (e) {
      patchJourney({ hazards: failed(store.get().journey.hazards, e) }, gen)
    }
  }
  const runHazardsRef = useRef(runHazards)
  runHazardsRef.current = runHazards
  useEffect(() => {
    if (!jWeather) return
    void runHazardsRef.current(true)
  }, [jWeather, replay, nonce])
  // Alerts change quickly: re-check every 2 min while a live journey is open and the tab is visible.
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden && !store.get().replay && store.get().journey.weather.data) void runHazardsRef.current(true)
    }, 2 * MIN)
    return () => clearInterval(t)
  }, [])

  // ---- Road conditions: RWIS pavement sensors near the route ----
  const roadRef = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  const runRoad = async (force = false) => {
    const s = store.get()
    const w = s.journey.weather.data
    const r = s.journey.routes.data?.routes[s.journey.selected]
    if (!w || !r) return
    const key = `${w.fetchedAt}:${s.replay?.id ?? 'live'}`
    if (!force && roadRef.current.key === key && Date.now() - roadRef.current.at < 5 * MIN) return
    roadRef.current = { key, at: Date.now() }
    const gen = s.journey.gen
    patchJourney({ road: loading(s.journey.road) })
    try {
      const { evaluateRoadIce, parseRwisArchive, fetchRwisCurrent, statesForBBox } = await loadJourney()
      if (s.replay) {
        const sc = s.replay
        if (!sc.files.rwis || !sc.files.rwisStations) {
          patchJourney({ road: { ...ready(evaluateRoadIce(w.samples, [], { now: s.journey.departure ?? Date.now(), mode: 'replay' }), 'no RWIS archive in this fixture', ''), error: 'fixture has no RWIS archive' } }, gen)
          return
        }
        const [csv, meta] = await Promise.all([
          fetch(`/fixtures/${sc.fixture}/${sc.files.rwis}`).then((x) => x.text()),
          fetch(`/fixtures/${sc.fixture}/${sc.files.rwisStations}`).then((x) => x.json() as Promise<Record<string, { name: string; lng: number; lat: number }>>),
        ])
        const stations = parseRwisArchive(csv, Object.fromEntries(Object.entries(meta).map(([id, m]) => [id, { name: m.name, lngLat: { lng: m.lng, lat: m.lat } }])), 0)
        const report = evaluateRoadIce(w.samples, stations, { now: s.journey.departure ?? Date.now(), mode: 'replay' })
        patchJourney({ road: ready(report, 'IEM RWIS archive (replay)', 'https://mesonet.agron.iastate.edu/RWIS/', report.evaluatedAt) }, gen)
      } else {
        let west = 180, south = 90, east = -180, north = -90
        for (const [x, y] of r.coords) {
          if (x < west) west = x
          if (x > east) east = x
          if (y < south) south = y
          if (y > north) north = y
        }
        const states = statesForBBox({ west: west - 0.1, south: south - 0.1, east: east + 0.1, north: north + 0.1 })
        if (!states.length) {
          patchJourney({ road: { ...ready(evaluateRoadIce(w.samples, [], { now: Date.now(), mode: 'live' }), 'IEM RWIS', 'https://mesonet.agron.iastate.edu/RWIS/'), error: 'RWIS pavement sensors are US-only' } }, gen)
          return
        }
        const stations = await fetchRwisCurrent(states)
        const report = evaluateRoadIce(w.samples, stations, { now: Date.now(), mode: 'live' })
        patchJourney({ road: ready(report, `IEM RWIS (${states.map((x) => x + '_RWIS').join(', ')})`, 'https://mesonet.agron.iastate.edu/RWIS/', report.evaluatedAt) }, gen)
      }
    } catch (e) {
      patchJourney({ road: failed(store.get().journey.road, e) }, gen)
    }
  }
  const runRoadRef = useRef(runRoad)
  runRoadRef.current = runRoad
  useEffect(() => {
    if (!jWeather) return
    void runRoadRef.current(true)
  }, [jWeather, replay, nonce])
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden && !store.get().replay && store.get().journey.weather.data) void runRoadRef.current(true)
    }, 5 * MIN)
    return () => clearInterval(t)
  }, [])

  // ---- Rivers: loaded only while something shows gauges, cached per place ----
  // Full tier on the Rivers page; summary tier while the Now tile is on screen or the map's rivers
  // layer is visible; nothing otherwise — a place change by itself costs no gauge request.
  const screen = useApp((s) => s.screen)
  const morePage = useApp((s) => s.morePage)
  const riversTileVisible = useApp((s) => s.riversTileVisible)
  const wide = useWide()
  const riversNeed: RiversTier | null =
    screen === 'more' && morePage === 'rivers' ? 'full' : (screen === 'now' && riversTileVisible) || ((screen === 'map' || wide) && layers.rivers) ? 'summary' : null
  const riversCache = useRef(new Map<string, RiversCacheEntry>(loadSavedRivers()))
  const riversNonce = useRef(nonce)
  // A new place shows what is cached for it (or nothing) until something asks for gauges.
  useEffect(() => {
    const c = riversCache.current.get(placeKey)
    store.set({ rivers: c?.resource ?? emptyResource(), riversTier: c?.tier ?? null })
  }, [placeKey])
  usePolling(
    async () => {
      const at = place?.lngLat
      const need = riversNeed
      if (!at || !need) return
      if (riversNonce.current !== nonce) {
        riversNonce.current = nonce
        riversCache.current.clear()
      }
      const cached = riversCache.current.get(placeKey)
      const fresh = cached && Date.now() - cached.at < REFRESH.rivers
      if (fresh && (cached.tier === 'full' || need === 'summary')) {
        store.set({ rivers: cached.resource, riversTier: cached.tier })
        return
      }
      const prev = store.get().rivers
      setResource('rivers', loading(prev))
      if (!likelyUS(at)) {
        const resource = { ...ready([] as RiverGauge[], 'USGS / NOAA NWPS', NWPS_URL), error: 'River gauges (USGS/NOAA) are only available in the US' }
        riversCache.current.set(placeKey, { tier: 'full', at: Date.now(), resource, nwps: [] })
        store.set({ rivers: resource, riversTier: 'full' })
        return
      }
      try {
        // The full list waits on NOAA's per-gauge details and USGS (12–15 s on a slow day, Nov 6 audit): with
        // nothing to show yet, NOAA's gauges go up as soon as NOAA's list lands, then the full list replaces them.
        let nwpsList = fresh ? cached.nwps : undefined
        if (need === 'full' && !store.get().rivers.data?.length) {
          const first = await loadRivers(at, 'summary', nwpsList)
          nwpsList = first.nwps
          if (store.get().place?.lngLat === at && !store.get().rivers.data?.length) store.set({ rivers: { ...first.resource, state: 'loading' }, riversTier: 'summary' })
        }
        const { resource, nwps } = await loadRivers(at, need, nwpsList)
        riversCache.current.set(placeKey, { tier: need, at: Date.now(), resource, nwps })
        if (need === 'full') saveRivers(placeKey, riversCache.current.get(placeKey)!)
        if (store.get().place?.lngLat === at) store.set({ rivers: resource, riversTier: need })
      } catch (e) {
        setResource('rivers', failed(prev, e))
      }
    },
    REFRESH.rivers,
    !!place && !!riversNeed,
    [placeKey, riversNeed, nonce],
  )

  // ---- Station observations ----
  usePolling(
    async () => {
      const at = place?.lngLat
      if (!at) return
      const prev = store.get().station
      setResource('station', loading(prev))
      try {
        if (likelyUS(at)) {
          try {
            const obs = await fetchNwsNearestObservation(at)
            setResource('station', ready(obs, 'NOAA NWS (api.weather.gov)', NWS_URL, obs.observedAt))
            return
          } catch (e) {
            if (!(e instanceof OutsideNwsCoverage)) {
              // Real failure inside the US: fall back but tell the user.
              toast(`weather.gov unavailable (${describeError(e)}) — using Open-Meteo`, 'warn')
            }
          }
        }
        const obs = await fetchOpenMeteoCurrent(at)
        setResource('station', ready(obs, 'Open-Meteo (model, no station)', OPEN_METEO_URL, obs.observedAt))
      } catch (e) {
        setResource('station', failed(prev, e))
      }
    },
    REFRESH.station,
    // Replays drive the Trip page only: no station observation for the fixture's origin (a blocked or failed
    // NWS call would otherwise fall back to a live Open-Meteo call inside a "zero live calls" replay).
    !!place && !replayActive,
    [placeKey, nonce],
  )

  // ---- Place conditions (Now screen): one Open-Meteo location per place, every 10 min ----
  usePolling(
    async () => {
      if (!place) return
      const prev = store.get().conditions
      // A new place must not show the old place's numbers while loading.
      setResource('conditions', prev.data && haversine(prev.data.lngLat, place.lngLat) > 2000 ? { ...prev, data: null, state: 'loading', error: null } : loading(prev))
      try {
        const f = await fetchPlaceForecast(place.lngLat)
        setResource('conditions', ready(f, 'Open-Meteo (best match model)', OPEN_METEO_URL, f.current.time))
      } catch (e) {
        setResource('conditions', failed(store.get().conditions, e))
      }
    },
    REFRESH.conditions,
    // Replays drive the Trip page only (archived data): no live place conditions / alerts for them.
    !!place && !replayActive,
    [placeKey, nonce],
  )

  // ---- Active NWS alerts for the place: every 3 min while open; outside the US it says so ----
  usePolling(
    async () => {
      if (!place) return
      const prev = store.get().alerts
      if (!likelyUS(place.lngLat)) {
        setResource('alerts', ready({ alerts: [], coverage: 'outside-us' } as AlertsData, 'NOAA NWS alerts', `${NWS_URL}/alerts`))
        return
      }
      setResource('alerts', loading(prev))
      try {
        const a = await fetchActiveAlerts(place.lngLat)
        setResource('alerts', ready(a, 'NOAA NWS alerts (api.weather.gov)', `${NWS_URL}/alerts`))
      } catch (e) {
        setResource('alerts', failed(store.get().alerts, e))
      }
    },
    REFRESH.alerts,
    !!place && !replayActive,
    [placeKey, nonce],
  )

  // ---- EPA AirNow sites around the place (±0.3°, ≈ 33 km): the Now tab's measured air-quality lines. ----
  usePolling(
    async () => {
      if (!place) return
      const prev = store.get().monitorsNear
      setResource('monitorsNear', { ...prev, data: null, state: 'loading', error: null })
      try {
        const { lng, lat } = place.lngLat
        const r = await fetchMonitorSites({ west: lng - 0.3, south: lat - 0.3, east: lng + 0.3, north: lat + 0.3 })
        setResource('monitorsNear', ready(r, AIRNOW_CREDIT, '', r.fetchedAt))
      } catch (e) {
        setResource('monitorsNear', failed(store.get().monitorsNear, e))
      }
    },
    REFRESH.monitorsNear,
    !!place && !replayActive,
    [placeKey, nonce],
  )

  // ---- Staleness ticker: mark a resource stale once it's older than 2× its cadence ----
  useEffect(() => {
    const t = setInterval(() => {
      const s = store.get()
      const check = (k: 'radar' | 'satellite' | 'rivers' | 'station' | 'conditions' | 'alerts', cadence: number) => {
        const r = s[k]
        if (r.freshness && !r.stale && Date.now() - r.freshness.fetchedAt > cadence * 2) setResource(k, { ...r, stale: true })
      }
      check('radar', REFRESH.radar)
      check('satellite', REFRESH.satellite)
      check('rivers', REFRESH.rivers)
      check('conditions', REFRESH.conditions)
      check('alerts', REFRESH.alerts)
      check('station', REFRESH.station)
    }, 30_000)
    return () => clearInterval(t)
  }, [])

  return null
}
