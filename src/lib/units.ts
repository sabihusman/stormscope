/**
 * Unit system. All data is stored in SI-ish source units (mm, m/s, hPa, °C,
 * metres) plus USGS/NOAA river units (ft, ft³/s); these helpers format for
 * display in the user's chosen system.
 */
export type Units = 'metric' | 'imperial'

export const defaultUnits = (): Units => {
  try {
    const saved = localStorage.getItem('stormscope.units')
    if (saved === 'metric' || saved === 'imperial') return saved
  } catch {
    /* ignore */
  }
  const lang = typeof navigator !== 'undefined' ? navigator.language : ''
  return /-(US|LR|MM)$/i.test(lang) ? 'imperial' : 'metric'
}

const fmt = (v: number, digits: number) => v.toFixed(digits)

export const U = {
  temp: (c: number | null | undefined, u: Units, digits = 0) =>
    c == null ? '—' : u === 'imperial' ? `${fmt((c * 9) / 5 + 32, digits)} °F` : `${fmt(c, digits)} °C`,

  /** Wind / speed from m/s. */
  speed: (ms: number | null | undefined, u: Units) =>
    ms == null ? '—' : u === 'imperial' ? `${fmt(ms * 2.23694, 0)} mph` : `${fmt(ms * 3.6, 0)} km/h`,
  speedNumber: (ms: number, u: Units) => (u === 'imperial' ? ms * 2.23694 : ms * 3.6),
  speedUnit: (u: Units) => (u === 'imperial' ? 'mph' : 'km/h'),

  pressure: (hpa: number | null | undefined, u: Units) =>
    hpa == null ? '—' : u === 'imperial' ? `${fmt(hpa * 0.02953, 2)} inHg` : `${fmt(hpa, 1)} hPa`,

  /** Precipitation depth from mm. */
  precip: (mm: number | null | undefined, u: Units, digits?: number) =>
    mm == null ? '—' : u === 'imperial' ? `${fmt(mm / 25.4, digits ?? 2)} in` : `${fmt(mm, digits ?? 1)} mm`,
  precipNumber: (mm: number, u: Units) => (u === 'imperial' ? mm / 25.4 : mm),
  precipUnit: (u: Units) => (u === 'imperial' ? 'in' : 'mm'),
  /** Short legend label for a mm threshold. */
  precipLabel: (mm: number, u: Units) => {
    if (u === 'metric') return `${mm}`
    const inch = mm / 25.4
    return inch < 0.1 ? inch.toFixed(2) : inch < 1 ? inch.toFixed(1) : inch.toFixed(1)
  },

  /** Distances from metres. */
  distance: (m: number | null | undefined, u: Units) => {
    if (m == null || !Number.isFinite(m)) return '—'
    if (u === 'imperial') {
      const ft = m * 3.28084
      if (ft < 1000) return `${Math.round(ft)} ft`
      const mi = m / 1609.344
      return `${mi.toFixed(mi < 10 ? 1 : 0)} mi`
    }
    if (m < 1000) return `${Math.round(m)} m`
    return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`
  },

  /** Elevation / height from metres. */
  height: (m: number | null | undefined, u: Units, digits = 0) =>
    m == null ? '—' : u === 'imperial' ? `${fmt(m * 3.28084, digits)} ft` : `${fmt(m, digits)} m`,

  /** River stage: source unit is usually ft (USGS/NOAA). */
  stage: (v: number, unit: string, u: Units) => {
    const isFt = /ft/i.test(unit)
    if (u === 'imperial') return isFt ? `${v.toFixed(2)} ft` : `${(v * 3.28084).toFixed(2)} ft`
    return isFt ? `${(v * 0.3048).toFixed(2)} m` : `${v.toFixed(2)} m`
  },
  stageThreshold: (v: number, unit: string, u: Units) => {
    const isFt = /ft/i.test(unit)
    if (u === 'imperial') return (isFt ? v : v * 3.28084).toFixed(1)
    return (isFt ? v * 0.3048 : v).toFixed(1)
  },
  stageUnit: (u: Units) => (u === 'imperial' ? 'ft' : 'm'),

  /** River discharge: source unit is usually ft³/s. */
  flow: (v: number, unit: string, u: Units) => {
    const isCfs = /ft/i.test(unit)
    if (u === 'imperial') return `${Math.round(isCfs ? v : v * 35.3147).toLocaleString()} ft³/s`
    return `${(isCfs ? v * 0.0283168 : v).toLocaleString(undefined, { maximumFractionDigits: 1 })} m³/s`
  },
}
