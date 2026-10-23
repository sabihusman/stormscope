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
/**
 * Open-Meteo locations per UTC day the suites may consume. Sized for the release pass (`prod-suite --split`
 * + the mocked walkthrough + `perf-measure --live-tiles`), measured on the Oct 8 live ledger per suite with
 * the Now flood tile on demand: pwa 1, flows ≈ 60 (one location per place change + the Flood page's block
 * once), nonus ≈ 50 (place + its Flood page block), satellite 1 + 1, rivers 1, journey Philadelphia 73,
 * hazards 23, road 23, perf 0 → ≈ 235. A full live run of every suite (`--force` without `--split`) needs
 * ≈ 4 400 (Oct 8: 3 686 for 10 of 18 suites) and must set QA_OM_CAP deliberately.
 */
// Oct 9 split pass, measured: pwa 5, flows 105, nonus 51, satellite 1, rivers 1, journey 74, hazards 33, road 6
// (capped: its live section never ran) → 276. Cap 350 leaves room for road's live section (≈ 25).
export const QA_DAILY_CAP = Number(process.env.QA_OM_CAP ?? 350)

/** Requests per UTC day per host. Unlisted hosts get DEFAULT_CAP; our own origins are never counted. */
// Sized for ONE release pass (split suite + mocked walkthrough + perf with live tiles) with no retry
// allowance: a second run of anything that day is refused by design. Numbers are the Oct 8 live ledger per
// live suite, × ~1.3 because they are small. A full live run of every suite needs QA_CAPS set deliberately
// (Oct 7 sizing: Open-Meteo 120, NWPS 150, NWS 140, SPC 85, IEM 60, nominatim 40, NHD 30, RainViewer 50,
// GIBS 1 100, radar tiles 1 700, basemap 1 200, terrain 450 — and that run still blew NHD and terrain).
// Oct 9: the Oct 8 ledger had hazards and road skipped, so their rows below were guesses (NWS 1 each; measured 23
// and ≥ 12) and the split pass capped NWS, NWPS, nominatim and Open-Meteo in those two suites. Re-sized from the
// Oct 9 ledger (used + blocked per host, + ~25 %); a blocked NWS station call falls back to Open-Meteo, so one
// cap cascades into another.
export const HOST_CAPS = {
  'api.open-meteo.com': 60, // Oct 9: pwa 5 + flows 9 + nonus 3 + satellite 1 + rivers 1 + journey 4 + hazards 11 + road 6 (+7 blocked) = 47
  'archive-api.open-meteo.com': 5, // replays are cached; only re-recording calls this
  'historical-forecast-api.open-meteo.com': 5,
  'geocoding-api.open-meteo.com': 10, // (no longer used by the app's search; kept for probes)
  'photon.komoot.io': 15, // place search: flows 2 + journey 1 + search probes
  'api.waterdata.usgs.gov': 50, // rivers-check's Node-side comparisons 27 + 3 per Rivers page open (2 opens)
  'api.water.noaa.gov': 85, // Oct 9: pwa 3 + flows 24 + satellite 1 + rivers 21 + journey 1 + hazards 8 + road 2 (+5 blocked) = 65
  'api.weather.gov': 110, // Oct 9: pwa 14 + flows 23 + satellite 4 + rivers 4 + journey 7 + hazards 23 + road 12 = 87
  'alerts.weather.gov': 10,
  'mapservices.weather.noaa.gov': 45, // journey Philadelphia 18 + hazards 6 + road 6 = 30
  'mesonet.agron.iastate.edu': 40, // journey Philadelphia 18 + hazards 6 + road 3 = 27
  'valhalla1.openstreetmap.de': 10, // 3
  'router.project-osrm.org': 10,
  'nominatim.openstreetmap.org': 30, // Oct 9: pwa 4 + flows 4 + nonus 1 + satellite 2 + rivers 2 + journey 1 + hazards 5 + road 5 = 24
  'hydro.nationalmap.gov': 10, // flows 3 (Flood page) + nonus 1
  'gibs.earthdata.nasa.gov': 1000, // satellite ×2 ≈ 800
  'api.rainviewer.com': 20, // ≈ 12
  'tilecache.rainviewer.com': 300, // ≈ 170 incl. perf's live tiles
  'tiles.openfreemap.org': 600, // ≈ 400 incl. perf's live tiles
  's3.amazonaws.com': 150, // flows ≈ 60 (Flood page) + nonus ≈ 20
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
 * Call at the start of a suite; exits if the Open-Meteo cap is already reached, and warns about hosts at
 * cap. A suite whose name says it runs against the mock server ("(mock)", "APIs mocked") is never refused —
 * nothing it does reaches Open-Meteo. `{ openMeteo: false }` declares that the APP makes no Open-Meteo
 * calls in this suite: live, such a request is aborted and the run flagged; mocked, the mock's answer is
 * flagged the same way (so a wrong declaration cannot hide behind --mock).
 */
const declaredNoOpenMeteo = new Set()
const baseName = (scriptName) => scriptName.split(' ')[0]
export function assertBudget(scriptName, { openMeteo = true } = {}) {
  if (!openMeteo) declaredNoOpenMeteo.add(baseName(scriptName))
  const j = loadLedger()
  const mocked = /mock/i.test(scriptName)
  if (openMeteo && !mocked && j.used >= QA_DAILY_CAP) {
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
const isOpenMeteoData = (url) => /open-meteo\.com\/v1\/(forecast|archive|era5|air-quality)/.test(url)
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
    // Vercel's preview toolbar (vercel.live) is injected once the bypass cookie is set; its panel covered the
    // bottom nav on Oct 9 and every later tap timed out. Never loaded, never counted.
    if (host === 'vercel.live' || host.endsWith('.vercel.live')) return route.abort()
    if (own(host)) {
      if (host.endsWith('.vercel.app')) {
        // Protected preview deployments: Vercel's Protection Bypass for Automation headers, when provided,
        // and the toolbar opt-out on every request to the deployment.
        const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
        const headers = { ...req.headers(), 'x-vercel-skip-toolbar': '1' }
        if (secret) Object.assign(headers, { 'x-vercel-protection-bypass': secret, 'x-vercel-set-bypass-cookie': 'true' })
        return route.continue({ headers })
      }
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
