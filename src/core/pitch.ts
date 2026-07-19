/**
 * The nine written pitches of the Great Highland Bagpipe scale.
 * Written on the treble staff from Low G (second line) to High A
 * (first ledger line above). C and F are understood sharp.
 */
export const PITCHES = [
  'LowG',
  'LowA',
  'B',
  'C',
  'D',
  'E',
  'F',
  'HighG',
  'HighA',
] as const

export type Pitch = (typeof PITCHES)[number]

export const PITCH_LABELS: Record<Pitch, string> = {
  LowG: 'Low G',
  LowA: 'Low A',
  B: 'B',
  C: 'C',
  D: 'D',
  E: 'E',
  F: 'F',
  HighG: 'High G',
  HighA: 'High A',
}

/**
 * Diatonic staff position: steps above the bottom staff line (E4 = 0).
 * Even = on a line, odd = in a space. Low G = 2 (G line), High A = 10.
 */
export const STAFF_POSITION: Record<Pitch, number> = {
  LowG: 2,
  LowA: 3,
  B: 4,
  C: 5,
  D: 6,
  E: 7,
  F: 8,
  HighG: 9,
  HighA: 10,
}

/**
 * Just-intonation frequency ratios relative to Low A — tuned against the
 * drones, as a real chanter is, rather than equal temperament.
 */
export const PITCH_RATIO: Record<Pitch, number> = {
  LowG: 8 / 9,
  LowA: 1,
  B: 9 / 8,
  C: 5 / 4, // C sharp
  D: 4 / 3,
  E: 3 / 2,
  F: 5 / 3, // F sharp
  HighG: 16 / 9,
  HighA: 2,
}

/** Modern pipe chanter Low A sits near 480 Hz; practice chanter near 440. */
export const LOW_A_HZ = { pipes: 480, practiceChanter: 440 } as const

export function frequency(pitch: Pitch, lowA: number): number {
  return lowA * PITCH_RATIO[pitch]
}

export function pitchAbove(pitch: Pitch): Pitch | null {
  const i = PITCHES.indexOf(pitch)
  return i < PITCHES.length - 1 ? PITCHES[i + 1] : null
}

export function pitchBelow(pitch: Pitch): Pitch | null {
  const i = PITCHES.indexOf(pitch)
  return i > 0 ? PITCHES[i - 1] : null
}

/** Nearest pitch for a staff position (used for click-to-place entry). */
export function pitchAtPosition(position: number): Pitch {
  let best: Pitch = 'LowA'
  let bestDist = Infinity
  for (const p of PITCHES) {
    const d = Math.abs(STAFF_POSITION[p] - position)
    if (d < bestDist) {
      bestDist = d
      best = p
    }
  }
  return best
}
