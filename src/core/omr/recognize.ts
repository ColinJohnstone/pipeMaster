import type { Pitch } from '../pitch'
import type { EmbellishmentType } from '../embellishments/registry'
import { matchEmbellishment } from './matchEmbellishment'

/**
 * Optical music recognition for pipe scores — a classical computer-vision
 * pipeline (no ML model, runs fully client-side):
 *
 *   grayscale → Otsu threshold → skew estimate + deskew →
 *   staff-line detection → staff-line removal → distance-transform notehead
 *   detection (melody + gracenote sizes) → pitch mapping → gracenote
 *   clustering → embellishment reverse-match → dot detection.
 *
 * It recognises note PITCHES, EMBELLISHMENTS, and augmentation dots. Note
 * durations are still approximate (filled noteheads default to quavers), so
 * treat the result as a strong draft, not a faithful transcription.
 */

export interface DetectedGrace {
  pitch: Pitch
  x: number
  y: number
}

export interface DetectedNote {
  pitch: Pitch
  x: number
  y: number
  staffIndex: number
  /** Detected note-length base (4 = crotchet, 8 = quaver, …). */
  base: 1 | 2 | 4 | 8 | 16 | 32
  embellishment?: EmbellishmentType
  dotted?: boolean
  graces: DetectedGrace[]
}

export interface DetectedStaff {
  lines: number[]
  spacing: number
}

export interface OmrRepeat {
  staffIndex: number
  x: number
  /** 'start' = |: (dots right of the line), 'end' = :| (dots left). */
  kind: 'start' | 'end'
}

export interface OmrVolta {
  staffIndex: number
  /** Bracket span in image x. */
  x0: number
  x1: number
  num: 1 | 2
}

export interface OmrResult {
  notes: DetectedNote[]
  staves: DetectedStaff[]
  /** Barline x positions per staff, so bars survive a misread note length. */
  barlines: number[][]
  /** Repeat barlines (dots beside a line), and 1st/2nd ending brackets. */
  repeats: OmrRepeat[]
  voltas: OmrVolta[]
  width: number
  height: number
  /** Degrees the image was rotated to straighten the staves. */
  skewDeg: number
  /** The processed (deskewed, downscaled) grayscale, for aligning an overlay. */
  processedGray: Uint8Array
  warnings: string[]
}

/** Treble-clef staff position (bottom line E4 = 0) → bagpipe pitch. */
const POSITION_TO_PITCH: Record<number, Pitch> = {
  2: 'LowG',
  3: 'LowA',
  4: 'B',
  5: 'C',
  6: 'D',
  7: 'E',
  8: 'F',
  9: 'HighG',
  10: 'HighA',
}

const MAX_WIDTH = 1600
/** Staff spacing below this leaves noteheads too small to resolve reliably. */
const MIN_SPACING = 9

// Gracenote-to-note attachment, in staff spaces. A head between MIN and SEED of
// a note starts that note's group; a head within GAP of one already in the group
// joins it, up to MAX from the note overall. Beamed gracenotes are spaced ~1.5
// apart while a cluster sits ~2 clear of its note, so GAP walks a group and
// stops at its left edge instead of running into the previous note's.
const CLUSTER_MIN = 1.2
const CLUSTER_SEED = 4.6
const CLUSTER_GAP = 2
const CLUSTER_MAX = 8

// -- Basic image ops ---------------------------------------------------------

function toGray(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    g[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000
  }
  return g
}

function otsu(gray: Uint8Array): number {
  const hist = new Array(256).fill(0)
  for (const v of gray) hist[v]++
  const total = gray.length
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0
  let wB = 0
  let best = 0
  let threshold = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    // `>=` keeps the upper end of the optimal plateau (clean B/W scans).
    if (between >= best) {
      best = between
      threshold = t
    }
  }
  return threshold
}

/**
 * Cheap look at the staff spacing before any real work, to decide whether the
 * image needs enlarging. Returns the most common gap between candidate staff
 * lines, or 0 when the spacing is already adequate (or nothing looks like a
 * staff, in which case enlarging would not help).
 */
function probeSpacing(gray: Uint8Array, w: number, h: number): number {
  const thr = otsu(gray)
  const rows: number[] = []
  for (let y = 0; y < h; y++) {
    let c = 0
    const row = y * w
    for (let x = 0; x < w; x++) if (gray[row + x] < thr) c++
    rows.push(c)
  }
  const lineThresh = w * 0.35
  const centres: number[] = []
  let y = 0
  while (y < h) {
    if (rows[y] >= lineThresh) {
      let y2 = y
      while (y2 < h && rows[y2] >= lineThresh) y2++
      centres.push((y + y2 - 1) / 2)
      y = y2
    } else y++
  }
  if (centres.length < 4) return 0
  const hist = new Map<number, number>()
  for (let i = 1; i < centres.length; i++) {
    const k = Math.round(centres[i] - centres[i - 1])
    if (k >= 2) hist.set(k, (hist.get(k) ?? 0) + 1)
  }
  let sp = 0
  let best = 0
  for (const [k, n] of hist) if (n > best) [best, sp] = [n, k]
  return sp > 0 && sp < MIN_SPACING ? sp : 0
}

// -- Deskew ------------------------------------------------------------------

/**
 * Estimate page skew by finding the rotation angle that makes the horizontal
 * projection of ink most "peaky" — staff lines pile into sharp peaks only
 * when they are horizontal.
 */
function estimateSkewDeg(ink: Uint8Array, w: number, h: number): number {
  const pts: number[] = []
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (ink[y * w + x]) {
        pts.push(x, y)
      }
    }
  }
  if (pts.length < 100) return 0

  const score = (deg: number): number => {
    const rad = (deg * Math.PI) / 180
    const s = Math.sin(rad)
    const c = Math.cos(rad)
    const off = Math.ceil(w * Math.abs(s)) + 1
    const bins = new Float64Array(h + 2 * off + 2)
    for (let i = 0; i < pts.length; i += 2) {
      const ry = Math.round(pts[i] * s + pts[i + 1] * c) + off
      if (ry >= 0 && ry < bins.length) bins[ry]++
    }
    let acc = 0
    for (const b of bins) acc += b * b
    return acc
  }

  let bestDeg = 0
  let bestScore = -1
  for (let a = -4; a <= 4; a += 0.5) {
    const sc = score(a)
    if (sc > bestScore) {
      bestScore = sc
      bestDeg = a
    }
  }
  // Refine around the coarse best.
  for (let a = bestDeg - 0.5; a <= bestDeg + 0.5; a += 0.15) {
    const sc = score(a)
    if (sc > bestScore) {
      bestScore = sc
      bestDeg = a
    }
  }
  return bestDeg
}

/** Rotate a grayscale buffer about its centre (nearest-neighbour, white fill). */
function rotateGray(gray: Uint8Array, w: number, h: number, deg: number): Uint8Array {
  const rad = (deg * Math.PI) / 180
  const s = Math.sin(rad)
  const c = Math.cos(rad)
  const cx = w / 2
  const cy = h / 2
  const out = new Uint8Array(w * h).fill(255)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx
      const dy = y - cy
      const sx = Math.round(cx + dx * c + dy * s)
      const sy = Math.round(cy - dx * s + dy * c)
      if (sx >= 0 && sx < w && sy >= 0 && sy < h) out[y * w + x] = gray[sy * w + sx]
    }
  }
  return out
}

// -- Staves ------------------------------------------------------------------

