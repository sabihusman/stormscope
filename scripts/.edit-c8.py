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

IMPORT = "import { allowLocation, openMap, openMore, openTrip, pageText, setLayers, setSheet, setUnits, sheetText, tripText, searchPlace, openNow } from './lib/ui.mjs'\n"

# ---------------- app tweaks the suites rely on
edit('src/components/Panels.tsx', [
("            <small className=\"muted cond-foot\">Indicative screening, not an official flood warning · computed {timeAgo(d!.computedAt, now)}</small>",
 "            <small className=\"muted cond-foot\">\n              Indicative screening, not an official flood warning · computed {timeAgo(d!.computedAt, now)}\n              {d!.drainageAvailable ? '' : ' · drainage not available here — terrain + rain only'}\n            </small>"),
])
edit('src/components/JourneyPanel.tsx', [
("        <button className=\"btn small ghost\" onClick={() => store.set({ pickerOpen: true })}>\n          Change\n        </button>", "        <button className=\"btn small ghost\" onClick={() => store.set({ pickerOpen: true })} aria-label=\"Change place\">\n          Change\n        </button>"),
])

# ---------------- every suite: 'Allow location' → the new prompt button, via the helper
for f in ['pwa-check','satellite-check','blocks-check','zoom-check','fab-check','sheet-check','boundary-check','follow-check','rivers-check','journey-check','hazards-check','road-check','walkthrough','perf-measure','flood-stall-check','dpr-check','webkit-profile']:
    p=f'scripts/{f}.mjs'; s,crlf=rd(p)
    s=s.replace("getByRole('button', { name: 'Allow location' })", "getByRole('button', { name: 'Use my location' }).first()")
    if "from './lib/ui.mjs'" not in s and f not in ('dpr-check','webkit-profile','flood-stall-check'):
        # insert after the last import line
        lines=s.split('\n'); last=max(i for i,l in enumerate(lines) if l.startswith('import '))
        lines.insert(last+1, IMPORT.rstrip('\n')); s='\n'.join(lines)
    wr(p,s,crlf)

# ---------------- pwa-check
edit('scripts/pwa-check.mjs', [
("  pills: [...document.querySelectorAll('.pill')].map((p) => p.textContent),\n  banner: document.body.innerText.includes('offline') || document.body.innerText.includes('Offline'),",
 "  pills: [...document.querySelectorAll('.now-card')].map((p) => p.className.split(' ').slice(-1)[0]),\n  banner: !!document.querySelector('.banner.offline') || document.body.innerText.includes('Offline'),"),
("check('Offline: the app says so (banner) and still shows its status pills', offline.banner && offline.pills.length > 0, offline.pills.join(' | '))",
 "check('Offline: the Now screen says so (banner) and still renders its cards', offline.banner && offline.pills.length > 0, offline.pills.join(' | '))"),
("await desk.getByRole('tab', { name: 'Station' }).click()\nawait desk.waitForTimeout(1000)\nconst side = await desk.evaluate(() => { const s = document.querySelector('.sheet'); return s ? s.getBoundingClientRect().width < window.innerWidth * 0.6 : false })\ncheck('Desktop: bottom sheet docks as a side card', side)",
 "await openMore(desk, 'Station observations')\nawait desk.waitForTimeout(1000)\nconst side = await desk.evaluate(() => { const s = document.querySelector('.screen'); const m = document.querySelector('.map-root'); return !!s && !!m && s.getBoundingClientRect().width < window.innerWidth * 0.6 && m.getBoundingClientRect().left >= s.getBoundingClientRect().right - 2 })\ncheck('Desktop: content column beside an always-visible map (rail + column + map)', side)"),
])

# ---------------- satellite-check
edit('scripts/satellite-check.mjs', [
("await page.waitForTimeout(4000)\nawait page.evaluate(() => window.__map.jumpTo({ zoom: 6 }))", "await page.waitForTimeout(4000)\nawait openMap(page)\nawait page.evaluate(() => window.__map.jumpTo({ zoom: 6 }))"),
("await page.getByRole('tab', { name: 'Timeline' }).click()\nawait page.getByRole('slider').focus()", "await setSheet(page, 'half')\nawait page.getByRole('slider').focus()"),
])

