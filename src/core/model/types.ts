import type { Pitch } from '../pitch'
import type { Duration, TimeSig } from '../duration'
import type { Embellishment } from '../embellishments/registry'

export interface Note {
  id: string
  pitch: Pitch
  duration: Duration
  embellishment?: Embellishment
  /** Tied to the following note. */
  tieToNext?: boolean
}

export interface Bar {
  id: string
  notes: Note[]
  /** Time signature change at this bar (first bar sets the tune's meter). */
  timeSig?: TimeSig
  repeatStart?: boolean
  repeatEnd?: boolean
  /** 1st/2nd time ending this bar belongs to, if any. */
  volta?: 1 | 2
}

export interface Part {
  id: string
  bars: Bar[]
}

export interface Score {
  version: 1
  id: string
  title: string
  /** Tune type, e.g. "March", "Strathspey", "Reel". */
  tuneType: string
  composer: string
  timeSig: TimeSig
  parts: Part[]
  /** Suggested tempo, crotchet (or dotted crotchet in compound time) BPM. */
  tempo: number
}

let counter = 0
export function newId(prefix: string): string {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`
}

export function timeSigForBar(score: Score, partIndex: number, barIndex: number): TimeSig {
  // The effective meter is the most recent explicit change, else the tune's.
  for (let p = partIndex; p >= 0; p--) {
    const bars = score.parts[p].bars
    const start = p === partIndex ? barIndex : bars.length - 1
    for (let b = start; b >= 0; b--) {
      if (bars[b].timeSig) return bars[b].timeSig!
    }
  }
  return score.timeSig
}

export interface NoteAddress {
  partIndex: number
  barIndex: number
  noteIndex: number
}

export function getNote(score: Score, addr: NoteAddress): Note | undefined {
  return score.parts[addr.partIndex]?.bars[addr.barIndex]?.notes[addr.noteIndex]
}
