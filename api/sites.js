// StormScope monitor service — a Vercel function (Node runtime) in this project.
//   GET /api/sites?bbox=west,south,east,north
//   → { fetchedAt, credit, sites: [{ id, name, agency, lngLat, parameters, readings: [{ parameter, value, unit, aqi, time }] }] }
//
// The AirNow API key lives only in the AIRNOW_API_KEY environment variable (set in the Vercel project by its
// owner); it is never logged or returned. Without it the function answers 503 with a plain message.
//
// AirNow limits and guidelines followed: observations update once an hour and appear 10–30 min past the hour,
// the API FAQ asks users to cache hourly observations and caps calls per key per hour (data stops until the next
// hour once met) — so every answer carries `Cache-Control: s-maxage=600, stale-while-revalidate=1200` and the
// client snaps its bbox to a 0.25° grid, so Vercel's CDN serves repeats and AirNow sees at most one request per
// tile per 10 minutes; an in-memory cache per instance backs that up. The Data Exchange Guidelines (EPA, Aug
// 2025): data are preliminary, passed through unaltered, credited to the reporting agencies and EPA AirNow.
//
// Diagnostic parameters (not used by the app; no CDN or memory cache): `end=YYYY-MM-DDTHH` sets the end of the
// 3-hour window to that UTC hour (within the last 72 h) and `all=1` returns every reading in the window with
// the agency's raw hourly concentration (`raw`), so the service's hour labels can be matched against AirNow's
// hourly files.
import { CREDIT, mergeSiteList, parseBbox, parseEndHour, parseSiteList, quantizeBbox, sitesFromRecords, upstreamUrl } from './_lib/airnow.js'

const CACHE_MS = 10 * 60_000
const SITE_LIST_MS = 24 * 3_600_000
const SITE_LIST_URL = 'https://files.airnowtech.org/airnow/today/monitoring_site_locations.dat'
const cache = new Map() // bbox key → { at, body }
let siteList = { at: 0, rows: [] }

async function getSiteList() {
  if (Date.now() - siteList.at < SITE_LIST_MS && siteList.rows.length) return siteList.rows
  try {
    const r = await fetch(SITE_LIST_URL, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`site list ${r.status}`)
    siteList = { at: Date.now(), rows: parseSiteList(await r.text()) }
  } catch {
    // Keep whatever we had; the data query alone still gives the sites with readings.
  }
  return siteList.rows
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (req.method !== 'GET') {
    res.statusCode = 405
    return res.end(JSON.stringify({ error: 'GET only' }))
  }
  const key = process.env.AIRNOW_API_KEY
  if (!key) {
    res.statusCode = 503
    res.setHeader('Cache-Control', 'no-store')
    return res.end(JSON.stringify({ error: 'Monitor service not configured: AIRNOW_API_KEY is not set' }))
  }
  const params = new URL(req.url, 'http://x').searchParams
  const rawBbox = parseBbox(req.query?.bbox ?? params.get('bbox'))
  if (!rawBbox) {
    res.statusCode = 400
    res.setHeader('Cache-Control', 'no-store')
    return res.end(JSON.stringify({ error: 'bbox=west,south,east,north required (at most 8° × 6°)' }))
  }
  const bbox = quantizeBbox(rawBbox)
  const endParam = req.query?.end ?? params.get('end')
  const diag = !!endParam || (req.query?.all ?? params.get('all')) === '1'
  const end = endParam ? parseEndHour(endParam) : null
  if (endParam && end == null) {
    res.statusCode = 400
    res.setHeader('Cache-Control', 'no-store')
    return res.end(JSON.stringify({ error: 'end=YYYY-MM-DDTHH (a UTC hour within the last 72 h)' }))
  }
  const cacheKey = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`
  const hit = diag ? null : cache.get(cacheKey)
  res.setHeader('Cache-Control', diag ? 'no-store' : 'public, s-maxage=600, stale-while-revalidate=1200')
  if (hit && Date.now() - hit.at < CACHE_MS) {
    res.setHeader('X-Monitor-Cache', 'hit')
    return res.end(hit.body)
  }
  try {
    const [upstream, list] = await Promise.all([fetch(upstreamUrl(bbox, Date.now(), key, { end, raw: diag }), { signal: AbortSignal.timeout(20_000) }), getSiteList()])
    if (!upstream.ok) {
      res.statusCode = upstream.status === 429 ? 429 : 502
      res.setHeader('Cache-Control', 'no-store')
      return res.end(JSON.stringify({ error: `AirNow answered ${upstream.status}` }))
    }
    const records = await upstream.json()
    const sites = mergeSiteList(sitesFromRecords(Array.isArray(records) ? records : [], { all: diag }), list, bbox)
    const body = JSON.stringify({ fetchedAt: Date.now(), credit: CREDIT, bbox, ...(diag ? { window: { end: end ?? Math.floor(Date.now() / 3_600_000) * 3_600_000, hours: 3, raw: true } } : {}), sites })
    if (!diag) cache.set(cacheKey, { at: Date.now(), body })
    res.setHeader('X-Monitor-Cache', 'miss')
    return res.end(body)
  } catch (e) {
    res.statusCode = 502
    res.setHeader('Cache-Control', 'no-store')
    return res.end(JSON.stringify({ error: `AirNow request failed: ${e && e.name === 'TimeoutError' ? 'timeout' : 'network error'}` }))
  }
}
