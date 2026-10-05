// Minimal ESRI Shapefile (polygon/polyline/point) + DBF → GeoJSON converter, no dependencies.
// Used to turn SPC outlook archive shapefiles into replay fixtures.
// Usage: node scripts/shp2geojson.mjs <base-without-ext> [<base> ...]  → writes <base>.geojson
import { readFileSync, writeFileSync } from 'node:fs'

function readDbf(buf) {
  const n = buf.readUInt32LE(4)
  const headerLen = buf.readUInt16LE(8)
  const recLen = buf.readUInt16LE(10)
  const fields = []
  for (let o = 32; o < headerLen - 1; o += 32) {
    const name = buf.toString('ascii', o, o + 11).replace(/\0.*$/, '').trim()
    const type = String.fromCharCode(buf[o + 11])
    const len = buf[o + 16]
    fields.push({ name, type, len })
  }
  const rows = []
  for (let r = 0; r < n; r++) {
    const base = headerLen + r * recLen
    if (buf[base] === 0x2a) continue // deleted
    let p = base + 1
    const row = {}
    for (const f of fields) {
      const raw = buf.toString('latin1', p, p + f.len).trim()
      p += f.len
      row[f.name] = f.type === 'N' || f.type === 'F' ? (raw === '' ? null : Number(raw)) : raw
    }
    rows.push(row)
  }
  return rows
}

function readShp(buf) {
  const geoms = []
  let o = 100
  while (o + 8 <= buf.length) {
    const len = buf.readInt32BE(o + 4) * 2
    const c = o + 8
    const type = buf.readInt32LE(c)
    if (type === 0) geoms.push(null)
    else if (type === 1) geoms.push({ type: 'Point', coordinates: [buf.readDoubleLE(c + 4), buf.readDoubleLE(c + 12)] })
    else if (type === 3 || type === 5) {
      const numParts = buf.readInt32LE(c + 36)
      const numPoints = buf.readInt32LE(c + 40)
      const parts = []
      for (let i = 0; i < numParts; i++) parts.push(buf.readInt32LE(c + 44 + i * 4))
      const pts = []
      const pBase = c + 44 + numParts * 4
      for (let i = 0; i < numPoints; i++) pts.push([buf.readDoubleLE(pBase + i * 16), buf.readDoubleLE(pBase + i * 16 + 8)])
      const rings = parts.map((start, i) => pts.slice(start, i + 1 < parts.length ? parts[i + 1] : numPoints))
      if (type === 3) geoms.push(rings.length === 1 ? { type: 'LineString', coordinates: rings[0] } : { type: 'MultiLineString', coordinates: rings })
      else {
        // Shapefile rings: clockwise = outer, counter-clockwise = hole. Group holes with the preceding outer.
        const area = (r) => r.reduce((a, [x, y], i) => { const [x2, y2] = r[(i + 1) % r.length]; return a + (x2 - x) * (y2 + y) }, 0)
        const polys = []
        for (const r of rings) {
          if (area(r) > 0 || polys.length === 0) polys.push([r])
          else polys[polys.length - 1].push(r)
        }
        geoms.push(polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys })
      }
    } else geoms.push(null)
    o = c + len
  }
  return geoms
}

for (const base of process.argv.slice(2)) {
  const geoms = readShp(readFileSync(`${base}.shp`))
  const rows = readDbf(readFileSync(`${base}.dbf`))
  const features = geoms.map((geometry, i) => ({ type: 'Feature', geometry, properties: rows[i] ?? {} })).filter((f) => f.geometry)
  writeFileSync(`${base}.geojson`, JSON.stringify({ type: 'FeatureCollection', features }))
  console.log(`${base}.geojson: ${features.length} features; fields: ${Object.keys(rows[0] ?? {}).join(',')}`)
}
