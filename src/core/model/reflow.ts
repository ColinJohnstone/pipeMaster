import type { Part, Score } from './types'
import { createBar } from './create'
import { timeSigForBar } from './types'
import { barCapacityBeats, beats } from '../duration'

const EPS = 1e-6

/**
 * After an edit that may have over-filled a bar, push the overflowing notes
 * into the following bar (creating bars as needed), cascading down the part.
 * A single note longer than a whole bar is left in place rather than looping.
 *
 * Mutates `part` in place. Meant to be called inside an immer recipe.
 */
export function reflowPart(score: Score, partIndex: number, fromBar: number): void {
  const part: Part = score.parts[partIndex]
  let b = Math.max(0, fromBar)
  // Bound the walk: reflow can append at most as many bars as there are notes.
  let guard = part.bars.reduce((a, bar) => a + bar.notes.length, 0) + part.bars.length + 4

  while (b < part.bars.length && guard-- > 0) {
    const bar = part.bars[b]
    // A pickup bar has its own fixed capacity; other bars use the meter.
    const cap = bar.pickup ?? barCapacityBeats(timeSigForBar(score, partIndex, b))

    let used = 0
    let splitAt = bar.notes.length
    for (let k = 0; k < bar.notes.length; k++) {
      used += beats(bar.notes[k].duration)
      if (used > cap + EPS) {
        splitAt = k
        break
      }
    }

    // Fits, or the first note alone is longer than a bar — leave as is.
    if (splitAt >= bar.notes.length || splitAt === 0) {
      b++
      continue
    }

    const overflow = bar.notes.splice(splitAt)
    if (b + 1 >= part.bars.length) part.bars.push(createBar())
    part.bars[b + 1].notes.unshift(...overflow)
    b++
  }
}

/** Beats currently used in a bar. */
export function usedBeats(score: Score, partIndex: number, barIndex: number): number {
  const bar = score.parts[partIndex]?.bars[barIndex]
  if (!bar) return 0
  return bar.notes.reduce((a, n) => a + beats(n.duration), 0)
}
