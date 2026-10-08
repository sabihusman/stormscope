// Shared external-traffic guard for the headless suites.
//
// Everything these scripts fetch leaves the owner's home IP (shared with their phone and
// laptop), and most of the public APIs rate-limit per IP. Each run therefore
//   - counts every request per host (and Open-Meteo *locations*, which is what its quota counts),
//   - persists the counts in a per-UTC-day ledger (e2e-shots/.qa-budget.json),
//   - refuses to start when the Open-Meteo location budget is exhausted,
//   - aborts further requests to any host once its daily cap is reached, so a runaway suite
//     fails loudly instead of hammering the service,
//   - prints what the run used.
// Overrides: QA_OM_CAP=<locations/day>, QA_CAPS='{"api.waterdata.usgs.gov":0}' (0 = block).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

// Lets Playwright (Chromium) report and route requests made by the service worker as well;
// without it a production run's SW-handled fetches would be invisible to the counter.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= '1'

const DIR = 'e2e-shots'
const FILE = `${DIR}/.qa-budget.json`
const LEGACY = `${DIR}/.open-meteo-budget.json`

/**
 * Open-Meteo locations per UTC day the suites may consume (leaves ≥ 6 400 of the 10 000 for real use).
 * One full pass, measured Oct 7 (mocked batch, same code path as live): 17 suites 2 077 + the live-only
 * sections the mock skips (hazards 23, road 23, journey Philadelphia 73) + phone walkthrough 422 +
 * perf ≤ 637 (13 requests × 49) ≈ 3 250.
 */
export const QA_DAILY_CAP = Number(process.env.QA_OM_CAP ?? 3600)

/** Requests per UTC day per host. Unlisted hosts get DEFAULT_CAP; our own origins are never counted. */
// Sized for ONE full pass (17 suites + phone walkthrough + perf) with no retry allowance: a second run of
// anything that day is refused by design. API hosts: Oct 7 mocked batch of the lazy-rivers build (the
// guard counts mocked requests per host; the app makes the same calls live) plus the Oct 6 live counts of
// the sections the mock skips, × ~1.15. Tile hosts: Oct 5 live ledger × ~1.05 (the mock serves fewer
// glyph/sprite requests than the real style, so mocked tile counts under-report).
export const HOST_CAPS = {
  'api.open-meteo.com': 120, // 64 suites + 15 walkthrough + 13 perf + 5 live-only = 97
  'archive-api.open-meteo.com': 5, // replays are cached; only re-recording calls this
  'historical-forecast-api.open-meteo.com': 5,
  'geocoding-api.open-meteo.com': 10, // 6
  'api.waterdata.usgs.gov': 50, // rivers-check's Node-side comparisons 27 + 3 per Rivers page open (5 opens) = 42
  'api.water.noaa.gov': 150, // 1 per summary load, 21 per Rivers page open (first time per place): suites 99 + walkthrough 25 + perf 1 + rivers-check 1 = 126
  'api.weather.gov': 140, // 85 + 28 + 4 + 5 = 122 (alerts 1 + station 3 per place change; alerts refresh every 3 min)
  'alerts.weather.gov': 10,
  'mapservices.weather.noaa.gov': 85, // 24 + 18 + 30 live-only = 72
  'mesonet.agron.iastate.edu': 60, // 12 + 9 + 27 live-only = 48
  'valhalla1.openstreetmap.de': 10, // 6
  'router.project-osrm.org': 10,
  'nominatim.openstreetmap.org': 40, // 34
  'hydro.nationalmap.gov': 30, // 25
  'gibs.earthdata.nasa.gov': 1100, // mocked 844
  'api.rainviewer.com': 50, // 41
  'tilecache.rainviewer.com': 1700,
  'tiles.openfreemap.org': 1200,
  's3.amazonaws.com': 450, // mocked 353
  ...(process.env.QA_CAPS ? JSON.parse(process.env.QA_CAPS) : {}),
}
export const DEFAULT_CAP = 50
export const capFor = (host) => HOST_CAPS[host] ?? DEFAULT_CAP
const own = (host) => host === 'localhost' || host.startsWith('localhost:') || host.startsWith('127.0.0.1') || host.startsWith('[::1]') || host.endsWith('.vercel.app')

