/**
 * Everything the journey pipeline needs (routing, forecast-at-ETA, hazards, pavement sensors),
 * re-exported so the data controller can `import()` it only when a journey exists. With the
 * matching manualChunks rule in vite.config.ts this keeps ~50 KB of JavaScript out of the entry
 * bundle that the first radar frame has to wait for.
 */
export { route } from '../api/routing'
export { fetchJourneyWeather, isRateLimited } from './journey'
export { fetchRwisCurrent, parseRwisArchive } from '../api/rwis'
export { evaluateRoadIce } from './roadIce'
export { fetchNwsHazards, fetchOutlooks, fetchReplayFile, fetchReplayIndex, fetchWatches, loadReplayHazards, resolveZones, statesForBBox } from '../api/hazards'
export { evaluateHazards } from './hazardEngine'

export type JourneyModules = typeof import('./journeyBundle')
let pending: Promise<JourneyModules> | null = null
/** Loads (once) and returns the journey modules. */
export const loadJourney = (): Promise<JourneyModules> => (pending ??= import('./journeyBundle'))
