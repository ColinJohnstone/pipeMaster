import type { Bar, Part, Score } from './types'
import { createBar } from './create'
import { timeSigForBar } from './types'
import { barCapacityBeats, noteBeats } from '../duration'

const EPS = 1e-6

/**
 * May a note flow across the boundary between two adjacent bars? It may not
 * cross anything that marks a structural division — a repeat sign, the start of
 * a first/second ending, a meter change, or a pickup bar — because moving notes
 * over one of those would corrupt the section it delimits.
 */
function softBoundary(prev: Bar, next: Bar): boolean {
  if (prev.repeatEnd || next.repeatStart) return false
  if (next.timeSig) return false
  if (next.pickup !== undefined) return false
  // Ending brackets are carried on the notes themselves, so they travel with a
  // note when it flows across a barline — no boundary check is needed for them.
  return true
}

function hasNoMarkers(bar: Bar): boolean {
  return (
    !bar.repeatStart &&
    !bar.repeatEnd &&
    bar.timeSig === undefined &&
    bar.pickup === undefined
  )
}

/**
 * Keep every bar filled to its meter after an edit, in both directions.
 *
 * Forward: notes that overflow a bar spill into the next, cascading down the
 * part and creating bars as needed. Backward: a bar left short — by a note made
 * shorter or deleted, or by widening the meter — pulls notes back from the bars
 * that follow. Neither pass crosses a structural boundary (see softBoundary), so
 * repeats, endings, meter changes and pickup bars stay intact.
 *
 * Mutates `part` in place. Meant to be called inside an immer recipe.
 */
export function reflowPart(score: Score, partIndex: number, fromBar: number): void {
  const part: Part = score.parts[partIndex]
  const capOf = (b: number): number =>
    part.bars[b].pickup ?? barCapacityBeats(timeSigForBar(score, partIndex, b))

  // Bound both walks: each moves a note permanently or removes a bar, so the
  // total work is finite; this guard is only a backstop against a logic slip.
  let guard = part.bars.reduce((a, bar) => a + bar.notes.length, 0) + part.bars.length + 8

  // --- Forward: spill overflow into the following bar. ----------------------
  let b = Math.max(0, fromBar)
  while (b < part.bars.length && guard-- > 0) {
    const bar = part.bars[b]
    const cap = capOf(b)
    let used = 0
    let splitAt = bar.notes.length
    for (let k = 0; k < bar.notes.length; k++) {
      used += noteBeats(bar.notes[k])
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

  // --- Backward: pull following notes into a bar left short. -----------------
  guard = part.bars.reduce((a, bar) => a + bar.notes.length, 0) + part.bars.length + 8
  b = Math.max(0, fromBar)
  while (b < part.bars.length && guard-- > 0) {
    const bar = part.bars[b]
    const cap = capOf(b)
    let used = bar.notes.reduce((a, n) => a + noteBeats(n), 0)
    while (used < cap - EPS && b + 1 < part.bars.length) {
      const donor = part.bars[b + 1]
      if (!softBoundary(bar, donor)) break
      // An empty donor the pull did not create is the user's own bar; a boundary
      // stops the flow, so leave it and move on rather than pulling past it.
      if (donor.notes.length === 0) break
      const nb = noteBeats(donor.notes[0])
      if (used + nb > cap + EPS) break
      bar.notes.push(donor.notes.shift()!)
      used += nb
      // A bar emptied by the pull, carrying no markers and soft on both sides,
      // is spliced out so the flow continues into what lay beyond it.
      if (
        donor.notes.length === 0 &&
        hasNoMarkers(donor) &&
        (b + 2 >= part.bars.length || softBoundary(donor, part.bars[b + 2]))
      ) {
        part.bars.splice(b + 1, 1)
      }
    }
    b++
  }

  if (part.bars.length === 0) part.bars.push(createBar())
}

/** Beats currently used in a bar. */
export function usedBeats(score: Score, partIndex: number, barIndex: number): number {
  const bar = score.parts[partIndex]?.bars[barIndex]
  if (!bar) return 0
  return bar.notes.reduce((a, n) => a + noteBeats(n), 0)
}