# ---------------- blocks-check / zoom-check: overlays set directly (rain + flood both derive from the grid)
edit('scripts/blocks-check.mjs', [
("await page.getByRole('button', { name: /layer menu/ }).click()\nawait page.getByRole('button', { name: 'Rainfall' }).click()\nawait page.getByRole('button', { name: 'Flood risk' }).click()\nawait page.getByRole('button', { name: /layer menu/ }).click()",
 "await openMap(page)\nawait setLayers(page, { rainfall: true, flood: true })"),
("await page.getByRole('tab', { name: 'Sources' }).click()\nawait page.waitForTimeout(500)\nconst src = await page.locator('.sheet-body').innerText()", "await openMore(page, 'Sources, freshness & settings')\nawait page.waitForTimeout(500)\nconst src = await pageText(page)\nawait openMap(page)"),
])
edit('scripts/zoom-check.mjs', [
("await p.getByRole('button', { name: /layer menu/ }).click()\nawait p.getByRole('button', { name: 'Rainfall' }).click()\nawait p.getByRole('button', { name: 'Flood risk' }).click()\nawait p.getByRole('button', { name: /layer menu/ }).click()",
 "await openMap(p)\nawait setLayers(p, { rainfall: true, flood: true })"),
])

# ---------------- fab-check: the menu "move" item is gone; drags cover every corner
edit('scripts/fab-check.mjs', [
("// Verifies the movable layer button (drag to corners, menu move, persistence) and grabs wind-tail shots at two zooms.", "// Verifies the movable layer button (drag to every corner, persistence) and grabs wind-tail shots at two zooms."),
("await page.waitForTimeout(6000)\n\nconst fab = ()", "await page.waitForTimeout(6000)\nawait openMap(page)\n\nconst fab = ()"),
("check('Drag did not open the menu', !(await page.locator('.fab-menu').isVisible()))\nconst legend = await page.locator('.legend').boundingBox()\ncheck('Legend moved below the button (no overlap)', legend.y >= b1.y + b1.height - 2, `legend y ${Math.round(legend.y)} vs fab bottom ${Math.round(b1.y + b1.height)}`)",
 "check('Drag did not open the menu', !(await page.locator('.fab-menu').isVisible()))\nconst legend = await page.locator('.legend-chip, .legend').first().boundingBox()\ncheck('Legend chip moved below the button (no overlap)', legend.y >= b1.y + b1.height - 2, `legend y ${Math.round(legend.y)} vs fab bottom ${Math.round(b1.y + b1.height)}`)"),
("await page.getByRole('button', { name: /Move this button/ }).click()\nawait page.waitForTimeout(300)\ncheck('Menu \"Move to …\" cycles to the next corner', (await corner()) === 'tr', await corner())\nawait page.screenshot({ path: `${OUT}/fab-top-right-menu.png` })",
 "await fab().click() // close the menu\nconst dragTo = async (x, y) => { const b = await box(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + (x - b.x) * (i / 10), b.y + (y - b.y) * (i / 10)); await page.mouse.up(); await page.waitForTimeout(400) }\nawait dragTo(350, 150)\ncheck('Drag to the top-right corner', (await corner()) === 'tr', await corner())\nawait page.screenshot({ path: `${OUT}/fab-top-right.png` })"),
("await page.getByRole('button', { name: /Move this button/ }).click() // → br\nawait page.getByRole('button', { name: /Move this button/ }).click() // → bl\nawait page.waitForTimeout(300)\ncheck('Cycle reaches bottom-left', (await corner()) === 'bl')",
 "await dragTo(350, 700)\ncheck('Drag to the bottom-right corner', (await corner()) === 'br', await corner())\nawait dragTo(40, 700)\ncheck('Drag to the bottom-left corner', (await corner()) === 'bl', await corner())"),
("await page.reload({ waitUntil: 'load' })\nawait page.waitForTimeout(3000)\ncheck('Corner persists across reload', (await corner()) === 'bl', await corner())",
 "await page.reload({ waitUntil: 'load' })\nawait page.waitForTimeout(3000)\nawait openMap(page)\ncheck('Corner persists across reload', (await corner()) === 'bl', await corner())"),
("await page.getByRole('button', { name: /layer menu/ }).click()\nawait page.getByRole('button', { name: 'Nowcast' }).click()\nawait page.getByRole('button', { name: /layer menu/ }).click()\nawait page.waitForTimeout(12000)",
 "await page.getByRole('button', { name: /layer menu/ }).click()\nawait page.getByRole('radio', { name: 'Next 2 h wind & cloud' }).click()\nawait page.getByRole('button', { name: /layer menu/ }).click()\nawait page.waitForTimeout(12000)"),
])

