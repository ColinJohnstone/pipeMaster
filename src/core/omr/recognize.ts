import type { Pitch } from '../pitch'

/**
 * Optical music recognition for pipe scores — a classical computer-vision
 * pipeline (no ML model, runs fully client-side):
 *
 *   grayscale → Otsu threshold → staff-line detection (horizontal projection)
 *   → staff-line removal → morphological opening → connected-component
 *   notehead detection → pitch mapping from staff geometry.
 *
 * It recognises note PITCHES and their order. Rhythm and embellishments are
 * NOT recognised (that needs far more than classical CV) — every note comes
 * in as a quaver for the user to correct in the editor. Treat the result as a
 * rough draft, not a faithful transcription.
 */

export interface DetectedNote {
  pitch: Pitch
  /** Notehead centre in processed-image pixels (for the overlay). */
  x: number
  y: number
  staffIndex: number
}

export interface DetectedStaff {
  /** y of the five line centres, top to bottom. */
  lines: number[]
  /** Median line spacing. */
  spacing: number
}

export interface OmrResult {
  notes: DetectedNote[]
  staves: DetectedStaff[]
  /** Dimensions of the (possibly downscaled) processed image. */
  width: number
  height: number
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

function toGray(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4]
    const gr = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    g[i] = (r * 299 + gr * 587 + b * 114) / 1000
  }
  return g
}

/** Otsu's method: the grayscale threshold that best separates ink from paper. */
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
    // `>=` keeps the upper end of the optimal plateau; important for clean
    // black-on-white scans where the whole gap between the two peaks is
    // equally optimal (a strict `>` would collapse the threshold to 0).
    if (between >= best) {
      best = between
      threshold = t
    }
  }
  return threshold
}

/** Detect staves as groups of five roughly evenly-spaced full-width lines. */
function detectStaves(ink: Uint8Array, w: number, h: number, warnings: string[]): DetectedStaff[] {
  // Horizontal projection: dark pixels per row.
  const rowDark = new Int32Array(h)
  for (let y = 0; y < h; y++) {
    let c = 0
    const row = y * w
    for (let x = 0; x < w; x++) if (ink[row + x]) c++
    rowDark[y] = c
  }
  const lineThresh = w * 0.35
  // Collapse runs of dark rows into single line centres.
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

  // Typical within-staff gap = median of small consecutive gaps.
  const gaps = lineCentres.slice(1).map((v, i) => v - lineCentres[i])
  const sortedGaps = [...gaps].sort((a, b) => a - b)
  const sp = sortedGaps[Math.floor(sortedGaps.length / 2)]

  const staves: DetectedStaff[] = []
  let group: number[] = [lineCentres[0]]
  const flush = () => {
    if (group.length >= 4) {
      // Use the (up to) five lines; recompute spacing from the group.
      const lines = group.slice(0, 5)
      const gsp =
        (lines[lines.length - 1] - lines[0]) / (lines.length - 1)
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

/** Remove near-horizontal staff-line pixels so noteheads separate cleanly. */
function removeStaffLines(ink: Uint8Array, w: number, h: number): Uint8Array {
  const out = ink.slice()
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const i = y * w + x
      if (!ink[i]) continue
      // A staff-line pixel has ink to the left/right but little above/below.
      const above = y > 1 && (ink[i - w] || ink[i - 2 * w])
      const below = y < h - 2 && (ink[i + w] || ink[i + 2 * w])
      if (!above && !below) out[i] = 0
    }
  }
  return out
}

/** Binary erosion then dilation with a square kernel of the given radius. */
function open(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const erode = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let keep = 1
      for (let dy = -r; dy <= r && keep; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) {
          keep = 0
          break
        }
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w || !src[yy * w + xx]) {
            keep = 0
            break
          }
        }
      }
      erode[y * w + x] = keep
    }
  }
  const dilate = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!erode[y * w + x]) continue
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          dilate[yy * w + xx] = 1
        }
      }
    }
  }
  return dilate
}