function detectStaves(ink: Uint8Array, w: number, h: number, warnings: string[]): DetectedStaff[] {
  const rowDark = new Int32Array(h)
  for (let y = 0; y < h; y++) {
    let c = 0
    const row = y * w
    for (let x = 0; x < w; x++) if (ink[row + x]) c++
    rowDark[y] = c
  }
  const lineThresh = w * 0.35
  const lineCentres: number[] = []
  let y = 0
  while (y < h) {
    if (rowDark[y] >= lineThresh) {
      let y2 = y
      while (y2 < h && rowDark[y2] >= lineThresh) y2++
      lineCentres.push((y + y2 - 1) / 2)
      y = y2
    } else y++
  }
  if (lineCentres.length < 5) {
    warnings.push('Could not find full staff lines — is the photo cropped to the music and reasonably straight?')
    return []
  }

  const gaps = lineCentres.slice(1).map((v, i) => v - lineCentres[i])
  // Single-line spacing = the most common gap (ignoring tiny noise gaps).
  const hist = new Map<number, number>()
  for (const g of gaps) {
    const k = Math.round(g)
    if (k >= 3) hist.set(k, (hist.get(k) ?? 0) + 1)
  }
  let sp = 0
  let bestN = 0
  for (const [k, n] of hist) {
    if (n > bestN) {
      bestN = n
      sp = k
    }
  }
  if (!sp) {
    const sorted = [...gaps].sort((a, b) => a - b)
    sp = sorted[Math.floor(sorted.length / 2)] || 8
  }

  // Group consecutive lines belonging to one staff (a missing middle line
  // leaves a ~2sp gap; between-staff gaps are far larger). Each staff spans
  // exactly four gaps (five lines), so interpolate the five evenly whether or
  // not every line was detected — this fixes spacing when a line drops out.
  const staves: DetectedStaff[] = []
  let group: number[] = [lineCentres[0]]
  /**
   * Pull every five-line staff out of a group of nearby lines. Scanning within
   * the group (rather than demanding the whole group span exactly four gaps)
   * makes this robust to extra rows that land close to the music — a dense line
   * of footer text under the last system used to be merged in and throw the
   * whole staff away. A span of four gaps whose implied spacing matches the
   * page's is a staff, even if some of its own lines went undetected.
   */
  const flush = () => {
    let i = 0
    while (i + 1 < group.length) {
      let matched = false
      for (let j = Math.min(group.length - 1, i + 6); j > i + 1; j--) {
        const span = group[j] - group[i]
        const gsp = span / 4
        if (Math.round(span / sp) === 4 && Math.abs(gsp - sp) <= sp * 0.3) {
          staves.push({ lines: [0, 1, 2, 3, 4].map((k) => group[i] + k * gsp), spacing: gsp })
          i = j + 1
          matched = true
          break
        }
      }
      if (!matched) i++
    }
    group = []
  }
  for (let i = 1; i < lineCentres.length; i++) {
    if (lineCentres[i] - lineCentres[i - 1] <= sp * 2.6) group.push(lineCentres[i])
    else {
      flush()
      group = [lineCentres[i]]
    }
  }
  flush()
  if (staves.length === 0) warnings.push('Found staff lines but could not group them into staves.')
  return staves
}

/**
 * Erase staff lines using their known positions. At each line, a column whose
 * vertical ink run is no thicker than a line is cleared; columns with a long
 * run (a stem or notehead passing through) are kept. This copes with lines a
 * few pixels thick, which the naive "no ink above or below" test leaves behind.
 */
function removeStaffLines(
  ink: Uint8Array,
  w: number,
  h: number,
  staves: DetectedStaff[],
  sp: number,
): Uint8Array {
  const out = ink.slice()
  const maxThick = Math.max(2, Math.round(sp * 0.2))
  const idx = (x: number, y: number) => y * w + x
  for (const st of staves) {
    for (const line of st.lines) {
      const y0 = Math.round(line)
      for (let x = 0; x < w; x++) {
        // Find an ink pixel on the line at this column.
        let seed = -1
        for (let dy = -1; dy <= 1; dy++) {
          if (inkAt(ink, w, h, x, y0 + dy)) {
            seed = y0 + dy
            break
          }
        }
        if (seed < 0) continue
        let up = 0
        while (inkAt(ink, w, h, x, seed - 1 - up)) up++
        let dn = 0
        while (inkAt(ink, w, h, x, seed + 1 + dn)) dn++
        if (up + dn + 1 <= maxThick) {
          for (let y = seed - up; y <= seed + dn; y++) out[idx(x, y)] = 0
        }
      }
    }
  }
  return out
}

// -- Notehead detection via distance transform -------------------------------

/**
 * Chamfer (3,4) distance transform: for each ink pixel, approximate distance
 * to the nearest background pixel, in pixel units. Solid noteheads produce a
 * high central value (~their radius); thin stems and beams stay low.
 */
function distanceTransform(ink: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9
  const d = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) d[i] = ink[i] ? INF : 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (d[i] === 0) continue
      let m = d[i]
      if (x > 0) m = Math.min(m, d[i - 1] + 3)
      if (y > 0) m = Math.min(m, d[i - w] + 3)
      if (x > 0 && y > 0) m = Math.min(m, d[i - w - 1] + 4)
      if (x < w - 1 && y > 0) m = Math.min(m, d[i - w + 1] + 4)
      d[i] = m
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x
      if (d[i] === 0) continue
      let m = d[i]
      if (x < w - 1) m = Math.min(m, d[i + 1] + 3)
      if (y < h - 1) m = Math.min(m, d[i + w] + 3)
      if (x < w - 1 && y < h - 1) m = Math.min(m, d[i + w + 1] + 4)
      if (x > 0 && y < h - 1) m = Math.min(m, d[i + w - 1] + 4)
      d[i] = m
    }
  }
  for (let i = 0; i < w * h; i++) d[i] /= 3 // chamfer units → pixels
  return d
}

interface Blob {
  x: number
  y: number
  r: number
}

/** Local-maxima of the distance transform (notehead centres), with NMS. */
function findBlobs(dt: Float32Array, w: number, h: number, minR: number): Blob[] {
  const cands: Blob[] = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const v = dt[y * w + x]
      if (v < minR) continue
      let isMax = true
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dt[(y + dy) * w + (x + dx)] > v) {
            isMax = false
            break
          }
        }
      }
      if (isMax) cands.push({ x, y, r: v })
    }
  }
  cands.sort((a, b) => b.r - a.r)
  const kept: Blob[] = []
  for (const c of cands) {
    let ok = true
    for (const k of kept) {
      const dx = k.x - c.x
      const dy = k.y - c.y
      const rad = k.r * 1.5
      if (dx * dx + dy * dy < rad * rad) {
        ok = false
        break
      }
    }
    if (ok) kept.push(c)
  }
  return kept
}

/**
 * Staff position of a y, corrected by that staff's measured phase (see
 * staffPhase). Noteheads only ever sit on integer positions, so the phase says
 * how far the detected line geometry is drifting from where the notes actually
 * are.
 */
function positionAt(staff: DetectedStaff, y: number, phase = 0): number {
  return (staff.lines[staff.lines.length - 1] - y) / (staff.spacing / 2) - phase
}

function pitchForY(staff: DetectedStaff, y: number, phase = 0): Pitch {
  let position = Math.round(positionAt(staff, y, phase))
  position = Math.max(2, Math.min(10, position))
  return POSITION_TO_PITCH[position]
}

/**
 * How far a staff's computed positions sit from the whole numbers they should
 * land on. Line centres come from thresholded row runs, so thick or soft-edged
 * lines bias the geometry by a fraction of a space; left uncorrected that
 * fraction pushes notes across a rounding boundary and every D reads as a C.
 * The notes themselves reveal the true grid: take the median offset from a whole
 * position and subtract it.
 */
function staffPhase(positions: number[]): number {
  if (positions.length < 3) return 0
  const frac = positions.map((p) => p - Math.round(p)).sort((a, b) => a - b)
  return frac[frac.length >> 1]
}

