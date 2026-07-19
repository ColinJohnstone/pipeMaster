import type { Score, Bar, Note, NoteAddress } from '../core/model/types'
import { timeSigForBar } from '../core/model/types'
import type { TimeSig } from '../core/duration'
import { beats, beamGroupBoundaries } from '../core/duration'
import type { Pitch } from '../core/pitch'
import { expandEmbellishment } from '../core/embellishments/registry'

/** One staff space, in px. Everything scales from this. */
export const SPACE = 9
/** Staff height (4 spaces). Also the Bravura font size (SMuFL: 1em = staff height). */
export const STAFF_HEIGHT = SPACE * 4
/** Vertical room reserved per system (gracenotes above, stems/text below). */
export const SYSTEM_HEIGHT = SPACE * 15
/** Top of staff within a system's band. */
export const STAFF_TOP_IN_SYSTEM = SPACE * 5.5
export const PAGE_WIDTH = 1060
export const MARGIN_X = 36
export const HEADER_HEIGHT = 108
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2

export const CLEF_WIDTH = SPACE * 4
export const TIMESIG_WIDTH = SPACE * 3.2
const GRACE_ADVANCE = SPACE * 1.5
const NOTE_MIN_WIDTH = SPACE * 3.2
const BAR_PAD = SPACE * 1.2
const MAX_BARS_PER_SYSTEM = 4

export interface LaidGrace {
  pitch: Pitch
  /** x relative to bar origin. */
  x: number
}

export interface LaidNote {
  note: Note
  addr: NoteAddress
  /** Notehead center x relative to bar origin. */
  x: number
  graces: LaidGrace[]
  /** Beat offset of this note from the start of its bar. */
  beatOffset: number
}

export interface LaidBar {
  bar: Bar
  partIndex: number
  barIndex: number
  /** x of the bar's left barline relative to page margin. */
  x: number
  width: number
  notes: LaidNote[]
  timeSig: TimeSig
  /** Draw clef (first bar of each system). */
  showClef: boolean
  /** Draw the meter (first bar of tune or meter change). */
  showTimeSig: boolean
  isFirstOfSystem: boolean
  isLastOfPart: boolean
}

export interface LaidSystem {
  bars: LaidBar[]
  /** y of the staff's top line on the page. */
  staffTop: number
  partIndex: number
  /** Part label like "2." shown at the line start when a part begins here. */
  partLabel?: string
}

export interface ScoreLayout {
  systems: LaidSystem[]
  width: number
  height: number
}

interface MeasuredBar {
  partIndex: number
  barIndex: number
  bar: Bar
  timeSig: TimeSig
  showTimeSig: boolean
  naturalWidth: number
}

/** Natural (unjustified) width of a bar's contents. */
function measureBar(bar: Bar): number {
  let w = BAR_PAD
  for (const note of bar.notes) {
    const graces = expandEmbellishment(note.embellishment, note.pitch)
    w += graces.length * GRACE_ADVANCE
    w += Math.max(NOTE_MIN_WIDTH, SPACE * 2.6 * Math.sqrt(beats(note.duration)))
    w += note.duration.dots > 0 ? SPACE : 0
  }
  w += BAR_PAD
  return Math.max(w, SPACE * 8)
}

/** Lay notes into a bar of the given final width. */
function layNotes(
  bar: Bar,
  partIndex: number,
  barIndex: number,
  contentStart: number,
  width: number,
): LaidNote[] {
  const items = bar.notes.map((note) => {
    const graces = expandEmbellishment(note.embellishment, note.pitch)
    return {
      note,
      graces,
      graceW: graces.length * GRACE_ADVANCE,
      noteW:
        Math.max(NOTE_MIN_WIDTH, SPACE * 2.6 * Math.sqrt(beats(note.duration))) +
        (note.duration.dots > 0 ? SPACE : 0),
    }
  })
  const natural = items.reduce((a, i) => a + i.graceW + i.noteW, 0)
  const avail = width - contentStart - BAR_PAD
  // Stretch only the melodic spacing; gracenote clusters keep their size.
  const graceTotal = items.reduce((a, i) => a + i.graceW, 0)
  const stretch = natural > 0 ? Math.max(0.6, (avail - graceTotal) / (natural - graceTotal || 1)) : 1

  const laid: LaidNote[] = []
  let x = contentStart + BAR_PAD * 0.5
  let beatOffset = 0
  bar.notes.forEach((note, noteIndex) => {
    const it = items[noteIndex]
    const graces: LaidGrace[] = it.graces.map((pitch, gi) => ({
      pitch,
      x: x + gi * GRACE_ADVANCE + GRACE_ADVANCE * 0.5,
    }))
    x += it.graceW
    const noteWidth = it.noteW * stretch
    laid.push({
      note,
      addr: { partIndex, barIndex, noteIndex },
      x: x + SPACE * 1.2,
      graces,
      beatOffset,
    })
    x += noteWidth
    beatOffset += beats(note.duration)
  })
  return laid
}

