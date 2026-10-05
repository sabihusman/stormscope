import { fetchJSON } from '../lib/fetch'
import type { LngLat } from '../lib/geo'

export interface GeoResult {
  name: string
  detail: string
  lngLat: LngLat
}

interface OmGeo {
  results?: { name: string; latitude: number; longitude: number; country?: string; admin1?: string; admin2?: string }[]
}
interface NomResult {
  display_name: string
  lat: string
  lon: string
  name?: string
}

/**
 * Place search: Open-Meteo geocoding (fast, cities/towns) first; Nominatim
 * (OpenStreetMap) for postcodes, addresses and anything Open-Meteo misses.
 */
export async function searchPlaces(q: string, signal?: AbortSignal): Promise<GeoResult[]> {
  const query = q.trim()
  if (!query) return []
  const out: GeoResult[] = []
  const looksLikePostcode = /\d/.test(query) && query.length <= 12
  if (!looksLikePostcode) {
    try {
      const j = await fetchJSON<OmGeo>(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=en&format=json`,
        { signal, timeoutMs: 8000 },
      )
      for (const r of j.results ?? [])
        out.push({
          name: r.name,
          detail: [r.admin1, r.country].filter(Boolean).join(', '),
          lngLat: { lng: r.longitude, lat: r.latitude },
        })
    } catch {
      /* fall through to Nominatim */
    }
  }
  if (out.length < 3) {
    try {
      const j = await fetchJSON<NomResult[]>(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=6&addressdetails=0`,
        { signal, timeoutMs: 10_000, headers: { Accept: 'application/json' } },
      )
      for (const r of j) {
        const parts = r.display_name.split(', ')
        const name = r.name || parts[0]
        const lngLat = { lng: parseFloat(r.lon), lat: parseFloat(r.lat) }
        if (out.some((o) => Math.abs(o.lngLat.lat - lngLat.lat) < 0.01 && Math.abs(o.lngLat.lng - lngLat.lng) < 0.01)) continue
        out.push({ name, detail: parts.slice(1, 4).join(', '), lngLat })
      }
    } catch {
      /* both failed: return what we have */
    }
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