function nearestStaff(staves: DetectedStaff[], y: number): number {
  let idx = 0
  let bestDist = Infinity
  staves.forEach((s, i) => {
    const centre = (s.lines[0] + s.lines[s.lines.length - 1]) / 2
    const d = Math.abs(y - centre)
    if (d < bestDist) {
      bestDist = d
      idx = i
    }
  })
  return idx
}

// -- Duration analysis (stems, beams, flags, open noteheads) -----------------

function inkAt(ink: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  return x >= 0 && x < w && y >= 0 && y < h && ink[y * w + x] === 1
}

interface Stem {
  dir: 1 | -1 | 0 // 1 = down, -1 = up
  tipY: number
  x: number
  len: number
}

/** Longest vertical ink run attached to a notehead — the stem. */
function findStem(
  ink: Uint8Array,
  w: number,
  h: number,
  nx: number,
  ny: number,
  r: number,
  sp: number,
): Stem {
  let best: Stem = { dir: 0, tipY: ny, x: Math.round(nx), len: 0 }
  // A stem attaches at the left or right edge of the notehead (~half a space
  // from centre), so search both the blob radius and the nominal head width.
  // Sweep the whole width of the notehead rather than probing a few nominal
  // offsets. Where a stem sits depends on how the head was engraved and on how
  // accurately the blob was centred, and a handful of fixed columns kept missing
  // it: one note in six was reported stemless and silently defaulted to a
  // quaver, which is where most wrong note lengths came from.
  const cols: number[] = []
  for (let d = -0.8; d <= 0.8001; d += 0.1) cols.push(Math.round(nx + d * sp))
  cols.push(Math.round(nx - r * 0.8), Math.round(nx + r * 0.8))
  for (const sx of cols) {
    for (const dir of [1, -1] as const) {
      let len = 0
      let gaps = 0
      let y = Math.round(ny + dir * r * 0.5)
      let lastInkY = y
      for (; y >= 0 && y < h; y += dir) {
        if (inkAt(ink, w, h, sx, y) || inkAt(ink, w, h, sx - 1, y) || inkAt(ink, w, h, sx + 1, y)) {
          len += 1 + gaps
          gaps = 0
          lastInkY = y
        } else {
          gaps++
          if (gaps > 2) break
        }
      }
      // tipY is the actual furthest ink, not ny+len (the scan starts offset).
      if (len > best.len) best = { dir, tipY: lastInkY, x: sx, len }
    }
  }
  return best
}

/** Consecutive ink pixels horizontally from (x,y) in direction step (±1). */
function hRun(ink: Uint8Array, w: number, h: number, x: number, y: number, step: number): number {
  let n = 0
  for (let xx = x; xx >= 0 && xx < w; xx += step) {
    if (inkAt(ink, w, h, xx, y)) n++
    else break
  }
  return n
}

/**
 * Count beams (or flags) stacked at a stem tip: horizontal ink bands beside the
 * stem near its tip. 1 → quaver, 2 → semiquaver, 3 → demisemiquaver.
 */
function countBeams(ink: Uint8Array, w: number, h: number, stem: Stem, sp: number): number {
  const toNote = -stem.dir // scan from the tip back toward the notehead
  let bands = 0
  let inBand = false
  // Stay near the tip so the notehead's own width is never counted as a beam.
  const span = Math.min(Math.round(sp * 1.4), Math.max(1, Math.round(stem.len - sp * 0.5)))
  for (let k = 0; k < span; k++) {
    const y = stem.tipY + toNote * k
    if (y < 0 || y >= h) break
    const run = hRun(ink, w, h, stem.x + 1, y, 1) + hRun(ink, w, h, stem.x - 1, y, -1)
    // A beam only has to be clearly wider than the stem it crosses. Demanding
    // 0.7 of a space missed real beams wholesale — the last note under a beam
    // carries only its own stub of one — and read the quavers as crotchets.
    // 0.45 and 0.55 score within one of each other, so this is a flat optimum.
    const isBeam = run >= sp * 0.5
    if (isBeam && !inBand) {
      bands++
      inBand = true
    } else if (!isBeam) {
      inBand = false
    }
  }
  return Math.min(bands, 3)
}

/**
 * Where the music proper begins on a staff — past the clef and, on the first
 * staff, past the time signature. Both are WIDE blocks of ink spanning almost
 * the whole staff height, whereas a stem is only a pixel or two wide, so a
 * minimum width tells them apart. Earlier this was a fixed offset, which either
 * clipped the first note or (on a wide layout) let the metre digits through to
 * be read as noteheads or gracenotes.
 */
function musicStartX(
  noStaff: Uint8Array,
  w: number,
  h: number,
  staff: DetectedStaff,
  sp: number,
  leftEdge: number,
): number {
  const top = Math.max(0, Math.round(staff.lines[0]))
  const bottom = Math.min(h - 1, Math.round(staff.lines[staff.lines.length - 1]))
  const from = Math.max(0, Math.round(leftEdge))
  const limit = Math.min(w - 1, Math.round(leftEdge + sp * 12))
  const blocks: Array<{ x0: number; x1: number }> = []
  let runStart = -1
  for (let x = from; x <= limit; x++) {
    let minY = -1
    let maxY = -1
    for (let y = top; y <= bottom; y++) {
      if (noStaff[y * w + x]) {
        if (minY < 0) minY = y
        maxY = y
      }
    }
    const tall = minY >= 0 && maxY - minY >= sp * 3.2
    if (tall) {
      if (runStart < 0) runStart = x
    } else if (runStart >= 0) {
      if (x - runStart >= sp * 0.4) blocks.push({ x0: runStart, x1: x - 1 })
      runStart = -1
    }
  }
  if (runStart >= 0 && limit - runStart >= sp * 0.4) blocks.push({ x0: runStart, x1: limit })
  let end = leftEdge
  for (const g of blocks) if (g.x0 <= leftEdge + sp * 8) end = Math.max(end, g.x1)
  // Every staff opens with a clef, so the music never starts hard against the
  // left edge — keep a floor even when no block was measured.
  return Math.max(end + sp * 0.5, leftEdge + sp * 2.5)
}

/**
 * Barlines: columns of ink running the full height of a staff. A note's stem can
 * be nearly as tall, so columns that sit right beside a detected notehead are
 * dropped — a stem attaches about half a space from its head, while a barline
 * stands clear of the music. Adjacent columns (thick and repeat barlines) merge
 * into one. Knowing where the bars actually are means bar structure survives
 * even when a note's duration is misread.
 */
/**
 * Is this barline a repeat sign, and which way does it face? A repeat barline
 * carries two dots stacked in the middle two spaces of the staff — to the LEFT
 * of the line for an end repeat (:|), to the RIGHT for a start (|:). Look for
 * ink in both dot spaces just off each side of the line.
 */
function detectRepeatKind(
  ink: Uint8Array,
  w: number,
  h: number,
  staff: DetectedStaff,
  sp: number,
  barX: number,
): 'start' | 'end' | null {
  const L = staff.lines
  // The two spaces either side of the middle line hold the dots.
  const dotYs = [(L[1] + L[2]) / 2, (L[2] + L[3]) / 2].map(Math.round)
  const inkNear = (cx: number, cy: number, rad = sp * 0.3): boolean => {
    const r = Math.round(rad)
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) if (inkAt(ink, w, h, x, y)) return true
    return false
  }
  // A repeat dot is a small round speck; a notehead sharing the space is far
  // wider. Require a compact ink blob at the dot — present, but narrow.
  const isDot = (cx: number, cy: number): boolean => {
    if (!inkNear(cx, cy, sp * 0.22)) return false
    const runW = hRun(ink, w, h, cx, cy, 1) + hRun(ink, w, h, cx, cy, -1)
    return runW > 0 && runW <= sp * 0.55
  }
  const sideHasDots = (dir: -1 | 1): boolean => {
    // Dots sit ~0.5–1.5 sp off the line; sample a couple of offsets.
    for (const off of [sp * 0.7, sp * 1.1]) {
      const cx = Math.round(barX + dir * off)
      if (!dotYs.every((cy) => isDot(cx, cy))) continue
      // A repeat dot is an isolated speck. A stem or a notehead edge that
      // happens to fill the two spaces runs on ABOVE the upper dot and BELOW
      // the lower one — so reject anything with ink in that vertical margin.
      if (inkNear(cx, dotYs[0] - sp * 0.9, sp * 0.25)) continue
      if (inkNear(cx, dotYs[1] + sp * 0.9, sp * 0.25)) continue
      return true
    }
    return false
  }
  // Dots belong to one side only; if both look dotted it is note ink, not a
  // repeat, so take neither.
  const left = sideHasDots(-1)
  const right = sideHasDots(1)
  if (left && !right) return 'end'
  if (right && !left) return 'start'
  return null
}

