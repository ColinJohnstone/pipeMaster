import type { Pitch } from '../pitch'

/**
 * Embellishments are stored semantically — a note carries e.g.
 * `{ type: 'doubling' }` and the gracenote cluster is derived from the
 * melody pitch it decorates. Rendering, playback, and format export all
 * share these expansions, so a doubling is one object everywhere, never
 * hand-placed gracenotes.
 *
 * Expansions follow the standard College of Piping / tutor-book canon.
 */

export type EmbellishmentType =
  | 'gGrace'
  | 'dGrace'
  | 'eGrace'
  | 'thumbGrace'
  | 'aGrace'
  | 'bGrace'
  | 'cGrace'
  | 'fGrace'
  | 'doubling'
  | 'halfDoubling'
  | 'thumbDoubling'
  | 'strike'
  | 'gStrike'
  | 'thumbStrike'
  | 'grip'
  | 'taorluath'
  | 'birl'
  | 'gGraceBirl'
  | 'thumbBirl'
  | 'throwD'
  | 'heavyThrowD'
  | 'pele'
  | 'bubbly'

export interface Embellishment {
  type: EmbellishmentType
}

export interface EmbellishmentDef {
  type: EmbellishmentType
  label: string
  /** Compact label for palette buttons. */
  short: string
  category: 'Gracenotes' | 'Doublings' | 'Strikes' | 'Movements'
  /**
   * Gracenote pitches for this embellishment on the given melody note,
   * or null when it doesn't apply to that pitch.
   */
  expand(melody: Pitch): Pitch[] | null
}

// -- Tables ------------------------------------------------------------------

const DOUBLING: Partial<Record<Pitch, Pitch[]>> = {
  LowG: ['HighG', 'LowG', 'D'],
  LowA: ['HighG', 'LowA', 'D'],
  B: ['HighG', 'B', 'D'],
  C: ['HighG', 'C', 'D'],
  D: ['HighG', 'D', 'E'],
  E: ['HighG', 'E', 'F'],
  F: ['HighG', 'F', 'HighG'],
  HighG: ['HighG', 'F'],
  HighA: ['HighA', 'HighG'],
}

/** The cutting gracenote of a strike on each melody pitch. */
const STRIKE: Partial<Record<Pitch, Pitch>> = {
  LowA: 'LowG',
  B: 'LowG',
  C: 'LowG',
  D: 'LowG',
  E: 'LowA',
  F: 'E',
  HighG: 'F',
  HighA: 'HighG',
}

const GRACE_PITCH = {
  gGrace: 'HighG',
  dGrace: 'D',
  eGrace: 'E',
  thumbGrace: 'HighA',
  aGrace: 'LowA',
  bGrace: 'B',
  cGrace: 'C',
  fGrace: 'F',
} as const satisfies Partial<Record<EmbellishmentType, Pitch>>

const ORDER: Pitch[] = ['LowG', 'LowA', 'B', 'C', 'D', 'E', 'F', 'HighG', 'HighA']
const above = (a: Pitch, b: Pitch) => ORDER.indexOf(a) > ORDER.indexOf(b)

function singleGrace(kind: keyof typeof GRACE_PITCH) {
  return (melody: Pitch): Pitch[] | null => {
    const g = GRACE_PITCH[kind]
    return above(g, melody) ? [g] : null
  }
}

// -- Registry ----------------------------------------------------------------

