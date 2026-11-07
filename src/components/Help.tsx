import { useEffect, useRef } from 'react'
import { usePresence } from '../hooks/usePresence'
import { AQI_CATEGORIES } from '../lib/aqi'
import { U } from '../lib/units'
import { RISK_COLORS } from '../map/RiversLayer'
import { store, useApp, type HelpTopic } from '../state/store'

/** The wind speed at which a streak reaches its darkest (NowcastLayer: alpha = 0.25 + speed / 12, capped at 0.9). */
const DARKEST_STREAK_MS = (0.9 - 0.25) * 12

/** What each gauge colour means — the rules in DataController's classifyRisk, in words. */
const GAUGE_ROWS: { level: keyof typeof RISK_COLORS; name: string; text: string }[] = [
  { level: 'flooding', name: 'Red · flooding', text: 'NOAA puts the river in flood (minor, moderate or major flood stage).' },
  { level: 'high', name: 'Orange · high', text: "NOAA's action stage is reached, or a USGS site's flow is 3× or more its median of the last 10 days." },
  { level: 'elevated', name: 'Yellow · elevated', text: "The stage is at 75 % of the minor flood stage or more, or a USGS site's flow is 1.75–3× its 10-day median." },
  { level: 'normal', name: 'Green · normal', text: 'None of the above: below those marks, or NOAA reports no flooding.' },
  { level: 'unknown', name: 'Grey · unknown', text: 'No reading in the last 12 hours, or nothing to compare the reading with. A stale reading never shows as green.' },
]

/**
 * "What am I looking at?": what the river-gauge colours, the wind streaks and the air-quality discs mean
 * (Nov 6 audit: nothing explained them except a legend that was cut off). The More tab shows it as a page; the
 * Layers menu's "What's this?" links (in the gauge, wind and air-quality legend titles) open it as a panel at that section.
 */
export function HelpContent({ focus }: { focus?: HelpTopic | null }) {
  const units = useApp((s) => s.units)
  const refs = { gauges: useRef<HTMLElement>(null), wind: useRef<HTMLElement>(null), aqi: useRef<HTMLElement>(null) }
  useEffect(() => {
    if (focus && focus !== 'all') refs[focus].current?.scrollIntoView({ block: 'start' })
  }, [focus]) // eslint-disable-line react-hooks/exhaustive-deps
  const mark = (t: HelpTopic) => (focus === t ? 'help-section focus' : 'help-section')
  return (
    <div className="help-content">
      <section ref={refs.gauges} className={mark('gauges')} data-topic="gauges" aria-labelledby="help-gauges">
        <h3 id="help-gauges">River gauge dots</h3>
        <p className="muted">Each dot is a NOAA or USGS gauge. Its colour says how high the river is against that gauge&apos;s own flood marks; orange and red dots also get a soft halo.</p>
        <ul className="help-list">
          {GAUGE_ROWS.map((r) => (
            <li key={r.level} data-level={r.level}>
              <i className="dot" style={{ background: RISK_COLORS[r.level] }} aria-hidden="true" />
              <span>
                <strong>{r.name}</strong> — {r.text}
              </span>
            </li>
          ))}
        </ul>
        <p className="muted">
          Iowa Flood Center sensors report the water surface above sea level (hundreds of feet), labelled &ldquo;elevation&rdquo;. Compare one of those with its own history, not with another gauge&apos;s stage. Tap a dot for its reading and flood stages.
        </p>
      </section>
      <section ref={refs.wind} className={mark('wind')} data-topic="wind" aria-labelledby="help-wind">
        <h3 id="help-wind">Wind streaks</h3>
        <p>
          The moving lines drift with the forecast wind 10 m above the ground (Open-Meteo) at the time on the playback clock. The faster and darker a streak, the stronger the wind; streaks are darkest from about {U.speed(DARKEST_STREAK_MS, units)} up.
        </p>
        <p className="muted">One second of animation is about 6 minutes of real drift, and the tails grow as you zoom in. Streaks show direction and relative speed, not gusts: the wind for your place is on Now.</p>
      </section>
      <section ref={refs.aqi} className={mark('aqi')} data-topic="aqi" aria-labelledby="help-aqi">
        <h3 id="help-aqi">Air-quality discs</h3>
        <p>
          Each shaded disc is a 25 km circle around an EPA AirNow monitor with a reading less than 2 hours old, in the colour of that reading&apos;s US AQI category. Where discs overlap, the worse reading shows. No shading means no recent monitor there: the app never estimates between monitors.
        </p>
        <ul className="help-list" aria-label="US AQI categories">
          {AQI_CATEGORIES.map((c) => (
            <li key={c.key} data-aqi={c.key}>
              <i className="dot" style={{ background: c.color }} aria-hidden="true" />
              <span>
                <strong>{c.name}</strong> · {c.max === Infinity ? `${c.min}+` : `${c.min}–${c.max}`}
              </span>
            </li>
          ))}
        </ul>
        <p className="muted">The discs show smoke (PM2.5) or ozone, one at a time (switch in the Layers menu). The Air monitors layer adds a dot per monitor; a grey dot is stale or offline. AirNow data are preliminary.</p>
      </section>
      <p className="muted help-foot">Radar, satellite, rain and flood-risk colours are in the legend at the bottom of the Layers menu (☰).</p>
    </div>
  )
}

/** The help as a panel over the map, opened from the Layers menu at one layer's section. */
export function HelpPanel() {
  const topic = useApp((s) => s.helpTopic)
  const presence = usePresence(topic != null)
  // Keep the last topic while the panel fades out.
  const last = useRef<HelpTopic>('all')
  if (topic) last.current = topic
  if (!presence.mounted) return null
  return (
    <div className="help-panel pop" data-state={presence.state} onTransitionEnd={presence.onTransitionEnd} role="dialog" aria-label="What am I looking at?">
      <div className="chooser-title">
        <strong>What am I looking at?</strong>
        <button className="icon-btn" onClick={() => store.set({ helpTopic: null })} aria-label="Close help">
          ×
        </button>
      </div>
      <HelpContent focus={last.current} />
    </div>
  )
}

const LINK_LABEL: Record<Exclude<HelpTopic, 'all'>, string> = { gauges: 'What the gauge colours mean', wind: 'What the wind streaks mean', aqi: 'What the air-quality colours mean' }

/** "What's this?" at the end of a legend row's title (no extra line, so the legend stays as short as before): opens the help at that layer's section. */
export function HelpLink({ topic }: { topic: Exclude<HelpTopic, 'all'> }) {
  return (
    <button type="button" className="help-link" data-topic={topic} aria-label={LINK_LABEL[topic]} onClick={() => store.set({ helpTopic: topic })}>
      What&apos;s this?
    </button>
  )
}
