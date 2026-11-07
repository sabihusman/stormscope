import { lazy, Suspense, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { MapView } from './map/MapView'
import { RadarLayer } from './map/RadarLayer'
import { SatelliteLayer } from './map/SatelliteLayer'
import { RainfallLayer } from './map/RainfallLayer'
import { FloodLayer } from './map/FloodLayer'
import { AqCirclesLayer } from './map/AqCirclesLayer'
import { MonitorSitesLayer } from './map/MonitorSitesLayer'
import { RiversLayer } from './map/RiversLayer'
import { StationLayer } from './map/StationLayer'
import { NowcastLayer, WindParticles } from './map/NowcastLayer'
import { MonitorChooser, PointChip } from './components/PointChip'
import { CreditsPanel } from './components/Credits'
// Journey overlays: code-split with the journey pipeline and mounted only once a destination exists.
const RouteLayer = lazy(() => import('./map/RouteLayer').then((m) => ({ default: m.RouteLayer })))
const HazardLayer = lazy(() => import('./map/HazardLayer').then((m) => ({ default: m.HazardLayer })))
import { DataController } from './state/DataController'
import { closeAllPanels, endPickOnMap, go, installOnePanelRule, loadPlace, savePlace, setPlace, startPickOnMap, store, toast, useApp, type LayerId } from './state/store'
import { useGeolocation } from './hooks/useGeolocation'
import { useDesktop, useWide } from './hooks/useMisc'
import { haversine } from './lib/geo'
import { WARM_CACHE_NO_REFETCH } from './lib/perfFlags'
import { LocationPrompt } from './components/LocationPrompt'
import { SearchBar } from './components/SearchBar'
import { LayerFab } from './components/LayerFab'
import { BottomSheet } from './components/BottomSheet'
import { GeoNotice } from './components/GeoNotice'
import { PlaybackBar } from './components/PlaybackBar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Nav } from './components/Nav'
import { NowScreen } from './components/NowScreen'
import { TripScreen } from './components/TripScreen'
import { MoreScreen } from './components/MoreScreen'
import { PlacePicker } from './components/PlacePicker'

/** A map layer boundary keyed on its toggle, so turning the layer on again retries it. */
function LayerGuard({ name, layer, children }: { name: string; layer: LayerId; children: ReactNode }) {
  const on = useApp((s) => s.layers[layer])
  return (
    <ErrorBoundary key={String(on)} kind="layer" name={name} layer={layer}>
      {children}
    </ErrorBoundary>
  )
}

/**
 * While a toast shows on a phone's content screen, the screen's scroll area starts below it (its height in
 * --toast-h), so the toast never sits on top of the 7-day list or anything else (Nov 6 audit). Returns the toast's ref.
 */
function useToastStrip(toast: unknown) {
  const ref = useRef<HTMLOutputElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const app = document.querySelector<HTMLElement>('.app')
    if (!el || !app) {
      app?.style.setProperty('--toast-h', '0px')
      return
    }
    const set = () => app.style.setProperty('--toast-h', `${Math.ceil(el.getBoundingClientRect().height)}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => {
      ro.disconnect()
      app.style.setProperty('--toast-h', '0px')
    }
  }, [toast])
  return ref
}

/** The app root's classes: the screen, the sheet height, the layout and the open chrome, for the CSS to follow. */
function appClassName(o: { toast: boolean; screen: string; sheet: string; fabCorner: string; fabCornerWide: string; wide: boolean; desk: boolean; dockOpen: boolean; pickMode: boolean; playbarExpanded: boolean; collapsed: boolean }) {
  const on: [boolean, string][] = [
    [o.toast, 'has-toast'],
    [true, `screen-${o.screen}`],
    [true, `sheet-${o.sheet}`],
    [true, `fab-${o.fabCorner}`],
    [true, `fabw-${o.fabCornerWide}`],
    [true, o.wide ? 'wide' : 'narrow'],
    [o.desk, 'desk'],
    [o.dockOpen, 'dock-open'],
    [o.pickMode, 'picking'],
    [o.playbarExpanded, 'playbar-open'],
    [o.collapsed, 'col-collapsed'],
  ]
  return ['app', ...on.filter(([x]) => x).map(([, c]) => c)].join(' ')
}

export default function App() {
  const geo = useGeolocation()
  const t = useApp((s) => s.toast)
  // Phones (the narrow layout): one panel at a time; the bottom sheet is exempt.
  useEffect(() => installOnePanelRule(() => window.innerWidth < 768), [])
  const toastRef = useToastStrip(t)
  const place = useApp((s) => s.place)
  const sheet = useApp((s) => s.sheet)
  const hasSelection = useApp((s) => !!s.selection)
  const fabCorner = useApp((s) => s.fabCorner)
  const fabCornerWide = useApp((s) => s.fabCornerWide)
  const journeyTo = useApp((s) => !!s.journey.to && s.routeOnMap)
  const screen = useApp((s) => s.screen)
  const pickMode = useApp((s) => s.pickMode)
  const pickerOpen = useApp((s) => s.pickerOpen)
  const wide = useWide()
  // Desktop (≥ 1024 px): the Now column is always on the left; Trip and More dock on the right, beside the map.
  const desktop = useDesktop()
  const desk = wide && desktop
  const dockOpen = desk && (screen === 'trip' || screen === 'more') && !pickMode

  // PWA update prompt.
  const { needRefresh, updateServiceWorker } = useRegisterSW({
    onRegisterError: () => toast('Offline support could not be enabled', 'warn'),
  })

  // First-ever visit: the initial fetches run before the service worker exists. With
  // WARM_CACHE_NO_REFETCH, fetchJSON stores good live-data responses in the worker's cache as they
  // arrive and MapView re-requests basemap/terrain through the worker from the HTTP cache; the
  // older behaviour refetched every API once the worker took control (doubling first-load traffic).
  useEffect(() => {
    if (WARM_CACHE_NO_REFETCH || !('serviceWorker' in navigator) || navigator.serviceWorker.controller) return
    const onControl = () => store.set((s) => ({ refreshNonce: s.refreshNonce + 1 }))
    navigator.serviceWorker.addEventListener('controllerchange', onControl, { once: true })
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onControl)
  }, [])

  // Returning users land where they left off; persist any new place.
  useEffect(() => {
    const saved = loadPlace()
    // Restored as a "search" place with its saved label so no reverse-geocode request is needed.
    if (saved && !store.get().place) store.set({ place: { ...saved.place, name: saved.label ?? saved.place.name }, placeLabel: saved.label ?? saved.place.name })
    const unsubscribe = store.subscribe(() => savePlace(store.get().place, store.get().placeLabel))
    return () => {
      unsubscribe()
    }
  }, [])

  // Apply geolocation result.
  useEffect(() => {
    if (geo.status === 'granted' && geo.position && !store.get().replay) {
      // Same spot as last time (within 1 km): keep the resolved label instead of "Your location".
      const cur = store.get()
      const keep = cur.place && cur.placeLabel && haversine(cur.place.lngLat, geo.position) < 1000 ? cur.placeLabel : null
      setPlace({ name: keep ?? 'Your location', lngLat: geo.position, source: 'geolocation' }, keep ?? undefined)
    }
  }, [geo.status, geo.position])

  // Phones: the expanded playback bar lifts the layers button above it (CSS .playbar-open).
  const playbarExpanded = useApp((s) => s.playbarExpanded)
  // Keyboard: Escape closes every open panel (the arrow keys already scrub the focused playback slider).
  const dockRef = useRef(dockOpen)
  dockRef.current = dockOpen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const hadPanel = store.get().pickerOpen || store.get().creditsOpen || !!store.get().dotChooser || store.get().legendOpen
      closeAllPanels()
      // With no floating panel to close, Escape closes the desktop dock (Trip / More) back to Now.
      if (!hadPanel && dockRef.current) go('now')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Wide layouts: the content column folds away for a full-map view.
  const columnCollapsed = useApp((s) => s.columnCollapsed)
  const askPlace = useApp((s) => s.askPlace)
  const showPrompt = !place && (askPlace || geo.status === 'prompt' || geo.status === 'locating' || geo.status === 'denied' || geo.status === 'timeout' || geo.status === 'unavailable') && !pickerOpen && !pickMode

  const confirmPick = () => {
    const m = (window as unknown as { __map?: { getCenter: () => { lng: number; lat: number } } }).__map
    if (!m) return
    const c = m.getCenter()
    geo.dismiss()
    setPlace({ name: 'Map point', lngLat: { lng: c.lng, lat: c.lat }, source: 'map' })
    endPickOnMap(false)
  }

  return (
    <div className={appClassName({ toast: !!t, screen, sheet: hasSelection && screen === 'map' ? sheet : 'none', fabCorner, fabCornerWide, wide, desk, dockOpen, pickMode, playbarExpanded, collapsed: wide && columnCollapsed && (desk || screen !== 'map') })}>
      <MapView>
        {/* Each layer is contained: if it throws, it is switched off with a note and the rest keeps working. */}
        <LayerGuard name="Satellite" layer="satellite"><SatelliteLayer /></LayerGuard>
        <LayerGuard name="Radar" layer="radar"><RadarLayer /></LayerGuard>
        <LayerGuard name="Rainfall" layer="rainfall"><RainfallLayer /></LayerGuard>
        <LayerGuard name="Flood risk" layer="flood"><FloodLayer /></LayerGuard>
        <LayerGuard name="Rivers" layer="rivers"><RiversLayer /></LayerGuard>
        <LayerGuard name="Station" layer="station"><StationLayer /></LayerGuard>
        <LayerGuard name="Nowcast" layer="nowcast"><NowcastLayer /></LayerGuard>
        <LayerGuard name="Air quality circles" layer="aqcircles"><AqCirclesLayer /></LayerGuard>
        <LayerGuard name="Air monitors" layer="monitors"><MonitorSitesLayer /></LayerGuard>
        <LayerGuard name="Wind particles" layer="nowcast"><WindParticles /></LayerGuard>
        {journeyTo && (
          <Suspense fallback={null}>
            <ErrorBoundary kind="layer" name="Hazard overlay"><HazardLayer /></ErrorBoundary>
            <ErrorBoundary kind="layer" name="Route overlay"><RouteLayer /></ErrorBoundary>
          </Suspense>
        )}
      </MapView>
      <DataController />

      {/* Map screen chrome. On wide layouts the map is always visible, so its chrome stays too. */}
      {(screen === 'map' || wide) && !pickMode && (
        <>
          <ErrorBoundary kind="panel" name="Search">
            <SearchBar onLocate={geo.request} locating={geo.status === 'locating'} />
          </ErrorBoundary>
          <ErrorBoundary kind="panel" name="Layer menu"><LayerFab /></ErrorBoundary>
          <ErrorBoundary kind="panel" name="Playback"><PlaybackBar /></ErrorBoundary>
          {/* The (i) control lives on the map, so its panel lives with the map's chrome: on wide layouts the map (and the (i)) is beside every tab. */}
          <ErrorBoundary kind="panel" name="Credits"><CreditsPanel /></ErrorBoundary>
        </>
      )}
      {screen === 'map' && !pickMode && (
        <>
          <ErrorBoundary kind="panel" name="Point"><PointChip /></ErrorBoundary>
          <ErrorBoundary kind="panel" name="Monitor chooser"><MonitorChooser /></ErrorBoundary>
          {hasSelection && sheet !== 'peek' && <ErrorBoundary kind="panel" name="Panel"><BottomSheet /></ErrorBoundary>}
        </>
      )}
      {pickMode && (
        <div className="pick-ui" role="group" aria-label="Pick a point on the map">
          <div className="crosshair" aria-hidden="true" />
          <div className="pick-actions">
            <button className="btn" onClick={() => endPickOnMap(true)}>
              Cancel
            </button>
            <button className="btn primary" onClick={confirmPick}>
              Use this point
            </button>
          </div>
        </div>
      )}

      {(screen === 'now' || (desk && !pickMode)) && (
        <ErrorBoundary kind="panel" name="Now">
          <NowScreen onLocate={geo.request} locating={geo.status === 'locating'} promptOpen={showPrompt} />
        </ErrorBoundary>
      )}
      {dockOpen && (
        <button className="dock-close" onClick={() => go('now')} aria-label="Close this panel (Escape)" title="Close (Esc)">
          ✕
        </button>
      )}
      {screen === 'trip' && (
        <ErrorBoundary kind="panel" name="Trip"><TripScreen /></ErrorBoundary>
      )}
      {screen === 'more' && (
        <ErrorBoundary kind="panel" name="More"><MoreScreen /></ErrorBoundary>
      )}
      <Nav />
      {wide && (desk || screen !== 'map') && !pickMode && (
        <button className="col-toggle" onClick={() => store.set({ columnCollapsed: !columnCollapsed })} aria-label={columnCollapsed ? 'Show the panel' : 'Hide the panel for a full-map view'} aria-expanded={!columnCollapsed} title={columnCollapsed ? 'Show the panel' : 'Full-map view'}>
          {columnCollapsed ? '›' : '‹'}
        </button>
      )}
      <PlacePicker onLocate={geo.request} locating={geo.status === 'locating'} geo={geo} />
      {place && !showPrompt && !pickerOpen && <GeoNotice status={geo.status} message={geo.message} attempt={geo.attempt} onRetry={geo.request} />}

      {showPrompt && (
        <LocationPrompt
          status={askPlace && geo.status === 'idle' ? 'prompt' : geo.status}
          message={geo.message}
          onAllow={geo.request}
          onSearch={() => {
            geo.dismiss()
            store.set({ pickerOpen: true, pickerMode: 'search', askPlace: false })
          }}
          onPickOnMap={() => {
            geo.dismiss()
            store.set({ askPlace: false })
            startPickOnMap()
          }}
          onClose={() => {
            // Closed without choosing: the Now column's empty state with the same three options, never a default city.
            geo.dismiss()
            store.set({ askPlace: false })
          }}
        />
      )}

      {needRefresh[0] && (
        <div className="toast info" role="status">
          <span>A new version is available.</span>
          <button className="btn small" onClick={() => updateServiceWorker(true)}>
            Reload
          </button>
          <button className="icon-btn" onClick={() => needRefresh[1](false)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {t && (
        <output className={`toast ${t.kind}`} ref={toastRef}>
          <span>{t.text}</span>
          <button className="icon-btn" onClick={() => store.set({ toast: null })} aria-label="Dismiss">
            ×
          </button>
        </output>
      )}
    </div>
  )
}
