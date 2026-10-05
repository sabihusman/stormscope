/**
 * Geodesic helpers. All distances are metres on the WGS84 sphere (R = 6371 km),
 * so results are latitude-aware and correct anywhere on Earth (including
 * across the antimeridian, which is handled by wrapping longitude deltas).
 */
export const EARTH_RADIUS_M = 6_371_008.8

export interface LngLat {
  lng: number
  lat: number
}
export interface BBox {
  west: number
  south: number
  east: number
  north: number
}

const D2R = Math.PI / 180
export const toRad = (d: number) => d * D2R
export const toDeg = (r: number) => r / D2R

/** Wrap a longitude difference into [-180, 180]. */
export function wrapDeltaLng(dLng: number): number {
  return ((((dLng + 180) % 360) + 360) % 360) - 180
}

/** Great-circle distance (haversine). */
export function haversine(a: LngLat, b: LngLat): number {
  const φ1 = toRad(a.lat)
  const φ2 = toRad(b.lat)
  const dφ = toRad(b.lat - a.lat)
  const dλ = toRad(wrapDeltaLng(b.lng - a.lng))
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** Initial bearing from a to b, degrees clockwise from north. */
export function bearing(a: LngLat, b: LngLat): number {
  const φ1 = toRad(a.lat)
  const φ2 = toRad(b.lat)
  const dλ = toRad(wrapDeltaLng(b.lng - a.lng))
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

/** Destination point given start, bearing (deg) and distance (m). */
export function destination(start: LngLat, bearingDeg: number, distM: number): LngLat {
  const δ = distM / EARTH_RADIUS_M
  const θ = toRad(bearingDeg)
  const φ1 = toRad(start.lat)
  const λ1 = toRad(start.lng)
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  const φ2 = Math.asin(sinφ2)
  const y = Math.sin(θ) * Math.sin(δ) * Math.cos(φ1)
  const x = Math.cos(δ) - Math.sin(φ1) * sinφ2
  const λ2 = λ1 + Math.atan2(y, x)
  return { lng: wrapDeltaLng(toDeg(λ2)), lat: toDeg(φ2) }
}

/** Bounding box of a circle of `radiusM` around `c`, latitude-aware. Clamped at the poles. */
export function bboxAround(c: LngLat, radiusM: number): BBox {
  const dLat = toDeg(radiusM / EARTH_RADIUS_M)
  const cosLat = Math.max(Math.cos(toRad(c.lat)), 1e-6)
  const dLng = toDeg(radiusM / (EARTH_RADIUS_M * cosLat))
  return {
    west: Math.max(-180, c.lng - dLng),
    east: Math.min(180, c.lng + dLng),
    south: Math.max(-89.9, c.lat - dLat),
    north: Math.min(89.9, c.lat + dLat),
  }
}

/** Metres per degree of longitude/latitude at a given latitude. */
export function metresPerDegree(lat: number): { lng: number; lat: number } {
  const perLat = (Math.PI / 180) * EARTH_RADIUS_M
  return { lat: perLat, lng: perLat * Math.max(Math.cos(toRad(lat)), 1e-6) }
}

// ---- Point → segment distance on the sphere ---------------------------------

type Vec3 = [number, number, number]
function toVec(p: LngLat): Vec3 {
  const φ = toRad(p.lat)
  const λ = toRad(p.lng)
  return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)]
}
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
function angleBetween(a: Vec3, b: Vec3): number {
  const c = cross(a, b)
  return Math.atan2(Math.hypot(c[0], c[1], c[2]), dot(a, b))
}

/**
 * Geodesic distance (m) from point p to the great-circle segment a–b.
 * Uses the 3D unit-vector formulation, so it is exact on the sphere regardless
 * of latitude or orientation (no flat-earth / equirectangular approximation).
 */
export function distancePointToSegment(p: LngLat, a: LngLat, b: LngLat): number {
  const P = toVec(p)
  const A = toVec(a)
  const B = toVec(b)
  const N = cross(A, B)
  const nLen = Math.hypot(N[0], N[1], N[2])
  if (nLen < 1e-12) return angleBetween(P, A) * EARTH_RADIUS_M // degenerate segment
  const n = norm(N)
  // Foot of the perpendicular from P onto the great circle through A and B.
  const F = norm([P[0] - dot(P, n) * n[0], P[1] - dot(P, n) * n[1], P[2] - dot(P, n) * n[2]])
  // Is F between A and B along the arc? Check it lies within both half-planes.
  const AB = angleBetween(A, B)
  const AF = angleBetween(A, F)
  const FB = angleBetween(F, B)
  if (AF + FB <= AB + 1e-9) return angleBetween(P, F) * EARTH_RADIUS_M
  return Math.min(angleBetween(P, A), angleBetween(P, B)) * EARTH_RADIUS_M
}

/** Minimum geodesic distance (m) from p to any segment of a polyline. */
export function distancePointToPolyline(p: LngLat, line: [number, number][]): number {
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const d = distancePointToSegment(
      p,
      { lng: line[i - 1][0], lat: line[i - 1][1] },
      { lng: line[i][0], lat: line[i][1] },
    )
    if (d < best) best = d
  }
  if (line.length === 1) best = haversine(p, { lng: line[0][0], lat: line[0][1] })
  return best
}

/** Slippy tile x/y for lng/lat at zoom. */
export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z
  const x = Math.floor(((lng + 180) / 360) * n)
  const latR = toRad(lat)
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n)
  return { x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) }
}

/** Fractional pixel position within the world at zoom z (256px tiles). */
export function lngLatToWorldPx(lng: number, lat: number, z: number): { px: number; py: number } {
  const n = 2 ** z * 256
  const latR = toRad(lat)
  return {
    px: ((lng + 180) / 360) * n,
    py: ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n,
  }
}

/** Point-in-bbox test. */
export function inBBox(p: LngLat, b: BBox): boolean {
  return p.lng >= b.west && p.lng <= b.east && p.lat >= b.south && p.lat <= b.north
}

export function formatDistance(m: number): string {
  if (!Number.isFinite(m)) return '—'
  if (m < 1000) return `${Math.round(m)} m`
  return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`
}
