import { describe, expect, it } from 'vitest'
import { recognize } from '../src/core/omr/recognize'
import { omrToScore } from '../src/core/omr/toScore'

/** Minimal raster canvas backed by a Uint8ClampedArray (white background). */
function makeImage(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255)
  const dark = (x: number, y: number) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return
    const i = (y * w + x) * 4
    data[i] = data[i + 1] = data[i + 2] = 0
  }
  return {
    imageData: { data, width: w, height: h } as unknown as ImageData,
    line: (y: number) => {
      for (let x = 0; x < w; x++) dark(x, y)
    },
    head: (cx: number, cy: number, rx: number, ry: number) => {
      for (let y = -ry; y <= ry; y++)
        for (let x = -rx; x <= rx; x++)
          if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) dark(cx + x, cy + y)
    },
  }
}

describe('OMR recognition on a synthetic staff', () => {
  // sp = 12, bottom line (position 0) at y = 88.
  const img = makeImage(300, 120)
  for (const y of [40, 52, 64, 76, 88]) img.line(y)
  img.head(60, 70, 5, 4) // position 3 → Low A
  img.head(140, 52, 5, 4) // position 6 → D
  img.head(220, 28, 5, 4) // position 10 → High A
  const res = recognize(img.imageData)

  it('detects exactly one staff of five lines', () => {
    expect(res.staves.length).toBe(1)
    expect(res.staves[0].lines.length).toBe(5)
    expect(res.staves[0].spacing).toBeCloseTo(12, 0)
  })

  it('detects the three noteheads', () => {
    expect(res.notes.length).toBe(3)
  })

  it('reads the correct pitches in left-to-right order', () => {
    expect(res.notes.map((n) => n.pitch)).toEqual(['LowA', 'D', 'HighA'])
  })
})

describe('OMR → Score conversion', () => {
  const img = makeImage(300, 120)
  for (const y of [40, 52, 64, 76, 88]) img.line(y)
  img.head(60, 70, 5, 4)
  img.head(140, 52, 5, 4)
  const res = recognize(img.imageData)

  it('produces an editable single-part score of quavers', () => {
    const score = omrToScore(res.notes, { beats: 4, unit: 4 }, 'Test')
    expect(score.parts.length).toBe(1)
    const notes = score.parts[0].bars.flatMap((b) => b.notes)
    expect(notes.length).toBe(2)
    expect(notes.every((n) => n.duration.base === 8)).toBe(true)
    expect(notes.map((n) => n.pitch)).toEqual(['LowA', 'D'])
  })

  it('reports a helpful warning when no staff is found', () => {
    const blank = makeImage(200, 80)
    const r = recognize(blank.imageData)
    expect(r.staves.length).toBe(0)
    expect(r.warnings.length).toBeGreaterThan(0)
  })
})
