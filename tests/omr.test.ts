import { describe, expect, it } from 'vitest'
import { recognize } from '../src/core/omr/recognize'
import { omrToScore, inferTimeSig, meterForType } from '../src/core/omr/toScore'
import { matchEmbellishment } from '../src/core/omr/matchEmbellishment'
import { parseHeader } from '../src/core/omr/ocr'

/** Minimal raster canvas backed by a Uint8ClampedArray (white background). */
function makeImage(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255)
  const dark = (x: number, y: number) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return
    const i = (y * w + x) * 4
    data[i] = data[i + 1] = data[i + 2] = 0
  }
  const ellipse = (cx: number, cy: number, rx: number, ry: number) => {
    for (let y = -ry; y <= ry; y++)
      for (let x = -rx; x <= rx; x++)
        if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) dark(cx + x, cy + y)
  }
  const rect = (x0: number, y0: number, wid: number, hei: number) => {
    for (let y = y0; y < y0 + hei; y++) for (let x = x0; x < x0 + wid; x++) dark(x, y)
  }
  const ring = (cx: number, cy: number) => {
    for (let y = -5; y <= 5; y++)
      for (let x = -6; x <= 6; x++) {
        const outer = (x * x) / 36 + (y * y) / 25 <= 1
        const inner = (x * x) / 12.25 + (y * y) / 6.25 <= 1
        if (outer && !inner) dark(cx + x, cy + y)
      }
  }
  return {
    imageData: { data, width: w, height: h } as unknown as ImageData,
    line: (y: number) => {
      for (let x = 0; x < w; x++) dark(x, y)
    },
    slopedLine: (baseY: number, slope: number) => {
      for (let x = 0; x < w; x++) {
        const y = Math.round(baseY + slope * (x - w / 2))
        dark(x, y)
        dark(x, y + 1)
      }
    },
    head: (cx: number, cy: number) => ellipse(cx, cy, 6, 5), // melody notehead
    grace: (cx: number, cy: number) => ellipse(cx, cy, 3, 2), // small gracenote
    /** Filled note with a downward stem and `beams` beam bars at the tip. */
    stemNote: (cx: number, cy: number, beams: number) => {
      ellipse(cx, cy, 6, 5)
      rect(cx - 6, cy, 2, 34) // stem down
      const tip = cy + 34
      for (let b = 0; b < beams; b++) rect(cx - 6, tip - 2 - b * 4, 14, 2) // beam bars
    },
    /** Open (half) note with a downward stem. */
    openNote: (cx: number, cy: number) => {
      ring(cx, cy)
      rect(cx - 6, cy, 2, 34)
    },
  }
}

// sp = 12, lines at [40,52,64,76,88]; bottom line (position 0) = y 88.
// pitch y = 88 - position * 6:  LowA(3)=70  B(4)=64  D(6)=52  E(7)=46  HG(9)=34  HA(10)=28
function staffImage(w = 320, h = 120) {
  const img = makeImage(w, h)
  for (const y of [40, 52, 64, 76, 88]) img.line(y)
  return img
}

describe('OMR recognition on a synthetic staff', () => {
  const img = staffImage()
  img.head(100, 70) // Low A
  img.head(150, 52) // D
  img.head(240, 28) // High A
  const res = recognize(img.imageData, { detectEmbellishments: true })

  it('detects exactly one staff of five lines', () => {
    expect(res.staves.length).toBe(1)
    expect(res.staves[0].lines.length).toBe(5)
    expect(res.staves[0].spacing).toBeCloseTo(12, 0)
  })

  it('detects the three melody noteheads with correct pitches', () => {
    expect(res.notes.length).toBe(3)
    expect(res.notes.map((n) => n.pitch)).toEqual(['LowA', 'D', 'HighA'])
  })
})

describe('OMR embellishment recognition', () => {
  it('reads a single High-G gracenote as a G gracenote', () => {
    const img = staffImage()
    img.grace(150, 34) // High G gracenote, just left of / above the melody note
    img.head(168, 64) // melody B
    const res = recognize(img.imageData, { detectEmbellishments: true })
    expect(res.notes.length).toBe(1)
    expect(res.notes[0].pitch).toBe('B')
    expect(res.notes[0].embellishment).toBe('gGrace')
  })

  it('reads a High-G / D / E cluster before a D as a doubling', () => {
    const img = staffImage()
    // Doubling on D expands to gracenotes High G, D, E.
    img.grace(176, 34) // High G
    img.grace(186, 52) // D
    img.grace(196, 46) // E
    img.head(214, 52) // melody D
    const res = recognize(img.imageData, { detectEmbellishments: true })
    const d = res.notes.find((n) => n.pitch === 'D')
    expect(d).toBeTruthy()
    expect(d!.embellishment).toBe('doubling')
  })
})

