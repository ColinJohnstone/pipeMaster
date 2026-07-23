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

export interface OmrResult {
  notes: DetectedNote[]
  staves: DetectedStaff[]
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

function pitchForY(staff: DetectedStaff, y: number): Pitch {
  const bottom = staff.lines[staff.lines.length - 1]
  const half = staff.spacing / 2
  let position = Math.round((bottom - y) / half)
  position = Math.max(2, Math.min(10, position))
  return POSITION_TO_PITCH[position]
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
  const cols = [
    Math.round(nx - r * 0.8),
    Math.round(nx + r * 0.8),
    Math.round(nx - sp * 0.5),
    Math.round(nx + sp * 0.5),
    // The stem often attaches at the notehead's outer edge (~0.6 sp from centre);
    // sampling there catches down-stems that the inner columns miss → better recall.
    Math.round(nx - sp * 0.62),
    Math.round(nx + sp * 0.62),
    Math.round(nx),
  ]
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
    const isBeam = run >= sp * 0.7
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
 * Count horizontal ink bands directly above a notehead — a gracenote leads up to
 * a beam or (in pipe notation) a cluster of ~3 little flags, which sit close
 * above its small head. Melody notes carry their beams below (stems down), so a
 * band count above is a strong "this is a gracenote" signal.
 */
function flagsAbove(ink: Uint8Array, w: number, h: number, b: Blob, sp: number): number {
  const x = Math.round(b.x)
  const top = Math.round(b.y - b.r)
  let bands = 0
  let inBand = false
  for (let k = 1; k <= Math.round(sp * 2.4); k++) {
    const y = top - k
    if (y < 0) break
    const run = hRun(ink, w, h, x, y, 1) + hRun(ink, w, h, x - 1, y, -1)
    const isBand = run >= sp * 0.45
    if (isBand && !inBand) {
      bands++
      inBand = true
    } else if (!isBand) {
      inBand = false
    }
  }
  return bands
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
    if (dia >= sp * 0.22 && dia <= sp * 0.75 && aspect > 0.5 && aspect < 2) {
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
    return { notes: [], staves, width: w, height: h, skewDeg, processedGray: gray, warnings }
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
  const clefZoneX = leftEdge + sp * 6.5

  const meloRMax = sp * 0.85 // reject over-large blobs (clef bowls, etc.)

  /** A blob is a plausible notehead: right size, on the staff, past the clef. */
  const onStaff = (b: Blob): boolean => {
    if (b.x < clefZoneX) return false // clef / time signature
    const staff = staves[nearestStaff(staves, b.y)]
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
  const stems = new Map<Blob, Stem>()
  const stemOf = (b: Blob): Stem => {
    let s = stems.get(b)
    if (!s) {
      s = findStem(noStaff, w, h, b.x, b.y, b.r, sp)
      stems.set(b, s)
    }
    return s
  }
  const hasUpStem = (b: Blob) => stemOf(b).dir === -1 && stemOf(b).len >= sp * 0.9
  const longDownStem = (b: Blob) => stemOf(b).dir === 1 && stemOf(b).len >= sp * 2.0

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
  const downRadii = cands
    .filter(longDownStem)
    .map((b) => b.r)
    .sort((a, b) => a - b)
  const melodyR = downRadii.length ? downRadii[downRadii.length >> 1] : sp * 0.42
  const graceR = melodyR * 0.78 * noteheadScale // below this → gracenote, whatever the stem reads

  const isMelody = (b: Blob): boolean => {
    // The bagpipe scale runs Low G (position 2) to High A (position 10). Anything
    // sitting above High A is a gracenote hovering over the staff, never a melody
    // note — on real scans this alone accounts for most gracenote leakage.
    const pos = staffPos(b)
    if (pos > 10.6 || pos < 1.4) return false
    if (b.r < graceR) return false // noticeably smaller → gracenote
    if (hasUpStem(b)) return false // up-stem → gracenote
    // A smallish blob capped by flags is a gracenote even if full-ish size; the
    // size gate above already protects genuine (larger) melody noteheads.
    if (b.r < melodyR * 0.92 && flagsAbove(noStaff, w, h, b, sp) >= 2) return false
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
   * across its width, each becoming a separate "note". Pipe music is monophonic,
   * so two melody notes are never within a space of one another — collapse any
   * such cluster to its strongest peak. Applied only to melody blobs, so a
   * gracenote cluster (handled separately) is untouched.
   */
  const mergeDuplicates = (bs: Blob[]): Blob[] => {
    const strongestFirst = [...bs].sort((a, b) => b.r - a.r)
    const kept: Blob[] = []
    for (const b of strongestFirst) {
      if (kept.some((k) => Math.abs(k.x - b.x) < sp * 0.9 && Math.abs(k.y - b.y) < sp * 0.8)) continue
      kept.push(b)
    }
    return kept
  }
  const melodyBlobs = mergeDuplicates(dedupeColumns(melody))
  const smallBlobs = detectEmb ? smalls : []

  // Open (half/whole) noteheads are found separately via their hole. The gaps
  // enclosed between a gracenote cluster's stems and its beams also read as
  // holes, so apply the same Low G…High A ceiling — a "note" above High A is a
  // gracenote artefact, not a minim.
  const openBlobs = findOpenNoteheads(noStaff, w, h, sp, melodyBlobs).filter(
    (b) => onStaff(b) && staffPos(b) <= 10.6 && staffPos(b) >= 1.4,
  )

  // Build melody notes with a detected duration.
  const notes: DetectedNote[] = [
    ...melodyBlobs.map((b) => ({ b, filled: true })),
    ...openBlobs.map((b) => ({ b, filled: false })),
  ].map(({ b, filled }) => {
    const staffIndex = nearestStaff(staves, b.y)
    return {
      pitch: pitchForY(staves[staffIndex], b.y),
      x: b.x,
      y: b.y,
      staffIndex,
      base: durationBase(noStaff, w, h, b, filled, sp),
      graces: [],
    }
  })
  notes.sort((a, b) => a.staffIndex - b.staffIndex || a.x - b.x)

  // Small blobs are either augmentation dots (just right of a notehead, same
  // height) or gracenotes (left of / above the note they lead into). Classify
  // by position so a dot is never mistaken for a gracenote.
  for (const s of smallBlobs) {
    const staff = nearestStaff(staves, s.y)

    let isDot = false
    for (const n of notes) {
      if (n.staffIndex !== staff) continue
      const dx = s.x - n.x
      if (dx > sp * 0.5 && dx < sp * 1.7 && Math.abs(s.y - n.y) < sp * 0.45) {
        n.dotted = true
        isDot = true
        break
      }
    }
    if (isDot) continue

    // Only blobs of gracenote size qualify — below this they are ink specks,
    // beam fragments or staff-line remnants, which otherwise pile up on a note.
    if (s.r < melodyR * 0.38) continue

    let target: DetectedNote | undefined
    let bestDx = Infinity
    for (const n of notes) {
      if (n.staffIndex !== staff) continue
      const dx = n.x - s.x // note is to the right of the gracenote
      // Gracenotes sit close to the LEFT of their note and above / beside it,
      // never below or on top of it — this rejects stem-tip, beam, and
      // ring/stem-junction artifacts that fall under the melody line.
      if (s.y > n.y + sp * 0.9) continue
      if (s.y < n.y - sp * 4.5) continue // far above: belongs to nothing here
      if (dx > sp * 0.35 && dx < sp * 3.5 && dx < bestDx) {
        bestDx = dx
        target = n
      }
    }
    if (target) target.graces.push({ pitch: pitchForY(staves[staff], s.y), x: s.x, y: s.y })
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

  if (notes.length === 0) {
    warnings.push('Staves were found but no noteheads were detected. Try a sharper, higher-contrast photo.')
  }
  return { notes, staves, width: w, height: h, skewDeg, processedGray: gray, warnings }
}