const today = () => new Date().toISOString().slice(0, 10)
export function loadLedger() {
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'))
    if (j.day === today()) return { used: 0, hosts: {}, blocked: {}, runs: [], ...j }
  } catch {
    /* no ledger yet */
  }
  // First run of the day: carry today's Open-Meteo count over from the older single-host ledger.
  let used = 0
  try {
    const o = JSON.parse(readFileSync(LEGACY, 'utf8'))
    if (o.day === today()) used = o.used
  } catch {
    /* none */
  }
  return { day: today(), used, hosts: {}, blocked: {}, runs: [] }
}
function save(j) {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(j, null, 1))
}

/**
 * Call at the start of a suite; exits if the Open-Meteo cap is already reached (unless the suite
 * declares `{ openMeteo: false }` — it makes no Open-Meteo calls, so only the per-host caps apply;
 * anything it does call is still counted), and warns about hosts at cap.
 */
const declaredNoOpenMeteo = new Set()
const baseName = (scriptName) => scriptName.split(' ')[0]
export function assertBudget(scriptName, { openMeteo = true } = {}) {
  if (!openMeteo) declaredNoOpenMeteo.add(baseName(scriptName))
  const j = loadLedger()
  if (openMeteo && j.used >= QA_DAILY_CAP) {
    console.log(`SKIP  ${scriptName}: QA Open-Meteo budget for ${j.day} exhausted (${j.used}/${QA_DAILY_CAP} locations). Set QA_OM_CAP to override.`)
    process.exit(3)
  }
  const full = Object.entries(j.hosts)
    .filter(([h, n]) => n >= capFor(h))
    .map(([h, n]) => `${h} ${n}/${capFor(h)}`)
  console.log(`budget: ${j.used}/${QA_DAILY_CAP} Open-Meteo locations used by QA today before this run${full.length ? `; hosts at their daily cap (requests will be blocked): ${full.join(', ')}` : ''}`)
}

/**
 * Attach to a Playwright page: counts every external request per host (plus Open-Meteo locations)
 * for the page's whole context, and aborts requests to a host once its daily cap is reached.
 * Returns finalize(), which records the run in the ledger and prints what it used.
 */