describe('OMR duration recognition', () => {
  it('reads stem/beam counts as crotchet, quaver, semiquaver', () => {
    const img = staffImage(360)
    img.stemNote(100, 52, 0) // stem, no beam → crotchet (base 4)
    img.stemNote(150, 52, 1) // 1 beam → quaver (base 8)
    img.stemNote(230, 52, 2) // 2 beams → semiquaver (base 16)
    const res = recognize(img.imageData, { detectEmbellishments: true })
    const bases = res.notes.sort((a, b) => a.x - b.x).map((n) => n.base)
    expect(bases).toEqual([4, 8, 16])
  })

  it('reads an open notehead with a stem as a minim', () => {
    const img = staffImage()
    img.openNote(120, 52) // open head + stem → half note (base 2)
    const res = recognize(img.imageData, { detectEmbellishments: true })
    expect(res.notes.length).toBe(1)
    expect(res.notes[0].base).toBe(2)
  })
})

describe('OMR rejects non-notes (clef, time signature, page text)', () => {
  it('ignores blobs in the clef zone and text above the staff', () => {
    const img = staffImage(360)
    // A clef-ish blob at the far left (within the clef/time-signature zone).
    img.head(26, 64)
    // Title/composer text well above the staff (far outside the pitch band).
    img.head(150, 12)
    img.head(230, 10)
    // Two genuine noteheads on the staff, past the clef.
    img.head(180, 64)
    img.head(260, 52)
    const res = recognize(img.imageData)
    expect(res.notes.length).toBe(2)
    expect(res.notes.map((n) => n.pitch)).toEqual(['B', 'D'])
  })

  it('ignores the time signature (two stacked digits) at the start of the first staff', () => {
    const img = staffImage(360)
    // A metre like 6/8: two stemless, similar-sized blobs stacked at the start,
    // just past the clef zone (x≥78). These must not be read as noteheads.
    img.head(86, 52) // upper digit
    img.head(86, 76) // lower digit
    // Real notes further along.
    img.head(170, 64) // B
    img.head(250, 52) // D
    const res = recognize(img.imageData)
    expect(res.notes.map((n) => n.pitch)).toEqual(['B', 'D'])
  })
})

describe('OMR deskew', () => {
  it('straightens a sloped page and still finds the staff', () => {
    const img = staffImage()
    // Re-draw the staff on a fresh sloped image (~3.4°).
    const sloped = makeImage(320, 140)
    for (const y of [45, 57, 69, 81, 93]) sloped.slopedLine(y, 0.06)
    sloped.head(150, 69 + Math.round(0.06 * (150 - 160))) // a note on the sloped staff
    const res = recognize(sloped.imageData)
    expect(Math.abs(res.skewDeg)).toBeGreaterThan(1)
    expect(res.staves.length).toBe(1)
    void img
  })
})

