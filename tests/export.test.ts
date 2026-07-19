import { describe, expect, it } from 'vitest'
import { exportMusicXml } from '../src/core/musicxml/export'
import { exportMidi } from '../src/core/midi/export'
import { createDemoScore, createNote } from '../src/core/model/create'
import type { Score } from '../src/core/model/types'
import { newId } from '../src/core/model/types'

const q = { base: 4, dots: 0 } as const
const h = { base: 2, dots: 0 } as const

/** Count how many top-level tags of a given name appear (crude but adequate). */
function countTag(xml: string, tag: string): number {
  return (xml.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length
}

describe('MusicXML export', () => {
  const xml = exportMusicXml(createDemoScore())

  it('is a well-formed score-partwise document', () => {
    expect(xml.startsWith('<?xml')).toBe(true)
    expect(xml).toContain('<score-partwise version="4.0">')
    expect(xml.trimEnd().endsWith('</score-partwise>')).toBe(true)
    // Every opening tag we emit is balanced by a close (spot-check key ones).
    for (const tag of ['part', 'measure', 'note', 'pitch', 'attributes']) {
      const opens = (xml.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length
      const closes = (xml.match(new RegExp(`</${tag}>`, 'g')) ?? []).length
      expect(opens, tag).toBe(closes)
    }
  })

  it('emits one measure per bar', () => {
    const barCount = createDemoScore().parts.reduce((a, p) => a + p.bars.length, 0)
    expect(countTag(xml, 'measure')).toBe(barCount)
  })

  it('declares the bagpipe key of D (two sharps) and treble clef', () => {
    expect(xml).toContain('<fifths>2</fifths>')
    expect(xml).toContain('<sign>G</sign>')
  })

  it('writes C and F as sharps (alter +1)', () => {
    // The demo tune contains C and F melody notes.
    expect(xml).toContain('<step>C</step>')
    expect(xml).toContain('<alter>1</alter>')
  })

  it('exports embellishments as slashed grace notes', () => {
    expect(xml).toContain('<grace slash="yes"/>')
  })

  it('marks repeats', () => {
    expect(xml).toContain('<repeat direction="forward"/>')
    expect(xml).toContain('<repeat direction="backward"/>')
  })
})

describe('MIDI tied-note merge', () => {
  function tiedScore(): Score {
    return {
      version: 1,
      id: newId('score'),
      title: 'Tie Test',
      tuneType: '',
      composer: '',
      timeSig: { beats: 4, unit: 4 },
      tempo: 60,
      parts: [
        {
          id: newId('p'),
          bars: [
            {
              id: newId('b'),
              notes: [
                { ...createNote('D', h), tieToNext: true },
                createNote('D', h),
              ],
            },
          ],
        },
      ],
    }
  }

  it('two tied same-pitch notes become a single MIDI note', () => {
    const bytes = exportMidi(tiedScore())
    // One note-on for D (0x90) — the tie is not re-articulated.
    const noteOns = [...bytes].filter((b) => b === 0x90).length
    expect(noteOns).toBe(1)
  })

  it('untied notes of the same pitch stay separate', () => {
    const s = tiedScore()
    s.parts[0].bars[0].notes[0].tieToNext = false
    const bytes = exportMidi(s)
    const noteOns = [...bytes].filter((b) => b === 0x90).length
    expect(noteOns).toBe(2)
  })
})
