import { go, useApp, type Screen } from '../state/store'

const ITEMS: { id: Screen; label: string; icon: string }[] = [
  { id: 'now', label: 'Now', icon: '🌤' },
  { id: 'map', label: 'Map', icon: '🗺' },
  { id: 'trip', label: 'Trip', icon: '🚗' },
  { id: 'more', label: 'More', icon: '☰' },
]

/** Bottom navigation on a phone; a left rail on wider screens (CSS). Hidden while picking a point on the map. */
export function Nav() {
  const screen = useApp((s) => s.screen)
  const pickMode = useApp((s) => s.pickMode)
  const alerts = useApp((s) => s.alerts.data?.alerts.length ?? 0)
  if (pickMode) return null
  return (
    <nav className="nav" aria-label="Main">
      {ITEMS.map((it) => (
        <button key={it.id} className={`nav-item ${screen === it.id ? 'on' : ''}`} aria-current={screen === it.id ? 'page' : undefined} onClick={() => go(it.id, it.id === 'more' ? null : undefined)}>
          <span className="nav-icon" aria-hidden="true">
            {it.icon}
          </span>
          <span className="nav-label">{it.label}</span>
          {it.id === 'now' && alerts > 0 && <span className="nav-badge" aria-label={`${alerts} active alerts`}>{alerts}</span>}
        </button>
      ))}
    </nav>
  )
}