/**
 * Find 1st/2nd ending brackets above a staff. A volta is a horizontal rule over
 * the ending bars, a short distance above the top line. Detect long horizontal
 * ink runs in that band and take each as one bracket; number them in reading
 * order (voltas always go 1 then 2), which sidesteps reading the digit itself.
 */
function detectVoltasForStaff(
  ink: Uint8Array,
  w: number,
  h: number,
  staff: DetectedStaff,
  sp: number,
  leftEdge: number,
): Array<{ x0: number; x1: number }> {
  const topLine = staff.lines[0]
  const y0 = Math.round(topLine - sp * 3.5)
  const y1 = Math.round(topLine - sp * 1.0)
  if (y0 < 0) return []
  // A volta rule is a thin horizontal line at a near-constant height. For each
  // column above the staff, record the y of ink in the band (topmost hit); a
  // column is "on the rule" if it has ink. Working by column, not by a single
  // continuous row, tolerates a slightly skewed or broken bracket line.
  const colY: number[] = new Array(w).fill(-1)
  for (let x = Math.round(leftEdge); x < w; x++) {
    for (let y = y0; y <= y1; y++)
      if (inkAt(ink, w, h, x, y)) {
        colY[x] = y
        break
      }
  }
  // Group runs of inked columns, allowing a small gap, into candidate spans.
  const spans: Array<{ x0: number; x1: number; ys: number[] }> = []
  let sx = -1
  let gap = 0
  let ys: number[] = []
  for (let x = Math.round(leftEdge); x < w; x++) {
    if (colY[x] >= 0) {
      if (sx < 0) sx = x
      ys.push(colY[x])
      gap = 0
    } else if (sx >= 0) {
      if (++gap > sp * 0.8) {
        spans.push({ x0: sx, x1: x - gap, ys })
        sx = -1
        ys = []
      }
    }
  }
  if (sx >= 0) spans.push({ x0: sx, x1: w - 1, ys })
  // A real ending bracket spans about a bar AND lies flat (its ink stays at a
  // near-constant height). A beamed gracenote cluster is both shorter and, with
  // its slanted flags, far more variable in height.
  return spans.filter((s) => {
    if (s.x1 - s.x0 < sp * 6) return false
    const mean = s.ys.reduce((a, b) => a + b, 0) / s.ys.length
    const varr = s.ys.reduce((a, b) => a + (b - mean) * (b - mean), 0) / s.ys.length
    return Math.sqrt(varr) <= sp * 0.6
  })
}

function detectBarlines(
  ink: Uint8Array,
  w: number,
  h: number,
  staff: DetectedStaff,
  sp: number,
  noteXs: number[],
): number[] {
  const top = Math.max(0, Math.round(staff.lines[0]))
  const bottom = Math.min(h - 1, Math.round(staff.lines[staff.lines.length - 1]))
  const band = bottom - top + 1
  if (band < 4) return []
  const cols: number[] = []
  for (let x = 0; x < w; x++) {
    let c = 0
    for (let y = top; y <= bottom; y++) if (ink[y * w + x]) c++
    if (c >= band * 0.92) cols.push(x)
  }
  const merged: number[] = []
  for (let i = 0; i < cols.length; ) {
    let j = i
    while (j + 1 < cols.length && cols[j + 1] - cols[j] <= Math.max(2, sp * 0.5)) j++
    merged.push((cols[i] + cols[j]) / 2)
    i = j + 1
  }
  // A tall stem is the main impostor. Measured on real scans, stems land within
  // ~0.85 space of their notehead while a genuine barline stands at least ~1.4
  // spaces clear of the nearest note, so this cleanly separates the two.
  const clear = merged.filter((x) => !noteXs.some((nx) => Math.abs(nx - x) < sp * 1.1))
  // A double or repeat barline is several lines side by side but marks ONE bar
  // boundary. Real bars are many spaces wide, so anything within three spaces
  // collapses to a single division.
  const out: number[] = []
  for (let i = 0; i < clear.length; ) {
    let j = i
    while (j + 1 < clear.length && clear[j + 1] - clear[j] <= sp * 3) j++
    out.push((clear[i] + clear[j]) / 2)
    i = j + 1
  }

  // Bars across one system are of comparable width. A gap far narrower than the
  // rest is not a bar — it is a leftover double line or a stray vertical — so
  // drop the line that created it and re-check.
  for (;;) {
    if (out.length < 3) break
    const gaps: number[] = []
    for (let i = 1; i < out.length; i++) gaps.push(out[i] - out[i - 1])
    const sorted = [...gaps].sort((a, b) => a - b)
    const median = sorted[sorted.length >> 1]
    let worst = -1
    for (let i = 0; i < gaps.length; i++) if (gaps[i] < median * 0.4 && (worst < 0 || gaps[i] < gaps[worst])) worst = i
    if (worst < 0) break
    out.splice(worst + 1, 1)
  }
  return out
}

/**
 * Open noteheads (half/whole notes) have a hole. Flood-fill the background from
 * the borders; any background left enclosed is a hole. Notehead-sized round
 * holes not already covered by a filled notehead mark open noteheads.
 */
function findOpenNoteheads(
  ink: Uint8Array,
  w: number,
  h: number,
  sp: number,
  filled: Blob[],
): Blob[] {
  const outside = new Uint8Array(w * h)
  const stack: number[] = []
  const pushIf = (x: number, y: number) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return
    const i = y * w + x
    if (ink[i] === 0 && outside[i] === 0) {
      outside[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < w; x++) {
    pushIf(x, 0)
    pushIf(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    pushIf(0, y)
    pushIf(w - 1, y)
  }
  while (stack.length) {
    const i = stack.pop()!
    const x = i % w
    const y = (i / w) | 0
    pushIf(x - 1, y)
    pushIf(x + 1, y)
    pushIf(x, y - 1)
    pushIf(x, y + 1)
  }

  const seen = new Uint8Array(w * h)
  const out: Blob[] = []
  for (let s = 0; s < w * h; s++) {
    if (ink[s] === 1 || outside[s] === 1 || seen[s] === 1) continue
    let minX = w
    let maxX = 0
    let minY = h
    let maxY = 0
    let area = 0
    let sx = 0
    let sy = 0
    const st = [s]
    seen[s] = 1
    while (st.length) {
      const i = st.pop()!
      const x = i % w
      const y = (i / w) | 0
      area++
      sx += x
      sy += y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j >= 0 && j < w * h && ink[j] === 0 && outside[j] === 0 && seen[j] === 0) {
          seen[j] = 1
          st.push(j)
        }
      }
    }
    const bw = maxX - minX + 1
    const bh = maxY - minY + 1
    const dia = (bw + bh) / 2
    const aspect = bw / bh
    // A minim's counter is a solid ellipse, tilted so it is wider than tall, and
    // it fills ~78% of its bounding box. The gaps enclosed between beams, stems
    // and slurs are triangular or wedge-shaped (~50% or less) and often the
    // wrong proportions — without these shape tests they read as minims and
    // wildly inflate the note lengths.
    //
    // Shape carries this, not size: an upper bound of 0.62 was throwing away
    // real minims, whose counters measure ~0.85 of a space on the sample scans
    // (aspect 1.9, fill 0.82 — textbook). 1.0 and 1.2 score identically, so
    // nothing hinges on the exact figure.
    const fill = area / (bw * bh)
    if (dia >= sp * 0.28 && dia <= sp * 1.0 && aspect > 0.9 && aspect < 2.4 && fill >= 0.55) {
      const cx = sx / area
      const cy = sy / area
      if (!filled.some((f) => Math.hypot(f.x - cx, f.y - cy) < sp * 0.8)) {
        out.push({ x: cx, y: cy, r: dia / 2 })
      }
    }
  }
  return out
}

