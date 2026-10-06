// Assembles docs/ux/phase1-report.html from inventory.json, audit.md, ia.md, changes.md and the
// wireframe PNGs. Pure file work, no network.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'

const md = (src) => {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>')
  const lines = src.split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre>${esc(buf.join('\n'))}</pre>`); continue }
    if (/^#{1,3} /.test(l)) { const n = l.match(/^#+/)[0].length; out.push(`<h${n + 1}>${inline(l.replace(/^#+ /, ''))}</h${n + 1}>`); i++; continue }
    if (/^\|/.test(l)) {
      const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++])
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()))
      const head = cells(rows[0]); const body = rows.slice(2).map(cells)
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue
    }
    if (/^(\d+\.|-) /.test(l)) { const ordered = /^\d/.test(l); const items = []; while (i < lines.length && /^(\d+\.|-) /.test(lines[i])) items.push(lines[i++].replace(/^(\d+\.|-) /, '')); out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`); continue }
    if (l.trim() === '') { i++; continue }
    const buf = []; while (i < lines.length && lines[i].trim() !== '' && !/^(#|\||```|- |\d+\. )/.test(lines[i])) buf.push(lines[i++])
    out.push(`<p>${inline(buf.join(' '))}</p>`)
  }
  return out.join('\n')
}

const inv = JSON.parse(readFileSync('docs/ux/inventory/inventory.json', 'utf8'))
const wire = readdirSync('docs/ux/wireframes').filter((f) => /^\d\d-.*\.png$/.test(f)).sort()
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>StormScope — UX Phase 1 (inventory, audit, IA, wireframes)</title>
<style>
body{margin:0;padding:24px 32px;font:14px/1.45 system-ui,sans-serif;color:#1f2937;background:#fff;max-width:1400px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:18px;margin:36px 0 10px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}h3{font-size:15px;margin:22px 0 6px}h4{font-size:13px;margin:16px 0 4px}
nav a{margin-right:14px}table{border-collapse:collapse;font-size:13px;margin:8px 0}th,td{border:1px solid #e5e7eb;padding:5px 8px;vertical-align:top;text-align:left}th{background:#f8fafc}
code{background:#f1f5f9;padding:1px 4px;border-radius:4px;font-size:12px}pre{background:#f8fafc;border:1px solid #e5e7eb;padding:8px;overflow:auto}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}.gallery figure{margin:0}.gallery img{width:100%;border:1px solid #cbd5e1;border-radius:8px}.gallery figcaption{font-size:12px;color:#4b5563;margin-top:4px}.gallery b{color:#111}
.wire img{max-width:100%;border:1px solid #e5e7eb;border-radius:8px;margin:6px 0 18px}.muted{color:#6b7280}
</style></head><body>
<h1>StormScope — UX redesign, Phase 1 (no code)</h1>
<p class="muted">Decision: conditions-first. Everything below is a proposal for approval. Captured ${inv.length} screens from the shipped bundle with mocked data (zero live calls) in headed Chrome at 390×844, DPR 2.</p>
<nav><a href="#inventory">1 · Screen inventory</a><a href="#audit">2 · Usability audit</a><a href="#ia">3 · IA &amp; navigation</a><a href="#wire">4 · Wireframes</a><a href="#changes">5 · Moves, removals, breakage</a></nav>
<h2 id="inventory">1 · Screen inventory (${inv.length})</h2>
<div class="gallery">${inv.map((s) => `<figure><a href="inventory/${s.file}"><img src="inventory/${s.file}" alt="${s.name}" loading="lazy"></a><figcaption><b>${s.file.slice(0, 2)}</b> ${s.what}<br><span class="muted">${s.how}</span></figcaption></figure>`).join('')}</div>
<h2 id="audit">2 · Usability audit</h2>${md(readFileSync('docs/ux/audit.md', 'utf8'))}
<h2 id="ia">3 · Information architecture &amp; navigation</h2>${md(readFileSync('docs/ux/ia.md', 'utf8'))}
<h2 id="wire">4 · Key flows as wireframes</h2><p class="muted">Source: <a href="wireframes.html">wireframes.html</a> (open for full size).</p><div class="wire">${wire.map((f) => `<h4>${f.replace(/^\d\d-/, '').replace(/\.png$/, '').replace(/-/g, ' ')}</h4><a href="wireframes/${f}"><img src="wireframes/${f}" alt="${f}" loading="lazy"></a>`).join('')}</div>
<h2 id="changes">5 · What moves, what is removed or merged, what breaks</h2>${md(readFileSync('docs/ux/changes.md', 'utf8'))}
</body></html>`
writeFileSync('docs/ux/phase1-report.html', html)
console.log(`docs/ux/phase1-report.html (${inv.length} screens, ${wire.length} wireframe flows)`)
