import type { Pitch } from '../pitch'
import type { EmbellishmentType } from '../embellishments/registry'
import type { Bar, Note, Part, Score } from '../model/types'
import { newId } from '../model/types'
import type { Duration, TimeSig } from '../duration'

/**
 * Bagpipe Music Writer (.bww) import/export — the de facto interchange
 * format in the piping world. Token spellings follow BWW Gold as documented
 * by the limepipes-plugin-bww symbol mapper and real published files.
 */

const PITCH_TOKEN: Record<Pitch, string> = {
  LowG: 'LG',
  LowA: 'LA',
  B: 'B',
  C: 'C',
  D: 'D',
  E: 'E',
  F: 'F',
  HighG: 'HG',
  HighA: 'HA',
}

const TOKEN_PITCH: Record<string, Pitch> = Object.fromEntries(
  Object.entries(PITCH_TOKEN).map(([p, t]) => [t, p as Pitch]),
)

/** Lowercase pitch suffixes used inside embellishment and dot tokens. */
const LOW_SUFFIX: Record<Pitch, string> = {
  LowG: 'lg',
  LowA: 'la',
  B: 'b',
  C: 'c',
  D: 'd',
  E: 'e',
  F: 'f',
  HighG: 'hg',
  HighA: 'ha',
}

const SINGLE_GRACE_TOKEN: Record<string, EmbellishmentType> = {
  ag: 'aGrace',
  bg: 'bGrace',
  cg: 'cGrace',
  dg: 'dGrace',
  eg: 'eGrace',
  fg: 'fGrace',
  gg: 'gGrace',
  tg: 'thumbGrace',
}

const GRACE_TOKEN_FOR_TYPE: Partial<Record<EmbellishmentType, string>> =
  Object.fromEntries(Object.entries(SINGLE_GRACE_TOKEN).map(([t, k]) => [k, t]))

// -- Serialize ---------------------------------------------------------------

function embellishmentToken(note: Note): string {
  const emb = note.embellishment
  if (!emb) return ''
  const p = LOW_SUFFIX[note.pitch]
  switch (emb.type) {
    case 'doubling':
      return `db${p}`
    case 'halfDoubling':
      return `hdb${p}`
    case 'thumbDoubling':
      return `tdb${p}`
    case 'strike':
      return `str${p}`
    case 'gStrike':
      return `gst${p}`
    case 'thumbStrike':
      return `tst${p}`
    case 'grip':
      return 'grp'
    case 'taorluath':
      return 'tar'
    case 'birl':
      return 'brl'
    case 'gGraceBirl':
      return 'gbr'
    case 'thumbBirl':
      return 'tbr'
    case 'throwD':
      return 'thrd'
    case 'heavyThrowD':
      return 'hvthrd'
    case 'pele':
      return `pel${p}`
    case 'bubbly':
      return 'bubly'
    default:
      return GRACE_TOKEN_FOR_TYPE[emb.type] ?? ''
  }
}

function noteTokens(note: Note): string {
  const parts: string[] = []
  const emb = embellishmentToken(note)
  if (emb) parts.push(emb)
  parts.push(`${PITCH_TOKEN[note.pitch]}_${note.duration.base}`)
  if (note.duration.dots > 0) {
    parts.push(`${"'".repeat(note.duration.dots)}${LOW_SUFFIX[note.pitch]}`)
  }
  return parts.join(' ')
}

export function serializeBww(score: Score): string {
  const lines: string[] = [
    'Bagpipe Reader:1.0',
    '',
    `TuneTempo,${score.tempo}`,
    '',
    `"${score.title}",(T,C,0,0,Times New Roman,16,700,0,0,18,0,0,0)`,
    `"${score.tuneType}",(Y,C,0,0,Times New Roman,14,400,0,0,18,0,0,0)`,
    `"${score.composer}",(M,R,0,0,Times New Roman,14,400,0,0,18,0,0,0)`,
    '',
  ]
  const ts = score.timeSig
  const tsToken =
    ts.symbol === 'common' ? 'C' : ts.symbol === 'cut' ? 'C_' : `${ts.beats}_${ts.unit}`

  score.parts.forEach((part, pi) => {
    const startsRepeat = part.bars[0]?.repeatStart
    const endsRepeat = part.bars[part.bars.length - 1]?.repeatEnd
    const tokens: string[] = ['&', 'sharpf', 'sharpc']
    if (pi === 0) tokens.push(tsToken)
    tokens.push(startsRepeat ? "I!''" : 'I!')
    part.bars.forEach((bar, bi) => {
      if (bi > 0) tokens.push('!')
      bar.notes.forEach((n) => {
        if (n.voltaStart === 1) tokens.push("'1")
        if (n.voltaStart === 2) tokens.push("'2")
        tokens.push(noteTokens(n))
        if (n.voltaStop) tokens.push("_'")
      })
    })
    tokens.push(endsRepeat ? "''!I" : '!I')
    lines.push(tokens.join(' '))
    lines.push('')
  })
  return lines.join('\n')
}