/** Note-length base from stem/beam analysis. */
function durationBase(
  ink: Uint8Array,
  w: number,
  h: number,
  b: Blob,
  filled: boolean,
  sp: number,
): 1 | 2 | 4 | 8 | 16 | 32 {
  const stem = findStem(ink, w, h, b.x, b.y, b.r, sp)
  const hasStem = stem.len >= sp * 1.1
  if (!filled) return hasStem ? 2 : 1 // half or whole
  if (!hasStem) return 8 // filled, no clear stem → assume quaver
  const beams = countBeams(ink, w, h, stem, sp)
  return beams === 0 ? 4 : beams === 1 ? 8 : beams === 2 ? 16 : 32
}

// -- Pipeline ----------------------------------------------------------------

export interface RecognizeOptions {
  /**
   * Scales the melody-notehead size threshold. < 1 detects smaller/more
   * noteheads (catch missed notes); > 1 detects fewer (drop spurious ones).
   */
  noteheadScale?: number
  /** Detect gracenotes/embellishments and attach them to melody notes. On by default. */
  detectEmbellishments?: boolean
}

/** Pitch and staff for a hand-placed correction at an image point. */
export function pitchAndStaffAt(
  result: Pick<OmrResult, 'staves'>,
  y: number,
): { pitch: Pitch; staffIndex: number } {
  if (result.staves.length === 0) return { pitch: 'LowA', staffIndex: 0 }
  const staffIndex = nearestStaff(result.staves, y)
  return { pitch: pitchForY(result.staves[staffIndex], y), staffIndex }
}

const PITCH_TO_POSITION: Record<Pitch, number> = {
  LowG: 2,
  LowA: 3,
  B: 4,
  C: 5,
  D: 6,
  E: 7,
  F: 8,
  HighG: 9,
  HighA: 10,
}

/** Image y for a given pitch on a staff — used when a correction changes pitch. */
export function yForPitch(result: Pick<OmrResult, 'staves'>, staffIndex: number, pitch: Pitch): number {
  const staff = result.staves[staffIndex] ?? result.staves[0]
  if (!staff) return 0
  const bottom = staff.lines[staff.lines.length - 1]
  return bottom - PITCH_TO_POSITION[pitch] * (staff.spacing / 2)
}

