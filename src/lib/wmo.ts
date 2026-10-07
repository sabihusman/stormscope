/** WMO weather interpretation codes (as used by Open-Meteo) → label + icon. */
const TABLE: [number[], string, string, string][] = [
  // codes, label, day icon, night icon
  [[0], 'Clear', '☀️', '🌙'],
  [[1], 'Mostly clear', '🌤', '🌙'],
  [[2], 'Partly cloudy', '⛅', '☁️'],
  [[3], 'Overcast', '☁️', '☁️'],
  [[45, 48], 'Fog', '🌫', '🌫'],
  [[51, 53, 55], 'Drizzle', '🌦', '🌧'],
  [[56, 57], 'Freezing drizzle', '🌧', '🌧'],
  [[61], 'Light rain', '🌧', '🌧'],
  [[63], 'Rain', '🌧', '🌧'],
  [[65], 'Heavy rain', '🌧', '🌧'],
  [[66, 67], 'Freezing rain', '🧊', '🧊'],
  [[71], 'Light snow', '🌨', '🌨'],
  [[73], 'Snow', '🌨', '🌨'],
  [[75], 'Heavy snow', '❄️', '❄️'],
  [[77], 'Snow grains', '🌨', '🌨'],
  [[80], 'Light showers', '🌦', '🌧'],
  [[81], 'Showers', '🌧', '🌧'],
  [[82], 'Violent showers', '⛈', '⛈'],
  [[85], 'Snow showers', '🌨', '🌨'],
  [[86], 'Heavy snow showers', '❄️', '❄️'],
  [[95], 'Thunderstorm', '⛈', '⛈'],
  [[96, 99], 'Thunderstorm with hail', '⛈', '⛈'],
]

export function wmo(code: number | null | undefined, isDay = true): { label: string; icon: string } {
  if (code == null) return { label: '—', icon: '·' }
  const row = TABLE.find((r) => r[0].includes(code))
  if (!row) return { label: `Code ${code}`, icon: '·' }
  return { label: row[1], icon: isDay ? row[2] : row[3] }
}
