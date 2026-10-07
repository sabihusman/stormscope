import io, re
def rd(p):
    s=io.open(p,encoding='utf-8',newline='').read(); return s.replace('\r\n','\n'), ('\r\n' in s)
def wr(p,s,crlf):
    io.open(p,'w',encoding='utf-8',newline='\r\n' if crlf else '\n').write(s)
def edit(p, pairs, must=True):
    s,crlf=rd(p)
    for old,new in pairs:
        if old not in s:
            if must: raise AssertionError((p, old[:80]))
            continue
        s=s.replace(old,new)
    wr(p,s,crlf)
def sub(p, pattern, repl, count=0):
    s,crlf=rd(p); s2=re.sub(pattern, repl, s, count=count)
    assert s2!=s, (p, pattern); wr(p,s2,crlf)

# ---------------- journey / hazards / road: Trip page
edit('scripts/journey-check.mjs', [
("const text = await page.locator('.sheet-body').innerText()", "const text = await tripText(page)"),
("  `${text.match(/→ [^\\n]*/)?.[0] ?? ''} | ${text.match(/Arrive [^\\n]*\\n[^\\n]*/)?.[0]?.replace('\\n', ' ') ?? 'no arrival card'}`,", "  `${text.match(/To [^\\n]*/)?.[0] ?? ''} | ${text.match(/Arrive [^\\n]*\\n[^\\n]*/)?.[0]?.replace('\\n', ' ') ?? 'no arrival card'}`,"),
("await page.getByRole('button', { name: 'Collapse panel' }).click()\nawait page.waitForTimeout(1500)\nawait page.screenshot({ path: `${OUT}/journey-map.png` })", "await openMap(page)\nawait page.waitForTimeout(1500)\nawait page.screenshot({ path: `${OUT}/journey-map.png` })\nawait openTrip(page)"),
("await page.getByRole('button', { name: 'Expand panel' }).click()\nconst fetchedBefore", "const fetchedBefore"),
])
edit('scripts/hazards-check.mjs', [
("const panelText = () => page.locator('.sheet-body').innerText()", "const panelText = () => tripText(page)"),
])
edit('scripts/road-check.mjs', [
("const panelText = () => page.locator('.sheet-body').innerText()", "const panelText = () => tripText(page)"),
])
# replay bootstraps open Trip already; any `panelText` call after a replay goto needs the Trip screen (it is)

# ---------------- sheet-check: the map sheet holds Timeline / point Details only
s,crlf = rd('scripts/sheet-check.mjs')
s = s.replace("// Phone bottom sheet: once expanded it must collapse again — by dragging the handle down, by\n// tapping the handle, by the ▼ button (which must be on screen), by dragging scrolled-to-top\n// content down, and by the browser back gesture — from every tab, with the content scrolled.",
"// The Map screen's sheet (timeline, or point details after a tap): once expanded it must collapse again —\n// by dragging the handle down, by tapping the handle, by the ▼ button (which must be on screen), by dragging\n// scrolled-to-top content down, and by the browser back gesture — for both contents.")
s = s.replace("await page.waitForTimeout(3000)\n\nconst st = () =>", "await page.waitForTimeout(3000)\nawait openMap(page)\nawait page.waitForTimeout(600)\n\nconst st = () =>")
s = s.replace("      tab: window.__store.get().tab,\n", "      content: window.__store.get().selection ? 'details' : 'timeline',\n")
s = s.replace("""/** Expand to full from peek: tap the tab (→ half), then drag the handle up (→ full); scroll the content if it can. */
const expandAndScroll = async (tabName) => {
  const trail = []
  await touchTap(page, await centre(page.getByRole('tab', { name: tabName })))
  await settle()
  trail.push(`tab→${(await st()).mode}`)""",
"""/** Put the wanted content in the sheet (timeline = no selection; details = a map tap), expand to full, scroll if it can. */
const select = async (content) => {
  if (content === 'details') {
    if (!(await st()).content.startsWith('details')) { await touchTap(page, { x: 195, y: 300 }); await settle() }
    const d = page.getByRole('button', { name: 'Details' })
    if (await d.count()) await touchTap(page, await centre(d))
  } else {
    await page.evaluate(() => window.__store.set({ selection: null, sheet: 'half' }))
  }
  await settle()
}
const expandAndScroll = async (content) => {
  const trail = []
  await select(content)
  trail.push(`${content}→${(await st()).mode}`)""")
