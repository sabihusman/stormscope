import { fetchJSON } from '../lib/fetch'
import type { LngLat } from '../lib/geo'

export interface GeoResult {
  name: string
  detail: string
  lngLat: LngLat
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] }
  properties: { name?: string; osm_key?: string; osm_value?: string; state?: string; county?: string; country?: string; countrycode?: string }
}
interface NomResult {
  display_name: string
  lat: string
  lon: string
  name?: string
  category?: string
  type?: string
  addresstype?: string
}

export const PHOTON_URL = 'https://photon.komoot.io/api/'
/** Biggest first: cities, then towns, then villages (Photon's own order within each). */
const PLACE_RANK: Record<string, number> = { city: 0, town: 1, village: 2 }
/** Case- and accent-insensitive comparison for "the same name as the query". */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()

/**
 * Place search: cities and towns only, biggest first — no hotels, businesses or street addresses.
 * Photon (komoot, OpenStreetMap) with a place filter: it is typo-tolerant ("Des Monies" → Des Moines), unlike the
 * Open-Meteo geocoder (which also matched towns by old alternate names: Willard OH for "Chicago"). A query with
 * digits is a postcode: Nominatim answers those, settlements only.
 */
export async function searchPlaces(q: string, signal?: AbortSignal): Promise<GeoResult[]> {
  const query = q.trim()
  if (!query) return []
  const looksLikePostcode = /\d/.test(query) && query.length <= 12
  if (looksLikePostcode) return searchPostcode(query, signal)
  const url = `${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=10&lang=en&osm_tag=place:city&osm_tag=place:town&osm_tag=place:village`
  const j = await fetchJSON<{ features?: PhotonFeature[] }>(url, { signal, timeoutMs: 8000 })
  // Ranking: places named exactly what was typed first (biggest first among them), then the other matches (biggest
  // first); Photon's place filter keeps unrelated kinds out. Every row shows its state or region and its country.
  const wanted = fold(query)
  const out: (GeoResult & { rank: number; exact: boolean })[] = []
  for (const f of j.features ?? []) {
    const p = f.properties
    if (!p.name || !f.geometry?.coordinates) continue
    const lngLat = { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }
    if (out.some((o) => o.name === p.name && Math.abs(o.lngLat.lat - lngLat.lat) < 0.02 && Math.abs(o.lngLat.lng - lngLat.lng) < 0.02)) continue
    out.push({ name: p.name, detail: [p.state ?? p.county, p.country].filter(Boolean).join(', '), lngLat, rank: PLACE_RANK[p.osm_value ?? ''] ?? 3, exact: fold(p.name) === wanted })
  }
  return out
    .sort((a, b) => Number(b.exact) - Number(a.exact) || a.rank - b.rank)
    .slice(0, 8)
    .map(({ rank: _rank, exact: _exact, ...r }) => r)
}

/** Postcodes via Nominatim: the postcode area or the settlement it belongs to, never a business or an address. */
async function searchPostcode(query: string, signal?: AbortSignal): Promise<GeoResult[]> {
  const j = await fetchJSON<NomResult[]>(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=6&addressdetails=0`, { signal, timeoutMs: 10_000, headers: { Accept: 'application/json' } }).catch(() => [] as NomResult[])
  const out: GeoResult[] = []
  for (const r of j) {
    if (r.category && !['place', 'boundary'].includes(r.category)) continue
    const parts = r.display_name.split(', ')
    const name = r.name || parts[0]
    const lngLat = { lng: parseFloat(r.lon), lat: parseFloat(r.lat) }
    if (out.some((o) => Math.abs(o.lngLat.lat - lngLat.lat) < 0.01 && Math.abs(o.lngLat.lng - lngLat.lng) < 0.01)) continue
    out.push({ name, detail: parts.slice(1, 4).join(', '), lngLat })
  }
  return out.slice(0, 8)
}

/** Reverse geocode for a friendly name on the location chip. */
export async function reverseGeocode(p: LngLat, signal?: AbortSignal): Promise<string | null> {
  try {
    const j = await fetchJSON<{ name?: string; display_name?: string; address?: Record<string, string> }>(
      `https://nominatim.openstreetmap.org/reverse?lat=${p.lat.toFixed(5)}&lon=${p.lng.toFixed(5)}&format=jsonv2&zoom=14`,
      { signal, timeoutMs: 8000 },
    )
    const a = j.address ?? {}
    const town = a.city || a.town || a.village || a.suburb || a.county || j.name
    const region = a.state || a.country
    return town ? (region ? `${town}, ${region}` : town) : (j.display_name?.split(', ').slice(0, 2).join(', ') ?? null)
  } catch {
    return null
  }
}
