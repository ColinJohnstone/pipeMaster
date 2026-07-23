import type { DetectedNote, OmrRepeat, OmrVolta } from './recognize'
import type { Score } from '../model/types'
import { newId } from '../model/types'
import { createNote } from '../model/create'
import type { TimeSig } from '../duration'
import { barCapacityBeats, beats } from '../duration'

/**
 * Build an editable Score from recognised noteheads. Pitches, embellishments,
 * durations (from beam/flag/stem analysis), and dots are carried over. Notes
 * are packed into bars up to the meter's capacity; recognition isn't perfect,
 * so the user still tidies the odd rhythm in the editor.
 */
/**
 * Split detected notes into bars at the barlines read off the page. Printed
 * music always ends a system at a barline, so each staff is segmented on its
 * own and empty segments (the gap inside a repeat sign) are dropped. This keeps
 * the bar structure faithful even when a note's length was misread — packing by
 * duration alone lets one wrong length shunt every later bar out of place.
 */
interface Segment {
  notes: DetectedNote[]
  staffIndex: number
  /** x of the barline that opened this bar (the previous line, or the staff start). */
  startX: number
  /** x of the barline that closes this bar, if it was read off the page. */
  endX?: number
}

function segmentByBarlines(notes: DetectedNote[], barlines: number[][]): Segment[] {
  const byStaff = new Map<number, DetectedNote[]>()
  for (const n of notes) {
    const list = byStaff.get(n.staffIndex)
    if (list) list.push(n)
    else byStaff.set(n.staffIndex, [n])
  }
  const bars: Segment[] = []
  for (const si of [...byStaff.keys()].sort((a, b) => a - b)) {
    const ns = byStaff.get(si)!.slice().sort((a, b) => a.x - b.x)
    const bl = (barlines[si] ?? []).slice().sort((a, b) => a - b)
    let idx = 0
    let cur: DetectedNote[] = []
    let startX = -Infinity
    for (const n of ns) {
      while (idx < bl.length && n.x > bl[idx]) {
        if (cur.length) bars.push({ notes: cur, staffIndex: si, startX, endX: bl[idx] })
        cur = []
        startX = bl[idx]
        idx++
      }
      cur.push(n)
    }
    if (cur.length) bars.push({ notes: cur, staffIndex: si, startX })
  }
  return bars
}

/** Mark repeat signs and 1st/2nd endings on the bars they fall on. */
function applyStructure(
  segments: Segment[],
  bars: {
    repeatStart?: boolean
    repeatEnd?: boolean
    notes: { voltaStart?: 1 | 2; voltaStop?: boolean }[]
  }[],
  repeats: OmrRepeat[],
  voltas: OmrVolta[],
  sp: number,
): void {
  const tol = sp * 1.5
  for (const r of repeats) {
    if (r.kind === 'end') {
      // The bar that ends at this line.
      let best = -1
      let bestD = tol
      segments.forEach((s, i) => {
        if (s.staffIndex !== r.staffIndex || s.endX === undefined) return
        const d = Math.abs(s.endX - r.x)
        if (d < bestD) {
          bestD = d
          best = i
        }
      })
      if (best >= 0) bars[best].repeatEnd = true
    } else {
      // The bar that opens at this line.
      let best = -1
      let bestD = tol
      segments.forEach((s, i) => {
        if (s.staffIndex !== r.staffIndex) return
        const d = Math.abs(s.startX - r.x)
        if (d < bestD) {
          bestD = d
          best = i
        }
      })
      if (best >= 0) bars[best].repeatStart = true
    }
  }
  for (const v of voltas) {
    // Bars whose notes sit under the bracket form one ending span; mark its
    // first note's start and its last note's stop.
    const covered: number[] = []
    segments.forEach((s, i) => {
      if (s.staffIndex !== v.staffIndex) return
      const cx = (s.notes[0].x + s.notes[s.notes.length - 1].x) / 2
      if (cx >= v.x0 - sp && cx <= v.x1 + sp) covered.push(i)
    })
    if (covered.length === 0) continue
    const firstBar = bars[covered[0]]
    const lastBar = bars[covered[covered.length - 1]]
    if (firstBar.notes[0]) firstBar.notes[0].voltaStart = v.num
    const lastNote = lastBar.notes[lastBar.notes.length - 1]
    if (lastNote) lastNote.voltaStop = true
  }
}