s = s.replace("for (const t of ['Timeline', 'Journey', 'Station', 'Rivers', 'Flood', 'Sources']) {", "for (const t of ['timeline', 'details']) {")
s = s.replace("""// (e) browser / Android back gesture collapses instead of leaving the app
let s = await expandAndScroll('Journey')""", """// (e) browser / Android back gesture collapses instead of leaving the app
let s = await expandAndScroll('timeline')""")
s = s.replace("""// Tab switch while expanded keeps it usable: switch tabs, then collapse by handle tap.
s = await expandAndScroll('Station')
await touchTap(page, await centre(page.getByRole('tab', { name: 'Flood' })))
await settle()
await touchTap(page, await handle())
await settle()
s = await st()
check('After switching tabs while open, a handle tap still collapses', s.mode === 'peek' && s.tab === 'flood' && s.height === H0, `${s.mode} ${s.tab} ${s.height}px`)""",
"""// Content switch while expanded keeps it usable: details → back to timeline, then collapse by handle tap.
s = await expandAndScroll('details')
await touchTap(page, await centre(page.getByRole('button', { name: '‹ Timeline' })))
await settle()
await touchTap(page, await handle())
await settle()
s = await st()
check('After switching content while open, a handle tap still collapses', s.mode === 'peek' && s.content === 'timeline' && s.height === H0, `${s.mode} ${s.content} ${s.height}px`)""")
assert "getByRole('tab'" not in s, 'sheet-check leftovers'
wr('scripts/sheet-check.mjs', s, crlf)

# ---------------- perf-measure: interactions on the new nav; first-conditions metric
edit('scripts/perf-measure.mjs', [
("for (let i = 0; i < 60; i++) { await page.waitForTimeout(500); const p = await page.evaluate(() => ({ map: window.__perf.mapLoad, radar: !!window.__store?.get().radar.data })); if (p.map && window_firstRadar) break }",
 "let firstConditions = null\nfor (let i = 0; i < 60; i++) { await page.waitForTimeout(500); const p = await page.evaluate(() => ({ map: window.__perf.mapLoad, radar: !!window.__store?.get().radar.data, cond: window.__store?.get().conditions.state === 'ready' })); if (p.cond && firstConditions == null) firstConditions = Date.now() - t0; if (p.map && window_firstRadar && firstConditions != null) break }"),
("out.firstLoad = { navigationToLoadEventMs: navToLoad, timeToFirstMapMs: firstLoad.mapLoad, timeToFirstRadarFrameMs: window_firstRadar ? window_firstRadar - t0 : null, lcp: firstLoad.lcp }",
 "out.firstLoad = { navigationToLoadEventMs: navToLoad, timeToFirstConditionsMs: firstConditions, timeToFirstMapMs: firstLoad.mapLoad, timeToFirstRadarFrameMs: window_firstRadar ? window_firstRadar - t0 : null, lcp: firstLoad.lcp }"),
("await label('tab-switch')\nfor (const t of ['Station', 'Sources', 'Timeline']) { await touchTap(page, await centre(page.getByRole('tab', { name: t }))); await page.waitForTimeout(900) }",
 "await label('nav-switch')\nfor (const t of [/^More/, 'Trip', /^Now/, 'Map']) { await touchTap(page, await centre(page.getByRole('button', { name: t, exact: typeof t === 'string' }))); await page.waitForTimeout(900) }\nawait setSheet(page, 'half')"),
("await label('all-layers-nowcast')\nawait touchTap(page, await centre(page.getByRole('button', { name: /layer menu/ })))\nfor (const n of ['Rainfall', 'Flood risk', 'Nowcast']) { await touchTap(page, await centre(page.getByRole('button', { name: n }))); await page.waitForTimeout(300) }\nawait touchTap(page, await centre(page.getByRole('button', { name: /layer menu/ })))\nawait page.waitForTimeout(20000) // blocks load + nowcast\nawait touchTap(page, await centre(page.getByRole('tab', { name: 'Timeline' })))\nawait page.waitForTimeout(500)",
 "await label('nowcast-overlay')\nawait touchTap(page, await centre(page.getByRole('button', { name: /layer menu/ })))\nawait touchTap(page, await centre(page.getByRole('radio', { name: 'Next 2 h wind & cloud' })))\nawait page.waitForTimeout(300)\nawait touchTap(page, await centre(page.getByRole('button', { name: /layer menu/ })))\nawait page.waitForTimeout(20000) // blocks load + nowcast\nawait setSheet(page, 'half')\nawait page.waitForTimeout(500)"),
("await label('idle-all-layers')", "await label('idle-nowcast')"),
("await label('journey-open')\nawait touchTap(page, await centre(page.getByRole('tab', { name: 'Journey' })))", "await label('trip-open')\nawait touchTap(page, await centre(page.getByRole('button', { name: 'Trip', exact: true })))"),
])

