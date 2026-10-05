/** Colour ramps shared by layers and legends. */

export interface Stop {
  value: number
  color: string
  label: string
}

/** Rainfall accumulation (mm). */
export const RAIN_STOPS: Stop[] = [
  { value: 0.2, color: 'rgba(147,197,253,0.35)', label: 'trace' },
  { value: 1, color: 'rgba(96,165,250,0.5)', label: '1' },
  { value: 3, color: 'rgba(59,130,246,0.6)', label: '3' },
  { value: 8, color: 'rgba(34,197,94,0.65)', label: '8' },
  { value: 15, color: 'rgba(250,204,21,0.7)', label: '15' },
  { value: 30, color: 'rgba(249,115,22,0.75)', label: '30' },
  { value: 60, color: 'rgba(239,68,68,0.8)', label: '60+' },
]

/** Flood-risk score 0..1. */
export const FLOOD_STOPS: Stop[] = [
  { value: 0.15, color: 'rgba(56,189,248,0.0)', label: 'low' },
  { value: 0.3, color: 'rgba(250,204,21,0.45)', label: 'elevated' },
  { value: 0.55, color: 'rgba(249,115,22,0.6)', label: 'high' },
  { value: 0.8, color: 'rgba(220,38,38,0.75)', label: 'severe' },
]

/** Cloud cover 0..100 (%). */
export const CLOUD_STOPS: Stop[] = [
  { value: 20, color: 'rgba(255,255,255,0.0)', label: 'clear' },
  { value: 50, color: 'rgba(226,232,240,0.25)', label: 'partly' },
  { value: 80, color: 'rgba(203,213,225,0.45)', label: 'mostly' },
  { value: 100, color: 'rgba(148,163,184,0.6)', label: 'overcast' },
]

/** NOAA flood categories. */
export const FLOOD_CATEGORY_COLORS: Record<string, string> = {
  no_flooding: '#22c55e',
  action: '#facc15',
  minor: '#fb923c',
  moderate: '#ef4444',
  major: '#a855f7',
  not_defined: '#94a3b8',
  obs_not_current: '#64748b',
  out_of_service: '#475569',
  low_threshold: '#38bdf8',
  unknown: '#94a3b8',
}
export const FLOOD_CATEGORY_LABELS: Record<string, string> = {
  no_flooding: 'No flooding',
  action: 'Action stage',
  minor: 'Minor flooding',
  moderate: 'Moderate flooding',
  major: 'Major flooding',
  not_defined: 'No categories',
  obs_not_current: 'Obs not current',
  out_of_service: 'Out of service',
  low_threshold: 'Low water',
  unknown: 'Unknown',
}

/** Build a MapLibre `step` expression from stops. */
export function stepExpression(prop: unknown[], stops: Stop[], base = 'rgba(0,0,0,0)'): unknown[] {
  const expr: unknown[] = ['step', prop, base]
  for (const s of stops) expr.push(s.value, s.color)
  return expr
}

/** Pick the colour for a value from stops (for canvas / legends). */
export function colorFor(v: number, stops: Stop[], base = 'rgba(0,0,0,0)'): string {
  let c = base
  for (const s of stops) if (v >= s.value) c = s.color
  return c
}
