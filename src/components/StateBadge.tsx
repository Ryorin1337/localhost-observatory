import { FAILURE_CODE, FAILURE_LABEL, STATE_META, stateLabel, TONE_VAR } from '../lib/meta'
import type { Conn, ConnState } from '../lib/types'

export function StateBadge({ state, failure }: { state: ConnState; failure?: Conn['failure'] }) {
  const meta = STATE_META[state]
  if (failure) {
    return (
      <span className="data inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-fg" title={FAILURE_LABEL[failure]}>
        <span aria-hidden="true" style={{ color: 'var(--critical)' }}>✕</span>
        {FAILURE_CODE[failure]}
      </span>
    )
  }
  return (
    <span className="data inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-fg" title={meta.hint}>
      <span aria-hidden="true" style={{ color: TONE_VAR[meta.tone] }}>{meta.glyph}</span>
      {stateLabel(state)}
    </span>
  )
}
