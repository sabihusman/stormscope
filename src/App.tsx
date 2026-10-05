import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { MapView } from './map/MapView'
import { RadarLayer } from './map/RadarLayer'
import { SatelliteLayer } from './map/SatelliteLayer'
import { RainfallLayer } from './map/RainfallLayer'
import { FloodLayer } from './map/FloodLayer'
import { RiversLayer } from './map/RiversLayer'
import { StationLayer } from './map/StationLayer'
import { NowcastLayer, WindParticles } from './map/NowcastLayer'
import { MapPopup } from './map/MapPopup'
// Journey overlays: code-split with the journey pipeline and mounted only once a destination exists.
const RouteLayer = lazy(() => import('./map/RouteLayer').then((m) => ({ default: m.RouteLayer })))
const HazardLayer = lazy(() => import('./map/HazardLayer').then((m) => ({ default: m.HazardLayer })))
import { DataController } from './state/DataController'
import { loadPlace, savePlace, store, toast, useApp, type LayerId } from './state/store'
import { useGeolocation } from './hooks/useGeolocation'
import { haversine } from './lib/geo'
import { WARM_CACHE_NO_REFETCH } from './lib/perfFlags'
import { LocationPrompt } from './components/LocationPrompt'
import { SearchBar } from './components/SearchBar'
import { LayerFab } from './components/LayerFab'
import { Legend } from './components/Legend'
import { BottomSheet } from './components/BottomSheet'
import { ErrorBoundary } from './components/ErrorBoundary'

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
  const [searchOpen, setSearchOpen] = useState(false)
  const t = useApp((s) => s.toast)
  const place = useApp((s) => s.place)
  const sheet = useApp((s) => s.sheet)
  const fabCorner = useApp((s) => s.fabCorner)
  const journeyTo = useApp((s) => !!s.journey.to)

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
      store.set({ place: { name: keep ?? 'Your location', lngLat: geo.position, source: 'geolocation' }, selection: null })
    }
  }, [geo.status, geo.position])

  const showPrompt = !place && (geo.status === 'prompt' || geo.status === 'locating' || geo.status === 'denied' || geo.status === 'timeout' || geo.status === 'unavailable') && !searchOpen

  return (
    <div className={`app sheet-${sheet} fab-${fabCorner}`}>
      <MapView>
        {/* Each layer is contained: if it throws, it is switched off with a note and the rest keeps working. */}
        <LayerGuard name="Satellite" layer="satellite"><SatelliteLayer /></LayerGuard>
        <LayerGuard name="Radar" layer="radar"><RadarLayer /></LayerGuard>
        <LayerGuard name="Rainfall" layer="rainfall"><RainfallLayer /></LayerGuard>
        <LayerGuard name="Flood risk" layer="flood"><FloodLayer /></LayerGuard>
        <LayerGuard name="Rivers" layer="rivers"><RiversLayer /></LayerGuard>
        <LayerGuard name="Station" layer="station"><StationLayer /></LayerGuard>
        <LayerGuard name="Nowcast" layer="nowcast"><NowcastLayer /></LayerGuard>
        <LayerGuard name="Wind particles" layer="nowcast"><WindParticles /></LayerGuard>
        {journeyTo && (
          <Suspense fallback={null}>
            <ErrorBoundary kind="layer" name="Hazard overlay"><HazardLayer /></ErrorBoundary>
            <ErrorBoundary kind="layer" name="Route overlay"><RouteLayer /></ErrorBoundary>
          </Suspense>
        )}
        <ErrorBoundary kind="layer" name="Map popup"><MapPopup /></ErrorBoundary>
      </MapView>
      <DataController />

      <ErrorBoundary kind="panel" name="Search">
        <SearchBar open={searchOpen} onOpen={() => setSearchOpen(true)} onClose={() => setSearchOpen(false)} onLocate={geo.request} locating={geo.status === 'locating'} />
      </ErrorBoundary>
      <ErrorBoundary kind="panel" name="Legend"><Legend /></ErrorBoundary>
      <ErrorBoundary kind="panel" name="Layer menu"><LayerFab /></ErrorBoundary>
      <ErrorBoundary kind="panel" name="Panel"><BottomSheet /></ErrorBoundary>

      {showPrompt && (
        <LocationPrompt
          status={geo.status}
          message={geo.message}
          onAllow={geo.request}
          onSkip={geo.dismiss}
          onSearch={() => {
            geo.dismiss()
            setSearchOpen(true)
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