const isOpenMeteoData = (url) => /open-meteo\.com\/v1\/(forecast|archive|era5)/.test(url)
export function trackTraffic(page, scriptName) {
  const start = loadLedger()
  const hosts = {}
  const blocked = {}
  const warned = new Set()
  const noOpenMeteo = declaredNoOpenMeteo.has(baseName(scriptName))
  let used = 0
  // Requests the mock server answered locally (--mock runs): counted per host and printed, never
  // charged to the ledger — the same app code path makes them live, so they size the caps.
  const mocked = {}
  let mockedUsed = 0
  globalThis.__qaMockedRequest = (url) => {
    let host
    try {
      host = new URL(url).host
    } catch {
      return
    }
    if (own(host)) return
    mocked[host] = (mocked[host] ?? 0) + 1
    if (isOpenMeteoData(url)) {
      const m = url.match(/[?&]latitude=([^&]*)/)
      mockedUsed += m ? m[1].split(',').length : 1
      // A wrong "zero Open-Meteo calls" declaration must fail the mocked run too (live, the request is aborted).
      if (noOpenMeteo) {
        blocked[host] = (blocked[host] ?? 0) + 1
        if (!warned.has('om-declared')) {
          warned.add('om-declared')
          console.log(`BLOCK ${host}: ${scriptName} declared zero Open-Meteo calls but requested ${url.slice(0, 90)}… (answered by the mock; live it would be aborted)`)
        }
      }
    }
  }
  page.context().route('**/*', (route, req) => {
    const url = req.url()
    let host
    try {
      host = new URL(url).host
    } catch {
      return route.continue()
    }
    if (!/^https?:/.test(url)) return route.continue()
    if (own(host)) {
      // Protected preview deployments: Vercel's Protection Bypass for Automation headers, when provided.
      const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
      if (secret && host.endsWith('.vercel.app')) return route.continue({ headers: { ...req.headers(), 'x-vercel-protection-bypass': secret, 'x-vercel-set-bypass-cookie': 'true' } })
      return route.continue()
    }
    // A suite that declared "no Open-Meteo calls" gets none: the request is aborted and the run flagged.
    if (noOpenMeteo && isOpenMeteoData(url)) {
      blocked[host] = (blocked[host] ?? 0) + 1
      if (!warned.has('om-declared')) {
        warned.add('om-declared')
        console.log(`BLOCK ${host}: ${scriptName} declared zero Open-Meteo calls but requested ${url.slice(0, 90)}…`)
      }
      return route.abort('blockedbyclient')
    }
    const total = (start.hosts[host] ?? 0) + (hosts[host] ?? 0)
    if (total >= capFor(host)) {
      blocked[host] = (blocked[host] ?? 0) + 1
      if (!warned.has(host)) {
        warned.add(host)
        console.log(`BLOCK ${host}: daily QA cap ${capFor(host)} reached — further requests aborted`)
      }
      return route.abort('blockedbyclient')
    }
    hosts[host] = (hosts[host] ?? 0) + 1
    if (isOpenMeteoData(url)) {
      const m = url.match(/[?&]latitude=([^&]*)/)
      used += m ? m[1].split(',').length : 1
    }
    return route.continue()
  })
  // A suite that crashes before calling finalize() must still be charged: record on process exit.
  let recorded = false
  const finalize = () => {
    if (recorded) return
    recorded = true
    const j = loadLedger()
    j.used += used
    for (const [h, n] of Object.entries(hosts)) j.hosts[h] = (j.hosts[h] ?? 0) + n
    for (const [h, n] of Object.entries(blocked)) j.blocked[h] = (j.blocked[h] ?? 0) + n
    j.runs.push({ script: scriptName, used, hosts, blocked, at: new Date().toISOString() })
    save(j)
    const top = Object.entries(hosts)
      .sort((a, b) => b[1] - a[1])
      .map(([h, n]) => `${h} ${n}/${capFor(h)}`)
      .join(', ')
    console.log(`budget: this run used ${used} Open-Meteo locations; ${j.used}/${QA_DAILY_CAP} today`)
    console.log(`traffic: ${top || 'no external requests'}`)
    if (Object.keys(mocked).length)
      console.log(
        `traffic (mocked, answered locally, not charged): ${mockedUsed} Open-Meteo locations; ${Object.entries(mocked)
          .sort((a, b) => b[1] - a[1])
          .map(([h, n]) => `${h} ${n}`)
          .join(', ')}`,
      )
    if (Object.keys(blocked).length)
      console.log(
        `traffic: BLOCKED ${Object.entries(blocked)
          .map(([h, n]) => `${h} ×${n}`)
          .join(', ')} — results are not trustworthy; raise QA_CAPS deliberately or wait for tomorrow`,
      )
  }
  process.once('exit', () => {
    if (!recorded) {
      console.log(`budget: ${scriptName} ended without finalize() — recording its usage anyway`)
      finalize()
    }
  })
  return finalize
}

/** Requests a host may still make today (for suites that fetch from Node, outside Playwright). */
export const remaining = (host) => Math.max(0, capFor(host) - (loadLedger().hosts[host] ?? 0))

/**
 * fetch() for requests a suite makes from Node (outside Playwright): each call is charged to the
 * day's host count *before* it is sent and refused once the host's cap is reached — the ledger is
 * written per request, so an aborted run can't under-report.
 */
export async function guardedFetch(url, scriptName, init) {
  const host = new URL(url).host
  const j = loadLedger()
  const n = j.hosts[host] ?? 0
  if (n >= capFor(host)) throw new Error(`QA cap reached: ${host} ${n}/${capFor(host)} today — refusing ${url.slice(0, 100)}`)
  j.hosts[host] = n + 1
  let run = j.runs.find((r) => r.script === scriptName && r.node)
  if (!run) {
    run = { script: scriptName, used: 0, hosts: {}, blocked: {}, node: true, at: new Date().toISOString() }
    j.runs.push(run)
  }
  run.hosts[host] = (run.hosts[host] ?? 0) + 1
  save(j)
  return fetch(url, init)
}

/** Record requests made outside Playwright (Node fetches in a suite) against the day's host counts. */
export function recordExternal(hosts, scriptName) {
  const j = loadLedger()
  for (const [h, n] of Object.entries(hosts)) j.hosts[h] = (j.hosts[h] ?? 0) + n
  j.runs.push({ script: scriptName, used: 0, hosts, blocked: {}, at: new Date().toISOString() })
  save(j)
  console.log(`traffic (node): ${Object.entries(hosts).map(([h, n]) => `${h} ${n}/${capFor(h)}`).join(', ')}`)
}

/** Backwards-compatible name used by the suites. */
export const trackOpenMeteo = trackTraffic