/** Every note length pipeMaster can represent, with its value in beats. */
const LEGAL_DURATIONS: Array<{ base: DetectedNote['base']; dots: 0 | 1; beats: number }> = [
  { base: 32, dots: 0, beats: 0.125 },
  { base: 16, dots: 0, beats: 0.25 },
  { base: 16, dots: 1, beats: 0.375 },
  { base: 8, dots: 0, beats: 0.5 },
  { base: 8, dots: 1, beats: 0.75 },
  { base: 4, dots: 0, beats: 1 },
  { base: 4, dots: 1, beats: 1.5 },
  { base: 2, dots: 0, beats: 2 },
  { base: 2, dots: 1, beats: 3 },
]

/**
 * Re-read a bar's note lengths from how the engraver spaced them. Printed music
 * allots horizontal room in proportion to duration, so a note's share of the
 * bar's width estimates its share of the bar's beats. Beam counting is the
 * primary signal, but it misreads the odd note; this is only consulted when a
 * bar does not add up, and only adopted when the spacing-derived lengths land
 * exactly on the meter — otherwise the original reading stands.
 */
function fitBarBySpacing(seg: Segment, capacity: number): Array<{ base: DetectedNote['base']; dots: 0 | 1 }> | null {
  const ns = seg.notes
  if (ns.length < 2 || seg.endX === undefined) return null
  const widths = ns.map((n, i) => (i + 1 < ns.length ? ns[i + 1].x : seg.endX!) - n.x)
  if (widths.some((wd) => wd <= 0)) return null
  const total = widths.reduce((a, b) => a + b, 0)
  if (total <= 0) return null
  const snapped = widths.map((wd) => {
    const est = (capacity * wd) / total
    let best = LEGAL_DURATIONS[0]
    for (const l of LEGAL_DURATIONS) if (Math.abs(l.beats - est) < Math.abs(best.beats - est)) best = l
    return best
  })
  const sum = snapped.reduce((a, s) => a + s.beats, 0)
  return Math.abs(sum - capacity) < 1e-6 ? snapped.map((s) => ({ base: s.base, dots: s.dots })) : null
}

export function omrToScore(
  notes: DetectedNote[],
  timeSig: TimeSig,
  title: string,
  meta?: {
    composer?: string
    tuneType?: string
    barlines?: number[][]
    repeats?: OmrRepeat[]
    voltas?: OmrVolta[]
    sp?: number
  },
): Score {
  const cap = barCapacityBeats(timeSig)
  const bars: {
    id: string
    notes: ReturnType<typeof createNote>[]
    repeatStart?: boolean
    repeatEnd?: boolean
    volta?: 1 | 2
  }[] = []
  const segments = meta?.barlines?.length ? segmentByBarlines(notes, meta.barlines) : null
  if (segments && segments.length > 0) {
    for (const seg of segments) {
      const read = seg.notes.map((n) => ({ base: n.base, dots: (n.dotted ? 1 : 0) as 0 | 1 }))
      const readTotal = read.reduce((a, d) => a + beats(d), 0)
      // Only second-guess the beam reading when the bar does not add up.
      const fitted = Math.abs(readTotal - cap) < 1e-6 ? null : fitBarBySpacing(seg, cap)
      const durs = fitted ?? read
      bars.push({
        id: newId('b'),
        notes: seg.notes.map((n, i) => createNote(n.pitch, durs[i], n.embellishment)),
      })
    }
    applyStructure(segments, bars, meta?.repeats ?? [], meta?.voltas ?? [], meta?.sp ?? 10)
  } else {
    // No barlines read — fall back to packing notes up to the meter's capacity.
    let current: ReturnType<typeof createNote>[] = []
    let used = 0
    for (const n of notes) {
      const dur = { base: n.base, dots: (n.dotted ? 1 : 0) as 0 | 1 }
      const nb = beats(dur)
      // Start a new bar when this note would overflow the current one.
      if (current.length > 0 && used + nb > cap + 1e-6) {
        bars.push({ id: newId('b'), notes: current })
        current = []
        used = 0
      }
      current.push(createNote(n.pitch, dur, n.embellishment))
      used += nb
    }
    if (current.length > 0) bars.push({ id: newId('b'), notes: current })
  }
  if (bars.length === 0) bars.push({ id: newId('b'), notes: [] })

  return {
    version: 1,
    id: newId('score'),
    title: title || 'Imported from photo',
    tuneType: meta?.tuneType ?? '',
    composer: meta?.composer ?? '',
    timeSig,
    tempo: 80,
    parts: [{ id: newId('p'), bars }],
  }
}
