import type { Score, NoteAddress } from './types'

/** Every note address in a part, in reading order. */
export function partNoteAddresses(score: Score, partIndex: number): NoteAddress[] {
  const out: NoteAddress[] = []
  score.parts[partIndex]?.bars.forEach((bar, barIndex) => {
    bar.notes.forEach((_, noteIndex) => out.push({ partIndex, barIndex, noteIndex }))
  })
  return out
}

const sameAddr = (a: NoteAddress, b: NoteAddress) =>
  a.partIndex === b.partIndex && a.barIndex === b.barIndex && a.noteIndex === b.noteIndex

/**
 * The inclusive range of note addresses between two endpoints, in reading
 * order. Ranges are confined to a single part; a cross-part pair collapses to
 * just the focus.
 */
export function rangeAddresses(
  score: Score,
  anchor: NoteAddress,
  focus: NoteAddress,
): NoteAddress[] {
  if (anchor.partIndex !== focus.partIndex) return [focus]
  const all = partNoteAddresses(score, anchor.partIndex)
  const ia = all.findIndex((x) => sameAddr(x, anchor))
  const ib = all.findIndex((x) => sameAddr(x, focus))
  if (ia < 0 || ib < 0) return [focus]
  const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia]
  return all.slice(lo, hi + 1)
}

/** Stable string key for a note address (for Set membership in the renderer). */
export const addrKey = (a: NoteAddress) => `${a.partIndex}:${a.barIndex}:${a.noteIndex}`

/** Move a note address by `dir` steps within its part's reading order. */
export function stepAddress(
  score: Score,
  addr: NoteAddress,
  dir: 1 | -1,
): NoteAddress | null {
  const all = partNoteAddresses(score, addr.partIndex)
  const i = all.findIndex((x) => sameAddr(x, addr))
  if (i < 0) return null
  const j = i + dir
  return j >= 0 && j < all.length ? all[j] : null
}