# ---------------- boundary-check
edit('scripts/boundary-check.mjs', [
("for (let i = 0; i < 40; i++) { await page.waitForTimeout(500); if (await page.evaluate(() => !!window.__map?.loaded() && window.__store?.get().rivers.state === 'ready')) break }",
 "for (let i = 0; i < 40; i++) { await page.waitForTimeout(500); if (await page.evaluate(() => !!window.__map?.loaded() && window.__store?.get().rivers.state === 'ready')) break }\nawait openMap(page)"),
("const st = () => page.evaluate(() => { const s = window.__store.get(); return { layers: s.layers, errors: s.layerErrors, sheet: s.sheet, tab: s.tab, toast: s.toast?.text ?? null } })",
 "const st = () => page.evaluate(() => { const s = window.__store.get(); return { layers: s.layers, errors: s.layerErrors, sheet: s.sheet, screen: s.screen, morePage: s.morePage, toast: s.toast?.text ?? null } })"),
("await page.getByRole('button', { name: /layer menu/ }).click()\nawait page.getByRole('button', { name: 'Rainfall' }).click()\nawait page.waitForTimeout(1500)\nlet s = await st()",
 "await page.getByRole('button', { name: /layer menu/ }).click()\nawait page.getByRole('radio', { name: 'Rain next 24 h' }).click()\nawait page.waitForTimeout(1500)\nlet s = await st()"),
("check('Layer menu shows \"unavailable — reason\" for it', /Rainfall[\\s\\S]{0,40}unavailable — injected/.test(await page.locator('.fab-menu, .fab-stack').innerText().catch(() => '')) || (await page.getByText(/unavailable — injected/).count()) > 0)",
 "check('Layer menu shows \"unavailable — reason\" for it', /Rain next 24 h[\\s\\S]{0,40}unavailable — injected/.test(await page.locator('.fab-menu, .fab-stack').innerText().catch(() => '')) || (await page.getByText(/unavailable — injected/).count()) > 0)"),
("await page.getByRole('tab', { name: 'Station' }).click()\nawait page.waitForTimeout(400)\ns = await st()\ncheck('Bottom sheet tabs still work after a layer failure', s.tab === 'station' && s.sheet === 'half')\nawait page.getByRole('button', { name: 'Collapse panel' }).click()\nawait page.waitForTimeout(400)\ncheck('Sheet still collapses', (await st()).sheet === 'peek')",
 "await setSheet(page, 'half')\ns = await st()\ncheck('Map sheet still opens after a layer failure', s.sheet === 'half' && (await page.locator('.timeline').count()) === 1)\nawait page.getByRole('button', { name: 'Collapse panel' }).click()\nawait page.waitForTimeout(400)\ncheck('Sheet still collapses', (await st()).sheet === 'peek')"),
("await page.getByRole('button', { name: /layer menu/ }).click()\nawait page.getByRole('button', { name: 'Rainfall' }).click()\nawait page.getByRole('button', { name: /layer menu/ }).click()\nawait page.waitForTimeout(2500)",
 "await page.getByRole('button', { name: /layer menu/ }).click()\nawait page.getByRole('radio', { name: 'Rain next 24 h' }).click()\nawait page.getByRole('button', { name: /layer menu/ }).click()\nawait page.waitForTimeout(2500)"),
("await page.getByRole('tab', { name: 'Rivers' }).click()\nawait page.waitForTimeout(600)\nconst body = await page.locator('.sheet-body').innerText()",
 "await openMore(page, 'Rivers & gauges')\nawait page.waitForTimeout(600)\nconst body = await page.locator('.screen.more').innerText()"),
("check('Throwing panel shows \"unavailable — reason\" with Retry, instead of unmounting the app', /Rivers unavailable —/.test(body) && (await page.getByRole('button', { name: 'Retry' }).count()) === 1, body.split('\\n')[0])\nawait page.getByRole('tab', { name: 'Station' }).click()\nawait page.waitForTimeout(400)\ncheck('Other tabs still render after a panel failure', /Station|pressure|Pressure/i.test(await page.locator('.sheet-body').innerText()))",
 "check('Throwing panel shows \"unavailable — reason\" with Retry, instead of unmounting the app', /Rivers & gauges unavailable —/.test(body) && (await page.getByRole('button', { name: 'Retry' }).count()) === 1, body.split('\\n').find((l) => /unavailable/.test(l)))\nawait openMore(page, 'Station observations')\nawait page.waitForTimeout(400)\ncheck('Other pages still render after a panel failure', /Station|pressure|Pressure/i.test(await pageText(page)))"),
("await page.getByRole('tab', { name: 'Rivers' }).click()\nawait page.waitForTimeout(400)\ncheck('Panel recovers once its data is sane again', !/unavailable —/.test(await page.locator('.sheet-body').innerText()))\ncheck('Layer menu, search and legend still present', (await page.getByRole('button', { name: /layer menu/ }).count()) === 1 && (await page.getByRole('button', { name: 'Change location' }).count()) === 1 && (await page.locator('.legend, .legend-chip').count()) >= 1)",
 "await openMore(page, 'Rivers & gauges')\nawait page.waitForTimeout(400)\ncheck('Panel recovers once its data is sane again', !/unavailable —/.test(await page.locator('.screen.more').innerText()))\nawait openMap(page)\ncheck('Layer menu, place chip, nav and legend still present', (await page.getByRole('button', { name: /layer menu/ }).count()) === 1 && (await page.getByRole('button', { name: 'Change place' }).count()) >= 1 && (await page.locator('.legend, .legend-chip').count()) >= 1 && (await page.locator('.nav').count()) === 1)"),
])

