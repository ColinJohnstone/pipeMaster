import type { Score, Bar, Note } from '../model/types'
import { voltaSpans } from '../model/voltas'
import { beats } from '../duration'
import type { Pitch } from '../pitch'
import { expandEmbellishment } from '../embellishments/registry'

/**
 * MusicXML (score-partwise 4.0) export for interchange with MuseScore,
 * Sibelius, Finale, etc. Bagpipe music is written on the treble staff in the
 * key of D (two sharps: F# and C#); embellishments export as slashed
 * gracenotes so the melodic rhythm stays intact in other editors.
 */

const DIVISIONS = 8 // divisions per quarter note (covers 32nds and dots)

interface XmlPitch {
  step: string
  alter?: number
  octave: number
}

const PITCH_XML: Record<Pitch, XmlPitch> = {
  LowG: { step: 'G', octave: 4 },
  LowA: { step: 'A', octave: 4 },
  B: { step: 'B', octave: 4 },
  C: { step: 'C', alter: 1, octave: 5 },
  D: { step: 'D', octave: 5 },
  E: { step: 'E', octave: 5 },
  F: { step: 'F', alter: 1, octave: 5 },
  HighG: { step: 'G', octave: 5 },
  HighA: { step: 'A', octave: 5 },
}

const TYPE_NAME: Record<number, string> = {
  1: 'whole',
  2: 'half',
  4: 'quarter',
  8: 'eighth',
  16: '16th',
  32: '32nd',
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function pitchXml(p: Pitch, indent: string): string {
  const x = PITCH_XML[p]
  const alter = x.alter ? `${indent}  <alter>${x.alter}</alter>\n` : ''
  return (
    `${indent}<pitch>\n` +
    `${indent}  <step>${x.step}</step>\n` +
    alter +
    `${indent}  <octave>${x.octave}</octave>\n` +
    `${indent}</pitch>\n`
  )
}

function graceNoteXml(p: Pitch): string {
  // Slashed acciaccatura with no duration, as pipe gracenotes are written.
  return (
    `      <note>\n` +
    `        <grace slash="yes"/>\n` +
    pitchXml(p, '        ') +
    `        <type>eighth</type>\n` +
    `      </note>\n`
  )
}

function noteXml(note: Note, tieStop: boolean): string {
  let out = ''
  for (const g of expandEmbellishment(note.embellishment, note.pitch)) {
    out += graceNoteXml(g)
  }
  const dur = Math.round(beats(note.duration) * DIVISIONS)
  const type = TYPE_NAME[note.duration.base]
  const dots = '        <dot/>\n'.repeat(note.duration.dots)

  const tieEls: string[] = []
  const tiedEls: string[] = []
  if (tieStop) {
    tieEls.push('        <tie type="stop"/>\n')
    tiedEls.push('          <tied type="stop"/>\n')
  }
  if (note.tieToNext) {
    tieEls.push('        <tie type="start"/>\n')
    tiedEls.push('          <tied type="start"/>\n')
  }
  const notations =
    tiedEls.length > 0
      ? `        <notations>\n${tiedEls.join('')}        </notations>\n`
      : ''

  out +=
    `      <note>\n` +
    pitchXml(note.pitch, '        ') +
    `        <duration>${dur}</duration>\n` +
    tieEls.join('') +
    `        <voice>1</voice>\n` +
    `        <type>${type}</type>\n` +
    dots +
    notations +
    `      </note>\n`
  return out
}

function attributesXml(score: Score): string {
  const ts = score.timeSig
  const beatType = ts.symbol === 'cut' ? { b: 2, u: 2 } : { b: ts.beats, u: ts.unit }
  return (
    `      <attributes>\n` +
    `        <divisions>${DIVISIONS}</divisions>\n` +
    `        <key>\n          <fifths>2</fifths>\n        </key>\n` +
    `        <time>\n          <beats>${beatType.b}</beats>\n          <beat-type>${beatType.u}</beat-type>\n        </time>\n` +
    `        <clef>\n          <sign>G</sign>\n          <line>2</line>\n        </clef>\n` +
    `      </attributes>\n`
  )
}

function measureXml(
  score: Score,
  bar: Bar,
  partIndex: number,
  barIndex: number,
  number: number,
  first: boolean,
  prevTiedToThis: boolean,
): string {
  let out = `    <measure number="${number}">\n`
  if (first) out += attributesXml(score)

  // Endings are note-stream spans; MusicXML brackets them at bar granularity, so
  // an ending is marked started on the bar its span begins in and stopped on the
  // bar it ends in.
  const spans = voltaSpans(score.parts[partIndex])
  const startSpan = spans.find((s) => s.startBar === barIndex)
  const endSpan = spans.find((s) => s.endBar === barIndex)

  const leftBarline: string[] = []
  if (bar.repeatStart) {
    leftBarline.push(
      `      <barline location="left">\n        <bar-style>heavy-light</bar-style>\n        <repeat direction="forward"/>\n      </barline>\n`,
    )
  }
  if (startSpan) {
    leftBarline.push(
      `      <barline location="left">\n        <ending number="${startSpan.num}" type="start"/>\n      </barline>\n`,
    )
  }
  out += leftBarline.join('')

  bar.notes.forEach((note, i) => {
    const tieStop = i === 0 ? prevTiedToThis : bar.notes[i - 1]?.tieToNext === true
    out += noteXml(note, tieStop)
  })

  const rightBarline: string[] = []
  if (endSpan) {
    const endingType = endSpan.num === 1 ? 'stop' : 'discontinue'
    rightBarline.push(
      `      <barline location="right">\n        <ending number="${endSpan.num}" type="${endingType}"/>\n` +
        (bar.repeatEnd
          ? `        <bar-style>light-heavy</bar-style>\n        <repeat direction="backward"/>\n`
          : '') +
        `      </barline>\n`,
    )
  } else if (bar.repeatEnd) {
    rightBarline.push(
      `      <barline location="right">\n        <bar-style>light-heavy</bar-style>\n        <repeat direction="backward"/>\n      </barline>\n`,
    )
  } else if (barIndex === score.parts[partIndex].bars.length - 1) {
    // Part end: light-heavy (final) barline.
    rightBarline.push(
      `      <barline location="right">\n        <bar-style>light-heavy</bar-style>\n      </barline>\n`,
    )
  }
  out += rightBarline.join('')

  out += `    </measure>\n`
  return out
}

export function exportMusicXml(score: Score): string {
  let measures = ''
  let measureNo = 0
  let prevTied = false
  score.parts.forEach((part, pi) => {
    part.bars.forEach((bar, bi) => {
      measureNo += 1
      const first = measureNo === 1 || bar.timeSig !== undefined
      measures += measureXml(score, bar, pi, bi, measureNo, first, prevTied)
      const last = bar.notes[bar.notes.length - 1]
      prevTied = last?.tieToNext === true
    })
  })

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n` +
    `<score-partwise version="4.0">\n` +
    `  <work>\n    <work-title>${esc(score.title)}</work-title>\n  </work>\n` +
    `  <identification>\n    <creator type="composer">${esc(score.composer)}</creator>\n` +
    `    <encoding>\n      <software>pipeMaster</software>\n    </encoding>\n  </identification>\n` +
    `  <part-list>\n    <score-part id="P1">\n      <part-name>${esc(score.tuneType || 'Bagpipe')}</part-name>\n` +
    `      <midi-instrument id="P1-I1">\n        <midi-program>110</midi-program>\n      </midi-instrument>\n` +
    `    </score-part>\n  </part-list>\n` +
    `  <part id="P1">\n` +
    measures +
    `  </part>\n` +
    `</score-partwise>\n`
  )
}