describe('OMR → Score conversion', () => {
  it('carries pitches and embellishments into an editable score', () => {
    const img = staffImage()
    img.grace(150, 34) // High G gracenote
    img.head(168, 64) // melody B
    img.head(240, 52) // melody D
    const res = recognize(img.imageData, { detectEmbellishments: true })
    const score = omrToScore(res.notes, { beats: 4, unit: 4 }, 'Test')
    const notes = score.parts[0].bars.flatMap((b) => b.notes)
    expect(notes.map((n) => n.pitch)).toEqual(['B', 'D'])
    expect(notes[0].embellishment?.type).toBe('gGrace')
    expect(notes.every((n) => n.duration.base === 8)).toBe(true)
  })

  it('infers the meter from the bar lengths the music shows', () => {
    // Helper: N bars each of the given note bases, split by barlines at x steps.
    const build = (bars: number[][]) => {
      const notes: Parameters<typeof inferTimeSig>[0] = []
      const lines: number[] = []
      let x = 0
      bars.forEach((bases) => {
        bases.forEach((base) => {
          notes.push({ pitch: 'LowA', x, y: 70, staffIndex: 0, base, dots: false, graces: [] } as never)
          x += 10
        })
        lines.push(x + 2)
        x += 6
      })
      return { notes, barlines: [lines] }
    }
    const three = [4, 4, 4]
    const four = [4, 4, 4, 4]
    const six = [8, 8, 8, 8, 8, 8]
    // Bars of three crotchets → 3/4.
    let g = build([three, three, three, three, three])
    expect(inferTimeSig(g.notes, g.barlines)).toEqual({ beats: 3, unit: 4 })
    // Bars of four crotchets → 4/4.
    g = build([four, four, four, four, four])
    expect(inferTimeSig(g.notes, g.barlines)).toEqual({ beats: 4, unit: 4 })
    // Three-beat bars packed with six quavers → 6/8, not 3/4.
    g = build([six, six, six, six, six])
    expect(inferTimeSig(g.notes, g.barlines)).toEqual({ beats: 6, unit: 8 })
  })

  it('lets the tune type settle 3/4 vs 6/8', () => {
    const sixEight = { beats: 6, unit: 8 } as const
    expect(meterForType(sixEight, 'Waltz')).toEqual({ beats: 3, unit: 4 })
    expect(meterForType(sixEight, 'March/Strathspey')).toEqual(sixEight) // unchanged
    expect(meterForType({ beats: 3, unit: 4 }, 'Jig')).toEqual({ beats: 6, unit: 8 })
    // Only touches three-beat meters.
    expect(meterForType({ beats: 4, unit: 4 }, 'Waltz')).toEqual({ beats: 4, unit: 4 })
    expect(meterForType(sixEight, undefined)).toEqual(sixEight)
  })

  it('reports a helpful warning when no staff is found', () => {
    const blank = makeImage(200, 80)
    const r = recognize(blank.imageData)
    expect(r.staves.length).toBe(0)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('places detected repeats and endings on the right bars', () => {
    // Two bars per staff, split by a barline at x=150 (staff spacing 12).
    const notes = [
      { pitch: 'LowA', x: 100, y: 70, staffIndex: 0, base: 4, dots: false, graces: [] },
      { pitch: 'B', x: 200, y: 64, staffIndex: 0, base: 4, dots: false, graces: [] },
      { pitch: 'C', x: 100, y: 58, staffIndex: 1, base: 4, dots: false, graces: [] },
      { pitch: 'D', x: 200, y: 52, staffIndex: 1, base: 4, dots: false, graces: [] },
    ] as unknown as Parameters<typeof omrToScore>[0]
    const score = omrToScore(notes, { beats: 2, unit: 4 }, 'Test', {
      barlines: [[150], [150]],
      // End repeat closes bar 0 (line at 150 on staff 0); the 2nd-ending bracket
      // sits over bar 1 of staff 0 (the note at x=200).
      repeats: [{ staffIndex: 0, x: 150, kind: 'end' }],
      voltas: [{ staffIndex: 0, x0: 175, x1: 240, num: 2 }],
      sp: 12,
    })
    const bars = score.parts[0].bars
    expect(bars[0].repeatEnd).toBe(true)
    // The 2nd-ending bracket covers bar 1's note — marked on the note now.
    expect(bars[1].notes[0].voltaStart).toBe(2)
    expect(bars[1].notes[bars[1].notes.length - 1].voltaStop).toBe(true)
    expect(bars[2].repeatEnd).toBeUndefined()
  })
})

describe('OCR header parsing', () => {
  // Shaped like Tesseract's data.lines for a typical pipe-tune header.
  const line = (text: string, x0: number, y0: number, x1: number, y1: number) => ({
    text,
    bbox: { x0, y0, x1, y1 },
  })

  it('pulls title, composer, type and metre from header lines', () => {
    const data = {
      lines: [
        line('6/8 March', 60, 60, 240, 85), // type + metre, top-left
        line('The Glendaruel Highlanders', 300, 20, 1050, 72), // title (tallest)
        line('P/M A. Fettes', 1120, 68, 1330, 92), // composer, top-right
      ],
    }
    const h = parseHeader(data)
    expect(h.title).toBe('The Glendaruel Highlanders')
    expect(h.tuneType).toBe('March')
    expect(h.timeSig).toEqual({ beats: 6, unit: 8 })
    expect(h.composer).toBe('P/M A. Fettes')
  })

  it('strips the metre/type credit when OCR merges it with the composer line', () => {
    // Type (left) and composer (right) share a baseline → one merged OCR line.
    const data = {
      lines: [
        { text: 'The Braes of Mar', bbox: { x0: 280, y0: 10, x1: 720, y1: 60 } },
        { text: '6/8 March   P/M J. MacLeod', bbox: { x0: 40, y0: 74, x1: 960, y1: 96 } },
      ],
    }
    const h = parseHeader(data)
    expect(h.title).toBe('The Braes of Mar')
    expect(h.tuneType).toBe('March')
    expect(h.timeSig).toEqual({ beats: 6, unit: 8 })
    expect(h.composer).toBe('P/M J. MacLeod')
  })

  it('ignores a browser print-to-PDF header/footer', () => {
    const data = {
      lines: [
        line('7/26/26, 2:29 PM   pipeMaster — Bagpipe Sheet Music Editor', 40, 8, 900, 24),
        line('Robin Adair', 300, 40, 700, 90),
        line('4/4 March', 60, 100, 200, 122),
        line('http://localhost:5199/', 40, 960, 300, 978),
      ],
    }
    const h = parseHeader(data)
    expect(h.title).toBe('Robin Adair')
    expect(h.tuneType).toBe('March')
    expect(h.composer).toBeUndefined()
  })

  it('returns nothing usable for an empty scan', () => {
    expect(parseHeader({ lines: [] })).toEqual({})
  })
})

describe('matchEmbellishment (reverse lookup against the registry)', () => {
  it('matches a single gracenote', () => {
    expect(matchEmbellishment('B', ['HighG'])?.type).toBe('gGrace')
    expect(matchEmbellishment('LowA', ['D'])?.type).toBe('dGrace')
  })

  it('matches a doubling and a taorluath', () => {
    expect(matchEmbellishment('LowA', ['HighG', 'LowA', 'D'])?.type).toBe('doubling')
    expect(matchEmbellishment('LowA', ['LowG', 'D', 'LowG', 'E'])?.type).toBe('taorluath')
  })

  // An expansion can include the melody note itself (a doubling on C expands to
  // High G, C, D) but that note is played, not drawn — the page shows only the
  // two little notes. Matching has to work from what is actually written.
  it('matches embellishments from the gracenotes actually drawn on the page', () => {
    // An expansion is the engraved sequence, and it may include a gracenote at
    // the melody note's own pitch: a doubling on C is drawn High G, C, D — three
    // little heads — and a birl on Low A is drawn Low A, Low G, Low A, Low G.
    expect(matchEmbellishment('C', ['HighG', 'C', 'D'])?.type).toBe('doubling')
    expect(matchEmbellishment('F', ['HighG', 'F', 'HighG'])?.type).toBe('doubling')
    expect(matchEmbellishment('LowA', ['LowA', 'LowG', 'LowA', 'LowG'])?.type).toBe('birl')
    expect(matchEmbellishment('LowA', ['LowG', 'D', 'LowG'])?.type).toBe('grip')
    expect(matchEmbellishment('C', ['LowG', 'D', 'LowG'])?.type).toBe('grip')
  })

  it('tells a birl from a G gracenote birl by its leading High G', () => {
    expect(matchEmbellishment('LowA', ['LowA', 'LowG', 'LowA', 'LowG'])?.type).toBe('birl')
    expect(matchEmbellishment('LowA', ['HighG', 'LowA', 'LowG', 'LowA', 'LowG'])?.type).toBe(
      'gGraceBirl',
    )
  })

  it('tells a doubling from a half doubling by its leading gracenote', () => {
    // They differ only in the High G at the front, which is why the whole beamed
    // group must be attached and not just the heads nearest the melody note.
    expect(matchEmbellishment('E', ['HighG', 'E', 'F'])?.type).toBe('doubling')
    expect(matchEmbellishment('E', ['E', 'F'])?.type).toBe('halfDoubling')
  })

  it('does not confuse a doubling with a thumb doubling', () => {
    // These differ only in the first gracenote: High G vs High A.
    expect(matchEmbellishment('C', ['HighG', 'C', 'D'])?.type).toBe('doubling')
    expect(matchEmbellishment('C', ['HighA', 'C', 'D'])?.type).toBe('thumbDoubling')
  })

  it('tolerates one missed gracenote', () => {
    // Doubling on D is [HighG, D, E]; drop the middle D.
    expect(matchEmbellishment('D', ['HighG', 'E'])?.type).toBe('doubling')
  })

  it('returns nothing for an empty or nonsense cluster', () => {
    expect(matchEmbellishment('D', [])).toBeUndefined()
  })
})
