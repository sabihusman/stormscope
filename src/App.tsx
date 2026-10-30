import { lazy, Suspense, useEffect, type ReactNode } from 'react'
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
import { closeAllPanels, endPickOnMap, loadPlace, savePlace, setPlace, startPickOnMap, store, toast, useApp, type LayerId } from './state/store'
import { useGeolocation } from './hooks/useGeolocation'
import { useWide } from './hooks/useMisc'
import { haversine } from './lib/geo'
import { WARM_CACHE_NO_REFETCH } from './lib/perfFlags'
import { LocationPrompt } from './components/LocationPrompt'
import { SearchBar } from './components/SearchBar'
import { LayerFab } from './components/LayerFab'
import { BottomSheet } from './components/BottomSheet'
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

export default function App() {
  const geo = useGeolocation()
  const t = useApp((s) => s.toast)
  const place = useApp((s) => s.place)
  const sheet = useApp((s) => s.sheet)
  const hasSelection = useApp((s) => !!s.selection)
  const fabCorner = useApp((s) => s.fabCorner)
  const fabCornerWide = useApp((s) => s.fabCornerWide)
  const journeyTo = useApp((s) => !!s.journey.to)
  const screen = useApp((s) => s.screen)
  const pickMode = useApp((s) => s.pickMode)
  const pickerOpen = useApp((s) => s.pickerOpen)
  const wide = useWide()

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAllPanels()
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
    <div className={`app screen-${screen} sheet-${hasSelection && screen === 'map' ? sheet : 'none'} fab-${fabCorner} fabw-${fabCornerWide} ${wide ? 'wide' : 'narrow'} ${pickMode ? 'picking' : ''} ${playbarExpanded ? 'playbar-open' : ''} ${wide && columnCollapsed && screen !== 'map' ? 'col-collapsed' : ''}`}>
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

      {screen === 'now' && (
        <ErrorBoundary kind="panel" name="Now">
          <NowScreen onLocate={geo.request} locating={geo.status === 'locating'} promptOpen={showPrompt} />
        </ErrorBoundary>
      )}
      {screen === 'trip' && (
        <ErrorBoundary kind="panel" name="Trip"><TripScreen /></ErrorBoundary>
      )}
      {screen === 'more' && (
        <ErrorBoundary kind="panel" name="More"><MoreScreen /></ErrorBoundary>
      )}
      <Nav />
      {wide && screen !== 'map' && !pickMode && (
        <button className="col-toggle" onClick={() => store.set({ columnCollapsed: !columnCollapsed })} aria-label={columnCollapsed ? 'Show the panel' : 'Hide the panel for a full-map view'} aria-expanded={!columnCollapsed} title={columnCollapsed ? 'Show the panel' : 'Full-map view'}>
          {columnCollapsed ? '›' : '‹'}
        </button>
      )}
      <PlacePicker onLocate={geo.request} locating={geo.status === 'locating'} />

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
        <div className={`toast ${t.kind}`} role="status">
          <span>{t.text}</span>
          <button className="icon-btn" onClick={() => store.set({ toast: null })} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  )
}
