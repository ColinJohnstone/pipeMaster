import { describe, expect, it, beforeEach } from 'vitest'
import { noteBeats, beats, tupletRatio } from '../src/core/duration'
import { useStore } from '../src/state/store'
import { createDemoScore, createNote } from '../src/core/model/create'

describe('tuplet timing', () => {
  it('a triplet quaver is two-thirds of a plain quaver', () => {
    const plain = createNote('LowA', { base: 8, dots: 0 })
    const trip = { ...createNote('LowA', { base: 8, dots: 0 }), tuplet: 3 }
    expect(noteBeats(plain)).toBeCloseTo(0.5, 6)
    expect(noteBeats(trip)).toBeCloseTo(0.5 * (2 / 3), 6)
  })

  it('three triplet quavers fill exactly one crotchet beat', () => {
    const three = 3 * noteBeats({ ...createNote('B', { base: 8, dots: 0 }), tuplet: 3 })
    expect(three).toBeCloseTo(beats({ base: 4, dots: 0 }), 6)
  })

  it('tupletRatio handles common tuplets', () => {
    expect(tupletRatio(3)).toBeCloseTo(2 / 3, 6)
    expect(tupletRatio(undefined)).toBe(1)
    expect(tupletRatio(6)).toBeCloseTo(4 / 6, 6)
  })
})

const st = () => useStore.getState()

describe('musical editing actions', () => {
  beforeEach(() => st().loadScore(createDemoScore()))

  it('tieSelection ties every note in a range except the last', () => {
    st().setSelection({ partIndex: 0, barIndex: 0, noteIndex: 0 })
    st().selectRangeTo({ partIndex: 0, barIndex: 0, noteIndex: 2 })
    st().tieSelection()
    const notes = st().score.parts[0].bars[0].notes
    expect(notes[0].tieToNext).toBe(true)
    expect(notes[1].tieToNext).toBe(true)
    expect(notes[2].tieToNext).toBeFalsy()
  })

  it('setTuplet marks the selected range as triplets', () => {
    st().setSelection({ partIndex: 0, barIndex: 0, noteIndex: 0 })
    st().selectRangeTo({ partIndex: 0, barIndex: 0, noteIndex: 2 })
    st().setTuplet(3)
    const notes = st().score.parts[0].bars[0].notes
    expect(notes.slice(0, 3).every((n) => n.tuplet === 3)).toBe(true)
    st().setTuplet(null)
    expect(st().score.parts[0].bars[0].notes[0].tuplet).toBeUndefined()
  })

  it('setBarTimeSig changes the meter from that bar onward', () => {
    st().setBarTimeSig(0, 1, { beats: 6, unit: 8 })
    expect(st().score.parts[0].bars[1].timeSig).toEqual({ beats: 6, unit: 8 })
    st().setBarTimeSig(0, 1, null)
    expect(st().score.parts[0].bars[1].timeSig).toBeUndefined()
  })
})