// -- Parse -------------------------------------------------------------------

export interface BwwParseResult {
  score: Score
  warnings: string[]
}

const MELODY_RE = /^(LG|LA|B|C|D|E|F|HG|HA)([lr])?_(1|2|4|8|16|32)$/
const DOT_RE = /^('{1,2})(lg|la|b|c|d|e|f|hg|ha)$/
const TIMESIG_RE = /^(\d{1,2})_(1|2|4|8|16|32)$/

/** Map an embellishment token to our semantic type, or undefined. */
function parseEmbellishment(token: string): EmbellishmentType | undefined {
  if (SINGLE_GRACE_TOKEN[token]) return SINGLE_GRACE_TOKEN[token]
  let m = token.match(/^db(lg|la|b|c|d|e|f|hg|ha)$/)
  if (m) return 'doubling'
  m = token.match(/^hdb(lg|la|b|c|d|e|f|hg|ha)$/)
  if (m) return 'halfDoubling'
  m = token.match(/^tdb(lg|la|b|c|d|e|f|hg|ha)$/)
  if (m) return 'thumbDoubling'
  if (/^(str|hst)(lg|la|b|c|d|e|f|hg|ha)$/.test(token) || token === 'lhstd') return 'strike'
  if (/^gst(la|b|c|d|e|f)$/.test(token) || token === 'lgstd') return 'gStrike'
  if (/^tst(la|b|c|d|e|f|hg)$/.test(token) || token === 'ltstd') return 'thumbStrike'
  if (/^(grp|hgrp|grpb)$/.test(token)) return 'grip'
  if (/^(g|t|h)grp(lg|la|b|c|d|e|f|hg|ha|db)$/.test(token)) return 'grip'
  if (/^(tar|tarb|htar)$/.test(token)) return 'taorluath'
  if (token === 'brl' || token === 'abr') return 'birl'
  if (token === 'gbr') return 'gGraceBirl'
  if (token === 'tbr') return 'thumbBirl'
  if (token === 'thrd' || token === 'hthrd') return 'throwD'
  if (token === 'hvthrd' || token === 'hhvthrd') return 'heavyThrowD'
  if (/^(pel|tpel|hpel)(la|b|c|d|e|f|hg)$/.test(token) || /^l(t|h)?peld$/.test(token))
    return 'pele'
  if (token === 'bubly' || token === 'hbubly') return 'bubbly'
  return undefined
}

export function parseBww(text: string): BwwParseResult {
  const warnings: string[] = []
  const score: Score = {
    version: 1,
    id: newId('score'),
    title: 'Imported Tune',
    tuneType: '',
    composer: '',
    timeSig: { beats: 4, unit: 4 },
    tempo: 80,
    parts: [],
  }

  // Music runs from the first "&" line to the end of the file; within it,
  // continuation lines start with "!", a note, or an embellishment token.
  // Header/metadata lines are quoted strings or "Name,(...)" settings.
  const musicLines: string[] = []
  let inMusic = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const meta = line.match(/^"(.*)",\(([TYMF]),/)
    if (meta) {
      if (meta[2] === 'T') score.title = meta[1]
      if (meta[2] === 'Y') score.tuneType = meta[1]
      if (meta[2] === 'M') score.composer = meta[1]
      continue
    }
    const tempo = line.match(/^TuneTempo,(\d+)/)
    if (tempo) {
      score.tempo = Number(tempo[1])
      continue
    }
    if (/^[A-Za-z]+,\(/.test(line)) continue // other settings lines
    if (line.startsWith('&')) inMusic = true
    if (inMusic) musicLines.push(line)
  }
  if (musicLines.length === 0) {
    warnings.push('No music lines (starting with "&") found.')
  }

  let part: Part = { id: newId('p'), bars: [] }
  let bar: Bar = { id: newId('b'), notes: [] }
  let pendingEmb: EmbellishmentType | undefined
  let pendingRepeatStart = false
  let volta: 1 | 2 | undefined
  let sawTimeSig = false

  const pushBar = () => {
    if (bar.notes.length === 0 && !bar.repeatStart && !bar.repeatEnd) return
    part.bars.push(bar)
    bar = { id: newId('b'), notes: [] }
  }
  const pushPart = (repeatEnd: boolean) => {
    pushBar()
    if (repeatEnd) {
      const last = part.bars[part.bars.length - 1]
      if (last) last.repeatEnd = true
    }
    if (part.bars.length > 0) score.parts.push(part)
    part = { id: newId('p'), bars: [] }
    volta = undefined
  }

  for (const line of musicLines) {
    for (const token of line.split(/\s+/)) {
      if (!token || token === '&' || token === 'sharpf' || token === 'sharpc' || token === 'naturalc' || token === 'naturalf') continue

      const melody = token.match(MELODY_RE)
      if (melody) {
        const note: Note = {
          id: newId('n'),
          pitch: TOKEN_PITCH[melody[1]],
          duration: { base: Number(melody[3]) as Duration['base'], dots: 0 },
        }
        if (pendingEmb) {
          note.embellishment = { type: pendingEmb }
          pendingEmb = undefined
        }
        if (volta) {
          note.voltaStart = volta
          volta = undefined
        }
        if (pendingRepeatStart && part.bars.length === 0 && bar.notes.length === 0) {
          bar.repeatStart = true
          pendingRepeatStart = false
        }
        bar.notes.push(note)
        continue
      }

      const dot = token.match(DOT_RE)
      if (dot) {
        const last = bar.notes[bar.notes.length - 1]
        if (last) last.duration.dots = dot[1].length as 1 | 2
        continue
      }

      const tsMatch = token.match(TIMESIG_RE)
      if (tsMatch && !sawTimeSig) {
        score.timeSig = { beats: Number(tsMatch[1]), unit: Number(tsMatch[2]) as TimeSig['unit'] }
        sawTimeSig = true
        continue
      }
      if ((token === 'C' || token === 'C_') && !sawTimeSig) {
        score.timeSig =
          token === 'C'
            ? { beats: 4, unit: 4, symbol: 'common' }
            : { beats: 2, unit: 2, symbol: 'cut' }
        sawTimeSig = true
        continue
      }

      switch (token) {
        case "I!''":
          pendingRepeatStart = true
          continue
        case 'I!':
          continue
        case '!':
        case '!t':
          pushBar()
          continue
        case "''!I":
          pushPart(true)
          continue
        case '!I':
          pushPart(false)
          continue
        // First/second endings mark a span of the note stream. In BWW they also
        // sit at a bar boundary, so keep delimiting bars — but record the ending
        // on the NOTES (`'1`/`'2` open on the next note, `_'` closes on the last
        // one), which is what lets pipeMaster place two endings inside one bar.
        case "'1":
          pushBar()
          volta = 1
          continue
        case "'2":
          pushBar()
          volta = 2
          continue
        case "_'": {
          const prev = bar.notes[bar.notes.length - 1]
          if (prev) prev.voltaStop = true
          pushBar()
          volta = undefined
          continue
        }
        case '^ts':
        case '^te': {
          const last = bar.notes[bar.notes.length - 1]
          if (token === '^ts' && last) last.tieToNext = true
          continue
        }
      }

      const emb = parseEmbellishment(token)
      if (emb) {
        if (pendingEmb) warnings.push(`Consecutive embellishments; kept "${token}".`)
        pendingEmb = emb
        continue
      }

      // Old-style tie tokens (^tla …) and anything else we don't model yet.
      if (/^\^t(lg|la|b|c|d|e|f|hg|ha)$/.test(token)) {
        const last = bar.notes[bar.notes.length - 1]
        if (last && !last.tieToNext) last.tieToNext = true
        continue
      }
      warnings.push(`Skipped unrecognised token "${token}".`)
    }
  }
  pushPart(false)

  if (score.parts.length === 0) {
    warnings.push('No bars could be read from the file.')
    score.parts.push({ id: newId('p'), bars: [{ id: newId('b'), notes: [] }] })
  }
  return { score, warnings }
}