# ---------------- follow-check: reference data is place-bound now; the map's follow mode is about blocks
s,crlf = rd('scripts/follow-check.mjs')
s = s.replace("// Verifies that the data window follows the map when panning, and snaps back on demand.",
"// Verifies the map's follow mode (the forecast window follows the map when panning, with a chip to come\n// back) while the reference views stay bound to the place — rivers and station must NOT change when you pan.")
s = s.replace("await page.waitForTimeout(7000)\nawait page.getByRole('tab', { name: 'Rivers' }).click()\nawait page.waitForTimeout(1500)\nconst before = await page.locator('.gauge-list li').first().innerText().catch(() => '')",
"await page.waitForTimeout(7000)\nawait openMore(page, 'Rivers & gauges')\nawait page.waitForTimeout(1500)\nconst before = await page.locator('.gauge-list li').first().innerText().catch(() => '')")
s = s.replace("// Pan ~150 km south-west to Baltimore.\nawait page.evaluate(() => window.__map.jumpTo({ center: [-76.6122, 39.2904], zoom: 10 }))\nawait page.waitForTimeout(9000)\nconst pill = await page.getByRole('button', { name: /Showing map area/ }).isVisible()\ncheck('Follow pill appears after panning away', pill)\nconst after = await page.locator('.gauge-list li').first().innerText().catch(() => '')\ncheck('River gauges refetched for the new area', after && after !== before && !/Schuylkill/.test(after), after.split('\\n')[0])\nawait page.getByRole('tab', { name: 'Station' }).click()\nawait page.waitForTimeout(3000)\nconst st = await page.locator('.sheet-body').innerText()\ncheck('Station now nearest to the map centre (Baltimore)', /Baltimore|BWI|Martin State/.test(st) && /map centre/.test(st), st.split('\\n')[0])",
"// Pan ~150 km south-west to Baltimore on the Map.\nawait openMap(page)\nawait page.evaluate(() => window.__map.jumpTo({ center: [-76.6122, 39.2904], zoom: 10 }))\nawait page.waitForTimeout(9000)\nconst pill = await page.getByRole('button', { name: /Showing map area/ }).isVisible()\ncheck('Follow chip appears on the map after panning away', pill)\nawait openMore(page, 'Rivers & gauges')\nawait page.waitForTimeout(800)\nconst after = await page.locator('.gauge-list li').first().innerText().catch(() => '')\ncheck('River gauges stay bound to the place (not the map centre)', after && after === before, after.split('\\n')[0])\nawait openMore(page, 'Station observations')\nawait page.waitForTimeout(1500)\nconst st = await pageText(page)\ncheck('Station stays the one nearest the place (Philadelphia)', /Philadelphia|PHL|Northeast Philadelphia/.test(st) && /your place/.test(st), st.split('\\n')[0])\nawait openMap(page)")
s = s.replace("await page.waitForTimeout(2500)\nconst st2 = await page.locator('.sheet-body').innerText()\ncheck('Continental zoom does not move the data window', /Baltimore|BWI|Martin State/.test(st2))",
"await page.waitForTimeout(2500)\nconst key2 = await page.evaluate(() => JSON.stringify(Object.values(window.__store?.get?.()?.focus ?? {})))\ncheck('Continental zoom does not move the data window', key1 === key2)")
s = s.replace("await page.waitForTimeout(6000)\nconst st3 = await page.locator('.sheet-body').innerText()\nconst center = await page.evaluate(() => window.__map.getCenter())\ncheck('\"Back to my spot\" recenters map and data', Math.abs(center.lat - 39.9526) < 0.05 && /Philadelphia/.test(st3), `${center.lat.toFixed(3)},${center.lng.toFixed(3)} · ${st3.split('\\n')[0]}`)",
"await page.waitForTimeout(6000)\nconst center = await page.evaluate(() => window.__map.getCenter())\nconst focus = await page.evaluate(() => window.__store.get().focus)\ncheck('\"Back to my place\" recenters the map and the data window', Math.abs(center.lat - 39.9526) < 0.05 && Math.abs(focus.lat - 39.9526) < 0.01, `${center.lat.toFixed(3)},${center.lng.toFixed(3)}`)")
s = s.replace("await page.getByRole('button', { name: 'Open layer menu' }).click()\nawait page.getByRole('button', { name: 'Nowcast' }).click()\nawait page.getByRole('button', { name: 'Close layer menu' }).click()\nawait page.getByRole('button', { name: 'Collapse panel' }).click()",
"await page.getByRole('button', { name: 'Open layer menu' }).click()\nawait page.getByRole('radio', { name: 'Next 2 h wind & cloud' }).click()\nawait page.getByRole('button', { name: 'Close layer menu' }).click()")
assert "getByRole('tab'" not in s and '.sheet-body' not in s, 'follow-check leftovers'
wr('scripts/follow-check.mjs', s, crlf)

