import type { CheckedSource } from '../lib/freshness'
import { useApp } from '../state/store'

/**
 * The sources the Now screen shows, each with the name the summary uses: NWS alerts, the place's forecast (the
 * headline), the station's measured line, the nearby air monitors and, once loaded, the gauges of the Rivers tile.
 * The Sources & freshness page lists the same ones, so the status row's "within the last N min" holds there too.
 */
export function useNowSources(): CheckedSource[] {
  const alerts = useApp((s) => s.alerts)
  const conditions = useApp((s) => s.conditions)
  const station = useApp((s) => s.station)
  const monitors = useApp((s) => s.monitorsNear)
  const rivers = useApp((s) => s.rivers)
  return [
    { name: 'alerts', r: alerts },
    { name: 'forecast', r: conditions },
    { name: 'station', r: station },
    { name: 'air monitors', r: monitors },
    { name: 'gauges', r: rivers },
  ]
}
