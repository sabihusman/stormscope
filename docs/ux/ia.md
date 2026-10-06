# Proposed information architecture and navigation — conditions-first

Your starting proposal (Now / Map / Trip / More) holds up. I kept it and changed four things, each argued below: the place picker becomes one shared component, the Timeline stops being a destination, Rivers/Flood/Station become *cards on Now* as well as pages under More, and the map tap gets one consistent model. Wireframes: `wireframes.html` (PNG exports in `wireframes/`).

## Phone (390 px): four bottom destinations

```
Now ────────── Map ────────── Trip ────────── More
home: the      full-bleed     journey        reference & settings
answer for     map + layers   planner        ├─ Flood risk (for a place)
the place      + 1-line       (from = place  ├─ Rivers & gauges
               timeline       to = pick)     ├─ Station observations
                                             └─ Sources, freshness, settings
```

### Now (home)
Order is fixed and answers "what's the weather here, now and the next few hours":

1. **Place row** — `📍 Johnston, Iowa · Change`. "Change" opens the **place picker** (below). Place name is the resolved label, never coordinates.
2. **Active NWS alerts for this point** — first and red/amber if any; otherwise one explicit grey line "No active NWS alerts · checked 2 min ago". Tapping an alert opens its full text and the polygon on the Map. *New data: `api.weather.gov/alerts/active?point=lat,lng`, one call per place change, cached 5 min.*
3. **Current conditions card** — big temperature, condition text + icon, feels-like, wind (dir + speed, gusts if ≥ 25 mph), precipitation rate now, humidity. Footer: "Observed 12 min ago at Des Moines Intl (4.3 mi) · model now" — the card blends the nearest station observation (already fetched) with Open-Meteo *current* for the place. *New data: one Open-Meteo forecast call for the place with `current=` + `hourly=` (temperature, apparent temperature, weather code, precipitation, probability, wind, gusts) for 48 h. One location = one call; the existing block grid does not carry temperature.*
4. **Next 12 hours strip** — horizontally scrollable hour cells (time, icon, temp, precip amount or probability). A tail line "Rain next 24 h: 1.1 in › timeline" links to the Map with the Rainfall layer + timeline open at the place. This is where today's 24 h popup content goes.
5. **Map preview** — a small live map (radar, current frame, no interaction except tap) that opens Map. On tablet/desktop this *is* the map.
6. **Plan a trip** (primary button) + **reference tiles**: "Rivers · 2 high", "Flood · elevated here", "Station · 12 min ago". Each tile shows the one-line answer and opens the More page for the place.
7. Freshness lives in each card's footer; the status-pill strip and the bottom sheet are gone from Now.

Loading: skeleton in the shape of the answer, place row shows "Locating…". Error: each card shows its own "Unavailable — reason · Retry"; an offline banner at the top replaces the red pill. Target (test): current conditions visible ≤ 5 s after the grant or address entry on the 4G profile.

### Map
Full-bleed map with: place row (tap name → Now), **layer FAB** (layers only), **legend chip**, and a **one-line timeline bar** at the bottom (play, scrubber, time label) for whichever animated layer is active. No tabs, no bottom sheet by default.

Tap model (one rule): a tap anywhere shows a **point chip** above the nav: `🌧 66° · Light rain at this point · 0.4 in next 24 h · 2.1 mi from you · [Details]`. Conditions come from the nearest forecast cell / hourly grid (no extra request); the chip never covers the tapped point. Tapping a gauge, station or route sample still produces a chip, with that object's headline (stage, observation, ETA) in the chip and the generic point conditions inside Details. *Details* expands a half sheet: point conditions, the 24 h rain strip, flood risk at the point, actions **Use as my place · Trip here · Flood risk here**. Tap elsewhere / back collapses it. Nothing opens by itself.

Layer menu: "Background: Radar | Satellite | None", then "Forecast overlay: Rain next 24 h | Flood risk | Next 2 h wind & cloud | None" (one at a time — the all-on quilt in inventory 34 is no longer reachable), then point layers "River gauges", "Station", "3D terrain". Units and motion move to More → Settings; the legend keeps its own chip.

Follow mode (data follows the viewport) stays a map feature: the status pill becomes a small "Showing map area · Back to my place" chip on the Map only. Reference pages are bound to the place, not the viewport.

