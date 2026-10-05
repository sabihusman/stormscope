import { fetchJSON } from '../lib/fetch'
import type { LngLat } from '../lib/geo'

/**
 * Road Weather Information System (RWIS) pavement sensors, via the Iowa
 * Environmental Mesonet, which aggregates the state DOT networks (42 states)
 * from NOAA MADIS. Keyless, CORS-enabled.
 *   live:    https://mesonet.agron.iastate.edu/api/1/currents.json?network=IA_RWIS
 *   archive: https://mesonet.agron.iastate.edu/cgi-bin/request/rwis.py (CSV; replay fixtures)
 */
export const IEM_CURRENTS = 'https://mesonet.agron.iastate.edu/api/1/currents.json'

/** ice = frozen film reported (confirms) · watch = moisture at/below freezing, not a continuous ice film (possible only). */
export type PavementState = 'ice' | 'watch' | 'wet' | 'dry' | 'unknown'
export interface PavementObs {
  /** Observation time (ms). */
  time: number
  airF: number | null
  /** Pavement sensors: temperature (°F) + condition text, as reported. */
  sensors: { tempF: number | null; condition: string | null }[]
}
export interface RwisStation {
  id: string
  name: string
  network: string
  lngLat: LngLat
  /** Latest observation (live) or the full series (replay archive), newest last. */
  obs: PavementObs[]
}

/**
 * Map a DOT surface-status string to a coarse state. The vocabulary is the SCAN/ScanWeb
 * (Surface Systems → Vaisala) status table the state networks publish — Montana DOT's copy is
 * https://mdt.mt.gov/travinfo/atms-glossary.aspx and Iowa DOT reports the same strings via IEM:
 *   Ice Warning / Snow Warning / Snow-Ice Warning / Black Ice Warning — "continuous film of ice and
 *     water mixture at or below freezing (32 °F / 0 °C) with insufficient chemical to keep the
 *     mixture from freezing" → ice (can confirm)
 *   Frost — "moisture on pavement at or below freezing with a pavement temperature at or below the
 *     dew point temperature" → ice (can confirm); plain Ice / Icy / Snow / Snowy / Slush likewise
 *   Ice Watch / Snow Watch — "thin or spotty film of moisture at or below freezing" → watch
 *     (possible ice only; never confirms)
 *   Chemical Wet — "continuous film of water and ice mixture at or below freezing with enough
 *     chemical to keep the mixture from freezing" → wet (treated, not frozen)
 *   Wet / Damp / Trace Moisture / Moist / Dew — moisture above freezing → wet
 *   Dry → dry · Other / No Report / NA / blank → unknown (never "dry")
 */
export function pavementState(condition: string | null | undefined): PavementState {
  if (!condition) return 'unknown'
  const c = condition.toLowerCase().trim()
  if (/watch/.test(c)) return 'watch'
  if (/warning|frost|slush|\bice\b|\bicy\b|\bsnow\b|snowy/.test(c)) return 'ice'
  if (/wet|moist|damp|chemical|dew|absorption/.test(c)) return 'wet'
  if (/dry/.test(c)) return 'dry'
  return 'unknown'
}

/** Worst sensor on the station: ice > watch > wet > dry > unknown; returns the sensor used. */
export function worstSensor(o: PavementObs): { state: PavementState; tempF: number | null; condition: string | null } {
  const rank: Record<PavementState, number> = { ice: 4, watch: 3, wet: 2, dry: 1, unknown: 0 }
  let best: { state: PavementState; tempF: number | null; condition: string | null } = { state: 'unknown', tempF: null, condition: null }
  for (const s of o.sensors) {
    const st = pavementState(s.condition)
    if (rank[st] > rank[best.state] || (rank[st] === rank[best.state] && best.tempF == null && s.tempF != null)) best = { state: st, tempF: s.tempF, condition: s.condition }
  }
  // A temperature without any condition text is still worth showing.
  if (best.tempF == null) best.tempF = o.sensors.find((s) => s.tempF != null)?.tempF ?? null
  return best
}

interface IemCurrentRow {
  station: string
  name: string
  network: string
  utc_valid: string
  tmpf: number | null
  lon: number
  lat: number
  scond0?: string | null
  scond1?: string | null
  scond2?: string | null
  scond3?: string | null
  tsf0?: number | null
  tsf1?: number | null
  tsf2?: number | null
  tsf3?: number | null
}

/** Latest observation for every RWIS station in the given state networks. */
export async function fetchRwisCurrent(states: string[], signal?: AbortSignal): Promise<RwisStation[]> {
  const out: RwisStation[] = []
  await Promise.all(
    states.map(async (st) => {
      const net = `${st}_RWIS`
      let j: { data: IemCurrentRow[] }
      try {
        j = await fetchJSON<{ data: IemCurrentRow[] }>(`${IEM_CURRENTS}?network=${net}`, { signal, timeoutMs: 25_000 })
      } catch {
        return // state without an RWIS network on IEM
      }
      for (const r of j.data ?? []) {
        if (typeof r.lon !== 'number' || typeof r.lat !== 'number') continue
        out.push({
          id: r.station,
          name: r.name,
          network: net,
          lngLat: { lng: r.lon, lat: r.lat },
          obs: [
            {
              time: Date.parse(r.utc_valid),
              airF: r.tmpf ?? null,
              sensors: [0, 1, 2, 3].map((i) => ({ tempF: (r[`tsf${i}` as keyof IemCurrentRow] as number | null | undefined) ?? null, condition: (r[`scond${i}` as keyof IemCurrentRow] as string | null | undefined) ?? null })),
            },
          ],
        })
      }
    }),
  )
  return out
}

/**
 * Parse an IEM rwis.py CSV (station,obtime,tmpf,pcpn,tfs0,tfs0_text,tfs1,tfs1_text…).
 * `obtime` has no zone; pass the archive's zone offset (minutes east of UTC) so times become ms epoch.
 */
export function parseRwisArchive(csv: string, stations: Record<string, { name: string; lngLat: LngLat }>, tzOffsetMin: number): RwisStation[] {
  const lines = csv.trim().split('\n')
  const header = lines[0].split(',')
  const col = (n: string) => header.indexOf(n)
  const iTime = col('obtime')
  const iAir = col('tmpf')
  const sensorCols: [number, number][] = []
  for (let i = 0; i < 4; i++) {
    const t = col(`tfs${i}`)
    const c = col(`tfs${i}_text`)
    if (t >= 0 || c >= 0) sensorCols.push([t, c])
  }
  const by = new Map<string, RwisStation>()
  for (const line of lines.slice(1)) {
    const f = line.split(',')
    const id = f[0]
    const meta = stations[id]
    if (!meta) continue
    const time = Date.parse(f[iTime].replace(' ', 'T') + 'Z') - tzOffsetMin * 60_000
    if (!Number.isFinite(time)) continue
    const num = (v: string | undefined) => (v == null || v === '' || v === 'M' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
    const txt = (v: string | undefined) => (v == null || v === '' || v === 'NA' || v === 'M' ? null : v)
    let st = by.get(id)
    if (!st) {
      st = { id, name: meta.name, network: 'archive', lngLat: meta.lngLat, obs: [] }
      by.set(id, st)
    }
    st.obs.push({ time, airF: num(f[iAir]), sensors: sensorCols.map(([t, c]) => ({ tempF: t >= 0 ? num(f[t]) : null, condition: c >= 0 ? txt(f[c]) : null })) })
  }
  for (const st of by.values()) st.obs.sort((a, b) => a.time - b.time)
  return [...by.values()]
}
