import { describe, expect, it } from 'vitest'
import { playOrder, buildEvents } from '../src/audio/player'
import { exportMidi } from '../src/core/midi/export'
import { createDemoScore } from '../src/core/model/create'
import type { Score } from '../src/core/model/types'
import { newId } from '../src/core/model/types'
import { createNote } from '../src/core/model/create'

const q = { base: 4, dots: 0 } as const

/** A one-part tune whose repeated section has 1st/2nd endings. */
function scoreWithVoltas(): Score {
  return {
    version: 1,
    id: newId('score'),
    title: 'Volta Test',
    tuneType: '',
    composer: '',
    timeSig: { beats: 4, unit: 4 },
    tempo: 80,
    parts: [
      {
        id: newId('p'),
        bars: [
          { id: newId('b'), repeatStart: true, notes: [createNote('LowA', q)] }, // 0
          { id: newId('b'), notes: [createNote('B', q)] }, // 1
          { id: newId('b'), volta: 1, repeatEnd: true, notes: [createNote('C', q)] }, // 2 (1st ending)
          { id: newId('b'), volta: 2, notes: [createNote('D', q)] }, // 3 (2nd ending)
        ],
      },
    ],
  }
}

describe('playOrder with repeats and voltas', () => {
  it('plays the section twice, taking 1st ending then 2nd ending', () => {
    const order = playOrder(scoreWithVoltas()).map(([, b]) => b)
    // First pass: bars 0,1,2 (skip 2nd ending). Second pass: 0,1,3 (skip 1st ending).
    expect(order).toEqual([0, 1, 2, 0, 1, 3])
  })

  it('a plain repeat (no voltas) replays the whole section once', () => {
    const s = scoreWithVoltas()
    delete s.parts[0].bars[2].volta
    delete s.parts[0].bars[3].volta
    s.parts[0].bars[3].repeatEnd = false
    s.parts[0].bars[2].repeatEnd = true
    // Now bars 0..2 are the repeated section; bar 3 follows once.
    const order = playOrder(s).map(([, b]) => b)
    expect(order).toEqual([0, 1, 2, 0, 1, 2, 3])
  })

  it('demo score expands its repeated first part', () => {
    const order = playOrder(createDemoScore())
    // Part 1 (4 bars) is repeated => 8; part 2 (4 bars) plays once => 4.
    expect(order.length).toBe(12)
  })

  it('plays bars after the endings only ONCE (the reported bug)', () => {
    // [0:RS] [1] [2] [3:V1] [4:V2] [5] [6] — the repeat boundary is the
    // ending, so bars 5 and 6 must not be repeated.
    const s: Score = {
      version: 1,
      id: newId('score'),
      title: '',
      tuneType: '',
      composer: '',
      timeSig: { beats: 4, unit: 4 },
      tempo: 80,
      parts: [
        {
          id: newId('p'),
          bars: [
            { id: newId('b'), repeatStart: true, notes: [createNote('LowA', q)] },
            { id: newId('b'), notes: [createNote('B', q)] },
            { id: newId('b'), notes: [createNote('C', q)] },
            { id: newId('b'), volta: 1, notes: [createNote('D', q)] },
            { id: newId('b'), volta: 2, notes: [createNote('E', q)] },
            { id: newId('b'), notes: [createNote('F', q)] },
            { id: newId('b'), notes: [createNote('HighG', q)] },
          ],
        },
      ],
    }
    const order = playOrder(s).map(([, b]) => b)
    // 0 1 2 3 (1st ending) | 0 1 2 (repeat) 4 (2nd ending) | 5 6 (once).
    expect(order).toEqual([0, 1, 2, 3, 0, 1, 2, 4, 5, 6])
  })

  it('handles two separate repeated sections in one part', () => {
    const s: Score = {
      version: 1,
      id: newId('score'),
      title: '',
      tuneType: '',
      composer: '',
      timeSig: { beats: 4, unit: 4 },
      tempo: 80,
      parts: [
        {
          id: newId('p'),
          bars: [
            { id: newId('b'), repeatStart: true, notes: [createNote('LowA', q)] },
            { id: newId('b'), repeatEnd: true, notes: [createNote('B', q)] },
            { id: newId('b'), repeatStart: true, notes: [createNote('C', q)] },
            { id: newId('b'), repeatEnd: true, notes: [createNote('D', q)] },
          ],
        },
      ],
    }
    expect(playOrder(s).map(([, b]) => b)).toEqual([0, 1, 0, 1, 2, 3, 2, 3])
  })
})

describe('event building', () => {
  it('count-in adds clicks before the first note', () => {
    const s = createDemoScore()
    const withIn = buildEvents(s, 480, { countIn: true })
    const without = buildEvents(s, 480, {})
    expect(withIn.clicks.length).toBe(4) // 4/4 => four count-in beats
    // First melody note is delayed by the count-in bar.
    expect(withIn.events[0].timeSec).toBeGreaterThan(without.events[0].timeSec)
  })

  it('metronome emits a strong click on beat one of each bar', () => {
    const { clicks } = buildEvents(createDemoScore(), 480, { metronome: true })
    expect(clicks.length).toBeGreaterThan(0)
    expect(clicks[0].strong).toBe(true)
  })
})

describe('MIDI export', () => {
  const bytes = exportMidi(createDemoScore(), { drone: true })

  it('starts with a valid SMF header chunk', () => {
    const header = String.fromCharCode(...bytes.slice(0, 4))
    expect(header).toBe('MThd')
    // format 0, 1 track
    expect(bytes[9]).toBe(0) // format low byte
    expect(bytes[11]).toBe(1) // ntracks low byte
  })

  it('contains a track chunk and end-of-track marker', () => {
    const asString = String.fromCharCode(...bytes)
    expect(asString.includes('MTrk')).toBe(true)
    // End of track meta: FF 2F 00
    const eot = [...bytes].findIndex(
      (b, i) => b === 0xff && bytes[i + 1] === 0x2f && bytes[i + 2] === 0x00,
    )
    expect(eot).toBeGreaterThan(0)
  })

  it('produces a non-trivial number of note events', () => {
    // Count note-on status bytes (0x90) — should match the many notes played.
    const noteOns = [...bytes].filter((b) => b === 0x90).length
    expect(noteOns).toBeGreaterThan(20)
  })
})
