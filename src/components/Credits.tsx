import { usePresence } from '../hooks/usePresence'
import { store, useApp } from '../state/store'

/** Every data and map source the app uses, with the credit each asks for. "OpenStreetMap" stays spelled as is. */
export const CREDITS: { what: string; who: string; url: string; note?: string }[] = [
  { what: 'Map tiles', who: 'OpenFreeMap', url: 'https://openfreemap.org/', note: '© OpenMapTiles © OpenStreetMap contributors' },
  { what: 'Terrain', who: 'Terrain Tiles (AWS Open Data)', url: 'https://registry.opendata.aws/terrain-tiles/' },
  { what: 'Radar', who: 'RainViewer', url: 'https://www.rainviewer.com/' },
  { what: 'Satellite', who: 'NASA GIBS / NOAA GOES', url: 'https://earthdata.nasa.gov/gibs' },
  { what: 'Forecasts, conditions, place search', who: 'Open-Meteo', url: 'https://open-meteo.com/', note: 'CC BY 4.0' },
  { what: 'Alerts and station observations', who: 'NOAA National Weather Service', url: 'https://www.weather.gov/' },
  { what: 'River gauges and forecasts', who: 'USGS Water Data · NOAA National Water Prediction Service', url: 'https://water.noaa.gov/' },
  { what: 'Air quality', who: 'EPA AirNow and the reporting air quality agencies', url: 'https://www.airnow.gov/', note: 'preliminary data, not fully verified' },
  { what: 'Road weather', who: 'Iowa DOT RWIS via the Iowa Environmental Mesonet', url: 'https://mesonet.agron.iastate.edu/' },
  { what: 'Routing', who: 'Valhalla (FOSSGIS) · OSRM', url: 'https://www.openstreetmap.org/copyright', note: 'routing data © OpenStreetMap contributors' },
  { what: 'Address lookup', who: 'Nominatim', url: 'https://nominatim.org/', note: '© OpenStreetMap contributors' },
  { what: 'Map rendering', who: 'MapLibre GL JS', url: 'https://maplibre.org/' },
]

/** The full credits list (the More tab's "About / Credits" page and the map's (i) panel). */
export function Credits() {
  return (
    <ul className="credits-list" aria-label="Credits">
      {CREDITS.map((c) => (
        <li key={c.what}>
          <span className="credit-what">{c.what}</span>
          <span className="credit-who">
            <a href={c.url} target="_blank" rel="noopener noreferrer">
              {c.who}
            </a>
            {c.note ? <small className="muted"> · {c.note}</small> : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The map's credits panel, opened by the (i) button; fades and slides like the other pop-ups. */
export function CreditsPanel() {
  const open = useApp((s) => s.creditsOpen)
  const presence = usePresence(open)
  if (!presence.mounted) return null
  return (
    <div className="credits-panel pop" data-state={presence.state} onTransitionEnd={presence.onTransitionEnd} role="dialog" aria-label="Map credits">
      <div className="chooser-title">
        <strong>Map credits</strong>
        <button className="icon-btn" onClick={() => store.set({ creditsOpen: false })} aria-label="Close credits">
          ×
        </button>
      </div>
      <Credits />
    </div>
  )
}
