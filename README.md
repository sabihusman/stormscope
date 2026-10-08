# StormScope

Mobile-first, installable (PWA) **conditions-first** weather app: the home screen answers "what's the weather here, now and in the next few hours" (active NWS alerts, current conditions, the next 12 hours) for your place; the map (live radar or satellite, expected rainfall, flood-risk screening, river gauges, station observations, a short-range nowcast, optional 3D terrain) is one tap away; **Trip** gives the forecast, official hazards and pavement-sensor ice reports along a route at the time you will actually be there.

Every data point in the app is real, shows its source, and carries an "updated X ago" timestamp. There is no mock or demo data; replays use archived products from the dates they describe.

**Live:** https://stormscope-two.vercel.app

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

```bash
npm run build        # type-check + production build (dist/) incl. service worker + manifest
npm run preview      # serve dist/ at http://localhost:4173 (needed to test the PWA/offline shell)
```

Other scripts: `npm run typecheck`, `npm run lint`, `npm run icons` (regenerates `public/icons/*.png`), and the test suites described in [Testing](#testing-headless-suites).

No API keys or environment variables are required: every service used is public and keyless.

## Screens

Four destinations (bottom nav on a phone; a left rail with a content column beside an always-visible map from 768 px):

| Screen | What it answers | Notes |
|---|---|---|
| **Now** (home) | the place name · active **NWS alerts** for that point (or an explicit "no active alerts" / "unavailable outside the US" line) · current conditions (Open-Meteo model headline; an "Observed X° at <station>, N min ago" line only when a real station reading is under 30 min old and within 10 miles) · next 12 h strip · "rain next 24 h · timeline ›" (opens the Map with the playback bar running) · a live window onto the map · **Plan a trip** · tiles for rivers ("N gauges, M high"), flood risk ("Low / Moderate / High at <place>"), station, settings | one Open-Meteo location + one NWS alerts request per place change; alerts refresh every 3 min while the app is open; the rivers and flood tiles fetch only while on screen |
| **Map** | the full map with the layer menu (background: radar / satellite / none; **one forecast overlay at a time**: rain next 24 h, flood risk, next 2 h wind & cloud; point layers; 3D), anchored to its ☰ button, and the **playback bar docked along the bottom edge of the map** (full map width, one row: ▶/❚❚ · time — "Now", "+1 h", "3:40 PM" · scrubber · 6/12/24/48 h ahead). One clock drives radar (or satellite) and the active forecast overlay together; on wide layouts the bar shows whichever section is open. Below forecast zoom it says "Zoom in to see the forecast" with a button that zooms to your place. **A tap anywhere shows a chip** with the conditions at that point (one cached Open-Meteo location) and *Details* opens the details sheet (24 h strip, actions); gauges, the station and route samples use the same chip. Nothing opens by itself. | the "Showing map area · back to my place" chip means the forecast blocks follow the map; reference data stays bound to the place |
| **Trip** | from = your place, to = search (with recents) or a point picked on the map; hazards first, then arrival, the along-the-way strip and the road sensors | reachable in one tap from Now |
| **More** | Flood risk (computed for the place's own block whatever the map shows), Rivers & gauges, Station observations, Sources / freshness / settings (units, motion) | every page starts with the place row |

**One place picker** sits behind every "Change" and every empty state, and is the first-run prompt: *use my location · search (with recents) · pick a point on the map* (a crosshair on the map with a confirm button). After a denial the primary action becomes Search; every path ends with a place, so Now is never empty.

## Deploying

Vercel project `stormscope`; the production alias is public, the per-deployment `*-sabihusman-4178s-projects.vercel.app` URLs sit behind Vercel's deployment protection. The project is a static Vite site; `vercel.json` sets the SPA rewrite and cache headers (`sw.js` is never cached, hashed assets are immutable).

```bash
vercel deploy --prod
```

(On a machine with TLS interception: `NODE_OPTIONS=--use-system-ca vercel deploy --prod`.) Any static host works: serve `dist/` and rewrite unknown paths to `index.html`.

## Map layers

| Layer | What it shows | Source | Refresh |
|---|---|---|---|
| **Satellite** | GOES-East/West GeoColor (true colour by day, IR-tinted at night) or Band-13 clean IR; last ~3 h of 10-minute frames, scrubbable. **Radar and satellite are one imagery slot** (radio-style in the layer menu): switching lands on the frame nearest the time you were viewing; if the other layer has nothing within 10 min (GIBS publishes GOES ~1 h behind), it shows its newest frame with a "X min earlier than the radar time you were on" note in the playback bar. The legend follows whichever is active. | NASA GIBS WMTS | 5 min |
| **Radar** | Animated reflectivity, ~2 h of past frames + RainViewer nowcast frames when published; play / pause / step / scrub | RainViewer | 5 min |
| **Rainfall** | Hourly precipitation per forecast block (7×7 points per 0.5°/1°/2° block, see below), rendered as accumulation cells; horizons 6 / 12 / 24 / 48 h; scrubbable | Open-Meteo forecast | 30 min, visible tab only |
| **Flood risk** | ~2 km cells scored from forecast rain, elevation relative to surroundings and geodesic distance to mapped drainage | Open-Meteo + AWS Terrain Tiles + USGS NHD flowlines (US only) | with the block |
| **Rivers** | Nearby stream gauges, colour-coded by flood category / elevated flow; tap for stage, flow, thresholds and forecast | NOAA NWPS + USGS Water Data | 15 min |
| **Station** | Nearest weather station: pressure (+3 h trend), humidity, wind, gusts, temperature, precipitation | api.weather.gov (US); Open-Meteo elsewhere or when NWS is down | 10 min |
| **Nowcast** | Next 6 h in 10-min steps: clouds and rain cells advected by the model wind, wind as animated particles whose streak length grows with zoom (static arrows under reduced motion) | Open-Meteo, advected in a web worker | with the block |

**Forecast blocks that tile the map.** Rainfall, flood risk and nowcast are fetched per fixed geographic block (0.5° / 1° / 2° depending on zoom, `src/lib/blocks.ts`), like map tiles. Panning loads only the blocks that are missing; everything already loaded stays where it is and is cached (30 blocks), so panning back costs nothing. Up to 16 blocks cover the viewport; below zoom 5.5 nothing is loaded and the playback bar says "Zoom in to see the forecast" with a zoom-to-place button. River gauges and the nearest station are bound to the **place**; the forecast blocks follow the map centre once you pan more than ~25 km, and a "Showing map area · back to my place" chip on the Map returns to it.

**Flood-risk model.** For each cell: `rain` = bilinearly interpolated precipitation summed over the selected horizon; `low` = how far the cell sits below the mean of its 5×5 neighbourhood (terrain tiles, fallback model elevation); `drain` = 1 − d/600 m where d is the **geodesic** distance to the nearest NHD flowline (3D point-to-great-circle-segment formula, exact at any latitude). Score = 0.45·rain + 0.30·low + 0.25·drain (terrain weight rises to 0.45 without drainage data), gated by rain so dry forecasts never show risk. Classes: elevated ≥ 0.30, high ≥ 0.55, severe ≥ 0.80. It is an indicative screening layer, not an official warning, and the panel says so.

## Journey weather

Open the **Journey** tab, pick a destination (search, or tap the map → "Set as destination") and a departure (chips for now / +30 min / +1 h / +2 h, or a date-time picker; one journey per driving day, no overnight-stop modelling). The app then:

1. **Routes** with Valhalla (FOSSGIS demo server, alternates when it offers them; OSRM demo as fallback) and computes an ETA at every vertex by spreading each maneuver's time along its length. Routing is at most one request per second; ETAs carry ±2–3 min (rural) to ±5–8 min (mixed) uncertainty because no live traffic is used, and the panel says so.
2. **Samples the route** every ~5 min of driving for the first 6 h and every ~15 min after (≤ 120 points), and fetches the forecast valid **at each sample's ETA** in one window-bounded Open-Meteo request: native 15-minutely data (HRRR / ICON-D2 / AROME) when departure is within two days, hourly beyond. Each sample is classified (WMO code + precipitation, temperature, snow, gusts, visibility) into clear / caution / hazardous / severe, which colours the route, the arrival card, the "worst along the way" line and the tappable strip.
3. **Checks official hazards in space and time** (`src/lib/hazardEngine.ts`): a route sample counts only when it is inside a polygon — or within 5 km of its edge — **and** its ETA falls inside that polygon's own validity window. Three tiers: NWS warnings/advisories (`api.weather.gov/alerts/active`, zone-based products resolved through `/zones/{type}/{id}`), SPC watches as polygons (IEM `spcwatch.py`), and SPC Day 1–3 outlooks (categorical plus tornado/severe probabilities, NOAA MapServer). Products that overlap the corridor but not at your ETA are listed as "nearby, not at your ETA" with the reason. Every source reports *checked / unavailable / not applicable*; the summary never says "clear", and a rate-limited source is reported as such rather than as "no warnings". Live journeys re-check every 2 min while the tab is visible.
4. **Reads pavement sensors (RWIS)** within 5 km of the route (state DOT networks aggregated by the Iowa Environmental Mesonet from NOAA MADIS). Each station is a chip with pavement temperature, the DOT's condition text and the observation age.

### Ice rules

The condition strings follow the SCAN/ScanWeb surface-status table the DOT networks publish (Montana DOT's copy of the glossary: https://mdt.mt.gov/travinfo/atms-glossary.aspx; Iowa reports the same vocabulary):

| DOT status | Glossary definition (abridged) | App state |
|---|---|---|
| Ice Warning, Snow Warning, Snow/Ice Warning, Black Ice Warning | continuous film of ice and water mixture at or below 32 °F with insufficient chemical to keep it from freezing | **ice** — can confirm |
| Frost; plain Ice / Snow / Slush / Icy / Snowy | moisture at or below freezing with pavement at or below the dew point; frozen film reported | **ice** — can confirm |
| Ice Watch, Snow Watch | thin or spotty film of moisture at or below freezing | **watch** — possible ice only, never confirms |
| Chemical Wet | water/ice mixture at or below freezing with enough chemical to keep it liquid | wet (treated) |
| Wet, Damp, Trace Moisture, Moist, Dew | moisture above freezing | wet |
| Dry | no moisture | dry |
| Other, No Report, NA, blank | — | unknown (never "dry") |

A sensor **confirms "icy"** only for samples within 5 km of it *and* with an ETA within 90 min of its observation. Live readings older than 60 min are stale and never confirm. A station with no readings is "unknown", never "no ice". An Ice/Snow Watch in the window yields "Possible ice — *station* reports Ice Watch (pavement N °F)" whatever the forecast says. Outside those rules the forecast alone can only say "possible ice".

### Replays

`?replay=<id>` loads a fixture from `public/fixtures/` (`index.json` lists them): a fixed start, destination and departure, archived hazard products, and the RWIS archive for the day. The weather comes from Open-Meteo's ERA5 reanalysis ("hindsight") or, for `*-forecast` variants, from the Historical Forecast API — the GFS run *as issued that day*. The banner says which, and the map fits the route.

| id | Date / depart (UTC) | What it exercises |
|---|---|---|
| `greenfield-2020z` | 2024-05-21 20:20Z, Des Moines → Omaha | PDS Tornado Watch 277, TO.W #41/#42 at ETA, SPC Day 1 Moderate risk + significant tornado; watches 276/278/279 must *not* be flagged |
| `greenfield-2200z` | 2024-05-21 22:00Z | negative timing: same corridor after the warnings expired → "nearby, not at your ETA" |
| `ice-storm-2024-12-14` | 2024-12-14 08:00Z, Johnston → Iowa City (I-80) | ERA5 weather; Colfax (Ice Warning 24 °F) and Tiffin (Snow Warning 29 °F) confirm; Altoona and Iowa City report Ice Watch → possible only; Grinnell has no readings → unknown |
| `ice-storm-2024-12-14-forecast` | 2024-12-14 10:00Z | same day on the GFS run as issued: the forecast alone classes 22/23 samples as ice (freezing drizzle/rain codes 56/66 from 10Z); at 08:00Z that run still showed no precipitation while the sensors had reported ice since 02:50Z |
| `ice-storm-2024-12-15-late` | 2024-12-15 00:30Z | 4 h after the last icy observation: nothing confirms, out-of-window stations are stale/unknown |

Fixture notes: the IEM RWIS archive CSV is in UTC; blank sensor values are kept as null (no 0 °F sentinels); `meta.json` in each fixture folder records the product IDs, the expected assertions and data-quality caveats.

**Zero live calls.** Each scenario also ships its recorded route (`route.<from>__<to>.json`) and the raw Open-Meteo response for that route and departure (`weather.<id>.json`), produced once by `scripts/record-replays.mjs`. A replay therefore makes no routing or Open-Meteo request; the provider line says "response cached in the fixture, no live call", and `?live=1` forces the live path (what the recorder uses). If a cache file is missing the app falls back to a live call and says so in a toast.

## Data sources and their limits

All services are public and keyless and are called **directly from the browser** (no proxy), so every limit below is per client IP — your phone, your laptop and any test run on the same connection share it. When one of a panel's sources is down the panel shows what it has and names the missing source (for example "NOAA NWPS only (USGS Water Data unavailable: rate-limited …)").

| Service | Used for | Endpoint | Limits / notes |
|---|---|---|---|
| RainViewer | radar frames + tiles | `api.rainviewer.com/public/weather-maps.json`, `tilecache.rainviewer.com/…/512/{z}/{x}/{y}/2/1_1.png` | Public tiles stop at zoom 7 (capped `maxzoom: 7`, overzoomed). Colour scheme 2. |
| NASA GIBS | satellite | `gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/{time}/{tms}/{z}/{y}/{x}.png` | `GOES-East_ABI_GeoColor`, `…_Band13_Clean_Infrared` and the GOES-West pair (west of −105°); frame times from the WMTS capabilities `<Dimension>`; newest frame is ~60–80 min old. |
| Open-Meteo forecast | blocks, journey forecast, station fallback | `api.open-meteo.com/v1/forecast` (multi-location) | **Every location counts as one call: 600/min, 5 000/h, 10 000/day per IP.** Blocks use 49 points; a full 16-block view is 784 calls per refresh (30 min, visible tab only). The client keeps a rolling one-minute budget (~550), parses the 429 tier (minute/hour/day) and backs off; the Sources panel shows calls made today from this browser. |
| Open-Meteo archive / historical forecast | replay weather | `archive-api.open-meteo.com/v1/archive` (ERA5), `historical-forecast-api.open-meteo.com/v1/forecast?models=gfs_seamless` | Same quota. Historical Forecast coverage verified for 2024-12-14 (GFS seamless, HRRR). |
| Open-Meteo geocoding / Nominatim | search, reverse geocode | `geocoding-api.open-meteo.com/v1/search`, `nominatim.openstreetmap.org` | Nominatim: ≤ 1 req/s, identify the app; searches debounced 300 ms. |
| Valhalla (FOSSGIS) / OSRM demo | routing | `valhalla1.openstreetmap.de/route`, `router.project-osrm.org/route/v1` | Demo servers, fair use, ≤ 1 req/s in the app; no traffic data. |
| api.weather.gov | nearest station, alerts, zones | `/points`, `/stations/{id}/observations/latest`, `/alerts/active?area=…`, `/zones/{type}/{id}` | US only (404 elsewhere → Open-Meteo fallback). Browsers cannot set `User-Agent`; the API accepts the request. Zone geometry is fetched lazily and capped at 60 per check. |
| IEM (Iowa Environmental Mesonet) | SPC watch polygons, RWIS live + archive | `mesonet.agron.iastate.edu/json/spcwatch.py`, `/api/1/currents.json?network=XX_RWIS`, `/cgi-bin/request/rwis.py` | Keyless, CORS. RWIS fields `scond0–3` (condition), `tsf0–3` (surface °F), `utc_valid`; the archive is UTC. US state networks only. |
| NOAA SPC via NWS MapServer | Day 1–3 outlooks | `mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer` layers 1/3/9/11/17/19 | Keyless, CORS. |
| NOAA NWPS | gauges, flood categories, forecasts | `api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=…&srid=EPSG_4326`, `/gauges/{lid}` | The bbox list carries each gauge's observed/forecast flood category; flood-stage thresholds and the USGS id exist only on the per-gauge detail (no area query for them in the v1 API — checked against `/nwps/v1/docs/swagger.json`). Gauges load in two tiers and only while something shows them: the list alone (1 request) for the Now tile and the map dots, the nearest 20 details (cached per gauge for the session) only on the Rivers page; cached per place for 15 min. Rate-limits per IP after sustained test traffic. |
| USGS Water Data (OGC API) | latest stage/flow, 10-day median | `api.waterdata.usgs.gov/ogcapi/v0/collections/{latest-continuous,monitoring-locations,daily}/items` | Replaces the decommissioned `waterservices.usgs.gov/nwis/iv`. Three requests per Rivers-page load (latest values, site names, one bbox query for the 10-day daily medians); nothing on a place change by itself. Rate-limits per IP (HTTP 429 with a sign-up hint); the app then shows NWPS-only gauges and says so. No API key is used. |
| USGS NHD (The National Map) | drainage for flood scoring | `hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query` | US only; elsewhere the flood score uses terrain + rain and says so. |
| AWS Terrain Tiles | 3D terrain, flood scoring | `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | Terrarium encoding, decoded in the worker. |
| OpenFreeMap | basemap | `tiles.openfreemap.org/styles/positron` | Free vector basemap. |

Known limitations: radar is coarse above zoom 7 (upstream); NHD, NWS, NWPS/USGS, RWIS and SPC products are US-only (each panel says so); the flood layer is a screening heuristic; the nowcast is model-advected beyond RainViewer's published nowcast frames; ETAs ignore traffic; the hazard engine checks products that exist as polygons, not local road closures.

## Testing (headless suites)

The suites are plain Playwright scripts in `scripts/` (Chromium + SwiftShader, no test framework). Install the browser once with `npx playwright install chromium`, and run the app on the port the scripts expect:

```bash
npx vite --port 5174 --strictPort
```

| Script | Covers |
|---|---|
| `flows-check.mjs` | the Phase 2 acceptance flows with real touch input: current conditions on Now within 15 s (10 s mocked) after a location grant and after an address entry; a map tap shows a chip (never a dialog) that fills with conditions, and Details expands the sheet; every place-bound view (Now, Trip, More → Flood / Rivers / Station) opens the same picker with use-my-location / search / pick-on-map, and pick-on-map returns to the page with the place moved; Trip is one tap from Now. `--mock` runs it with zero live calls |
| `qa.mjs` | first-run prompt and denied recovery, Now (label, conditions within 15 s, alerts line), units via Settings, Station / Rivers pages, details-sheet modes and FAB, legend chip, point chip at every corner + details, gauge chip, exclusive overlays, playback bar step/play, reload persistence, non-US fallbacks on Now / Station / Rivers / Flood, reduced motion, desktop rail + column + map, main-thread responsiveness, desktop layout |
| `e2e.mjs` | screenshot walkthrough of every panel (visual review, few assertions) |
| `pwa-check.mjs` | manifest, service worker, offline shell, cached API data (needs `npm run preview` or production) |
| `satellite-check.mjs` | radar ⇄ satellite exclusivity, time carry-over on the shared playback clock, lag note in the bar, legend follow (`VIEWPORT=mobile` for the phone layout) |
| `playbar-check.mjs` | the docked playback bar on phone, tablet and desktop: fully in view, one row, never overlapping the open layer menu, the open legend, ☰ or the zoom buttons; the menu anchored to ☰; no control clipped by the viewport; status chips not cut off; ▶ advances the time label; below forecast zoom the "Zoom in to see the forecast" note and its zoom-to-place button. One screenshot per layout |
| `blocks-check.mjs` | block tiling: persistence across pans, neighbours only, cache, hidden-tab pause, 49-point tiles, daily counter |
| `zoom-check.mjs` | block level per zoom, continental zoom loads nothing |
| `fab-check.mjs` | draggable layer button (every corner by drag), corners persist, legend chip / controls move aside |
| `follow-check.mjs` | the map's follow chip appears when panning away while rivers/station stay bound to the place; recenter returns map + data window |
| `journey-check.mjs` | routing, ETAs, 15-minutely sampling, budget, panel wording, departure change, alternates (`JOURNEY_SCENARIO=0` Philadelphia → Baltimore, `1` Johnston → Iowa City) |
| `hazards-check.mjs` | Greenfield replays: polygon IDs at ETA, watches excluded, outlooks, negative timing, per-source status, camera fit |
| `road-check.mjs` | ice-storm replays: Warning vs Watch statuses, 5 km / 90 min rules, stale/unknown, forecast-as-issued variant, live I-80 stations |
| `rivers-check.mjs` | rivers layer **on** at a fixed Iowa viewport: the one-request bbox query for 10-day discharge medians equals the old per-site queries (live) and, exactly, a snapshot recorded from a fully **approved** USGS window (`scripts/fixtures/rivers-iowa.json`, refresh with `--record`, `SNAP_START`/`SNAP_END`); the app's elevated-flow ratios use those medians |
| `sheet-check.mjs` | the Map screen's details sheet with real touch input (CDP touch events, `scripts/lib/touch.mjs`): opened from the point chip, with content scrolled, collapse by handle drag, handle tap, the ▼ button (must be on screen), content swipe-down at scroll top, and the browser back gesture; the sheet must return to its starting height |
| `record-replays.mjs` | not a test: records each replay's route and raw Open-Meteo response into its fixture folder so replays make no live routing/forecast calls (run against the dev server; `--only=<id>`) |
| `traffic-count.mjs` | not a test: requests per host for one ordinary session, phase by phase (open app → change place twice → open Map → open Trip, then the Rivers tile and page as extras), mocked by default (`--live` goes through the guard). The numbers the caps are sized from |

Run one suite as `node scripts/<name>.mjs <base-url> <screenshot-dir>`, e.g. `node scripts/road-check.mjs http://localhost:5174/ e2e-shots/road`. Screenshots land in the directory you give.

### Traffic guard (shared IP)

Every request a suite makes leaves the machine's public IP, which the owner's own devices share, and most of the APIs above limit per IP. `scripts/lib/qa-budget.mjs` therefore wraps every suite:

* counts every external request **per host** and Open-Meteo **per location**, for the browser context including service-worker fetches (`PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1` is set for you);
* keeps a per-UTC-day ledger in `e2e-shots/.qa-budget.json` and prints it before and after each run (`budget:` / `traffic:` lines);
* refuses to start when the Open-Meteo day cap (`QA_OM_CAP`, default 3 600 locations — one full pass needs ≈ 3 250, leaving 6 400 for real use) is spent;
* **aborts requests to any host that has reached its daily cap** (`HOST_CAPS` in the module, sized for ONE full pass — 17 suites + phone walkthrough + perf — with no retry allowance, from the Oct 7 measurement: NWPS 150, NWS 140, Open-Meteo 120 requests, USGS 50, IEM 60, SPC MapServer 85, routing 10 each, GIBS 1 100, radar tiles 1 700) and prints `BLOCK <host>` so the suite fails loudly instead of hammering the service. Override deliberately with `QA_CAPS='{"api.waterdata.usgs.gov":0}'`.
* under `--mock` it also counts the requests the mock server answered, per host, and prints them as `traffic (mocked, …)` without charging the ledger — the app makes the same calls live, so a mocked batch (`node scripts/prod-suite.mjs <url> --mock`) is how the caps are sized.

River gauges load only while something shows them (the Now tile on screen, the map's rivers layer, the Rivers page) and are cached per place, so a place change by itself costs no NWPS/USGS request; the station and alerts calls (4 NWS requests) and one Open-Meteo request are the per-place cost.

Node-side requests a suite makes itself (the rivers suite's USGS/NWPS queries) go through `guardedFetch`, which charges the host cap **before** each request and refuses past it, so a long loop cannot overrun. A suite that declares `assertBudget(name, { openMeteo: false })` is held to it: any Open-Meteo request it makes is aborted and the run is flagged.

### Performance measurement and the feature walkthrough (zero live calls)

```bash
PERF_SOURCEMAP=1 npm run build && npx vite preview --port 4173 --strictPort   # or the preview-4173 launch config
node scripts/perf-measure.mjs http://localhost:4173/ e2e-shots/perf --mock --headed [--low-device] [--viewport=tablet]
node scripts/walkthrough.mjs  http://localhost:4173/ e2e-shots/walkthrough --mock [--viewport=phone|tablet|desktop]
```

`--mock` answers every API from saved or synthesized bodies (`scripts/lib/mock-server.mjs`): real Open-Meteo series from the replay caches reshaped to the request, the recorded Valhalla route, the RWIS archive, the rivers snapshot; NWS, NWPS, USGS, RainViewer and GIBS bodies synthesized in the shapes the app parses (timing only, never shipped); the real basemap style/sprites/glyphs from `e2e-shots/perf/basemap/` with empty vector tiles. `--headed` uses installed Chrome with the machine's GPU; the report records page visibility, rAF rate and a CPU-throttle calibration and marks the run invalid otherwise. The bundled headless Chromium on an ARM Windows machine runs under emulation, ignores CPU throttling and rasterises in software, so its numbers are not the stated profile. `perf-measure` reports time to first radar frame (the headline), LCP, INP per interaction, every main-thread task over 50 ms with its source (trace + CPU profile through the sourcemaps), frames over 50/100 ms per phase, bundle sizes and first-load requests. The walkthrough records per feature: time to usable, interactions over 200 ms, frame drops, console errors and a screenshot.

**Other engines and real devices.** `--browser=webkit` on `sheet-check.mjs` and `walkthrough.mjs` runs Playwright's WebKit (the Safari engine on Windows: taps are real touch input, drags are synthesized pointer + touch events, no CPU throttle; it does not cover iOS Safari's viewport/toolbar behaviour, safe-area insets, the back-swipe gesture, scroll bounce or the device GPU). For an Android device over USB with Chrome: enable USB debugging, then

```bash
adb devices && adb forward tcp:9222 localabstract:chrome_devtools_remote
node scripts/perf-measure.mjs https://<deployment>/ e2e-shots/perf --cdp=http://localhost:9222 --label=device
```

(`adb` from Google's platform-tools; the device's Chrome must be signed in to Vercel for a protected preview.) Device runs are unthrottled and use the device's own viewport and network; their numbers outrank the laptop's.

### Release flow: preview → full run → promote

```bash
vercel deploy                                   # preview deployment (protected URL)
VERCEL_AUTOMATION_BYPASS_SECRET=… node scripts/prod-suite.mjs https://<preview>.vercel.app/
vercel promote https://<preview>.vercel.app     # only when every suite is green
```

Preview URLs sit behind Vercel Authentication; the suites pass Vercel's *Protection Bypass for Automation* headers on every request to a `*.vercel.app` host when `VERCEL_AUTOMATION_BYPASS_SECRET` is set (generate one under Project Settings → Deployment Protection, or `vercel api /v1/projects/stormscope/protection-bypass -X PATCH --input body.json`; revoke it afterwards). `npm run qa:prod` runs the same thing against the production alias.

`scripts/prod-suite.mjs` runs the suites **sequentially** (one browser at a time) against the deployed bundle, identifies the bundle by its hashed entry script, writes each run's logs and screenshots to its own `e2e-shots/prod/<UTC stamp>-run/` directory, records the result (and that path) in `e2e-shots/.prod-runs.json`, and **refuses to run the same bundle twice** unless you pass `--force`. It also refuses to start a full run the Open-Meteo day budget cannot finish (~1 500 locations). `--only=road,hazards` runs a subset without marking the bundle as fully tested; `npm run qa:local` does the same against the dev server with `--force`.

## Project layout

```
src/
  api/          one client per service: rainviewer, gibs, openMeteo (budgeted limiter), geocode, nws, nwps,
                usgsWater, nhd, routing (Valhalla/OSRM), hazards (NWS alerts, IEM watches, SPC outlooks,
                replay loader), rwis (IEM pavement sensors)
  lib/          geo (geodesic maths), blocks (tiling), journey (sampling, ETA forecast, classification),
                hazardEngine, roadIce (RWIS rules), polyline, units, time, fetch, colors
  workers/      geo.worker.ts (flood scoring, terrain decode, drainage distance, nowcast advection) + client
  state/        store.ts (tiny external store) · DataController.tsx (all polling, worker jobs, journey pipeline)
  map/          MapView (MapLibre + terrain + 2D/3D), one component per overlay, RouteLayer, HazardLayer, MapPopup
  components/   SearchBar, LocationPrompt, LayerFab, Legend, PlaybackBar, BottomSheet, Panels, JourneyPanel
public/fixtures/  replay scenarios (index.json + one folder per event)
scripts/        test suites, prod-suite.mjs, lib/qa-budget.mjs, make-icons.mjs, shp2geojson.mjs
```

## Browser support

Modern evergreen browsers (Chrome/Edge 100+, Safari 16.4+, Firefox 105+). The worker uses `OffscreenCanvas` + `createImageBitmap` for terrain decoding and falls back to the model elevation if a tile fails.