export function recognize(source: ImageData, opts: RecognizeOptions = {}): OmrResult {
  const warnings: string[] = []
  const noteheadScale = opts.noteheadScale ?? 1
  const detectEmb = opts.detectEmbellishments ?? true

  // Downscale wide images for speed. Use BOX AVERAGING (not nearest-neighbour)
  // so thin staff lines survive as gray rather than being dropped between rows.
  let { width: w, height: h } = source
  let gray: Uint8Array
  if (w > MAX_WIDTH) {
    const scale = MAX_WIDTH / w
    const nw = MAX_WIDTH
    const nh = Math.round(h * scale)
    const full = toGray(source.data, w, h)
    const small = new Uint8Array(nw * nh)
    const step = w / nw
    for (let y = 0; y < nh; y++) {
      const sy0 = Math.floor(y * step)
      const sy1 = Math.min(h, Math.max(sy0 + 1, Math.floor((y + 1) * step)))
      for (let x = 0; x < nw; x++) {
        const sx0 = Math.floor(x * step)
        const sx1 = Math.min(w, Math.max(sx0 + 1, Math.floor((x + 1) * step)))
        let sum = 0
        let count = 0
        for (let yy = sy0; yy < sy1; yy++) {
          for (let xx = sx0; xx < sx1; xx++) {
            sum += full[yy * w + xx]
            count++
          }
        }
        small[y * nw + x] = count ? sum / count : full[sy0 * w + sx0]
      }
    }
    gray = small
    w = nw
    h = nh
  } else if (probeSpacing(toGray(source.data, w, h), w, h) > 0) {
    // Small sources (screenshots, low-resolution downloads) leave the staff only
    // a few pixels between lines, at which point noteheads are smaller than the
    // detector's smallest feature and nothing resolves. Enlarge first, with
    // bilinear sampling so lines and heads stay smooth rather than blocky.
    // Decided from the measured spacing, so normal scans are left untouched.
    const found = probeSpacing(toGray(source.data, w, h), w, h)
    const scale = Math.min(3, MIN_SPACING / found)
    const nw = Math.round(w * scale)
    const nh = Math.round(h * scale)
    const full = toGray(source.data, w, h)
    const big = new Uint8Array(nw * nh)
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(h - 1, y / scale)
      const y0 = Math.floor(sy)
      const y1 = Math.min(h - 1, y0 + 1)
      const fy = sy - y0
      for (let x = 0; x < nw; x++) {
        const sx = Math.min(w - 1, x / scale)
        const x0 = Math.floor(sx)
        const x1 = Math.min(w - 1, x0 + 1)
        const fx = sx - x0
        const a = full[y0 * w + x0] * (1 - fx) + full[y0 * w + x1] * fx
        const b = full[y1 * w + x0] * (1 - fx) + full[y1 * w + x1] * fx
        big[y * nw + x] = a * (1 - fy) + b * fy
      }
    }
    gray = big
    w = nw
    h = nh
  } else {
    gray = toGray(source.data, w, h)
  }

  const binOf = (g: Uint8Array): Uint8Array => {
    const thr = otsu(g)
    const ink = new Uint8Array(g.length)
    for (let i = 0; i < g.length; i++) ink[i] = g[i] < thr ? 1 : 0
    return ink
  }

  // Deskew: straighten the page so staff lines are horizontal.
  let ink = binOf(gray)
  const skewDeg = estimateSkewDeg(ink, w, h)
  if (Math.abs(skewDeg) > 0.5) {
    gray = rotateGray(gray, w, h, skewDeg)
    ink = binOf(gray)
  }

  const staves = detectStaves(ink, w, h, warnings)
  if (staves.length === 0) {
    return {
      notes: [],
      staves,
      barlines: [],
      repeats: [],
      voltas: [],
      width: w,
      height: h,
      skewDeg,
      processedGray: gray,
      warnings,
    }
  }
  const sp = staves.reduce((a, s) => a + s.spacing, 0) / staves.length

  // Notehead detection.
  const noStaff = removeStaffLines(ink, w, h, staves, sp)
  const dt = distanceTransform(noStaff, w, h)
  const blobs = findBlobs(dt, w, h, sp * 0.14)

  // Left edge of the staves, and the clef + time-signature zone after it, so
  // the clef and metre glyphs aren't mistaken for noteheads.
  let leftEdge = w
  for (const s of staves) {
    const midY = Math.round((s.lines[0] + s.lines[s.lines.length - 1]) / 2)
    for (let x = 0; x < w; x++) {
      if (inkAt(ink, w, h, x, Math.round(s.lines[0])) || inkAt(ink, w, h, x, midY)) {
        leftEdge = Math.min(leftEdge, x)
        break
      }
    }
  }
  if (leftEdge === w) leftEdge = 0
  // Clef + time signature sit at the start of the line; skip that whole zone.
  // Per staff: skip its clef, and on the first staff the time signature too.
  const musicStart = staves.map((s) => musicStartX(noStaff, w, h, s, sp, leftEdge))

  const meloRMax = sp * 0.85 // reject over-large blobs (clef bowls, etc.)

  /** A blob is a plausible notehead: right size, on the staff, past the clef. */
  const onStaff = (b: Blob): boolean => {
    const si = nearestStaff(staves, b.y)
    if (b.x < musicStart[si]) return false // clef / time signature on this staff
    const staff = staves[si]
    const bottom = staff.lines[staff.lines.length - 1]
    const position = (bottom - b.y) / (sp / 2)
    // Bagpipe notes live roughly from Low G to High A; reject anything well
    // outside that band (page titles, composer text, lyrics, etc.).
    return position >= -1.5 && position <= 12
  }

  /**
   * Pipe music is monophonic — one note at a time — so blobs stacked at the
   * same x are never a chord. They are a barline (thick bar + repeat dots) or
   * detection noise: drop columns of three or more, keep the largest of a pair.
   */
  const dedupeColumns = (bs: Blob[]): Blob[] => {
    const sorted = [...bs].sort((a, b) => a.x - b.x)
    const used = new Array(sorted.length).fill(false)
    const kept: Blob[] = []
    for (let i = 0; i < sorted.length; i++) {
      if (used[i]) continue
      const col = [sorted[i]]
      used[i] = true
      for (let j = i + 1; j < sorted.length && sorted[j].x - sorted[i].x < sp * 0.35; j++) {
        if (!used[j]) {
          col.push(sorted[j])
          used[j] = true
        }
      }
      // Only a true stack (barline: thick bar + repeat dots) makes 3+; keep
      // everything else, including a close pair (a note beside a barline dot).
      if (col.length >= 3) continue
      for (const bl of col) kept.push(bl)
    }
    return kept
  }

  // Stem lookup, memoised — findStem is the workhorse for every classification
  // below. dir=+1 scans downward in image space, dir=-1 upward.
  // --- Time signature -------------------------------------------------------
  // The metre digits (6-over-8, 2-over-4, …) sit at the start of the first staff
  // and read as two stacked "noteheads". They are a vertical pair of similar-
  // sized blobs at the system start; a real note there is a single blob, and a
  // note+gracenote pair differs a lot in size. Digits are tall, so an earlier
  // "stemless" test wrongly excluded them — don't use it. Once the pair is
  // found, clear everything on the first staff up to it (clef, stray digit bits).
  const staffOf = (b: Blob) => staves[nearestStaff(staves, b.y)]
  const staffPos = (b: Blob) => {
    const s = staffOf(b)
    return (s.lines[s.lines.length - 1] - b.y) / (sp / 2)
  }
  const timeSig = new Set<Blob>()
  {
    const start = blobs.filter(
      (b) =>
        nearestStaff(staves, b.y) === 0 &&
        b.x >= leftEdge + sp * 1.5 &&
        b.x < leftEdge + sp * 9 &&
        b.r >= sp * 0.3 &&
        b.r <= meloRMax &&
        staffPos(b) >= -3 &&
        staffPos(b) <= 13,
    )
    let right = 0
    for (let i = 0; i < start.length; i++)
      for (let j = i + 1; j < start.length; j++) {
        const a = start[i]
        const b = start[j]
        const dy = Math.abs(a.y - b.y)
        const sim = Math.min(a.r, b.r) / Math.max(a.r, b.r)
        if (Math.abs(a.x - b.x) < sp * 0.8 && dy > sp * 1.0 && dy < sp * 3.8 && sim > 0.7) {
          timeSig.add(a)
          timeSig.add(b)
          right = Math.max(right, a.x + a.r, b.x + b.r)
        }
      }
    // Clear the whole clef+metre run at the start of the first staff.
    if (right > 0) for (const b of blobs) if (nearestStaff(staves, b.y) === 0 && b.x <= right + sp * 0.5) timeSig.add(b)
  }

  // --- Melody vs gracenote --------------------------------------------------
  // Gracenotes are (1) noticeably SMALLER than melody noteheads and (2) topped
  // by an up-stem into ~3 little flags. Melody notes are full-size with a stem
  // DOWN. Size is checked first, because a gracenote sitting just above a melody
  // note can pick up a false "down-stem" when the scan bridges into the note
  // below — so a stem test alone promoted gracenotes to melody. The melody size
  // is calibrated from notes with a clear LONG down-stem (never a gracenote),
  // making the comparison adapt to the scan's resolution.
  // Notehead-sized candidates only (≥0.2 sp) — smaller blobs are dots or the
  // thin edges of a ring (open notehead) and must not be promoted to melody.
  const cands = blobs.filter((b) => onStaff(b) && !timeSig.has(b) && b.r >= sp * 0.2 && b.r <= meloRMax)
  // Calibrate the melody-notehead size from notes with a clear DOWNWARD stem.
  // Those are unambiguously melody, because a gracenote's stem runs up to its
  // beam — which makes them a clean sample even though the reverse is NOT true:
  // printed sources stem notes below the middle line upwards, so an up-stem must
  // never be used to reject a melody note (that discarded whole beamed groups).
  const downRadii = cands
    .filter((b) => {
      const s = findStem(noStaff, w, h, b.x, b.y, b.r, sp)
      return s.dir === 1 && s.len >= sp * 2.0
    })
    .map((b) => b.r)
    .sort((a, b) => a - b)
  const melodyR = downRadii.length ? downRadii[downRadii.length >> 1] : sp * 0.42
  const graceR = melodyR * 0.78 * noteheadScale

  const isMelody = (b: Blob): boolean => {
    // The bagpipe scale runs Low G (position 2) to High A (position 10). Anything
    // sitting above High A is a gracenote hovering over the staff, never a melody
    // note — on real scans this alone accounts for most gracenote leakage.
    const pos = staffPos(b)
    if (pos > 10.6 || pos < 1.4) return false
    if (b.r < graceR) return false // noticeably smaller than a notehead → gracenote
    // An up-stem running to a beam marks a gracenote. NOTE: this is imperfect —
    // printed sources also stem melody notes below the middle line upwards, so
    // some beamed melody notes are lost here. Size is what mainly separates the
    // two; loosening this costs more (gracenotes promoted to melody) than it
    // gains, measured across the sample scans.
    const s = findStem(noStaff, w, h, b.x, b.y, b.r, sp)
    if (s.dir === -1 && s.len >= sp * 0.9) return false
    return true
  }

  const melody: Blob[] = []
  const smalls: Blob[] = [] // gracenotes + augmentation dots, placed by position below
  for (const b of cands) (isMelody(b) ? melody : smalls).push(b)
  // Augmentation dots are smaller than gracenotes; add them for the dot pass.
  for (const b of blobs) {
    if (onStaff(b) && !timeSig.has(b) && b.r >= sp * 0.12 && b.r < sp * 0.2) smalls.push(b)
  }
  /**
   * One printed notehead can raise several distance-transform peaks spread
   * across it, each becoming a separate "note". Collapse a cluster of peaks to
   * its strongest. Melody notes get a wide window — pipe music is monophonic, so
   * two are never within a space of one another. Gracenotes get a much tighter
   * one: the little heads of a doubling sit under a space apart and must stay
   * distinct, but repeated peaks on ONE of them wreck embellishment matching
   * (a cluster reading [HighA,HighA,HighA,D] fits no pattern).
   */
  const mergeClose = (bs: Blob[], rx: number, ry: number): Blob[] => {
    const strongestFirst = [...bs].sort((a, b) => b.r - a.r)
    const kept: Blob[] = []
    for (const b of strongestFirst) {
      if (kept.some((k) => Math.abs(k.x - b.x) < rx && Math.abs(k.y - b.y) < ry)) continue
      kept.push(b)
    }
    return kept
  }
  const melodyBlobs = mergeClose(dedupeColumns(melody), sp * 0.9, sp * 0.8)
  const smallBlobs = detectEmb ? mergeClose(smalls, sp * 0.45, sp * 0.45) : []

  // Open (half/whole) noteheads are found separately via their hole. The gaps
  // enclosed between a gracenote cluster's stems and its beams also read as
  // holes, so apply the same Low G…High A ceiling — a "note" above High A is a
  // gracenote artefact, not a minim.
  const openFound = findOpenNoteheads(noStaff, w, h, sp, melodyBlobs).filter(
    (b) => onStaff(b) && staffPos(b) <= 10.6 && staffPos(b) >= 1.4,
  )
  /**
   * The white slivers BETWEEN a gracenote's three slanted flags enclose gaps
   * that pass every counter shape test, so a strike reads as a little tower of
   * phantom minims sitting on its own flags — wrong notes AND wrong lengths,
   * since each is scored as a half note.
   *
   * What gives them away is that they STACK: pipe music is a single voice, so
   * two noteheads never share an x. A counter with another counter directly
   * above or below it is a flag gap, and both go.
   */
  const openBlobs = openFound.filter(
    (b) =>
      !openFound.some(
        (o) => o !== b && Math.abs(o.x - b.x) < sp * 0.9 && Math.abs(o.y - b.y) > sp * 0.3,
      ),
  )

  // Calibrate each staff's position grid from its own noteheads before reading
  // any pitch off it — see staffPhase.
  const phases = staves.map((s, si) =>
    staffPhase(
      melodyBlobs.filter((b) => nearestStaff(staves, b.y) === si).map((b) => positionAt(s, b.y)),
    ),
  )

  // Build melody notes with a detected duration.
  const notes: DetectedNote[] = [
    ...melodyBlobs.map((b) => ({ b, filled: true })),
    ...openBlobs.map((b) => ({ b, filled: false })),
  ].map(({ b, filled }) => {
    const staffIndex = nearestStaff(staves, b.y)
    return {
      pitch: pitchForY(staves[staffIndex], b.y, phases[staffIndex]),
      x: b.x,
      y: b.y,
      staffIndex,
      base: durationBase(noStaff, w, h, b, filled, sp),
      graces: [],
    }
  })
  notes.sort((a, b) => a.staffIndex - b.staffIndex || a.x - b.x)

  /**
   * Recover a notehead the hole-based pass missed by finding its STEM. An open
   * notehead centred in a space loses its ring to staff-line removal, so no
   * counter survives — but its stem does, and the note leaves a conspicuous wide
   * GAP in the row of detected notes (a minim is long, so it sits far from its
   * neighbours). So look inside each oversized gap for a lone vertical stem with
   * no notehead at its base, and rebuild the note there. This reaches the
   * degraded minims that no amount of counter-shape tuning can, and — placed
   * before gracenote attachment — lets the note collect its own embellishment.
   */
  for (let si = 0; si < staves.length; si++) {
    const row = notes.filter((n) => n.staffIndex === si).sort((a, b) => a.x - b.x)
    if (row.length < 3) continue
    const gaps = row.slice(1).map((n, i) => n.x - row[i].x).sort((a, b) => a - b)
    const med = gaps[gaps.length >> 1]
    if (!(med > 0)) continue
    const top = Math.round(staves[si].lines[0] - sp * 1.2)
    const bot = Math.round(staves[si].lines[staves[si].lines.length - 1] + sp * 1.2)
    for (let i = 1; i < row.length; i++) {
      if (row[i].x - row[i - 1].x < med * 1.8) continue
      // Longest vertical ink run in the open middle of the gap = a stem.
      let found: { x: number; y0: number; len: number } | null = null
      for (let x = Math.round(row[i - 1].x + med * 0.7); x < row[i].x - med * 0.3; x += 1) {
        let run = 0
        let y0 = 0
        let bestLen = 0
        let bestY0 = 0
        for (let y = top; y <= bot; y++) {
          if (inkAt(noStaff, w, h, x, y)) {
            if (run === 0) y0 = y
            run++
            if (run > bestLen) {
              bestLen = run
              bestY0 = y0
            }
          } else run = 0
        }
        if (bestLen >= sp * 1.8 && bestLen <= sp * 4 && (!found || bestLen > found.len)) {
          found = { x, y0: bestY0, len: bestLen }
        }
      }
      if (!found) continue
      // The head is at the stem's upper end (melody stems run down): the row of
      // widest ink just below the stem top.
      let headY = found.y0 + Math.round(sp * 0.3)
      let bestW = 0
      for (let y = found.y0; y <= found.y0 + Math.round(sp * 0.8); y++) {
        const wRun = hRun(noStaff, w, h, found.x, y, 1) + hRun(noStaff, w, h, found.x, y, -1)
        if (wRun > bestW) {
          bestW = wRun
          headY = y
        }
      }
      const headX = found.x
      const pos = positionAt(staves[si], headY, phases[si])
      // Two guards keep this from grabbing a gracenote cluster's stem, which is
      // the only other lone vertical run in a gap: a cluster sits ABOVE the top
      // line (its heads and beam land at High G / High A and above) and rarely
      // settles on a step, whereas a melody minim rests ON a staff step at or
      // below High G. So require an on-step head no higher than High G. Both
      // guards sit on a plateau — 9.0/0.3 and 9.3/0.35 score identically.
      if (pos > 9.0 || pos < 1.4) continue
      if (Math.abs(pos - Math.round(pos)) > 0.3) continue
      // Skip if a note is already here.
      if (notes.some((n) => n.staffIndex === si && Math.abs(n.x - headX) < med * 0.6)) continue
      notes.push({
        pitch: pitchForY(staves[si], headY, phases[si]),
        x: headX,
        y: headY,
        staffIndex: si,
        base: durationBase(noStaff, w, h, { x: headX, y: headY, r: sp * 0.4 }, false, sp),
        graces: [],
      })
    }
  }
  notes.sort((a, b) => a.staffIndex - b.staffIndex || a.x - b.x)

  // Small blobs are either augmentation dots (just right of a notehead, same
  // height) or gracenotes (left of / above the note they lead into). Classify
  // by position so a dot is never mistaken for a gracenote.
  const dots = new Set<Blob>()
  for (const s of smallBlobs) {
    // An augmentation dot is markedly SMALLER than a gracenote head. Without
    // that guard, a gracenote that happens to sit level with the PREVIOUS note
    // and a space or so to its right is shaped exactly like that note's dot, and
    // was being consumed as one — losing the gracenote and inventing the dot.
    if (s.r >= melodyR * 0.5) continue
    const staff = nearestStaff(staves, s.y)
    for (const n of notes) {
      if (n.staffIndex !== staff) continue
      const dx = s.x - n.x
      if (dx > sp * 0.5 && dx < sp * 1.7 && Math.abs(s.y - n.y) < sp * 0.45) {
        n.dotted = true
        dots.add(s)
        break
      }
    }
  }

  /**
   * Which small blobs look like a notehead at all? Answering this for every blob
   * BEFORE pairing them up matters: the "a head is the lowest of a stack" test
   * below has to compare a candidate against other HEADS, not against any ink.
   * Judged against raw blobs it was rejecting real gracenotes because a melody
   * beam happened to pass a couple of spaces underneath them.
   */
  const headLike: Blob[] = []
  for (const s of smallBlobs) {
    if (dots.has(s)) continue
    const staff = nearestStaff(staves, s.y)

    // Only blobs of gracenote size qualify — below this they are ink specks,
    // beam fragments or staff-line remnants, which otherwise pile up on a note.
    if (s.r < melodyR * 0.38) continue
    // Tell a head from the cluster's BEAM by shape rather than position. A head
    // is compact — about a notehead wide — while a beam is a long horizontal
    // run, and sampling one at several points along its length is what produced
    // clusters like [F,F,F] where a grip's Low G and D should have been.
    const runW =
      hRun(noStaff, w, h, Math.round(s.x), Math.round(s.y), 1) +
      hRun(noStaff, w, h, Math.round(s.x) - 1, Math.round(s.y), -1)
    if (runW > sp * 1.6) continue
    // A gracenote HEAD sits on the staff at its own pitch (a High G gracenote is
    // on the top line). What floats above the staff is its stem's ~3 flags and
    // the cluster's beam — and since pitch mapping clamps anything above the
    // staff to High A, those flags used to read as [HighA, HighA, HighA…] and
    // stopped any cluster from matching an embellishment.
    const sPos = positionAt(staves[staff], s.y, phases[staff])
    if (sPos > 10.6 || sPos < 1.4) continue
    // A notehead sits ON a line or IN a space — never straddling one. Fragments
    // of a cluster's beams land at arbitrary heights, so anything that does not
    // settle on a staff step is not a gracenote head. Dropping them is what lets
    // a doubling or birl read as its own pattern instead of a run of noise.
    // The allowance has to cover a gracenote head's own measurement noise: real
    // ones were landing at 0.31 and 0.34 off their step and being thrown away.
    if (Math.abs(sPos - Math.round(sPos)) > 0.38) continue

    headLike.push(s)
  }

  /**
   * A gracenote's head is the BOTTOM of it: the stem and its three flags rise
   * above. So where several heads stack at the same x, only the lowest is real —
   * the others are flags, and taking one reads the pitch a step or more too high
   * (a High G gracenote arriving as High A, turning a doubling into a thumb
   * doubling).
   *
   * The reach sideways has to cover the stem, which rises from the head's RIGHT
   * edge, so a flag sits offset from its head rather than directly over it. At
   * 0.4 the flags fell outside and every single gracenote gained a phantom twin
   * one space above it — [D] read as [D,F]. Distinct heads in a cluster sit ~1.5
   * apart, so 0.7 cannot swallow a real neighbour.
   */
  const heads: { s: Blob; staff: number }[] = []
  for (const s of headLike) {
    if (
      headLike.some(
        (o) => o !== s && Math.abs(o.x - s.x) < sp * 0.7 && o.y > s.y + sp * 0.3 && o.y < s.y + sp * 3,
      )
    )
      continue

    heads.push({ s, staff: nearestStaff(staves, s.y) })
  }

  /**
   * Attach each gracenote head to the note it decorates.
   *
   * Distance alone cannot do this. The gracenotes of one embellishment are
   * beamed into a group, and a long group reaches a long way back: the leading
   * High G of a doubling sits over five spaces from its note, further than the
   * gap between two melody notes. Widening the window to cover it starts
   * stealing the previous note's gracenotes instead.
   *
   * So attach by GROUP, the way the engraving is actually built. A head near a
   * note claims it; then any head close to an already-claimed one joins the same
   * note, repeatedly. A beamed cluster is evenly spaced — much tighter than the
   * gap from the cluster to its note — so the chain walks the whole group and
   * stops at its left edge instead of running on into the previous note's.
   */
  const owner = new Map<{ s: Blob; staff: number }, DetectedNote>()
  for (const head of heads) {
    const { s, staff } = head
    let target: DetectedNote | undefined
    let bestDx = Infinity
    for (const n of notes) {
      if (n.staffIndex !== staff) continue
      const dx = n.x - s.x // note is to the right of the gracenote
      // Gracenotes sit close to the LEFT of their note, at any height. They are
      // NOT confined to above it: a grip, throw, birl or taorluath is built on a
      // Low G gracenote, which sits near the bottom of the staff and so falls
      // well below a note like D or E. Rejecting anything under the melody line
      // silently removed every one of those, which is why single (high) G
      // gracenotes read correctly while the combined embellishments never did.
      // Artefacts below the staff are already excluded by the Low G…High A band.
      if (Math.abs(s.y - n.y) > sp * 5) continue
      // Keep clear of the note's own width. A gracenote head cannot sit closer
      // than about a notehead from the note it leads into, but the flag bundle
      // of a strike sometimes raises a phantom "melody note" right on top of the
      // gracenote — and being half a space away, that phantom used to win the
      // nearest-note contest and swallow the strike's only gracenote.
      if (dx > sp * CLUSTER_MIN && dx < sp * CLUSTER_SEED && dx < bestDx) {
        bestDx = dx
        target = n
      }
    }
    if (target) owner.set(head, target)
  }
  // Grow each group leftwards along the chain of neighbouring heads.
  for (;;) {
    let grew = false
    for (const head of heads) {
      if (owner.has(head)) continue
      for (const other of heads) {
        const n = owner.get(other)
        if (!n || other.staff !== head.staff) continue
        // Only ever reach further LEFT, and never past the whole-cluster limit —
        // no embellishment is wider than that, so this cannot walk into the
        // previous note's gracenotes.
        if (head.s.x >= other.s.x || other.s.x - head.s.x > sp * CLUSTER_GAP) continue
        if (n.x - head.s.x > sp * CLUSTER_MAX) continue
        owner.set(head, n)
        grew = true
        break
      }
    }
    if (!grew) break
  }
  for (const head of heads) {
    const n = owner.get(head)
    if (!n) continue
    const { s, staff } = head
    n.graces.push({ pitch: pitchForY(staves[staff], s.y, phases[staff]), x: s.x, y: s.y })
  }

  // Reverse-match each gracenote cluster to an embellishment.
  for (const n of notes) {
    n.graces.sort((a, b) => a.x - b.x)
    // No pipe embellishment has more than five gracenotes; if more were
    // collected the extras are noise, so keep the five nearest the note.
    if (n.graces.length > 5) n.graces = n.graces.slice(-5)
    if (n.graces.length > 0) {
      const m = matchEmbellishment(
        n.pitch,
        n.graces.map((g) => g.pitch),
      )
      if (m) n.embellishment = m.type
    }
  }

  const barlines = staves.map((s, si) =>
    detectBarlines(
      ink,
      w,
      h,
      s,
      sp,
      notes.filter((n) => n.staffIndex === si).map((n) => n.x),
    ),
  )

  // Repeat barlines: check each detected line for dots on either side.
  const repeats: OmrRepeat[] = []
  staves.forEach((s, si) => {
    for (const x of barlines[si]) {
      const kind = detectRepeatKind(ink, w, h, s, sp, x)
      if (kind) repeats.push({ staffIndex: si, x, kind })
    }
  })

  // 1st/2nd ending brackets, numbered in reading order (voltas run 1 then 2).
  const voltas: OmrVolta[] = []
  const brackets: Array<{ staffIndex: number; x0: number; x1: number }> = []
  staves.forEach((s, si) => {
    for (const b of detectVoltasForStaff(ink, w, h, s, sp, leftEdge))
      brackets.push({ staffIndex: si, ...b })
  })
  brackets.sort((a, b) => a.staffIndex - b.staffIndex || a.x0 - b.x0)
  brackets.forEach((b, i) => {
    voltas.push({ staffIndex: b.staffIndex, x0: b.x0, x1: b.x1, num: ((i % 2) + 1) as 1 | 2 })
  })

  if (notes.length === 0) {
    warnings.push('Staves were found but no noteheads were detected. Try a sharper, higher-contrast photo.')
  }
  return {
    notes,
    staves,
    barlines,
    repeats,
    voltas,
    width: w,
    height: h,
    skewDeg,
    processedGray: gray,
    warnings,
  }
}
