// Runs the headless suites against one deployment — sequentially (one browser at a time on the
// shared home IP) and once per bundle: a second run for the same build is refused unless --force.
//
//   node scripts/prod-suite.mjs [base-url] [--force] [--only=road,hazards] [--mock] [--split]
//
// --split is the release pass: suites whose checks need live data run live (pwa on the real deployment,
// flows' live latency, satellite's GIBS frames and tiles, rivers' USGS comparisons, journey Philadelphia's
// routing, hazards' and road's live NWS/SPC/RWIS sections, the non-US fallbacks) and every other suite
// runs against the mock server. Suites that load forecast blocks (> 250 Open-Meteo locations) are followed
// by a 60 s pause so two of them never land in the same minute (Open-Meteo allows 600 locations/min).
//
// The bundle is identified by the hashed entry script in index.html; runs are recorded in
// e2e-shots/.prod-runs.json with each suite's pass count. --mock passes --mock to every suite
// (APIs answered locally, zero live calls, nothing charged to the ledger); logs go under e2e-shots/mock/.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

// route.fetch() sends the request to the real host from Playwright's own network stack, where the traffic guard
// (which counts the page's requests) cannot see it: a mocked suite must never call it (Oct 31: summary-check did).
const usesRouteFetch = (text) => text.split(/\r?\n/).some((l) => !l.trim().startsWith('//') && /route\.fetch\s*\(/.test(l))
const fetchers = readdirSync('scripts').filter((f) => f.endsWith('.mjs') && f !== 'prod-suite.mjs').filter((f) => usesRouteFetch(readFileSync(`scripts/${f}`, 'utf8')))
if (fetchers.length) {
  console.log(`FAIL  route.fetch() in ${fetchers.join(', ')} — it makes live calls the traffic guard cannot see; rewrite the mock's answer instead (installMocks editForecast)`)
  process.exit(1)
}
import { loadLedger, QA_DAILY_CAP } from './lib/qa-budget.mjs'

const args = process.argv.slice(2)
const force = args.includes('--force')
const mock = args.includes('--mock')
const split = args.includes('--split')
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',')
const BASE = (args.find((a) => !a.startsWith('--')) || 'https://stormscope-two.vercel.app/').replace(/\/?$/, '/')
const RUNS = 'e2e-shots/.prod-runs.json'
// One directory per run (bundle + start time), so a later run never overwrites this run's logs/screens.
const OUT = `e2e-shots/${mock ? 'mock' : 'prod'}/${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}-${process.env.PROD_SUITE_TAG ?? 'run'}`
mkdirSync(OUT, { recursive: true })

// A protected preview needs Vercel's automation-bypass header (the suites add it to every request via the guard).
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
const head = await fetch(BASE, { headers: bypass ? { 'x-vercel-protection-bypass': bypass } : {} })
if (!head.ok) {
  console.log(`FAIL  ${BASE} answered ${head.status}${head.status === 401 || head.status === 403 || (head.redirected && /sso/.test(head.url)) ? ' — protected deployment; set VERCEL_AUTOMATION_BYPASS_SECRET' : ''}`)
  process.exit(1)
}
const html = await head.text()
const bundle = html.match(/assets\/index-([A-Za-z0-9_-]+)\.js/)?.[1] ?? 'unknown'
let runs = []
try {
  runs = JSON.parse(readFileSync(RUNS, 'utf8'))
} catch {
  /* first run */
}
const prev = runs.find((r) => r.bundle === bundle && r.base === BASE && !r.only && !r.incomplete && !r.mock)
if (prev && !force && !only && !mock) {
  console.log(`SKIP  bundle ${bundle} at ${BASE} was already run on ${prev.at} (${prev.summary}). Use --force to repeat.`)
  process.exit(3)
}
// Don't start a full run that the Open-Meteo day budget can't finish (≈ 2 200 locations across the 17 suites, Oct 7 measurement).
const ledger = loadLedger()
const NEED = 2200
if (!only && !mock && !split && ledger.used + NEED > QA_DAILY_CAP) {
  console.log(`SKIP  QA Open-Meteo budget: ${ledger.used}/${QA_DAILY_CAP} locations used today, a full run needs ≈${NEED}. Run after 00:00 UTC, or --only=<suites> for the cheap ones.`)
  process.exit(3)
}

