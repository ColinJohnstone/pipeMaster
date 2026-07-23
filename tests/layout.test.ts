import { describe, expect, it } from 'vitest'
import { layoutScore } from '../src/layout/layout'
import { createNote } from '../src/core/model/create'
import type { Score } from '../src/core/model/types'
import { newId } from '../src/core/model/types'

const q = { base: 4, dots: 0 } as const

// A full 4/4 bar so every bar has the same natural width.
const fullBar = () => ({
  id: newId('b'),
  notes: [
    createNote('LowA', q),
    createNote('B', q),
    createNote('C', q),
    createNote('D', q),
  ],
})

function scoreOfBars(n: number): Score {
  return {
    version: 1,
    id: newId('score'),
    title: '',
    tuneType: '',
    composer: '',
    timeSig: { beats: 4, unit: 4 },
    tempo: 80,
    parts: [{ id: newId('p'), bars: Array.from({ length: n }, fullBar) }],
  }
}

const counts = (s: Score) => layoutScore(s).systems.map((sys) => sys.bars.length)

describe('layoutScore — no stranded last bar', () => {
  it('rebalances 5 bars from 4,1 to 3,2', () => {
    expect(counts(scoreOfBars(5))).toEqual([3, 2])
  })

  it('rebalances 9 bars from 4,4,1 to 4,3,2', () => {
    expect(counts(scoreOfBars(9))).toEqual([4, 3, 2])
  })

  it('leaves a clean fit untouched', () => {
    expect(counts(scoreOfBars(8))).toEqual([4, 4])
    expect(counts(scoreOfBars(6))).toEqual([4, 2])
  })

  it('keeps the bars in order after rebalancing', () => {
    const s = scoreOfBars(5)
    const laid = layoutScore(s)
    const seen = laid.systems.flatMap((sys) => sys.bars.map((b) => b.barIndex))
    expect(seen).toEqual([0, 1, 2, 3, 4])
  })

  it('leaves a genuine one-bar part alone', () => {
    // Part A of 4 bars, part B of a single bar.
    const s = scoreOfBars(4)
    s.parts.push({ id: newId('p'), bars: [fullBar()] })
    expect(counts(s)).toEqual([4, 1])
  })
})
