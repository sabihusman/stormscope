// One-shot live pass against a deployment, run once after the 00:00 UTC cap reset:
//   1. the headless suite in --split mode (live where live data is the point, mocks elsewhere)
//   2. one phone walkthrough against the deployment with the APIs mocked (layout and flows, no quota)
//   3. one headed perf measurement with live tiles and mocked APIs (first radar frame on live tiles,
//      main-thread tasks on a real GPU)
// Together ≈ 150 Open-Meteo locations instead of ≈ 5 600 for everything live.
// Logs and a summary land in e2e-shots/prod/live-<UTC day>/. Each step runs through the QA traffic
// guard; nothing is retried.
//
//   node scripts/live-pass.mjs [base-url]
import { spawnSync } from 'node:child_process'
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs'
const BASE = process.argv[2] || 'https://stormscope-two.vercel.app/'
const day = new Date().toISOString().slice(0, 10)
const OUT = `e2e-shots/prod/live-${day}`
mkdirSync(OUT, { recursive: true })
const steps = [
  { name: 'prod-suite', args: ['scripts/prod-suite.mjs', BASE, '--split'] },
  { name: 'walkthrough-phone', args: ['scripts/walkthrough.mjs', BASE, `${OUT}/walkthrough`, '--viewport=phone', '--mock'] },
  { name: 'perf-live-tiles', args: ['scripts/perf-measure.mjs', BASE, `${OUT}/perf`, '--headed', '--live-tiles', '--label=live-tiles'] },
]
const summary = { base: BASE, startedAt: new Date().toISOString(), steps: [] }
for (const s of steps) {
  const fd = openSync(`${OUT}/${s.name}.log`, 'w')
  const t0 = Date.now()
  const r = spawnSync('node', s.args, { stdio: ['ignore', fd, fd], env: process.env })
  closeSync(fd)
  summary.steps.push({ name: s.name, exit: r.status, secs: Math.round((Date.now() - t0) / 1000), at: new Date().toISOString() })
  writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2))
  console.log(`${r.status === 0 ? 'OK  ' : 'FAIL'} ${s.name} (exit ${r.status}, ${summary.steps.at(-1).secs}s) → ${OUT}/${s.name}.log`)
}
summary.finishedAt = new Date().toISOString()
writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2))