export function layoutScore(score: Score): ScoreLayout {
  // Measure every bar with its effective meter.
  const measured: MeasuredBar[] = []
  let prevTs: TimeSig | null = null
  score.parts.forEach((part, partIndex) => {
    part.bars.forEach((bar, barIndex) => {
      const ts = timeSigForBar(score, partIndex, barIndex)
      const isTuneStart = partIndex === 0 && barIndex === 0
      const changed =
        prevTs !== null && (ts.beats !== prevTs.beats || ts.unit !== prevTs.unit)
      measured.push({
        partIndex,
        barIndex,
        bar,
        timeSig: ts,
        showTimeSig: isTuneStart || changed,
        naturalWidth: measureBar(bar),
      })
      prevTs = ts
    })
  })

  // Break into systems: parts always start a new line (pipe convention),
  // at most 4 bars per line, wrap early only if genuinely over-full.
  const systems: LaidSystem[] = []
  let current: MeasuredBar[] = []
  let currentNatural = 0

  const flush = () => {
    if (current.length === 0) return
    systems.push(buildSystem(current, systems.length))
    current = []
    currentNatural = 0
  }

  for (const mb of measured) {
    const startsPart = mb.barIndex === 0
    const prefix = current.length === 0 ? CLEF_WIDTH + (mb.showTimeSig ? TIMESIG_WIDTH : 0) : 0
    const wouldOverflow =
      current.length > 0 &&
      currentNatural + mb.naturalWidth + prefix > CONTENT_WIDTH * 1.15
    if (startsPart || current.length >= MAX_BARS_PER_SYSTEM || wouldOverflow) flush()
    current.push(mb)
    currentNatural += mb.naturalWidth
  }
  flush()

  function buildSystem(mbs: MeasuredBar[], systemIndex: number): LaidSystem {
    const staffTop = HEADER_HEIGHT + systemIndex * SYSTEM_HEIGHT + STAFF_TOP_IN_SYSTEM
    const naturalTotal = mbs.reduce((a, m) => a + m.naturalWidth, 0)
    const prefixTotal = CLEF_WIDTH + (mbs[0].showTimeSig ? TIMESIG_WIDTH : 0)
    const scale = (CONTENT_WIDTH - prefixTotal) / naturalTotal

    const bars: LaidBar[] = []
    let x = 0
    mbs.forEach((mb, i) => {
      const isFirst = i === 0
      const prefix = isFirst ? CLEF_WIDTH + (mb.showTimeSig ? TIMESIG_WIDTH : 0) : 0
      const width = mb.naturalWidth * scale + prefix
      bars.push({
        bar: mb.bar,
        partIndex: mb.partIndex,
        barIndex: mb.barIndex,
        x,
        width,
        timeSig: mb.timeSig,
        showClef: isFirst,
        showTimeSig: isFirst && mb.showTimeSig,
        isFirstOfSystem: isFirst,
        isLastOfPart: false,
        notes: layNotes(mb.bar, mb.partIndex, mb.barIndex, prefix, width),
      })
      x += width
    })
    const last = mbs[mbs.length - 1]
    const lastBar = bars[bars.length - 1]
    // Mark part ends for final/double barlines.
    lastBar.isLastOfPart = false
    const sys: LaidSystem = {
      bars,
      staffTop,
      partIndex: mbs[0].partIndex,
      partLabel:
        mbs[0].barIndex === 0 && countParts() > 1
          ? `${mbs[0].partIndex + 1}.`
          : undefined,
    }
    void last
    return sys
  }

  function countParts() {
    return score.parts.length
  }

  // Mark bars that end a part (for double barlines).
  for (const sys of systems) {
    for (const lb of sys.bars) {
      lb.isLastOfPart = lb.barIndex === score.parts[lb.partIndex].bars.length - 1
    }
  }

  const height = HEADER_HEIGHT + systems.length * SYSTEM_HEIGHT + SPACE * 6
  return { systems, width: PAGE_WIDTH, height }
}

/** y of a staff position (0 = bottom line) relative to the staff's top line. */
export function positionToY(position: number): number {
  return ((8 - position) * SPACE) / 2
}

/** Beam groups for a bar: arrays of note indices that share a beam. */
export function beamGroups(laid: LaidBar): number[][] {
  const bounds = beamGroupBoundaries(laid.timeSig)
  const groups: number[][] = []
  let group: number[] = []
  let groupStart = -1

  const boundaryIndex = (t: number) => {
    for (let i = bounds.length - 1; i >= 0; i--) {
      if (t >= bounds[i] - 1e-9) return i
    }
    return 0
  }

  laid.notes.forEach((ln, i) => {
    const beamable = ln.note.duration.base >= 8
    const bIdx = boundaryIndex(ln.beatOffset)
    if (!beamable) {
      if (group.length > 1) groups.push(group)
      group = []
      groupStart = -1
      return
    }
    if (group.length > 0 && bIdx !== groupStart) {
      if (group.length > 1) groups.push(group)
      group = []
    }
    if (group.length === 0) groupStart = bIdx
    group.push(i)
  })
  if (group.length > 1) groups.push(group)
  return groups
}
