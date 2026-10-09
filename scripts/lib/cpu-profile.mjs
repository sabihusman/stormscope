// A CPU profile of a window of page time (Chromium only), summarised as self time per function so a
// long main-thread task can be named. startProfile(page) → stop() → { total, top, profile }.
export async function startProfile(page, { intervalUs = 250 } = {}) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: intervalUs })
  await cdp.send('Profiler.start')
  return async ({ top = 12 } = {}) => {
    const { profile } = await cdp.send('Profiler.stop')
    await cdp.detach().catch(() => {})
    return { ...summarise(profile, top), profile }
  }
}

export function summarise(profile, top = 12) {
  const self = new Map()
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i]
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0))
  }
  const byFn = new Map()
  let busy = 0
  for (const [id, us] of self) {
    const cf = nodes.get(id).callFrame
    if (cf.functionName === '(idle)') continue
    busy += us
    const url = cf.url ? cf.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 60) : ''
    const key = `${cf.functionName || '(anonymous)'}  ${url}${cf.lineNumber >= 0 ? ':' + (cf.lineNumber + 1) : ''}`
    byFn.set(key, (byFn.get(key) ?? 0) + us)
  }
  return { total: Math.round(busy / 1000), top: [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([fn, us]) => ({ fn, ms: Math.round(us / 100) / 10 })) }
}

export const formatTop = (top) => top.map((t) => `${t.fn.trim()} ${t.ms} ms`).join(' · ')
