// Runs the headless suites against one deployment — sequentially (one browser at a time on the
// shared home IP) and once per bundle: a second run for the same build is refused unless --force.
//
//   node scripts/prod-suite.mjs [base-url] [--force] [--only=road,hazards]
//
// The bundle is identified by the hashed entry script in index.html; runs are recorded in
// e2e-shots/.prod-runs.json with each suite's pass count.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { loadLedger, QA_DAILY_CAP } from './lib/qa-budget.mjs'

const args = process.argv.slice(2)
const force = args.includes('--force')
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',')
const BASE = (args.find((a) => !a.startsWith('--')) || 'https://stormscope-two.vercel.app/').replace(/\/?$/, '/')
const RUNS = 'e2e-shots/.prod-runs.json'
// One directory per run (bundle + start time), so a later run never overwrites this run's logs/screens.
const OUT = `e2e-shots/prod/${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}-${process.env.PROD_SUITE_TAG ?? 'run'}`
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
const prev = runs.find((r) => r.bundle === bundle && r.base === BASE && !r.only && !r.incomplete)
if (prev && !force && !only) {
  console.log(`SKIP  bundle ${bundle} at ${BASE} was already run on ${prev.at} (${prev.summary}). Use --force to repeat.`)
  process.exit(3)
}
// Don't start a full run that the Open-Meteo day budget can't finish (≈ 1 500 locations across the suites).
const ledger = loadLedger()
const NEED = 1500
if (!only && ledger.used + NEED > QA_DAILY_CAP) {
  console.log(`SKIP  QA Open-Meteo budget: ${ledger.used}/${QA_DAILY_CAP} locations used today, a full run needs ≈${NEED}. Run after 00:00 UTC, or --only=<suites> for the cheap ones.`)
  process.exit(3)
}

const SUITES = [
  { name: 'pwa', script: 'pwa-check.mjs' },
  { name: 'flows', script: 'flows-check.mjs' },
  { name: 'qa', script: 'qa.mjs' },
  { name: 'satellite-desktop', script: 'satellite-check.mjs' },
  { name: 'satellite-phone', script: 'satellite-check.mjs', env: { VIEWPORT: 'mobile' } },
  { name: 'blocks', script: 'blocks-check.mjs' },
  { name: 'zoom', script: 'zoom-check.mjs' },
  { name: 'fab', script: 'fab-check.mjs' },
  { name: 'sheet', script: 'sheet-check.mjs' },
  { name: 'boundary', script: 'boundary-check.mjs' },
  { name: 'follow', script: 'follow-check.mjs' },
  { name: 'rivers', script: 'rivers-check.mjs' },
  { name: 'journey-phl-bal', script: 'journey-check.mjs', env: { JOURNEY_SCENARIO: '0' } },
  { name: 'journey-ia', script: 'journey-check.mjs', env: { JOURNEY_SCENARIO: '1' } },
  { name: 'hazards', script: 'hazards-check.mjs' },
  { name: 'road', script: 'road-check.mjs' },
].filter((s) => !only || only.includes(s.name))

console.log(`prod-suite: ${BASE} bundle ${bundle} — ${SUITES.length} suites, sequential; logs in ${OUT}`)
const results = []
for (const s of SUITES) {
  const t0 = Date.now()
  const r = spawnSync('node', [`scripts/${s.script}`, BASE, `${OUT}/${s.name}`], { env: { ...process.env, ...(s.env ?? {}) }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  writeFileSync(`${OUT}/${s.name}.log`, out)
  const passed = out.match(/(\d+)\/(\d+) (?:checks )?passed/)
  const skipped = /^SKIP/m.test(out)
  const blocked = (out.match(/^BLOCK .*/gm) ?? []).join('; ')
  const status = skipped ? 'skip' : passed ? `${passed[1]}/${passed[2]}` : `crash (exit ${r.status})`
  const ok = !skipped && !!passed && passed[1] === passed[2] && !blocked
  results.push({ name: s.name, status, ok, blocked, secs: Math.round((Date.now() - t0) / 1000) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(18)} ${status.padEnd(8)} ${results.at(-1).secs}s${blocked ? '  ' + blocked : ''}`)
  for (const line of out.split('\n')) if (/^FAIL|^SKIP|traffic: BLOCKED/.test(line)) console.log('      ' + line)
}
const summary = `${results.filter((r) => r.ok).length}/${results.length} suites passed`
// A run cut short by the budget guard doesn't count as "done" for this bundle.
const incomplete = results.some((r) => r.status === 'skip')
runs.push({ bundle, base: BASE, at: new Date().toISOString(), only: only ?? null, incomplete, summary, results, logs: OUT })
writeFileSync(RUNS, JSON.stringify(runs, null, 1))
console.log(summary)
process.exit(results.every((r) => r.ok) ? 0 : 1)