# ---------------- walkthrough: the feature list on the new nav
s,crlf = rd('scripts/walkthrough.mjs')
rep = [
("await feature('station + rivers data', async () => {}, () => st(() => window.__store.get().station.state === 'ready' && window.__store.get().rivers.state === 'ready'))",
 "await feature('now: conditions + alerts + station + rivers', async () => {}, () => st(() => { const s = window.__store.get(); return s.conditions.state === 'ready' && s.alerts.state === 'ready' && s.station.state === 'ready' && s.rivers.state === 'ready' && !!document.querySelector('.cond-temp') }))"),
("  // ---------------- pan / zoom across tile levels\n  for (const z of [3, 5, 8, 11, 14]) {", "  // ---------------- pan / zoom across tile levels (on the Map screen)\n  await feature('open map', async () => { await openMap(page) }, () => st(() => window.__store.get().screen === 'map' && !!document.querySelector('.fab-main')))\n  for (const z of [3, 5, 8, 11, 14]) {"),
("await feature('radar play', async () => { await tap(page.getByRole('tab', { name: 'Timeline' })); await page.waitForTimeout(400);", "await feature('radar play', async () => { await setSheet(page, 'half'); await page.waitForTimeout(400);"),
("await feature('rainfall + flood layers', async () => { await openMenu(); await tap(page.getByRole('button', { name: 'Rainfall' })); await tap(page.getByRole('button', { name: 'Flood risk' })); await page.waitForTimeout(300); await openMenu() }",
 "await feature('rain overlay then flood overlay (one at a time)', async () => { await openMenu(); await tap(page.getByRole('radio', { name: 'Rain next 24 h' })); await page.waitForTimeout(300); await tap(page.getByRole('radio', { name: 'Flood risk' })); await page.waitForTimeout(300); await openMenu() }"),
("await feature('nowcast + wind particles playing', async () => { await openMenu(); await tap(page.getByRole('button', { name: 'Nowcast' })); await page.waitForTimeout(300); await openMenu(); await tap(page.getByRole('tab', { name: 'Timeline' }));",
 "await feature('nowcast + wind particles playing', async () => { await openMenu(); await tap(page.getByRole('radio', { name: 'Next 2 h wind & cloud' })); await page.waitForTimeout(300); await openMenu(); await setSheet(page, 'half');"),
("await feature('layers off again', async () => { await openMenu(); for (const n of ['Rainfall', 'Flood risk', 'Nowcast']) await tap(page.getByRole('button', { name: n })); await page.waitForTimeout(300); await openMenu() }",
 "await feature('overlay off again', async () => { await openMenu(); await tap(page.getByRole('radio', { name: 'Next 2 h wind & cloud' })); await page.waitForTimeout(300); await openMenu() }"),
("  // ---------------- rivers / station panels\n  await feature('rivers panel', async () => { await tap(page.getByRole('tab', { name: 'Rivers' })) }, () => st(() => (window.__store.get().rivers.data?.length ?? 0) > 0 && document.querySelector('.gauge-list') != null))\n  await feature('gauge popup', async () => { const g = page.locator('.gauge-row').first(); if (await g.count()) await tap(g) }, () => st(() => !!window.__store.get().selection))\n  await feature('station panel', async () => { await tap(page.getByRole('tab', { name: 'Station' })) }, () => st(() => window.__store.get().station.state === 'ready' && document.querySelector('.stat-grid') != null))",
 "  // ---------------- map tap → chip → details; More pages\n  await feature('map tap → point chip', async () => { await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' })); await tap(page.locator('.map-container')) }, () => st(() => !!window.__store.get().selection && !!document.querySelector('.point-chip') && !document.querySelector('[role=dialog]')))\n  await feature('point details', async () => { await tap(page.getByRole('button', { name: 'Details' })) }, () => st(() => window.__store.get().sheet !== 'peek' && !!document.querySelector('.point-details')))\n  await feature('details → dismiss', async () => { await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' })) }, () => st(() => !window.__store.get().selection))\n  await feature('more: rivers page', async () => { await openMore(page, 'Rivers & gauges') }, () => st(() => (window.__store.get().rivers.data?.length ?? 0) > 0 && document.querySelector('.gauge-list') != null))\n  await feature('more: station page', async () => { await openMore(page, 'Station observations') }, () => st(() => window.__store.get().station.state === 'ready' && document.querySelector('.stat-grid') != null))\n  await feature('more: flood page (for the place)', async () => { await openMore(page, 'Flood risk') }, () => st(() => !!document.querySelector('.flood-here')), { timeoutMs: 60000 })\n  await feature('back to map', async () => { await openMap(page) }, () => st(() => window.__store.get().screen === 'map'))"),
("  // ---------------- bottom sheet: every tab; collapse by drag, tap, ▼, swipe, back\n  for (const t of ['Timeline', 'Journey', 'Station', 'Rivers', 'Flood', 'Sources']) {\n    await feature(`sheet ${t}: open full + collapse (drag/tap/▼/swipe/back)`, async () => {\n      await tap(page.getByRole('tab', { name: t }))\n      await page.waitForTimeout(400)",
 "  // ---------------- map sheet: timeline and details; collapse by drag, tap, ▼, swipe, back\n  const showContent = async (t) => { if (t === 'details') { await page.evaluate(() => window.__store.set({ selection: null, sheet: 'peek' })); await tap(page.locator('.map-container')); await page.waitForTimeout(300); const d = page.getByRole('button', { name: 'Details' }); if (await d.count()) await tap(d) } else await page.evaluate(() => window.__store.set({ selection: null, sheet: 'half' })) }\n  for (const t of ['timeline', 'details']) {\n    await feature(`sheet ${t}: open full + collapse (drag/tap/▼/swipe/back)`, async () => {\n      await showContent(t)\n      await page.waitForTimeout(400)"),
("      const m1 = await sheetMode()\n      await tap(page.getByRole('tab', { name: t }))\n      await page.waitForTimeout(300)\n      await tap(page.locator('.sheet-handle'))\n      await page.waitForTimeout(300)\n      const m2 = await sheetMode()\n      await tap(page.getByRole('tab', { name: t }))\n      await page.waitForTimeout(300)\n      await tap(page.getByRole('button', { name: 'Collapse panel' }))\n      await page.waitForTimeout(300)\n      const m3 = await sheetMode()\n      await tap(page.getByRole('tab', { name: t }))\n      await page.waitForTimeout(300)",
 "      const m1 = await sheetMode()\n      await showContent(t)\n      await page.waitForTimeout(300)\n      await tap(page.locator('.sheet-handle'))\n      await page.waitForTimeout(300)\n      const m2 = await sheetMode()\n      await showContent(t)\n      await page.waitForTimeout(300)\n      await tap(page.getByRole('button', { name: 'Collapse panel' }))\n      await page.waitForTimeout(300)\n      const m3 = await sheetMode()\n      await showContent(t)\n      await page.waitForTimeout(300)"),
("await feature('journey: hazards + road chips rendered', async () => { await tap(page.getByRole('tab', { name: 'Journey' })) }", "await feature('trip: hazards + road chips rendered', async () => { await openTrip(page) }"),
("await feature('journey: clear', async () => { await tap(page.getByRole('button', { name: 'Change', exact: true })) }", "await feature('trip: clear', async () => { await tap(page.getByRole('button', { name: 'Change', exact: true })) }"),
]
for old,new in rep:
    assert old in s, ('walkthrough', old[:70]); s=s.replace(old,new,1)
