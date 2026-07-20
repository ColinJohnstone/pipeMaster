import { describe, expect, it } from 'vitest'
import { reflowPart } from '../src/core/model/reflow'
import { createNote } from '../src/core/model/create'
import type { Score } from '../src/core/model/types'
import { newId } from '../src/core/model/types'

const q = { base: 4, dots: 0 } as const // crotchet = 1 beat
const h = { base: 2, dots: 0 } as const // minim = 2 beats

function scoreOf(barNotes: ReturnType<typeof createNote>[][], beats = 4, unit = 4): Score {
  return {
    version: 1,
    id: newId('score'),
    title: '',
    tuneType: '',
    composer: '',
    timeSig: { beats, unit },
    tempo: 80,
    parts: [{ id: newId('p'), bars: barNotes.map((notes) => ({ id: newId('b'), notes })) }],
  }
}

const pitches = (score: Score, bar: number) =>
  score.parts[0].bars[bar].notes.map((n) => n.pitch)

describe('reflowPart — auto bar overflow', () => {
  it('spills the 5th crotchet of a 4/4 bar into the next (empty) bar', () => {
    const s = scoreOf([
      [
        createNote('LowA', q),
        createNote('B', q),
        createNote('C', q),
        createNote('D', q),
        createNote('E', q), // the overflow
      ],
      [],
    ])
    reflowPart(s, 0, 0)
    expect(pitches(s, 0)).toEqual(['LowA', 'B', 'C', 'D'])
    expect(pitches(s, 1)).toEqual(['E'])
  })

  it('creates a new bar when there is no next bar', () => {
    const s = scoreOf([[createNote('LowA', q), createNote('B', q), createNote('C', q), createNote('D', q), createNote('E', q)]])
    reflowPart(s, 0, 0)
    expect(s.parts[0].bars.length).toBe(2)
    expect(pitches(s, 1)).toEqual(['E'])
  })

  it('cascades across several bars', () => {
    // Two full bars of minims plus one extra, all in bar 0.
    const s = scoreOf([
      [createNote('LowA', h), createNote('B', h), createNote('C', h), createNote('D', h), createNote('E', h)],
      [],
    ])
    reflowPart(s, 0, 0)
    expect(pitches(s, 0)).toEqual(['LowA', 'B'])
    expect(pitches(s, 1)).toEqual(['C', 'D'])
    expect(pitches(s, 2)).toEqual(['E'])
  })

  it('leaves a bar that is exactly full untouched', () => {
    const s = scoreOf([[createNote('LowA', q), createNote('B', q), createNote('C', q), createNote('D', q)], []])
    reflowPart(s, 0, 0)
    expect(pitches(s, 0)).toEqual(['LowA', 'B', 'C', 'D'])
    expect(pitches(s, 1)).toEqual([])
  })

  it('a pickup bar seals at its capacity so extra notes flow onward', () => {
    // Bar 0 is a pickup of one quaver (0.5 beats); adding a second note spills.
    const s = scoreOf([
      [createNote('E', { base: 8, dots: 0 }), createNote('LowA', { base: 8, dots: 0 })],
      [],
    ])
    s.parts[0].bars[0].pickup = 0.5
    reflowPart(s, 0, 0)
    expect(pitches(s, 0)).toEqual(['E']) // just the lead-in quaver
    expect(pitches(s, 1)).toEqual(['LowA']) // downbeat flows into bar 1
  })

  it('a full meter bar after a pickup still reflows against the meter, not the pickup', () => {
    const s = scoreOf([
      [createNote('E', { base: 8, dots: 0 })], // pickup, 0.5 beats
      [createNote('LowA', q), createNote('B', q), createNote('C', q), createNote('D', q), createNote('E', q)],
      [],
    ])
    s.parts[0].bars[0].pickup = 0.5
    reflowPart(s, 0, 0)
    expect(pitches(s, 0)).toEqual(['E'])
    expect(pitches(s, 1)).toEqual(['LowA', 'B', 'C', 'D']) // 4 beats = full 4/4
    expect(pitches(s, 2)).toEqual(['E'])
  })

  it('does not loop on a single note longer than a bar', () => {
    const s = scoreOf([[createNote('LowA', h)]], 2, 4) // minim in a 2/4 bar: exactly full
    const whole = scoreOf([[{ ...createNote('LowA', { base: 1, dots: 0 }) }]], 2, 4)
    reflowPart(s, 0, 0)
    reflowPart(whole, 0, 0)
    // The oversized single note stays put rather than cascading forever.
    expect(whole.parts[0].bars[0].notes.length).toBe(1)
    expect(whole.parts[0].bars.length).toBe(1)
  })
})
