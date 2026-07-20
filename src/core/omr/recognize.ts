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

const MAX_WIDTH = 1100

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
  const sortedGaps = [...gaps].sort((a, b) => a - b)
  const sp = sortedGaps[Math.floor(sortedGaps.length / 2)]

  const staves: DetectedStaff[] = []
  let group: number[] = [lineCentres[0]]
  const flush = () => {
    if (group.length >= 4) {
      const lines = group.slice(0, 5)
      const gsp = (lines[lines.length - 1] - lines[0]) / (lines.length - 1)
      staves.push({ lines, spacing: gsp })
    }
    group = []
  }
  for (let i = 1; i < lineCentres.length; i++) {
    if (lineCentres[i] - lineCentres[i - 1] < sp * 1.8) group.push(lineCentres[i])
    else {
      flush()
      group = [lineCentres[i]]
    }
  }
  flush()
  if (staves.length === 0) warnings.push('Found staff lines but could not group them into staves.')
  return staves
}

function removeStaffLines(ink: Uint8Array, w: number, h: number): Uint8Array {
  const out = ink.slice()
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const i = y * w + x
      if (!ink[i]) continue
      const above = y > 1 && (ink[i - w] || ink[i - 2 * w])
      const below = y < h - 2 && (ink[i + w] || ink[i + 2 * w])
      if (!above && !below) out[i] = 0
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

// -- Pipeline ----------------------------------------------------------------

export function recognize(source: ImageData): OmrResult {
  const warnings: string[] = []

  // Downscale wide images for speed.
  let { width: w, height: h } = source
  let gray: Uint8Array
  if (w > MAX_WIDTH) {
    const scale = MAX_WIDTH / w
    const nw = MAX_WIDTH
    const nh = Math.round(h * scale)
    const full = toGray(source.data, w, h)
    const small = new Uint8Array(nw * nh)
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(h - 1, Math.floor(y / scale))
      for (let x = 0; x < nw; x++) {
        small[y * nw + x] = full[sy * w + Math.min(w - 1, Math.floor(x / scale))]
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
  const noStaff = removeStaffLines(ink, w, h)
  const dt = distanceTransform(noStaff, w, h)
  const blobs = findBlobs(dt, w, h, sp * 0.14)

  const meloR = sp * 0.36 // radius threshold: melody vs everything smaller
  const melodyBlobs = blobs.filter((b) => b.r >= meloR)
  const smallBlobs = blobs.filter((b) => b.r >= sp * 0.15 && b.r < meloR)

  // Build melody notes.
  const notes: DetectedNote[] = melodyBlobs.map((b) => {
    const staffIndex = nearestStaff(staves, b.y)
    return { pitch: pitchForY(staves[staffIndex], b.y), x: b.x, y: b.y, staffIndex, graces: [] }
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

    let target: DetectedNote | undefined
    let bestDx = Infinity
    for (const n of notes) {
      if (n.staffIndex !== staff) continue
      const dx = n.x - s.x // note is to the right of the gracenote
      if (dx > -sp * 0.6 && dx < sp * 3.5 && dx < bestDx) {
        bestDx = dx
        target = n
      }
    }
    if (target) target.graces.push({ pitch: pitchForY(staves[staff], s.y), x: s.x, y: s.y })
  }

  // Reverse-match each gracenote cluster to an embellishment.
  for (const n of notes) {
    n.graces.sort((a, b) => a.x - b.x)
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
