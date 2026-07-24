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

/**
 * Guess the time signature from the music itself: read the notes off the page,
 * split them at the detected barlines, and see how many beats a full bar holds.
 * The most common bar total is the meter's capacity — far more reliable than
 * reading the tiny printed time-signature glyph, which OCR routinely misses, and
 * it is what stops a 3/4 tune importing as 4/4 with every bar a beat short.
 *
 * Returns null when there is too little to go on (few bars, or no barlines), so
 * the caller can keep whatever the header OCR or the user chose.
 */
export function inferTimeSig(notes: DetectedNote[], barlines: number[][]): TimeSig | null {
  if (!barlines.some((b) => b.length > 0)) return null
  const segs = segmentByBarlines(notes, barlines)
  // Only full interior bars are reliable — the first/last of a line may be a
  // pickup or a bar the barline detector clipped.
  const totals: number[] = []
  for (const s of segs) {
    if (s.endX === undefined || s.notes.length === 0) continue
    const t = s.notes.reduce((a, n) => a + beats({ base: n.base, dots: n.dotted ? 1 : 0 }), 0)
    if (t > 0.5) totals.push(Math.round(t * 2) / 2) // nearest half-beat
  }
  if (totals.length < 3) return null
  // The commonest bar total is the capacity.
  const freq = new Map<number, number>()
  for (const t of totals) freq.set(t, (freq.get(t) ?? 0) + 1)
  let cap = 0
  let best = 0
  for (const [t, n] of freq) if (n > best || (n === best && t > cap)) [best, cap] = [n, t]
  // Need a clear winner, not a scatter of misread bars.
  if (best < Math.max(2, totals.length * 0.34)) return null
  // A three-beat bar is 3/4 OR 6/8 — same capacity, different feel. Compound
  // time is dense with quavers (two groups of three), so tell them apart by how
  // many notes a full bar carries: a 6/8 bar runs to five or more, a 3/4 march
  // sits around three or four. Six beats splits 12/8 vs a rare 6/4 the same way.
  const capBars = segs.filter(
    (s) =>
      s.endX !== undefined &&
      Math.round(
        s.notes.reduce((a, n) => a + beats({ base: n.base, dots: n.dotted ? 1 : 0 }), 0) * 2,
      ) /
        2 ===
        cap,
  )
  const avgNotes = capBars.reduce((a, s) => a + s.notes.length, 0) / Math.max(1, capBars.length)
  if (cap === 3) return avgNotes >= 5 ? { beats: 6, unit: 8 } : { beats: 3, unit: 4 }
  if (cap === 6) return { beats: 12, unit: 8 }
  const BY_CAP: Record<number, TimeSig> = {
    1.5: { beats: 3, unit: 8 },
    2: { beats: 2, unit: 4 },
    4: { beats: 4, unit: 4 },
    4.5: { beats: 9, unit: 8 },
  }
  return BY_CAP[cap] ?? null
}

/**
 * The tune type breaks the 3/4-vs-6/8 tie the notes can't. A waltz (or minuet)
 * is always 3/4; a jig, or a march written in 6/8, is compound. Both fill a
 * three-beat bar with six quavers, so only the named dance tells them apart —
 * used to correct the density guess once header OCR has read the type.
 */
export function meterForType(ts: TimeSig, tuneType: string | undefined): TimeSig {
  if (!tuneType || barCapacityBeats(ts) !== 3) return ts
  const t = tuneType.toLowerCase()
  if (/waltz|minuet/.test(t)) return { beats: 3, unit: 4 }
  if (/jig/.test(t)) return { beats: 6, unit: 8 }
  return ts
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
      // Keep the note lengths exactly as read from the beams and stems — the
      // same values shown on the review screen. Re-deriving a whole bar's
      // lengths from spacing to force it onto the meter changed notes that were
      // read correctly, so the import no longer matches what you reviewed.
      const durs = seg.notes.map((n) => ({ base: n.base, dots: (n.dotted ? 1 : 0) as 0 | 1 }))
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
