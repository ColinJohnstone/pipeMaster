import { describe, expect, it } from 'vitest'
import { voltaSpans, migrateBarVoltas } from '../src/core/model/voltas'
import { serializeBww, parseBww } from '../src/core/bww/bww'
import { createNote } from '../src/core/model/create'
import type { Part, Score } from '../src/core/model/types'
import { newId } from '../src/core/model/types'

const q = { base: 4, dots: 0 } as const

function partOf(notes: ReturnType<typeof createNote>[][]): Part {
  return { id: newId('p'), bars: notes.map((ns) => ({ id: newId('b'), notes: ns })) }
}

describe('voltaSpans', () => {
  it('resolves a 1st and 2nd ending that share a single bar', () => {
    const a = createNote('LowA', q)
    const b = createNote('B', q)
    const c = createNote('C', q)
    const d = createNote('D', q)
    a.voltaStart = 1
    b.voltaStop = true
    c.voltaStart = 2
    d.voltaStop = true
    const spans = voltaSpans(partOf([[a, b, c, d]]))
    expect(spans).toEqual([
      { num: 1, startBar: 0, startNote: 0, endBar: 0, endNote: 1 },
      { num: 2, startBar: 0, startNote: 2, endBar: 0, endNote: 3 },
    ])
  })

  it('resolves an ending that spans two bars', () => {
    const a = createNote('LowA', q)
    const b = createNote('B', q)
    a.voltaStart = 1
    b.voltaStop = true
    const spans = voltaSpans(partOf([[a], [b]]))
    expect(spans).toEqual([{ num: 1, startBar: 0, startNote: 0, endBar: 1, endNote: 0 }])
  })

  it('migrates a legacy whole-bar volta to note markers', () => {
    const score = {
      version: 1,
      id: newId('s'),
      title: '',
      tuneType: '',
      composer: '',
      timeSig: { beats: 4, unit: 4 },
      tempo: 80,
      parts: [
        {
          id: newId('p'),
          bars: [
            { id: newId('b'), notes: [createNote('LowA', q)] },
            { id: newId('b'), volta: 1, notes: [createNote('B', q), createNote('C', q)] },
          ],
        },
      ],
    } as unknown as Score
    migrateBarVoltas(score)
    const bar = score.parts[0].bars[1]
    expect((bar as { volta?: number }).volta).toBeUndefined()
    expect(bar.notes[0].voltaStart).toBe(1)
    expect(bar.notes[1].voltaStop).toBe(true)
    expect(voltaSpans(score.parts[0]).length).toBe(1)
  })
})

describe('BWW round-trip of note-level endings', () => {
  it('preserves 1st/2nd endings through serialize → parse', () => {
    const score: Score = {
      version: 1,
      id: newId('s'),
      title: 'Ending Test',
      tuneType: 'March',
      composer: '',
      timeSig: { beats: 4, unit: 4 },
      tempo: 80,
      parts: [
        {
          id: newId('p'),
          bars: [
            { id: newId('b'), repeatStart: true, notes: [createNote('LowA', q)] },
            (() => {
              const n = createNote('B', q)
              n.voltaStart = 1
              n.voltaStop = true
              return { id: newId('b'), repeatEnd: true, notes: [n] }
            })(),
            (() => {
              const n = createNote('C', q)
              n.voltaStart = 2
              n.voltaStop = true
              return { id: newId('b'), notes: [n] }
            })(),
          ],
        },
      ],
    }
    const round = parseBww(serializeBww(score)).score
    const spans = voltaSpans(round.parts[0])
    expect(spans.map((s) => s.num)).toEqual([1, 2])
  })
})
