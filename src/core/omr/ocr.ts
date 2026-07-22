import type { TimeSig } from '../duration'

/**
 * Header text extraction for photo import. The recognizer reads note *shapes*;
 * the tune's title, composer, type and metre are printed *text*, so they need
 * OCR. Tesseract.js is heavy, so it is loaded from a CDN on demand — the first
 * import that uses it pulls the engine + English data over the network; nothing
 * ships in the app bundle, and the rest of pipeMaster stays offline-capable.
 */

export interface OcrHeader {
  title?: string
  composer?: string
  tuneType?: string
  timeSig?: TimeSig
}

// A non-literal specifier keeps TypeScript from resolving the module (it is only
// present at runtime) and @vite-ignore stops Vite trying to bundle the URL.
const CDN_URL = 'https://esm.sh/tesseract.js@5'
let enginePromise: Promise<{ recognize: (img: unknown, lang: string) => Promise<{ data: unknown }> }> | null = null

function loadEngine() {
  if (!enginePromise) {
    const url = CDN_URL
    enginePromise = import(/* @vite-ignore */ url)
      .then((m) => (m as { default?: unknown }).default ?? m)
      .catch((e) => {
        enginePromise = null // allow a retry on the next import
        throw e
      }) as Promise<{ recognize: (img: unknown, lang: string) => Promise<{ data: unknown }> }>
  }
  return enginePromise
}

const TUNE_TYPES = [
  'March',
  'Slow Air',
  'Air',
  'Strathspey',
  'Reel',
  'Jig',
  'Hornpipe',
  'Waltz',
  'Polka',
  'Retreat',
  'Lament',
  'Salute',
]

interface Line {
  text: string
  h: number // glyph height ≈ font size
  cx: number
  y: number
}

function toLines(data: unknown): Line[] {
  const raw = (data as { lines?: unknown[] })?.lines ?? []
  return raw
    .map((l) => {
      const line = l as { text?: string; bbox?: { x0: number; y0: number; x1: number; y1: number } }
      const b = line.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 }
      return {
        text: (line.text || '').replace(/\s+/g, ' ').trim(),
        h: b.y1 - b.y0,
        cx: (b.x0 + b.x1) / 2,
        y: b.y0,
      }
    })
    .filter((l) => l.text.length > 0)
}

/** Turn OCR'd header lines into title / composer / type / metre. Best-effort. */
export function parseHeader(data: unknown): OcrHeader {
  const lines = toLines(data)
  const all = lines.map((l) => l.text).join('  ')
  const out: OcrHeader = {}

  // Metre, e.g. "6/8" (also matches the "6/8 March" credit line, which is clearer
  // than the tiny stave glyph).
  const ts = all.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/)
  if (ts) {
    const beats = Number(ts[1])
    const unit = Number(ts[2])
    if (beats >= 1 && beats <= 12 && (unit === 2 || unit === 4 || unit === 8)) out.timeSig = { beats, unit }
  }

  // Tune type.
  const typeRe = new RegExp('\\b(' + TUNE_TYPES.join('|') + ')\\b', 'i')
  const tm = all.match(typeRe)
  if (tm) out.tuneType = tm[1].replace(/\b\w/g, (c) => c.toUpperCase())

  // Title: the tallest line that is not just the metre/type credit or a composer
  // credit — the title is normally the largest text on the page.
  const isCredit = (t: string) => (typeRe.test(t) || /\d\s*\/\s*\d/.test(t)) && t.length < 24
  const looksLikeName = (t: string) =>
    /\b(P\/?M|Pipe\s*Major|Comp\.?|composed|arr\.?|arranged)\b/i.test(t) ||
    /^[A-Z]\.?\s*[A-Z][a-z]+/.test(t) ||
    /\b[A-Z]\.\s*[A-Z]/.test(t)
  const title = [...lines].filter((l) => !isCredit(l.text)).sort((a, b) => b.h - a.h)[0]
  if (title && title.text.length >= 2) out.title = title.text

  // Composer: a name-ish line that isn't the title. When the type/metre credit
  // and the composer share a baseline, OCR merges them into one line (e.g.
  // "6/8 March   P/M J. MacLeod") — strip that leading credit off the front.
  const comp = lines.find((l) => l.text !== out.title && looksLikeName(l.text))
  if (comp)
    out.composer = comp.text
      .replace(/^\s*\d{1,2}\s*\/\s*\d{1,2}\s*/, '') // leading metre
      .replace(new RegExp('^\\s*(' + TUNE_TYPES.join('|') + ')\\b\\s*', 'i'), '') // leading tune type
      .replace(/^(by|comp\.?|composed by|arr\.?|arranged by)\s+/i, '')
      .trim()

  return out
}

/**
 * OCR the strip above the first staff and return whatever header fields we can
 * read. `headerBottomY` is the y (in the image's pixel space) where the music
 * starts. Throws if the engine can't be loaded (offline) — callers treat that
 * as "no fields read".
 */
export async function ocrHeader(source: HTMLCanvasElement, headerBottomY: number): Promise<OcrHeader> {
  const h = Math.max(24, Math.min(Math.round(headerBottomY), source.height))
  const crop = document.createElement('canvas')
  crop.width = source.width
  crop.height = h
  crop.getContext('2d')!.drawImage(source, 0, 0, source.width, h, 0, 0, source.width, h)
  const engine = await loadEngine()
  const { data } = await engine.recognize(crop, 'eng')
  return parseHeader(data)
}
