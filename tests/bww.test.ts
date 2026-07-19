import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBww, serializeBww } from '../src/core/bww/bww'
import { createDemoScore } from '../src/core/model/create'
import { expandEmbellishment } from '../src/core/embellishments/registry'
import type { Score } from '../src/core/model/types'
import { beats } from '../src/core/duration'

/** Strip ids so structural comparison ignores generated identifiers. */
function structure(score: Score) {
  return {
    title: score.title,
    tuneType: score.tuneType,
    composer: score.composer,
    tempo: score.tempo,
    timeSig: score.timeSig,
    parts: score.parts.map((p) => ({
      bars: p.bars.map((b) => ({
        repeatStart: !!b.repeatStart,
        repeatEnd: !!b.repeatEnd,
        volta: b.volta ?? null,
        notes: b.notes.map((n) => ({
          pitch: n.pitch,
          duration: n.duration,
          emb: n.embellishment?.type ?? null,
        })),
      })),
    })),
  }
}

describe('BWW round-trip', () => {
  it('serialize → parse reproduces the demo score structurally', () => {
    const original = createDemoScore()
    const text = serializeBww(original)
    const { score: reparsed, warnings } = parseBww(text)
    expect(warnings).toEqual([])
    expect(structure(reparsed)).toEqual(structure(original))
  })

  it('is stable across a second round-trip', () => {
    const once = parseBww(serializeBww(createDemoScore())).score
    const twice = parseBww(serializeBww(once)).score
    expect(structure(twice)).toEqual(structure(once))
  })
})

describe('BWW parsing of a real published file (Balmoral Highlanders)', () => {
  const text = readFileSync(join(__dirname, 'fixtures/Balmoral.bww'), 'utf8')
  const { score, warnings } = parseBww(text)

  it('reads the tune metadata', () => {
    expect(score.title).toBe('The Balmoral Highlanders')
    expect(score.tuneType).toBe('March')
    expect(score.composer).toBe('A. MacKay')
    expect(score.tempo).toBe(82)
    expect(score.timeSig).toEqual({ beats: 2, unit: 4 })
  })

  it('reads all parts and bars', () => {
    // 6 part sections in the file (each ends with ''!I).
    expect(score.parts.length).toBe(6)
    for (const part of score.parts) {
      expect(part.bars.length).toBeGreaterThanOrEqual(9)
      for (const bar of part.bars) {
        expect(bar.notes.length).toBeGreaterThan(0)
      }
    }
  })

  it('parses without skipping any tokens', () => {
    expect(warnings).toEqual([])
  })

  it('attaches embellishments that expand to gracenotes', () => {
    let embellished = 0
    for (const part of score.parts) {
      for (const bar of part.bars) {
        for (const note of bar.notes) {
          if (note.embellishment) {
            embellished++
            expect(
              expandEmbellishment(note.embellishment, note.pitch).length,
            ).toBeGreaterThan(0)
          }
        }
      }
    }
    expect(embellished).toBeGreaterThan(100)
  })

  it('bar lengths are consistent with the 2/4 meter', () => {
    // Pickups and volta-adjacent bars are legitimately short, but no bar may
    // exceed the meter, and most bars should be exactly full.
    let full = 0
    let total = 0
    for (const part of score.parts) {
      for (const bar of part.bars) {
        const sum = bar.notes.reduce((a, n) => a + beats(n.duration), 0)
        expect(sum).toBeLessThanOrEqual(2 + 1e-6)
        total++
        if (Math.abs(sum - 2) < 1e-6) full++
      }
    }
    expect(full / total).toBeGreaterThan(0.6)
  })
})
