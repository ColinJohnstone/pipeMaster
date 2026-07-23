import type { Part, Score } from './types'

/**
 * First/second endings are spans of the note stream, marked by `voltaStart` on
 * the first note and `voltaStop` on the last. A resolved span points at those
 * notes by (bar, note) index within a part, so rendering, playback and export
 * can all read the same structure — and, unlike a whole-bar `volta`, a 1st and
 * a 2nd ending can live in the same bar.
 */
export interface VoltaSpan {
  num: 1 | 2
  startBar: number
  startNote: number
  endBar: number
  endNote: number
}

/** Resolve the ending spans in a part, in reading order. */
export function voltaSpans(part: Part): VoltaSpan[] {
  const spans: VoltaSpan[] = []
  let open: VoltaSpan | null = null
  part.bars.forEach((bar, bi) => {
    bar.notes.forEach((n, ni) => {
      if (n.voltaStart && !open) {
        open = { num: n.voltaStart, startBar: bi, startNote: ni, endBar: bi, endNote: ni }
      }
      if (open) {
        open.endBar = bi
        open.endNote = ni
        if (n.voltaStop) {
          spans.push(open)
          open = null
        }
      }
    })
  })
  // An ending left open (no explicit stop) runs to the end of the part.
  if (open) spans.push(open)
  return spans
}

/** The ending number covering a given note, or undefined. */
export function voltaAt(spans: VoltaSpan[], bar: number, note: number): 1 | 2 | undefined {
  for (const s of spans) {
    const afterStart = bar > s.startBar || (bar === s.startBar && note >= s.startNote)
    const beforeEnd = bar < s.endBar || (bar === s.endBar && note <= s.endNote)
    if (afterStart && beforeEnd) return s.num
  }
  return undefined
}

/**
 * Convert a legacy whole-bar `volta` (older saved scores and imports) into note
 * markers: a run of bars sharing a volta number becomes one span from the first
 * note of the run to the last. Mutates the score and clears the old field.
 */
export function migrateBarVoltas(score: Score): void {
  for (const part of score.parts) {
    const bars = part.bars as Array<Part['bars'][number] & { volta?: 1 | 2 }>
    let i = 0
    while (i < bars.length) {
      const v = bars[i].volta
      if (!v) {
        i++
        continue
      }
      let j = i
      while (j + 1 < bars.length && bars[j + 1].volta === v) j++
      // Mark the span across bars i..j at their first/last notes.
      const first = bars[i].notes[0]
      const lastBar = bars[j]
      const last = lastBar.notes[lastBar.notes.length - 1]
      if (first) first.voltaStart = v
      if (last) last.voltaStop = true
      for (let k = i; k <= j; k++) delete bars[k].volta
      i = j + 1
    }
  }
}
