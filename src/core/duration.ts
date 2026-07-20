/** Note length as a base value (1 = semibreve … 32 = demisemiquaver) plus dots. */
export interface Duration {
  base: 1 | 2 | 4 | 8 | 16 | 32
  dots: 0 | 1 | 2
}

export const DURATION_BASES = [1, 2, 4, 8, 16, 32] as const

/** Length in crotchet beats (crotchet = 1). */
export function beats(d: Duration): number {
  let b = 4 / d.base
  if (d.dots === 1) b *= 1.5
  if (d.dots === 2) b *= 1.75
  return b
}

/** Time scaling for a tuplet: n notes in the time of the previous power of 2. */
export function tupletRatio(tuplet?: number): number {
  if (!tuplet || tuplet < 2) return 1
  const normal = Math.pow(2, Math.floor(Math.log2(tuplet)))
  return normal / tuplet
}

/** Sounding length of a note in crotchet beats, accounting for any tuplet. */
export function noteBeats(note: { duration: Duration; tuplet?: number }): number {
  return beats(note.duration) * tupletRatio(note.tuplet)
}

export const DURATION_NAMES: Record<number, string> = {
  1: 'Semibreve',
  2: 'Minim',
  4: 'Crotchet',
  8: 'Quaver',
  16: 'Semiquaver',
  32: 'Demisemiquaver',
}

export interface TimeSig {
  beats: number // numerator
  unit: 2 | 4 | 8 | 16 // denominator
  /** Render as C (common) or cut-C instead of numerals. */
  symbol?: 'common' | 'cut'
}

export function barCapacityBeats(ts: TimeSig): number {
  return ts.beats * (4 / ts.unit)
}

/** Is this a compound meter (6/8, 9/8, 12/8) grouped in dotted-crotchet beats? */
export function isCompound(ts: TimeSig): boolean {
  return ts.unit === 8 && ts.beats % 3 === 0 && ts.beats >= 6
}

/**
 * Beat-group boundaries for beaming, in crotchet-beat offsets from bar start.
 * Compound meters group per dotted crotchet; simple meters per beat.
 */
export function beamGroupBoundaries(ts: TimeSig): number[] {
  const groupLen = isCompound(ts) ? 1.5 : 4 / ts.unit
  const total = barCapacityBeats(ts)
  const bounds: number[] = []
  for (let t = 0; t <= total + 1e-9; t += groupLen) bounds.push(t)
  return bounds
}