s = s.replace("await feature('journey:", "await feature('trip:")
# the 429 context: Rivers tab → More page
s = s.replace("    await p2.getByRole('tab', { name: 'Rivers' }).click()", "    await openMore(p2, 'Rivers & gauges')")
s = s.replace("    text = await p2.locator('.sheet-body').innerText()", "    text = await p2.locator('.screen.more').innerText()")
s = s.replace("    const pills = await p2.evaluate(() => [...document.querySelectorAll('.pill')].map((p) => p.textContent))", "    const pills = await p2.evaluate(() => [...document.querySelectorAll('.now-card.err, .err-text')].map((p) => p.textContent))")
assert "getByRole('tab'" not in s, 'walkthrough leftovers: ' + s[s.index("getByRole('tab'")-120:s.index("getByRole('tab'")+60]
wr('scripts/walkthrough.mjs', s, crlf)

# ---------------- dpr-check / webkit-profile: Timeline tab → map sheet
for f in ['dpr-check', 'webkit-profile']:
    p=f'scripts/{f}.mjs'; s,crlf=rd(p)
    s = s.replace("await touchTap(page, await centre(page.getByRole('tab', { name: 'Timeline' })))", "await page.getByRole('button', { name: 'Map', exact: true }).click(); await page.waitForTimeout(600); await page.evaluate(() => window.__store.set({ sheet: 'half' }))")
    s = s.replace("await page.getByRole('tab', { name: 'Timeline' }).click()", "await page.getByRole('button', { name: 'Map', exact: true }).click(); await page.waitForTimeout(600); await page.evaluate(() => window.__store.set({ sheet: 'half' }))")
    wr(p,s,crlf)
print('ok')
