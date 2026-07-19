import { STAFF_POSITION, type Pitch } from '../core/pitch'
import { expandEmbellishment, type EmbellishmentType } from '../core/embellishments/registry'

/**
 * A small notation icon for an embellishment: a reference melody note with
 * its gracenote cluster drawn above, so pipers can pick by the familiar
 * shape rather than an abbreviation.
 */

const W = 58
const H = 60
const SP = 5 // staff space
const BOTTOM = 46 // y of the bottom staff line (pitch position 0)

const yOf = (pitch: Pitch) => BOTTOM - STAFF_POSITION[pitch] * (SP / 2)

// A reference pitch each embellishment is valid on, preferring the ones
// pipers usually see it written against.
const PREF: Pitch[] = ['D', 'LowA', 'B', 'E', 'C', 'F', 'LowG', 'HighG']

function referencePitch(type: EmbellishmentType): Pitch {
  for (const p of PREF) {
    const g = expandEmbellishment({ type }, p)
    if (g.length > 0) return p
  }
  return 'LowA'
}

export function EmbellishmentPreview({ type }: { type: EmbellishmentType }) {
  const melody = referencePitch(type)
  const graces = expandEmbellishment({ type }, melody)

  const noteX = W - 14
  const noteY = yOf(melody)

  // Gracenotes lead right into the melody note: the cluster ends just before
  // the notehead and spreads backward, clamped to the left edge.
  const gStep = 5
  const gEndX = noteX - 10
  const gStartX = Math.max(7, gEndX - (graces.length - 1) * gStep)
  const graceEls = graces.map((g, i) => ({
    x: gStartX + i * gStep,
    y: yOf(g),
  }))
  const beamY = Math.min(...graceEls.map((g) => g.y), noteY - 12) - 3

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <line
          key={i}
          x1={2}
          x2={W - 2}
          y1={BOTTOM - i * SP}
          y2={BOTTOM - i * SP}
          stroke="var(--staff-mini)"
          strokeWidth={0.6}
        />
      ))}

      {/* Gracenote cluster */}
      {graceEls.map((g, i) => (
        <g key={i}>
          <line x1={g.x + 1.6} x2={g.x + 1.6} y1={g.y} y2={beamY} stroke="var(--ink-mini)" strokeWidth={0.7} />
          <ellipse cx={g.x} cy={g.y} rx={1.9} ry={1.4} fill="var(--ink-mini)" />
        </g>
      ))}
      {graceEls.length > 1 && (
        <line
          x1={graceEls[0].x + 1.6}
          x2={graceEls[graceEls.length - 1].x + 1.6}
          y1={beamY}
          y2={beamY}
          stroke="var(--ink-mini)"
          strokeWidth={1.6}
        />
      )}
      {graceEls.length === 1 && (
        <line
          x1={graceEls[0].x + 1.6}
          x2={graceEls[0].x + 4}
          y1={beamY}
          y2={beamY + 1.5}
          stroke="var(--ink-mini)"
          strokeWidth={1.4}
        />
      )}

      {/* Reference melody note (stem down, pipe convention) */}
      <line x1={noteX - 3} x2={noteX - 3} y1={noteY} y2={noteY + 16} stroke="var(--ink-mini)" strokeWidth={1} />
      <ellipse cx={noteX} cy={noteY} rx={3.1} ry={2.3} fill="var(--ink-mini)" transform={`rotate(-18 ${noteX} ${noteY})`} />
    </svg>
  )
}