// live: what this suite checks needs live data (see --split above); everything else is app logic the mock covers.
const SUITES = [
  { name: 'pwa', script: 'pwa-check.mjs', live: 'the service worker and caches of the real deployment' },
  { name: 'flows', script: 'flows-check.mjs', live: 'conditions within 15 s of a grant / an address on real latency' },
  { name: 'units', script: 'units-check.mjs' },
  { name: 'playbar', script: 'playbar-check.mjs' },
  { name: 'flood-tile', script: 'flood-tile-check.mjs' },
  { name: 'daily', script: 'daily-check.mjs' },
  { name: 'hourly', script: 'hourly-check.mjs' },
  { name: 'departure', script: 'departure-check.mjs' },
  { name: 'monitors', script: 'monitors-check.mjs' },
  { name: 'gauges', script: 'gauges-check.mjs' },
  { name: 'firstrun', script: 'firstrun-check.mjs' },
  { name: 'zoomchip', script: 'zoomchip-check.mjs' },
  { name: 'playlabel', script: 'playlabel-check.mjs' },
  { name: 'observed', script: 'observed-check.mjs' },
  { name: 'search', script: 'search-check.mjs' },
  { name: 'floodquick', script: 'floodquick-check.mjs' },
  { name: 'slowload', script: 'slowload-check.mjs' },
  { name: 'loadtime', script: 'loadtime-check.mjs' },
  { name: 'desktop', script: 'desktop-check.mjs' },
  { name: 'horizon', script: 'horizon-check.mjs' },
  { name: 'summary', script: 'summary-check.mjs' },
  { name: 'trust', script: 'trust-check.mjs' },
  { name: 'paths', script: 'paths-check.mjs' },
  { name: 'layout', script: 'layout-check.mjs' },
  { name: 'help', script: 'help-check.mjs' },
  { name: 'freshness', script: 'freshness-check.mjs' },
  { name: 'lite', script: 'lite-check.mjs' },
  { name: 'monitor-service', script: 'monitor-service-check.mjs' },
  { name: 'nowmap', script: 'nowmap-check.mjs' },
  { name: 'polish', script: 'polish-check.mjs' },
  { name: 'mapchrome', script: 'mapchrome-check.mjs' },
  { name: 'trip', script: 'trip-check.mjs' },
  { name: 'playback', script: 'playback-loop-diag.mjs', args: ['--headless', '--assert'] },
  { name: 'qa', script: 'qa.mjs' },
  { name: 'nonus', script: 'nonus-check.mjs', live: 'postcode search (Nominatim) and the outside-US fallbacks (NWS 404s)' },
  { name: 'satellite-desktop', script: 'satellite-check.mjs', live: 'GIBS frame listing and GOES tiles' },
  { name: 'satellite-phone', script: 'satellite-check.mjs', env: { VIEWPORT: 'mobile' } },
  { name: 'blocks', script: 'blocks-check.mjs' },
  { name: 'zoom', script: 'zoom-check.mjs' },
  { name: 'fab', script: 'fab-check.mjs' },
  { name: 'menu', script: 'menu-check.mjs' },
  { name: 'sheet', script: 'sheet-check.mjs' },
  { name: 'boundary', script: 'boundary-check.mjs' },
  { name: 'follow', script: 'follow-check.mjs' },
  { name: 'rivers', script: 'rivers-check.mjs', live: 'USGS medians old-vs-new path and the snapshot' },
  { name: 'journey-phl-bal', script: 'journey-check.mjs', env: { JOURNEY_SCENARIO: '0' }, live: 'live routing + forecast-at-ETA (no mocked bodies)' },
  { name: 'journey-ia', script: 'journey-check.mjs', env: { JOURNEY_SCENARIO: '1' } },
  { name: 'hazards', script: 'hazards-check.mjs', live: 'the live journey section (NWS / SPC / RWIS)' },
  { name: 'road', script: 'road-check.mjs', live: 'live I-80 RWIS stations' },
].filter((s) => !only || only.includes(s.name))
const isMocked = (s) => mock || (split && !s.live)
const HEAVY = 250 // Open-Meteo locations in one suite above which the next live suite waits a minute

console.log(`prod-suite: ${BASE} bundle ${bundle} — ${SUITES.length} suites, sequential${mock ? ', MOCKED (zero live calls)' : split ? `, SPLIT (live: ${SUITES.filter((s) => !isMocked(s)).map((s) => s.name).join(', ')}; the rest mocked)` : ''}; logs in ${OUT}`)
const results = []
let lastUsed = 0
for (const s of SUITES) {
  if (!isMocked(s) && lastUsed > HEAVY) {
    console.log(`      pacing: the previous suite used ${lastUsed} Open-Meteo locations — waiting 60 s before ${s.name}`)
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
  }
  const t0 = Date.now()
  const r = spawnSync('node', [`scripts/${s.script}`, BASE, `${OUT}/${s.name}`, ...(s.args ?? []), ...(isMocked(s) ? ['--mock'] : [])], { env: { ...process.env, ...(s.env ?? {}) }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  writeFileSync(`${OUT}/${s.name}.log`, out)
  lastUsed = isMocked(s) ? 0 : Number(out.match(/budget: this run used (\d+) Open-Meteo locations/)?.[1] ?? 0)
  const passed = out.match(/(\d+)\/(\d+) (?:checks )?passed/)
  const skipped = /^SKIP/m.test(out)
  const blocked = (out.match(/^BLOCK .*/gm) ?? []).join('; ')
  // A suite prints SKIP for a section it cannot run here (its live-only part under --mock, or the whole
  // suite). The checks that did run still count; a mock-only skip of a live-only suite is fine in a mocked
  // run (the dry run), and only a live run treats a skip as incomplete.
  const status = passed ? `${passed[1]}/${passed[2]}${skipped ? '+skip' : ''}` : skipped ? 'skip' : `crash (exit ${r.status})`
  const ok = !blocked && (passed ? passed[1] === passed[2] : skipped && mock)
  results.push({ name: s.name, status, ok, blocked, secs: Math.round((Date.now() - t0) / 1000) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(18)} ${status.padEnd(8)} ${results.at(-1).secs}s${split ? (isMocked(s) ? '  (mock)' : '  (live)') : ''}${blocked ? '  ' + blocked : ''}`)
  for (const line of out.split('\n')) if (/^FAIL|^SKIP|traffic: BLOCKED/.test(line)) console.log('      ' + line)
}
const summary = `${results.filter((r) => r.ok).length}/${results.length} suites passed`
// A run cut short by the budget guard doesn't count as "done" for this bundle.
const incomplete = !mock && results.some((r) => r.status === 'skip')
runs.push({ bundle, base: BASE, at: new Date().toISOString(), only: only ?? null, mock, split, incomplete, summary, results, logs: OUT })
writeFileSync(RUNS, JSON.stringify(runs, null, 1))
console.log(summary)
process.exit(results.every((r) => r.ok) ? 0 : 1)