### Trip
The Journey panel as a full page, reached from the Trip tab or "Plan a trip" on Now (one tap from Now either way).

- **From** = current place (changeable through the same picker). **To** = search or "pick on map" (enters Map in pick mode with a crosshair and Done). Departure chips unchanged.
- Result order: **hazard summary first** (the tone line + the worst hit), arrival card, the along-the-way strip, an inline route map preview (opens Map with the route), then the sources (NWS/SPC/RWIS) and the road-sensor chips under disclosures. Trip-level road verdict chip ("Possible ice near Grinnell 4:10 PM") before sensor detail.
- Replay banner unchanged. Recent trips listed on the empty state.

### More
A list whose rows already answer something: "Flood risk — Elevated at Johnston", "Rivers — 2 of 14 gauges high", "Station — Des Moines Intl · 12 min ago", "Sources, freshness & settings". Each page starts with the **place row** and defaults to the current place.

- **Flood risk**: first line is the risk *at the place* with its reason (rain, low ground, distance to drainage), then the around-you cell counts, the map preview, horizon control, and the method text under "How this is scored". Computes for the place's cell regardless of map zoom (the controller requests that block explicitly).
- **Rivers**: list for the place sorted by risk then distance; tapping opens the gauge sheet (stage, category, trend) with "Show on map".
- **Station**: the existing observation panel, with the place row.
- **Sources & settings**: units, motion, data sources + freshness, Refresh all, attribution. The Open-Meteo budget text goes under a "Developer" disclosure.

### The one place picker
Every "Change" and every empty state uses the same sheet: **◎ Use my location · 🔍 Search (with recents) · 🗺 Pick a point on the map**. The first-run prompt is this picker with an explanation line; "Just show the map" is replaced by "Pick a point on the map" so every path ends with a place and Now is never empty. Denied/timeout flips the primary action to Search.

Vocabulary: one noun everywhere — **place** ("your place", "Back to my place", "Use as my place"). "Map point", "my spot", "Your location" go away.

## Tablet (≥ 768 px portrait) and desktop

- The bottom nav becomes a **left rail** (Now / Map / Trip / More).
- A **column** (380 px, scrollable) holds the current destination's content: Now cards, Trip, or a More page.
- The **map** fills the rest and is always visible, so the "map preview" card disappears (the map is right there) and the point chip / details sheet docks to the bottom of the map area.
- Desktop adds nothing structurally; widths grow (column 420 px) and the timeline bar sits under the map.

## What this does to the five complaints

| Complaint | Cause | Where it is fixed |
|---|---|---|
| No current weather after grant/address | home = map; no current/hourly fetch for the place | Now screen (cards 2–4), one Open-Meteo call + one NWS call per place |
| Map tap opens the 24 h rainfall dialog | tap answers with the topmost layer, as prose | point chip + Details sheet; 24 h content becomes a strip inside Details and the Now "Rain next 24 h" line |
| Journey buried in the sheet | six unrelated tabs in one sheet | Trip is a top-level destination and a primary button on Now |
| Flood asks for a location with no picker | panel driven by map zoom and layer toggle, not the place | More → Flood takes the place; picker everywhere; computes for the place's cell |
| Logical inconsistencies | viewport-bound reference views, four names for "place", settings in the layer menu, five tap popups | place-bound pages, one noun, layers-only menu, one tap model |

## Open questions for you (decide before Phase 2)

1. **Alerts source and cap.** `alerts/active?point=` is one NWS request per place change. The QA cap for api.weather.gov is 100/day; the suites would add roughly 20. Fine, or raise that cap deliberately?
2. **Current conditions blend.** Show the station observation as the headline when it is < 30 min old and < 10 mi away, otherwise the model "now"? (Proposed yes; the footer always says which.)
3. **Timeline on Now.** The "Rain next 24 h" line links to the Map's timeline. Do you also want the scrubber itself on Now? (Proposed no: Now is static, Map animates.)
4. **Mutually exclusive forecast overlays** on the Map (rain / flood / nowcast one at a time). This removes the all-layers quilt but is a visible behaviour change from today.
5. **Replay fixtures**: keep `?replay=` as a Trip-page feature only (proposed), or also drive Now from the fixture's place and time?
