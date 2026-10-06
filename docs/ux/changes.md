# What moves, what is removed or merged, and what breaks

## Moves

| Today | Proposed | Notes |
|---|---|---|
| Bottom sheet · Timeline tab | Map screen: one-line timeline bar (play, scrubber, time) | Same model/engine; layer switcher becomes the FAB's "Background/Overlay" choice |
| Bottom sheet · Journey tab | **Trip** destination (full page) + "Plan a trip" on Now | Panel code reused; sections re-ordered (hazards first) |
| Bottom sheet · Station tab | More → Station; one-line tile on Now | Place-bound (nearest station to the place, not the viewport) |
| Bottom sheet · Rivers tab | More → Rivers; "Rivers · 2 high" tile on Now | Place-bound; gauge popup becomes the details sheet |
| Bottom sheet · Flood tab | More → Flood risk; "Flood · elevated here" tile on Now | Computes for the place's cell regardless of zoom; needs a controller path to request a block by place |
| Bottom sheet · Sources tab | More → Sources, freshness & settings | Units + motion move here from the layer menu |
| Status-pill strip (freshness) | Card footers on Now; "updated" line per page | Offline pill → offline banner on Now |
| Map tap → rain / flood / gauge / station / point popups | One point chip + Details sheet | Popup content survives inside Details |
| 24 h rainfall popup text | Rain strip inside Details; "Rain next 24 h" line on Now | Same numbers (`a<h>`, `r<h>` properties) |
| "Use as my location" / "Set as destination" | "Use as my place" / "Trip here" in Details | Same store actions |
| Search bar (top) + Journey destination search | One search component with recents, used by the place picker and Trip | Geocode API unchanged |
| First-run prompt | Place picker with an explanation line | "Just show the map" → "Pick a point on the map" |
| Layer menu: units, legend toggle, 3D, move-corner | Layers only (+ 3D under point layers); units → Settings; legend chip stays; drag-to-corner stays, menu item removed | |

## Removed or merged

- Bottom sheet as a six-tab container (the component survives as the Map's Details sheet, with the Oct 5 gestures).
- "Just show the map" exit from the prompt.
- "Map point" coordinate headline; "my spot" / "Your location" / "Map point" vocabulary → **place**.
- Units toggle in two places → one (Settings).
- Open-Meteo budget text in the user UI → "Developer" disclosure.
- Ability to stack rain + flood + nowcast overlays at once (one forecast overlay at a time).

## New

- **Now** screen and its two data calls: Open-Meteo `current` + 48 h `hourly` for the place (temperature, apparent temperature, weather code, precipitation, probability, wind, gusts, humidity) and NWS `alerts/active?point=`. One location each; cached in the SW live-data cache like the rest.
- **Place picker** sheet (use my location / search with recents / pick on map) and a Map "pick mode" (crosshair + Done).
- Point chip on Map; Details sheet.
- Bottom nav (phone) / left rail + column (≥ 768 px).

## Tests and harness that break (and the replacement)

| Suite / script | Why it breaks | Replacement in Phase 2 |
|---|---|---|
| `sheet-check.mjs` (40 checks: tabs, ▼, drag, back) | The six-tab sheet no longer exists on the home screen | Re-targeted at the Map Details sheet (same gestures); tab checks become nav checks |
| `qa.mjs` (34 checks) | Steps use `getByRole('tab', {name: 'Timeline' …})`, "Full sheet" via ArrowUp, status pills, "Expand panel" | Rewritten around Now → Map → Trip → More; the 200 ms long-task bar stays |
| `boundary-check.mjs` | Uses tabs "Station"/"Rivers", "Collapse panel", `.sheet-body` | Panel boundary moves to More pages; same injections |
| `journey-check.mjs`, `hazards-check.mjs`, `road-check.mjs` | `getByRole('tab', {name:'Journey'})`, "Expand panel", `.sheet-body` scroll, "Change" | Trip page selectors; assertions on content unchanged |
| `rivers-check.mjs` | Rivers tab, gauge popup `.map-popup` | More → Rivers page + Details sheet |
| `satellite-check.mjs`, `follow-check.mjs` | Timeline tab, status-strip pills ("Showing map area") | Map timeline bar; follow chip on Map |
| `fab-check.mjs` | "Move to …" menu item removed; units item removed | Drag-to-corner checks stay; menu item checks dropped |
| `blocks-check.mjs`, `zoom-check.mjs`, `flood-stall-check.mjs` | Store-level; unaffected unless block loading by place changes `visibleBlocks` semantics | Add a "block for place" case |
| `walkthrough.mjs`, `perf-measure.mjs`, `webkit-profile.mjs` | Feature steps and interaction labels (tabs, sheet) | Steps re-mapped to the new nav; TTFR headline unchanged; add "time to first conditions" |
| `scripts/lib/mock-server.mjs` | No mock for Open-Meteo `current=` on the forecast endpoint, nor for `alerts/active?point=` | Extend: reshape the saved series into `current`/`hourly` for a point; synthesize alerts from the saved NWS bodies |
| `scripts/lib/qa-budget.mjs` caps | +1 Open-Meteo location and +1 NWS request per place change in every suite | Re-size for one pass after measuring |
| `ErrorBoundary` panel names, `LayerGuard` | Panel names change ("Panel" → page names) | Boundary tests follow |
| `public/fixtures` replays (`?replay=`) | Bootstrap sets `tab: 'journey'` and sheet modes | Bootstrap opens Trip |
| New flow tests (your list) | — | `now-check.mjs`: conditions ≤ N s after grant / address; `map-tap-check.mjs`: chip not dialog; `picker-check.mjs`: every place-bound page has a working picker; `nav-check.mjs`: Trip ≤ 1 tap from Now |

## Risk notes

- **Traffic**: +2 requests per place change (Open-Meteo 1 location, NWS 1). Negligible for users; the QA caps need re-sizing once the suites are rewritten.
- **Service worker cache**: two new URL patterns must be added to the live-data cache regex, otherwise the first offline Now is empty.
- **Store shape**: `sheet`/`tab` give way to `screen` + `details`; `savePlace`/`loadPlace` unchanged; `selection` becomes the chip model.
- **Perf**: Now adds a small static map; keep it a second MapLibre instance only on tablet/desktop (where it is the real map). On phone, use a cached radar snapshot image around the place to protect the first-radar-frame budget.
