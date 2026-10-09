// The mocked dry run of a deployed preview — the gate before any live pass (rule set Oct 9):
//   every suite mocked against the deployment URL (prod-suite --mock), the phone walkthrough mocked, and the
//   headed playback diag on phone + desktop (mocked) — through the traffic guard (bypass + toolbar opt-out),
//   with ZERO live calls: any request the guard charged to the ledger during the run turns the result red.
// Records {bundle, base, green} in e2e-shots/prod/.dry-runs.json; live-pass.mjs refuses to start without a
// green record for the deployed bundle.
//   node scripts/preview-dry-run.mjs <base-url>
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { loadLedger } from './lib/qa-budget.mjs'

const BASE = (process.argv[2] || '').replace(/\/?$/, '/')
export const RECORDS = 'e2e-shots/prod/.dry-runs.json'
export const readRecords = () => (existsSync(RECORDS) ? JSON.parse(readFileSync(RECORDS, 'utf8')) : [])

/** The hashed entry script of the deployment (the bundle id used by prod-suite and the build log). */
export async function bundleOf(base) {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  const headers = { 'x-vercel-skip-toolbar': '1', ...(secret ? { 'x-vercel-protection-bypass': secret } : {}) }
  const res = await fetch(base, { headers })
  if (!res.ok) throw new Error(`${base} answered ${res.status}${res.status === 401 ? ' (protected: set VERCEL_AUTOMATION_BYPASS_SECRET)' : ''}`)
  const html = await res.text()
  return html.match(/assets\/index-([A-Za-z0-9_-]+)\.js/)?.[1] ?? 'unknown'
}

if (process.argv[1] && /preview-dry-run\.mjs$/.test(process.argv[1])) {
  if (BASE === '/') {
    console.log('usage: node scripts/preview-dry-run.mjs <base-url>')
    process.exit(2)
  }
  const bundle = await bundleOf(BASE)
  const day = new Date().toISOString().slice(0, 10)
  const OUT = `e2e-shots/prod/dryrun-${day}-${bundle}`
  mkdirSync(OUT, { recursive: true })
  const before = loadLedger()
  const runsBefore = before.runs?.length ?? 0
  const steps = [
    { name: 'prod-suite-mock', args: ['scripts/prod-suite.mjs', BASE, '--mock'] },
    { name: 'walkthrough-phone-mock', args: ['scripts/walkthrough.mjs', BASE, `${OUT}/walkthrough`, '--viewport=phone', '--mock'] },
    { name: 'playback-phone', args: ['scripts/playback-loop-diag.mjs', BASE, '--viewport=phone', '--assert'] },
    { name: 'playback-desktop', args: ['scripts/playback-loop-diag.mjs', BASE, '--viewport=desktop', '--assert'] },
  ]
  const summary = { base: BASE, bundle, startedAt: new Date().toISOString(), steps: [] }
  console.log(`preview-dry-run: ${BASE} bundle ${bundle} — everything mocked, zero live calls expected; logs in ${OUT}`)
  for (const s of steps) {
    const fd = openSync(`${OUT}/${s.name}.log`, 'w')
    const t0 = Date.now()
    const r = spawnSync('node', s.args, { stdio: ['ignore', fd, fd], env: process.env })
    closeSync(fd)
    summary.steps.push({ name: s.name, exit: r.status, secs: Math.round((Date.now() - t0) / 1000) })
    console.log(`${r.status === 0 ? 'OK  ' : 'FAIL'} ${s.name} (exit ${r.status}, ${summary.steps.at(-1).secs}s) → ${OUT}/${s.name}.log`)
  }
  // Live calls: every run the guard recorded during the dry run must have charged nothing to any host.
  const after = loadLedger()
  const liveHosts = {}
  for (const run of (after.runs ?? []).slice(runsBefore)) for (const [h, n] of Object.entries({ ...run.hosts, ...run.blocked })) liveHosts[h] = (liveHosts[h] ?? 0) + n
  const live = Object.keys(liveHosts).length > 0
  const green = summary.steps.every((s) => s.exit === 0) && !live
  summary.finishedAt = new Date().toISOString()
  summary.liveHosts = liveHosts
  summary.green = green
  writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2))
  const records = readRecords().filter((r) => !(r.bundle === bundle && r.base === BASE))
  records.push({ bundle, base: BASE, at: summary.finishedAt, green, steps: summary.steps.map((s) => `${s.name}:${s.exit}`), liveHosts, logs: OUT })
  writeFileSync(RECORDS, JSON.stringify(records, null, 1))
  console.log(live ? `LIVE CALLS during the dry run: ${Object.entries(liveHosts).map(([h, n]) => `${h} ${n}`).join(', ')}` : 'live calls: none')
  console.log(green ? `GREEN  dry run of bundle ${bundle} — the live pass may start (after 00:00 UTC, on the user's message)` : `RED  dry run of bundle ${bundle} — no live pass on this build`)
  process.exit(green ? 0 : 1)
}
