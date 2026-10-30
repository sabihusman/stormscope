import { useEffect } from 'react'
import type { MapLayerMouseEvent } from 'maplibre-gl'
import { U, type Units } from '../lib/units'
import { timeAgo } from '../lib/time'
import { store, useApp } from '../state/store'
import { useMap } from './MapView'
import { attachTooltip } from './tooltip'
import type { StationObs } from '../types'

const SRC = 'station-marker'

export function windLabel(o: StationObs, units: Units): string {
  if (o.windSpeedMs == null) return '—'
  if (o.windSpeedMs < 0.3 && !(o.windGustMs && o.windGustMs > 1)) return 'Calm'
  const dir = o.windDirDeg == null ? '' : ` from ${compass(o.windDirDeg)}`
  const gust = o.windGustMs != null && o.windGustMs > (o.windSpeedMs ?? 0) ? `, gusts ${U.speedNumber(o.windGustMs, units).toFixed(0)}` : ''
  return `${U.speedNumber(o.windSpeedMs, units).toFixed(0)}${gust} ${U.speedUnit(units)}${dir}`
}
export function compass(deg: number): string {
  const d = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return d[Math.round(deg / 22.5) % 16]
}

export function StationLayer() {
  const map = useMap()
  const enabled = useApp((s) => s.layers.station)
  const obs = useApp((s) => s.station.data)

  useEffect(() => {
    if (!map || !enabled || !obs || obs.provider !== 'weather.gov') return
    map.addSource(SRC, {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'Point', coordinates: [obs.lngLat.lng, obs.lngLat.lat] }, properties: {} },
    })
    map.addLayer({
      id: SRC,
      type: 'circle',
      source: SRC,
      paint: { 'circle-radius': 7, 'circle-color': '#e2e8f0', 'circle-stroke-color': '#0ea5e9', 'circle-stroke-width': 3 },
    })
    const onClick = (e: MapLayerMouseEvent) => {
      e.preventDefault()
      const units = store.get().units
      store.set({
        selection: {
          kind: 'station',
          lngLat: obs.lngLat,
          title: `${obs.name} (${obs.stationId})`,
          lines: [
            `${U.distance(obs.distanceM, units)} away · observed ${timeAgo(obs.observedAt)}`,
            `Pressure ${U.pressure(obs.pressureHpa, units)} · humidity ${obs.humidityPct == null ? '—' : obs.humidityPct.toFixed(0) + ' %'}`,
            `Wind ${windLabel(obs, units)}`,
            `Temperature ${U.temp(obs.tempC, units, 1)}`,
          ],
          source: 'NOAA NWS',
          updated: obs.observedAt,
        },
      })
    }
    map.on('click', SRC, onClick)
    const tip = attachTooltip(map, SRC, () => `${obs.name} · observed ${timeAgo(obs.observedAt)}`)
    return () => {
      tip()
      map.off('click', SRC, onClick)
      if (map.getLayer(SRC)) map.removeLayer(SRC)
      if (map.getSource(SRC)) map.removeSource(SRC)
    }
  }, [map, enabled, obs])

  return null
}
