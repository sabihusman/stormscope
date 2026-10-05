/** Decode a Google-style encoded polyline. Valhalla uses precision 6, OSRM 5. */
export function decodePolyline(str: string, precision = 6): [number, number][] {
  const factor = 10 ** precision
  let i = 0
  let lat = 0
  let lng = 0
  const out: [number, number][] = []
  while (i < str.length) {
    let b: number
    let shift = 0
    let result = 0
    do {
      b = str.charCodeAt(i++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    lat += result & 1 ? ~(result >> 1) : result >> 1
    shift = 0
    result = 0
    do {
      b = str.charCodeAt(i++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    lng += result & 1 ? ~(result >> 1) : result >> 1
    out.push([lng / factor, lat / factor])
  }
  return out
}
