// Shared scaffolding for the mocked check scripts: the "mocked only" guard and arguments, the PASS / FAIL printer,
// and a polling wait. New scripts use it instead of copying the same block.
import { mkdirSync } from 'node:fs'
import { assertBudget } from './qa-budget.mjs'

/** Exits with SKIP unless --mock is given; returns the base URL and the shots directory (created). */
export function mockedOnly(scriptName, defaultOut) {
  const argv = process.argv.slice(2)
  if (!argv.includes('--mock')) {
    console.log(`SKIP  ${scriptName}: mocked only`)
    process.exit(3)
  }
  assertBudget(`${scriptName} (mock)`)
  const positional = argv.filter((a) => !a.startsWith('--'))
  const out = positional[1] || defaultOut
  mkdirSync(out, { recursive: true })
  return { base: positional[0] || 'http://localhost:4173/', out }
}

/** check(name, ok, evidence) prints one line; finish() prints the tally and exits 0 only when every check passed. */
export function checker() {
  const results = []
  const check = (name, ok, ev = '') => {
    results.push(!!ok)
    const evidence = typeof ev === 'string' ? ev : JSON.stringify(ev)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? '  — ' + evidence : ''}`)
  }
  const finish = () => {
    console.log(`${results.filter(Boolean).length}/${results.length} passed`)
    process.exit(results.every(Boolean) ? 0 : 1)
  }
  return { check, finish }
}

/** Polls fn in the page until it returns truthy (true) or the time runs out (false). */
export async function until(page, fn, ms = 30000, stepMs = 200) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const ok = await page.evaluate(fn).catch(() => false)
    if (ok) return true
    await page.waitForTimeout(stepMs)
  }
  return false
}

/** Text of an element's lines joined with " | " (for evidence strings). */
export const oneLine = (s) => String(s ?? '').replaceAll('\n', ' | ')