interface Component {
  minX: number
  maxX: number
  minY: number
  maxY: number
  area: number
  cx: number
  cy: number
}

/** Label connected components (4-connectivity) and return their stats. */
function components(bin: Uint8Array, w: number, h: number): Component[] {
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const out: Component[] = []
  for (let start = 0; start < w * h; start++) {
    if (!bin[start] || seen[start]) continue
    let minX = w
    let maxX = 0
    let minY = h
    let maxY = 0
    let area = 0
    let sx = 0
    let sy = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w
      const y = (i / w) | 0
      area++
      sx += x
      sy += y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x > 0 && bin[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), stack.push(i - 1)
      if (x < w - 1 && bin[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), stack.push(i + 1)
      if (y > 0 && bin[i - w] && !seen[i - w]) (seen[i - w] = 1), stack.push(i - w)
      if (y < h - 1 && bin[i + w] && !seen[i + w]) (seen[i + w] = 1), stack.push(i + w)
    }
    out.push({ minX, maxX, minY, maxY, area, cx: sx / area, cy: sy / area })
  }
  return out
}

function pitchForY(staff: DetectedStaff, y: number): Pitch {
  const bottom = staff.lines[staff.lines.length - 1]
  const half = staff.spacing / 2
  let position = Math.round((bottom - y) / half)
  position = Math.max(2, Math.min(10, position))
  return POSITION_TO_PITCH[position]
}

export function recognize(source: ImageData): OmrResult {
  const warnings: string[] = []
  // Downscale wide images for speed (nearest-neighbour is fine for line/blob work).
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
        const sx = Math.min(w - 1, Math.floor(x / scale))
        small[y * nw + x] = full[sy * w + sx]
      }
    }
    gray = small
    w = nw
    h = nh
  } else {
    gray = toGray(source.data, w, h)
  }

  const thr = otsu(gray)
  const ink = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) ink[i] = gray[i] < thr ? 1 : 0

  const staves = detectStaves(ink, w, h, warnings)
  if (staves.length === 0) {
    return { notes: [], staves, width: w, height: h, warnings }
  }

  const sp = staves.reduce((a, s) => a + s.spacing, 0) / staves.length
  const noStaff = removeStaffLines(ink, w, h)
  const r = Math.max(1, Math.round(sp * 0.24))
  const opened = open(noStaff, w, h, r)
  const comps = components(opened, w, h)

  // A notehead is a roughly round blob about one staff space across.
  const minDim = sp * 0.5
  const maxDim = sp * 2.1
  const heads = comps.filter((c) => {
    const cw = c.maxX - c.minX + 1
    const ch = c.maxY - c.minY + 1
    const aspect = cw / ch
    const fill = c.area / (cw * ch)
    return (
      cw >= minDim &&
      cw <= maxDim &&
      ch >= minDim &&
      ch <= maxDim * 1.2 &&
      aspect >= 0.5 &&
      aspect <= 2.4 &&
      fill >= 0.45
    )
  })

  const notes: DetectedNote[] = heads.map((c) => {
    // Assign to the nearest staff by vertical distance to its centre.
    let staffIndex = 0
    let bestDist = Infinity
    staves.forEach((s, i) => {
      const centre = (s.lines[0] + s.lines[s.lines.length - 1]) / 2
      const d = Math.abs(c.cy - centre)
      if (d < bestDist) {
        bestDist = d
        staffIndex = i
      }
    })
    return {
      pitch: pitchForY(staves[staffIndex], c.cy),
      x: c.cx,
      y: c.cy,
      staffIndex,
    }
  })

  // Reading order: staff top-to-bottom, then left-to-right within a staff.
  notes.sort((a, b) => a.staffIndex - b.staffIndex || a.x - b.x)

  if (notes.length === 0) {
    warnings.push('Staves were found but no noteheads were detected. Try a sharper, higher-contrast photo.')
  }
  return { notes, staves, width: w, height: h, warnings }
}
