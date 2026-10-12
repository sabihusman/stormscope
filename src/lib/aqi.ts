/**
 * US Air Quality Index categories, breakpoints and colours.
 *
 * Source: US EPA, "Technical Assistance Document for the Reporting of Daily Air Quality – the Air Quality
 * Index (AQI)", EPA-403/B-26-003, May 2026 — Table 1 (categories and index ranges) and Table 2 "Standard AQI
 * color formulas" (RGB): Green 0,228,0 · Yellow 255,255,0 · Orange 255,126,0 · Red 255,0,0 · Purple
 * 143,63,151 · Maroon 126,0,35. (AirNow.gov "AQI Basics" lists the same six categories by colour name.)
 */
export interface AqiCategory {
  /** Stable key for class names and tests. */
  key: 'good' | 'moderate' | 'usg' | 'unhealthy' | 'very-unhealthy' | 'hazardous'
  name: string
  /** Inclusive index range; the last category is open-ended. */
  min: number
  max: number
  /** EPA standard colour, hex of the RGB formula. */
  color: string
  /** Legible text colour on the swatch. */
  text: string
}

export const AQI_CATEGORIES: AqiCategory[] = [
  { key: 'good', name: 'Good', min: 0, max: 50, color: '#00E400', text: '#041019' },
  { key: 'moderate', name: 'Moderate', min: 51, max: 100, color: '#FFFF00', text: '#041019' },
  { key: 'usg', name: 'Unhealthy for Sensitive Groups', min: 101, max: 150, color: '#FF7E00', text: '#041019' },
  { key: 'unhealthy', name: 'Unhealthy', min: 151, max: 200, color: '#FF0000', text: '#ffffff' },
  { key: 'very-unhealthy', name: 'Very Unhealthy', min: 201, max: 300, color: '#8F3F97', text: '#ffffff' },
  { key: 'hazardous', name: 'Hazardous', min: 301, max: Infinity, color: '#7E0023', text: '#ffffff' },
]

/** The category an AQI value falls in (values are rounded to whole numbers first, as the index is reported). */
export function aqiCategory(aqi: number | null | undefined): AqiCategory | null {
  if (aqi == null || !Number.isFinite(aqi)) return null
  const v = Math.round(aqi)
  return AQI_CATEGORIES.find((c) => v >= c.min && v <= c.max) ?? AQI_CATEGORIES[AQI_CATEGORIES.length - 1]
}

/** Pollutant keys as the Open-Meteo per-pollutant US AQI variables name them, with display names. */
export const POLLUTANTS: { key: 'pm2_5' | 'pm10' | 'ozone' | 'nitrogen_dioxide' | 'sulphur_dioxide' | 'carbon_monoxide'; name: string; short: string }[] = [
  { key: 'pm2_5', name: 'fine particles (PM2.5)', short: 'PM2.5' },
  { key: 'pm10', name: 'coarse particles (PM10)', short: 'PM10' },
  { key: 'ozone', name: 'ozone', short: 'O₃' },
  { key: 'nitrogen_dioxide', name: 'nitrogen dioxide', short: 'NO₂' },
  { key: 'sulphur_dioxide', name: 'sulphur dioxide', short: 'SO₂' },
  { key: 'carbon_monoxide', name: 'carbon monoxide', short: 'CO' },
]

/** Attribution Open-Meteo requires for its air-quality data (CAMS) plus the reference to Open-Meteo itself. */
export const AQI_ATTRIBUTION = 'Open-Meteo.com · Copernicus Atmosphere Monitoring Service (CAMS) — modeled estimate'
