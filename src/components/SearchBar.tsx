import { useEffect, useRef } from 'react'
import { store, useApp } from '../state/store'

interface Props {
  onLocate: () => void
  locating: boolean
}

/** Map top bar: the place chip (opens the shared place picker) and the locate button. */
export function SearchBar({ onLocate, locating }: Props) {
  const label = useApp((s) => s.placeLabel)
  const place = useApp((s) => s.place)
  const ref = useRef<HTMLDivElement>(null)
  // The layers panel sizes itself to the space below this bar: publish the bar's real height as --topbar-h
  // on .app (the CSS default is a fallback), the way the playback bar publishes --playbar-h.
  useEffect(() => {
    const el = ref.current
    const app = document.querySelector<HTMLElement>('.app')
    if (!el || !app) return
    const apply = () => app.style.setProperty('--topbar-h', `${el.offsetHeight}px`)
    apply()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null
    ro?.observe(el)
    return () => {
      ro?.disconnect()
      app.style.removeProperty('--topbar-h')
    }
  }, [])
  return (
    <div className="topbar" ref={ref}>
      <div className="place-chip-row">
        <button className="place-chip" onClick={() => store.set({ pickerOpen: true })} aria-label="Change place">
          <span className="chip-icon" aria-hidden="true">
            📍
          </span>
          <span className="chip-text">{place ? (label ?? place.name) : 'Pick a place'}</span>
        </button>
        <button className="icon-btn round" onClick={onLocate} disabled={locating} aria-label="Use my location">
          {locating ? '…' : '◎'}
        </button>
      </div>
    </div>
  )
}
