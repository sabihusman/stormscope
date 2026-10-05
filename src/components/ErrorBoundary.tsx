import { Component, type ReactNode } from 'react'
import { store, toast, type LayerId } from '../state/store'

/**
 * Containment: one layer or panel throwing must never unmount the app.
 *  - kind "layer": the layer is switched off, its error is recorded (shown in the layer menu as
 *    "unavailable — reason"), a toast says so, and nothing is rendered. Re-enabling the layer
 *    remounts the boundary (keyed on the toggle) and retries.
 *  - kind "panel": the panel area shows "unavailable — reason" with a Retry button.
 */
type Props = { name: string; kind: 'layer' | 'panel'; layer?: LayerId; children: ReactNode }
type State = { error: string | null }

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160)

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }
  static getDerivedStateFromError(e: unknown): State {
    return { error: describe(e) }
  }
  componentDidCatch(e: unknown) {
    const msg = describe(e)
    console.error(`[${this.props.name}] failed and was contained:`, e)
    if (this.props.kind === 'layer' && this.props.layer) {
      const key = this.props.layer
      store.set((s) => ({ layers: { ...s.layers, [key]: false }, layerErrors: { ...s.layerErrors, [key]: msg } }))
      toast(`${this.props.name} turned off: ${msg}`, 'error')
    } else if (this.props.kind === 'layer') {
      store.set((s) => ({ layerErrors: { ...s.layerErrors, [this.props.name]: msg } }))
      toast(`${this.props.name} unavailable: ${msg}`, 'error')
    }
  }
  render() {
    if (!this.state.error) return this.props.children
    if (this.props.kind === 'layer') return null
    return (
      <div className="panel-empty" role="alert">
        <p className="err-text">
          {this.props.name} unavailable — {this.state.error}
        </p>
        <button className="btn small" onClick={() => this.setState({ error: null })}>
          Retry
        </button>
      </div>
    )
  }
}