export const EMBELLISHMENTS: EmbellishmentDef[] = [
  {
    type: 'gGrace',
    label: 'G gracenote',
    short: 'G',
    category: 'Gracenotes',
    expand: singleGrace('gGrace'),
  },
  {
    type: 'dGrace',
    label: 'D gracenote',
    short: 'D',
    category: 'Gracenotes',
    expand: singleGrace('dGrace'),
  },
  {
    type: 'eGrace',
    label: 'E gracenote',
    short: 'E',
    category: 'Gracenotes',
    expand: singleGrace('eGrace'),
  },
  {
    type: 'thumbGrace',
    label: 'Thumb (High A) gracenote',
    short: 'HA',
    category: 'Gracenotes',
    expand: singleGrace('thumbGrace'),
  },
  {
    type: 'aGrace',
    label: 'Low A gracenote',
    short: 'A',
    category: 'Gracenotes',
    expand: singleGrace('aGrace'),
  },
  {
    type: 'bGrace',
    label: 'B gracenote',
    short: 'B',
    category: 'Gracenotes',
    expand: singleGrace('bGrace'),
  },
  {
    type: 'cGrace',
    label: 'C gracenote',
    short: 'C',
    category: 'Gracenotes',
    expand: singleGrace('cGrace'),
  },
  {
    type: 'fGrace',
    label: 'F gracenote',
    short: 'F',
    category: 'Gracenotes',
    expand: singleGrace('fGrace'),
  },
  {
    type: 'doubling',
    label: 'Doubling',
    short: 'Dbl',
    category: 'Doublings',
    expand: (m) => DOUBLING[m] ?? null,
  },
  {
    type: 'halfDoubling',
    label: 'Half doubling',
    short: '½Dbl',
    category: 'Doublings',
    expand: (m) => {
      if (m === 'HighG' || m === 'HighA') return DOUBLING[m] ?? null
      const full = DOUBLING[m]
      return full ? full.slice(1) : null
    },
  },
  {
    type: 'thumbDoubling',
    label: 'Thumb doubling',
    short: 'TDbl',
    category: 'Doublings',
    expand: (m) => {
      if (m === 'HighA') return null
      if (m === 'HighG') return ['HighA', 'HighG', 'F']
      const full = DOUBLING[m]
      return full ? (['HighA', ...full.slice(1)] as Pitch[]) : null
    },
  },
  {
    type: 'strike',
    label: 'Strike',
    short: 'Str',
    category: 'Strikes',
    expand: (m) => (STRIKE[m] ? [STRIKE[m]!] : null),
  },
  {
    type: 'gStrike',
    label: 'G gracenote strike',
    short: 'GStr',
    category: 'Strikes',
    expand: (m) => {
      const s = STRIKE[m]
      if (!s || !above('HighG', m)) return null
      return ['HighG', m, s]
    },
  },
  {
    type: 'thumbStrike',
    label: 'Thumb strike',
    short: 'TStr',
    category: 'Strikes',
    expand: (m) => {
      const s = STRIKE[m]
      if (!s || !above('HighA', m)) return null
      return ['HighA', m, s]
    },
  },
  {
    type: 'grip',
    label: 'Grip',
    short: 'Grip',
    category: 'Movements',
    expand: (m) => (m === 'D' ? ['LowG', 'B', 'LowG'] : ['LowG', 'D', 'LowG']),
  },
  {
    type: 'taorluath',
    label: 'Taorluath',
    short: 'Taor',
    category: 'Movements',
    expand: (m) =>
      m === 'D' ? ['LowG', 'B', 'LowG', 'E'] : ['LowG', 'D', 'LowG', 'E'],
  },
  {
    type: 'birl',
    label: 'Birl',
    short: 'Birl',
    category: 'Movements',
    expand: (m) => (m === 'LowA' ? ['LowG', 'LowA', 'LowG'] : null),
  },
  {
    type: 'gGraceBirl',
    label: 'G gracenote birl',
    short: 'GBirl',
    category: 'Movements',
    expand: (m) =>
      m === 'LowA' ? ['HighG', 'LowA', 'LowG', 'LowA', 'LowG'] : null,
  },
  {
    type: 'thumbBirl',
    label: 'Thumb birl',
    short: 'TBirl',
    category: 'Movements',
    expand: (m) =>
      m === 'LowA' ? ['HighA', 'LowA', 'LowG', 'LowA', 'LowG'] : null,
  },
  {
    type: 'throwD',
    label: 'Throw on D',
    short: 'ThrD',
    category: 'Movements',
    expand: (m) => (m === 'D' ? ['LowG', 'D', 'C'] : null),
  },
  {
    type: 'heavyThrowD',
    label: 'Heavy throw on D',
    short: 'HThrD',
    category: 'Movements',
    expand: (m) => (m === 'D' ? ['LowG', 'D', 'LowG', 'C'] : null),
  },
  {
    type: 'pele',
    label: 'Pele (shake)',
    short: 'Pele',
    category: 'Movements',
    // A pele is a doubling followed by a strike on the same note.
    expand: (m) => {
      const dbl = DOUBLING[m]
      const s = STRIKE[m]
      if (!dbl || !s || m === 'HighG' || m === 'HighA') return null
      return [...dbl, s]
    },
  },
  {
    type: 'bubbly',
    label: 'Bubbly note',
    short: 'Bub',
    category: 'Movements',
    expand: (m) => (m === 'B' ? ['LowG', 'D', 'LowG', 'C'] : null),
  },
]

const BY_TYPE = new Map(EMBELLISHMENTS.map((d) => [d.type, d]))

export function embellishmentDef(type: EmbellishmentType): EmbellishmentDef {
  const def = BY_TYPE.get(type)
  if (!def) throw new Error(`Unknown embellishment type: ${type}`)
  return def
}

/** Gracenote pitches for an embellishment on a melody note, or [] if invalid. */
export function expandEmbellishment(
  emb: Embellishment | undefined,
  melody: Pitch,
): Pitch[] {
  if (!emb) return []
  return embellishmentDef(emb.type).expand(melody) ?? []
}