# ---------------- rivers-check
edit('scripts/rivers-check.mjs', [
("await page.getByRole('tab', { name: 'Rivers' }).click()\nawait page.waitForTimeout(800)\nawait page.screenshot({ path: `${OUT}/rivers-iowa.png` })", "await openMore(page, 'Rivers & gauges')\nawait page.waitForTimeout(800)\nawait page.screenshot({ path: `${OUT}/rivers-iowa.png` })"),
])

# ---------------- journey / hazards / road: Trip page
edit('scripts/journey-check.mjs', [
("await page.waitForTimeout(5000)\nawait page.getByRole('tab', { name: 'Journey' }).click()\nawait page.waitForTimeout(500)", "await page.waitForTimeout(5000)\nawait openTrip(page)\nawait page.waitForTimeout(500)"),
("const text = await page.locator('.sheet-body').innerText()", "const text = await tripText(page)"),
("  `${text.match(/→ [^\\n]*/)?.[0] ?? ''} | ${text.match(/Arrive [^\\n]*\\n[^\\n]*/)?.[0]?.replace('\\n', ' ') ?? 'no arrival card'}`,", "  `${text.match(/To [^\\n]*/)?.[0] ?? ''} | ${text.match(/Arrive [^\\n]*\\n[^\\n]*/)?.[0]?.replace('\\n', ' ') ?? 'no arrival card'}`,"),
("await page.getByRole('button', { name: 'Collapse panel' }).click()\nawait page.waitForTimeout(1500)\nawait page.screenshot({ path: `${OUT}/journey-map.png` })", "await openMap(page)\nawait page.waitForTimeout(1500)\nawait page.screenshot({ path: `${OUT}/journey-map.png` })\nawait openTrip(page)"),
("await page.getByRole('button', { name: 'Expand panel' }).click()\nconst fetchedBefore", "const fetchedBefore"),
])
edit('scripts/hazards-check.mjs', [
("const panelText = () => page.locator('.sheet-body').innerText()", "const panelText = () => tripText(page)"),
("await page.waitForTimeout(4000)\nawait page.getByRole('tab', { name: 'Journey' }).click()\nawait page.getByRole('searchbox', { name: 'Destination' }).fill('Baltimore')", "await page.waitForTimeout(4000)\nawait openTrip(page)\nawait page.getByRole('searchbox', { name: 'Destination' }).fill('Baltimore')"),
])
edit('scripts/road-check.mjs', [
("const panelText = () => page.locator('.sheet-body').innerText()", "const panelText = () => tripText(page)"),
("await page.waitForTimeout(4000)\nawait page.getByRole('tab', { name: 'Journey' }).click()\nawait page.getByRole('searchbox', { name: 'Destination' }).fill('Iowa City')", "await page.waitForTimeout(4000)\nawait openTrip(page)\nawait page.getByRole('searchbox', { name: 'Destination' }).fill('Iowa City')"),
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
("await feature('journey: search + route + forecast', async () => { await tap(page.getByRole('tab', { name: 'Journey' })); await page.waitForTimeout(500);", "await feature('trip: search + route + forecast', async () => { await openTrip(page); await page.waitForTimeout(500);"),
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
