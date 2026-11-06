import { useEffect } from 'react'
import { attachTooltip } from './tooltip'
import type { MapLayerMouseEvent } from 'maplibre-gl'
import { FLOOD_CATEGORY_LABELS } from '../lib/colors'
import { timeAgo } from '../lib/time'
import { U, type Units } from '../lib/units'
import { setLayer, store, useApp } from '../state/store'
import { labelLayer, useMap } from './MapView'
import type { RiverGauge } from '../types'

const SRC = 'river-gauges'

export const RISK_COLORS: Record<RiverGauge['riskLevel'], string> = {
  normal: '#22c55e',
  elevated: '#facc15',
  high: '#f97316',
  flooding: '#ef4444',
  unknown: '#94a3b8',
}

/** A gauge's selection: it carries the gauge id, so the chip and the sheet redraw from the current list (one source). */
export function gaugeSelection(g: RiverGauge, units: Units, fetchedAt?: number) {
  return {
    kind: 'gauge' as const,
    gaugeId: g.id,
    lngLat: g.lngLat,
    title: g.name,
    lines: gaugeLines(g, units),
    source: g.sources.join(' + '),
    updated: fetchedAt,
  }
}
/**
 * Open a gauge's detail: the Map screen, the gauge layer on, and the bottom sheet at half for that gauge — from its
 * marker or from a list row (Home tile, Rivers page), with no chip or toast in between. From a list the map also
 * centres the gauge above the sheet.
 */
export function openGauge(g: RiverGauge, fromList: boolean) {
  const s = store.get()
  if (!s.layers.rivers) setLayer('rivers', true)
  store.set({
    screen: 'map',
    pickerOpen: false,
    selection: gaugeSelection(g, s.units, s.rivers.freshness?.fetchedAt),
    sheet: 'half',
    ...(fromList ? { selectionFlyNonce: s.selectionFlyNonce + 1 } : {}),
  })
}
export const gaugeLines = (g: RiverGauge, units: Units) => [`${FLOOD_CATEGORY_LABELS[g.floodCategory] ?? g.floodCategory} · risk: ${g.riskLevel}`, ...describeGauge(g, units)]

export function describeGauge(g: RiverGauge, units: Units): string[] {
  const lines: string[] = []
  if (g.stage)
    lines.push(
      g.stage.basis === 'elevation'
        ? `Water level ${U.stage(g.stage.value, g.stage.unit, units)} above sea level · ${timeAgo(g.stage.time)} (elevation-based gauge — not comparable with river stages)`
        : `Stage ${U.stage(g.stage.value, g.stage.unit, units)} · ${timeAgo(g.stage.time)}`,
    )
  if (g.flow) lines.push(`Flow ${U.flow(g.flow.value, g.flow.unit, units)} · ${timeAgo(g.flow.time)}${g.flow.source ? ` · ${g.flow.source}` : ''}`)
  if (g.categories?.minor) {
    const c = g.categories
    const t = (v?: number) => (v == null ? '—' : U.stageThreshold(v, c.unit, units))
    lines.push(`Flood stages (${U.stageUnit(units)}): action ${t(c.action)} · minor ${t(c.minor)} · moderate ${t(c.moderate)} · major ${t(c.major)}`)
  }
  if (g.forecast)
    lines.push(`Forecast ${U.stage(g.forecast.value, g.forecast.unit, units)} (${FLOOD_CATEGORY_LABELS[g.forecast.floodCategory] ?? g.forecast.floodCategory})`)
  if (g.flowRatio != null) lines.push(`Flow is ${g.flowRatio.toFixed(1)}× the 10-day median`)
  if (!lines.length) lines.push('No recent readings')
  return lines
}

export function RiversLayer() {
  const map = useMap()
  const enabled = useApp((s) => s.layers.rivers)
  const gauges = useApp((s) => s.rivers.data)

  useEffect(() => {
    if (!map || !enabled || !gauges) return
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: gauges.map((g) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [g.lngLat.lng, g.lngLat.lat] },
        properties: { id: g.id, color: RISK_COLORS[g.riskLevel], alert: g.riskLevel === 'flooding' || g.riskLevel === 'high' ? 1 : 0 },
      })),
    }
    map.addSource(SRC, { type: 'geojson', data: fc })
    map.addLayer({
      id: `${SRC}-halo`,
      type: 'circle',
      source: SRC,
      filter: ['==', ['get', 'alert'], 1],
      paint: { 'circle-radius': 14, 'circle-color': ['get', 'color'], 'circle-opacity': 0.25 },
    }, labelLayer(map))
    map.addLayer({
      id: SRC,
      type: 'circle',
      source: SRC,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 5, 12, 9],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#0b1220',
        'circle-stroke-width': 1.5,
      },
    }, labelLayer(map))
    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0]
      if (!f) return
      e.preventDefault()
      const g = gauges.find((x) => x.id === f.properties?.id)
      if (!g) return
      openGauge(g, false)
    }
    const enter = () => (map.getCanvas().style.cursor = 'pointer')
    const leave = () => (map.getCanvas().style.cursor = '')
    map.on('click', SRC, onClick)
    map.on('mouseenter', SRC, enter)
    map.on('mouseleave', SRC, leave)
    const tip = attachTooltip(map, SRC, (p) => { const g = store.get().rivers.data?.find((x) => x.id === p.id); return g ? `${g.name} · ${FLOOD_CATEGORY_LABELS[g.floodCategory] ?? g.riskLevel}` : null })
    return () => {
      map.off('click', SRC, onClick)
      map.off('mouseenter', SRC, enter)
      map.off('mouseleave', SRC, leave)
      tip()
      for (const id of [SRC, `${SRC}-halo`]) if (map.getLayer(id)) map.removeLayer(id)
      if (map.getSource(SRC)) map.removeSource(SRC)
    }
  }, [map, enabled, gauges])

  return null
}
