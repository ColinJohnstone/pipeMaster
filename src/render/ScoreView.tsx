import React from 'react'
import type { Score, NoteAddress } from '../core/model/types'
import { voltaSpans, type VoltaSpan } from '../core/model/voltas'
import type { Pitch } from '../core/pitch'
import { STAFF_POSITION, pitchAtPosition } from '../core/pitch'
import { embellishmentDef } from '../core/embellishments/registry'

/** Single-letter note name shown above the staff (octave shown by position). */
const NOTE_LETTER: Record<Pitch, string> = {
  LowG: 'G',
  LowA: 'A',
  B: 'B',
  C: 'C',
  D: 'D',
  E: 'E',
  F: 'F',
  HighG: 'G',
  HighA: 'A',
}
import {
  SPACE,
  STAFF_HEIGHT,
  MARGIN_X,
  CLEF_WIDTH,
  TIMESIG_WIDTH,
  beamGroups,
  layoutScore,
  positionToY,
  type LaidBar,
  type LaidSystem,
  type ScoreLayout,
} from '../layout/layout'

// SMuFL codepoints (Bravura).
const GLYPH = {
  gClef: 0xe050,
  timeSigCommon: 0xe08a,
  timeSigCut: 0xe08b,
  noteheadWhole: 0xe0a2,
  noteheadHalf: 0xe0a3,
  noteheadBlack: 0xe0a4,
  flag8thDown: 0xe241,
  flag16thDown: 0xe243,
  flag32ndDown: 0xe245,
  flag32ndUp: 0xe244,
  timeSigDigit: (d: number) => 0xe080 + d,
}

const EMPTY_KEYS: Set<string> = new Set()

const HEAD_W = SPACE * 1.18
const STEM_LEN = SPACE * 3.5
const STEM_W = SPACE * 0.13
const BEAM_THICK = SPACE * 0.5
const GRACE_SCALE = 0.62
const GRACE_HEAD_W = HEAD_W * GRACE_SCALE
const GRACE_BEAM_THICK = SPACE * 0.32

export interface CursorPos {
  systemIndex: number
  x: number
}

/** Where a click or drop lands on the staff. */
export interface DropTarget {
  partIndex: number
  barIndex: number
  index: number
  pitch: Pitch
  /** Index of an existing note the pointer is over, if any. */
  noteIndex?: number
}

interface Preview {
  staffTop: number
  x: number
  pitch: Pitch
}

interface ScoreViewProps {
  score: Score
  selection: NoteAddress | null
  /** Keys (`pi:bi:ni`) of all notes in the selected range, for highlighting. */
  selectedKeys?: Set<string>
  /** Show the pitch letter (and embellishment name) above each note. */
  showLetters?: boolean
  onSelectNote(addr: NoteAddress, extend: boolean): void
  onInsertNote(partIndex: number, barIndex: number, noteIndex: number, pitch: Pitch): void
  onBackgroundClick(): void
  onStaffDrop?(target: DropTarget, payload: string): void
  cursor?: CursorPos | null
  layoutOut?: (l: ScoreLayout) => void
}

function Glyph({
  x,
  y,
  code,
  size = STAFF_HEIGHT,
  fill = 'var(--ink)',
  anchor = 'start',
}: {
  x: number
  y: number
  code: number
  size?: number
  fill?: string
  anchor?: 'start' | 'middle'
}) {
  return (
    <text
      x={x}
      y={y}
      fontFamily="Bravura"
      fontSize={size}
      fill={fill}
      textAnchor={anchor}
      style={{ userSelect: 'none', pointerEvents: 'none' }}
    >
      {String.fromCodePoint(code)}
    </text>
  )
}

const noteheadGlyph = (base: number) =>
  base === 1 ? GLYPH.noteheadWhole : base === 2 ? GLYPH.noteheadHalf : GLYPH.noteheadBlack

const beamCount = (base: number) => (base >= 32 ? 3 : base >= 16 ? 2 : base >= 8 ? 1 : 0)

function StaffLines({ y, width }: { y: number; width: number }) {
  return (
    <g>
      {[0, 1, 2, 3, 4].map((i) => (
        <line
          key={i}
          x1={MARGIN_X}
          x2={MARGIN_X + width}
          y1={y + i * SPACE}
          y2={y + i * SPACE}
          stroke="var(--staff)"
          strokeWidth={1}
        />
      ))}
    </g>
  )
}

function Barline({
  x,
  staffTop,
  kind,
}: {
  x: number
  staffTop: number
  kind: 'normal' | 'double' | 'final' | 'repeatStart' | 'repeatEnd'
}) {
  const y1 = staffTop
  const y2 = staffTop + STAFF_HEIGHT
  const dotY1 = staffTop + SPACE * 1.5
  const dotY2 = staffTop + SPACE * 2.5
  const thin = 1.2
  const thick = SPACE * 0.55
  switch (kind) {
    case 'normal':
      return <line x1={x} x2={x} y1={y1} y2={y2} stroke="var(--ink)" strokeWidth={thin} />
    case 'double':
      return (
        <g stroke="var(--ink)" strokeWidth={thin}>
          <line x1={x - SPACE * 0.6} x2={x - SPACE * 0.6} y1={y1} y2={y2} />
          <line x1={x} x2={x} y1={y1} y2={y2} />
        </g>
      )
    case 'final':
      return (
        <g>
          <line x1={x - SPACE} x2={x - SPACE} y1={y1} y2={y2} stroke="var(--ink)" strokeWidth={thin} />
          <rect x={x - thick} y={y1} width={thick} height={y2 - y1} fill="var(--ink)" />
        </g>
      )
    case 'repeatStart':
      return (
        <g>
          <rect x={x} y={y1} width={thick} height={y2 - y1} fill="var(--ink)" />
          <line x1={x + thick + SPACE * 0.45} x2={x + thick + SPACE * 0.45} y1={y1} y2={y2} stroke="var(--ink)" strokeWidth={thin} />
          <circle cx={x + thick + SPACE * 1.1} cy={dotY1} r={SPACE * 0.22} fill="var(--ink)" />
          <circle cx={x + thick + SPACE * 1.1} cy={dotY2} r={SPACE * 0.22} fill="var(--ink)" />
        </g>
      )
    case 'repeatEnd':
      return (
        <g>
          <circle cx={x - thick - SPACE * 1.1} cy={dotY1} r={SPACE * 0.22} fill="var(--ink)" />
          <circle cx={x - thick - SPACE * 1.1} cy={dotY2} r={SPACE * 0.22} fill="var(--ink)" />
          <line x1={x - thick - SPACE * 0.45} x2={x - thick - SPACE * 0.45} y1={y1} y2={y2} stroke="var(--ink)" strokeWidth={thin} />
          <rect x={x - thick} y={y1} width={thick} height={y2 - y1} fill="var(--ink)" />
        </g>
      )
  }
}

function TimeSigView({ x, staffTop, laid }: { x: number; staffTop: number; laid: LaidBar }) {
  const ts = laid.timeSig
  if (ts.symbol === 'common' || ts.symbol === 'cut') {
    return (
      <Glyph
        x={x}
        y={staffTop + SPACE * 2}
        code={ts.symbol === 'common' ? GLYPH.timeSigCommon : GLYPH.timeSigCut}
        anchor="middle"
      />
    )
  }
  return (
    <g>
      <Glyph x={x} y={staffTop + SPACE} code={GLYPH.timeSigDigit(ts.beats)} anchor="middle" />
      <Glyph x={x} y={staffTop + SPACE * 3} code={GLYPH.timeSigDigit(ts.unit)} anchor="middle" />
    </g>
  )
}

function GraceCluster({
  graces,
  barX,
  staffTop,
}: {
  graces: { pitch: Pitch; x: number }[]
  barX: number
  staffTop: number
}) {
  if (graces.length === 0) return null
  const heads = graces.map((g) => ({
    x: barX + g.x,
    y: staffTop + positionToY(STAFF_POSITION[g.pitch]),
  }))
  // Beam sits above the highest gracenote, and never below 2.5 spaces over the staff.
  const beamY = Math.min(
    staffTop - SPACE * 2.5,
    Math.min(...heads.map((h) => h.y)) - SPACE * 2.1,
  )
  const stemX = (h: { x: number }) => h.x + GRACE_HEAD_W / 2 - STEM_W / 2
  return (
    <g>
      {heads.map((h, i) => (
        <g key={i}>
          <Glyph
            x={h.x - GRACE_HEAD_W / 2}
            y={h.y}
            code={GLYPH.noteheadBlack}
            size={STAFF_HEIGHT * GRACE_SCALE}
          />
          <rect
            x={stemX(h)}
            y={beamY}
            width={STEM_W}
            height={h.y - beamY - SPACE * 0.2}
            fill="var(--ink)"
          />
          {h.y < staffTop - SPACE * 0.5 && (
            // Ledger line for High A gracenotes.
            <line
              x1={h.x - GRACE_HEAD_W}
              x2={h.x + GRACE_HEAD_W}
              y1={staffTop - SPACE}
              y2={staffTop - SPACE}
              stroke="var(--staff)"
              strokeWidth={1}
            />
          )}
        </g>
      ))}
      {heads.length === 1 ? (
        <Glyph
          x={stemX(heads[0])}
          y={beamY}
          code={GLYPH.flag32ndUp}
          size={STAFF_HEIGHT * GRACE_SCALE}
        />
      ) : (
        [0, 1, 2].map((level) => (
          <rect
            key={level}
            x={stemX(heads[0])}
            y={beamY + level * GRACE_BEAM_THICK * 1.7}
            width={stemX(heads[heads.length - 1]) - stemX(heads[0]) + STEM_W}
            height={GRACE_BEAM_THICK}
            fill="var(--ink)"
          />
        ))
      )}
    </g>
  )
}

function BarNotes({
  laid,
  staffTop,
  selection,
  selectedKeys,
  showLetters,
  onSelectNote,
  tieIn,
}: {
  laid: LaidBar
  staffTop: number
  selection: NoteAddress | null
  selectedKeys: Set<string>
  showLetters: boolean
  onSelectNote(addr: NoteAddress, extend: boolean): void
  tieIn: boolean
}) {
  const barX = MARGIN_X + laid.x
  const groups = beamGroups(laid)
  const inBeam = new Set(groups.flat())

  const headY = (pitch: Pitch) => staffTop + positionToY(STAFF_POSITION[pitch])
  const stemXOf = (x: number) => x - HEAD_W / 2 + STEM_W / 2

  // Beamed groups share a horizontal beam below the lowest stem end.
  const beamYByGroup = new Map<number, number>()
  groups.forEach((g, gi) => {
    const maxY = Math.max(...g.map((i) => headY(laid.notes[i].note.pitch)))
    beamYByGroup.set(gi, maxY + STEM_LEN)
    g.forEach(() => {})
    void gi
  })

  const isFocus = (addr: NoteAddress) =>
    selection &&
    selection.partIndex === addr.partIndex &&
    selection.barIndex === addr.barIndex &&
    selection.noteIndex === addr.noteIndex
  const inRange = (addr: NoteAddress) =>
    selectedKeys.has(`${addr.partIndex}:${addr.barIndex}:${addr.noteIndex}`)

  const firstNote = laid.notes[0]
  return (
    <g>
      {tieIn && firstNote && (
        // Incoming half of a tie that started in the previous bar.
        <path
          d={(() => {
            const x2 = barX + firstNote.x - HEAD_W * 0.5
            const x1 = x2 - SPACE * 2.4
            const y = headY(firstNote.note.pitch) - SPACE * 0.8
            return `M ${x1} ${y} Q ${(x1 + x2) / 2} ${y - SPACE * 1.1} ${x2} ${y}`
          })()}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={1.4}
        />
      )}
      {laid.notes.map((ln, i) => {
        const { note } = ln
        const x = barX + ln.x
        const y = headY(note.pitch)
        const focus = isFocus(ln.addr)
        const ranged = focus || inRange(ln.addr)
        const selectedFill = ranged ? 'var(--accent)' : 'var(--ink)'
        const groupIndex = groups.findIndex((g) => g.includes(i))
        const beamed = inBeam.has(i)
        const stemEnd = beamed ? beamYByGroup.get(groupIndex)! : y + STEM_LEN
        const hasStem = note.duration.base >= 2
        const flags = !beamed ? beamCount(note.duration.base) : 0
        const dotY = STAFF_POSITION[note.pitch] % 2 === 0 ? y - SPACE / 2 : y
        return (
          <g key={note.id}>
            {ranged && (
              // Selection highlight behind the note (brighter for the focus).
              <rect
                x={x - HEAD_W * 1.1}
                y={staffTop - SPACE * 1.5}
                width={HEAD_W * 2.2}
                height={STAFF_HEIGHT + SPACE * 3}
                rx={3}
                fill="var(--accent)"
                opacity={focus ? 0.16 : 0.09}
              />
            )}
            {note.pitch === 'HighA' && (
              <line
                x1={x - HEAD_W * 1.1}
                x2={x + HEAD_W * 1.1}
                y1={staffTop - SPACE}
                y2={staffTop - SPACE}
                stroke="var(--staff)"
                strokeWidth={1}
              />
            )}
            <Glyph x={x - HEAD_W / 2} y={y} code={noteheadGlyph(note.duration.base)} fill={selectedFill} />
            {hasStem && (
              <rect
                x={stemXOf(x) - STEM_W / 2}
                y={y + SPACE * 0.15}
                width={STEM_W}
                height={stemEnd - y - SPACE * 0.15}
                fill={selectedFill}
              />
            )}
            {flags === 1 && <Glyph x={stemXOf(x) - STEM_W / 2} y={stemEnd} code={GLYPH.flag8thDown} fill={selectedFill} />}
            {flags === 2 && <Glyph x={stemXOf(x) - STEM_W / 2} y={stemEnd} code={GLYPH.flag16thDown} fill={selectedFill} />}
            {flags === 3 && <Glyph x={stemXOf(x) - STEM_W / 2} y={stemEnd} code={GLYPH.flag32ndDown} fill={selectedFill} />}
            {note.duration.dots > 0 && (
              <circle cx={x + HEAD_W * 0.9} cy={dotY} r={SPACE * 0.24} fill={selectedFill} />
            )}
            {note.tieToNext && <Tie laid={laid} noteIndex={i} barX={barX} headY={headY} />}
            <rect
              x={x - HEAD_W}
              y={y - SPACE}
              width={HEAD_W * 2}
              height={SPACE * 2}
              fill="transparent"
              style={{ cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation()
                onSelectNote(ln.addr, e.shiftKey)
              }}
            />
          </g>
        )
      })}
      {groups.map((g, gi) => {
        const beamY = beamYByGroup.get(gi)!
        const x1 = stemXOf(barX + laid.notes[g[0]].x) - STEM_W / 2
        const x2 = stemXOf(barX + laid.notes[g[g.length - 1]].x) + STEM_W / 2
        const segments: React.ReactNode[] = [
          <rect key="b1" x={x1} y={beamY - BEAM_THICK} width={x2 - x1} height={BEAM_THICK} fill="var(--ink)" />,
        ]
        // Secondary beams (16ths, 32nds): segments between neighbors that share
        // the level, stubs for isolated ones.
        for (let level = 2; level <= 3; level++) {
          for (let k = 0; k < g.length; k++) {
            const i = g[k]
            if (beamCount(laid.notes[i].note.duration.base) < level) continue
            const sx = stemXOf(barX + laid.notes[i].x)
            const prev = k > 0 ? g[k - 1] : null
            const next = k < g.length - 1 ? g[k + 1] : null
            const prevHas = prev !== null && beamCount(laid.notes[prev].note.duration.base) >= level
            const nextHas = next !== null && beamCount(laid.notes[next].note.duration.base) >= level
            const yy = beamY - BEAM_THICK - (level - 1) * BEAM_THICK * 1.5
            if (nextHas) {
              const ex = stemXOf(barX + laid.notes[next!].x)
              segments.push(
                <rect key={`b${level}-${k}`} x={sx - STEM_W / 2} y={yy} width={ex - sx + STEM_W} height={BEAM_THICK} fill="var(--ink)" />,
              )
            } else if (!prevHas) {
              // Isolated at this level: stub toward the neighbor.
              const dir = next !== null ? 1 : -1
              segments.push(
                <rect
                  key={`b${level}-stub-${k}`}
                  x={dir === 1 ? sx - STEM_W / 2 : sx + STEM_W / 2 - SPACE * 1.2}
                  y={yy}
                  width={SPACE * 1.2}
                  height={BEAM_THICK}
                  fill="var(--ink)"
                />,
              )
            }
          }
        }
        return <g key={gi}>{segments}</g>
      })}
      {laid.notes.map((ln) => (
        <GraceCluster key={`g${ln.note.id}`} graces={ln.graces} barX={barX} staffTop={staffTop} />
      ))}
      {showLetters &&
        laid.notes.map((ln) => {
          const x = barX + ln.x
          const emb = ln.note.embellishment
          return (
            <g key={`L${ln.note.id}`} style={{ pointerEvents: 'none' }}>
              {emb && (
                <text
                  x={x}
                  y={staffTop - SPACE * 5}
                  textAnchor="middle"
                  fontSize={SPACE * 1.05}
                  fontFamily="Inter, sans-serif"
                  fill="var(--accent)"
                >
                  {embellishmentDef(emb.type).short}
                </text>
              )}
              <text
                x={x}
                y={staffTop - SPACE * 3.7}
                textAnchor="middle"
                fontSize={SPACE * 1.5}
                fontWeight={700}
                fontFamily="Inter, sans-serif"
                fill="var(--ink-soft)"
              >
                {NOTE_LETTER[ln.note.pitch]}
              </text>
            </g>
          )
        })}
      {tupletRuns(laid.notes).map((run, ri) => {
        const first = laid.notes[run[0]]
        const last = laid.notes[run[run.length - 1]]
        const x1 = barX + first.x - HEAD_W * 0.6
        const x2 = barX + last.x + HEAD_W * 0.6
        const topY =
          Math.min(...run.map((i) => headY(laid.notes[i].note.pitch))) - SPACE * 3.4
        const mid = (x1 + x2) / 2
        const num = laid.notes[run[0]].note.tuplet ?? 3
        return (
          <g key={`t${ri}`}>
            <path
              d={`M ${x1} ${topY + SPACE * 0.5} V ${topY} H ${mid - SPACE} M ${mid + SPACE} ${topY} H ${x2} V ${topY + SPACE * 0.5}`}
              fill="none"
              stroke="var(--ink-soft)"
              strokeWidth={1}
            />
            <text
              x={mid}
              y={topY + SPACE * 0.55}
              textAnchor="middle"
              fontSize={SPACE * 1.5}
              fontStyle="italic"
              fontFamily="Georgia, serif"
              fill="var(--ink-soft)"
            >
              {num}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/** Maximal runs of consecutive notes sharing a tuplet grouping. */
function tupletRuns(notes: { note: { tuplet?: number } }[]): number[][] {
  const runs: number[][] = []
  let run: number[] = []
  for (let i = 0; i < notes.length; i++) {
    const t = notes[i].note.tuplet
    if (t && (run.length === 0 || notes[run[0]].note.tuplet === t)) {
      run.push(i)
    } else {
      if (run.length > 0) runs.push(run)
      run = t ? [i] : []
    }
  }
  if (run.length > 0) runs.push(run)
  return runs
}

function Tie({
  laid,
  noteIndex,
  barX,
  headY,
}: {
  laid: LaidBar
  noteIndex: number
  barX: number
  headY: (p: Pitch) => number
}) {
  const from = laid.notes[noteIndex]
  const to = laid.notes[noteIndex + 1]
  const x1 = barX + from.x + HEAD_W * 0.4
  // Tie to the next note in this bar, or arc toward the barline.
  const x2 = to ? barX + to.x - HEAD_W * 0.4 : barX + laid.width - SPACE * 0.5
  const y = headY(from.note.pitch) - SPACE * 0.8
  const mid = (x1 + x2) / 2
  return (
    <path
      d={`M ${x1} ${y} Q ${mid} ${y - SPACE * 1.1} ${x2} ${y}`}
      fill="none"
      stroke="var(--ink)"
      strokeWidth={1.4}
    />
  )
}

/** Map a pointer event over a bar to a drop target and preview geometry. */
function targetFromEvent(
  e: React.MouseEvent<SVGRectElement>,
  laid: LaidBar,
  staffTop: number,
  barX: number,
): { target: DropTarget; preview: Preview } {
  const svg = (e.target as SVGRectElement).ownerSVGElement!
  const pt = svg.createSVGPoint()
  pt.x = e.clientX
  pt.y = e.clientY
  const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
  const position = Math.round(8 - (2 * (p.y - staffTop)) / SPACE)
  const pitch = pitchAtPosition(position)
  let index = 0
  let noteIndex: number | undefined
  laid.notes.forEach((ln, i) => {
    if (barX + ln.x < p.x) index++
    if (Math.abs(barX + ln.x - p.x) < HEAD_W) noteIndex = i
  })
  return {
    target: { partIndex: laid.partIndex, barIndex: laid.barIndex, index, pitch, noteIndex },
    preview: { staffTop, x: p.x, pitch },
  }
}

function BarView({
  laid,
  staffTop,
  selection,
  selectedKeys,
  showLetters,
  onSelectNote,
  onInsertNote,
  onStaffDrop,
  onPreview,
  onClearPreview,
  tieIn,
  spans,
}: {
  laid: LaidBar
  staffTop: number
  selection: NoteAddress | null
  selectedKeys: Set<string>
  showLetters: boolean
  onSelectNote(addr: NoteAddress, extend: boolean): void
  onInsertNote(partIndex: number, barIndex: number, noteIndex: number, pitch: Pitch): void
  onStaffDrop?(target: DropTarget, payload: string): void
  onPreview(p: Preview): void
  onClearPreview(): void
  tieIn: boolean
  spans: VoltaSpan[]
}) {
  const barX = MARGIN_X + laid.x
  const rightX = barX + laid.width

  const handleClick = (e: React.MouseEvent<SVGRectElement>) => {
    const { target } = targetFromEvent(e, laid, staffTop, barX)
    onInsertNote(target.partIndex, target.barIndex, target.index, target.pitch)
  }

  return (
    <g>
      {laid.isFirstOfSystem && laid.barNumber !== null && laid.barNumber > 1 && (
        <text
          x={barX + (laid.showClef ? CLEF_WIDTH + SPACE : SPACE * 0.5)}
          y={staffTop - SPACE * 1.6}
          fontSize={9}
          fontFamily="Inter, sans-serif"
          fill="var(--ink-soft)"
        >
          {laid.barNumber}
        </text>
      )}
      {laid.showClef && (
        <Glyph x={barX + SPACE * 0.8} y={staffTop + SPACE * 3} code={GLYPH.gClef} />
      )}
      {laid.showTimeSig && (
        <TimeSigView x={barX + SPACE * 5.6} staffTop={staffTop} laid={laid} />
      )}
      <rect
        x={barX}
        y={staffTop - SPACE * 4.5}
        width={laid.width}
        height={STAFF_HEIGHT + SPACE * 8}
        fill="transparent"
        onClick={handleClick}
        onMouseMove={(e) => onPreview(targetFromEvent(e, laid, staffTop, barX).preview)}
        onMouseLeave={onClearPreview}
        onDragOver={(e) => {
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
          onPreview(targetFromEvent(e, laid, staffTop, barX).preview)
        }}
        onDragLeave={onClearPreview}
        onDrop={(e) => {
          e.preventDefault()
          const payload = e.dataTransfer.getData('application/x-pm')
          onClearPreview()
          if (payload && onStaffDrop) {
            onStaffDrop(targetFromEvent(e, laid, staffTop, barX).target, payload)
          }
        }}
        style={{ cursor: 'text' }}
      />
      {laid.isFirstOfSystem && <Barline x={barX} staffTop={staffTop} kind="normal" />}
      {laid.bar.repeatStart && (
        // At a system start the repeat sign sits after the clef and meter.
        <Barline
          x={
            laid.isFirstOfSystem
              ? barX + CLEF_WIDTH + (laid.showTimeSig ? TIMESIG_WIDTH : 0) - SPACE * 0.4
              : barX
          }
          staffTop={staffTop}
          kind="repeatStart"
        />
      )}
      <Barline
        x={rightX}
        staffTop={staffTop}
        kind={
          laid.bar.repeatEnd
            ? 'repeatEnd'
            : laid.isLastOfPart
              ? 'double'
              : 'normal'
        }
      />
      {spans.map((s, si) => {
        if (laid.barIndex < s.startBar || laid.barIndex > s.endBar) return null
        // The notes of this ending that fall in this bar.
        const lo = laid.barIndex === s.startBar ? s.startNote : 0
        const hi = laid.barIndex === s.endBar ? s.endNote : Infinity
        const inBar = laid.notes.filter((ln) => ln.addr.noteIndex >= lo && ln.addr.noteIndex <= hi)
        if (inBar.length === 0) return null
        const opensHere = laid.barIndex === s.startBar
        const closesHere = laid.barIndex === s.endBar
        // Reach the bar edges where the ending carries on into an adjacent bar,
        // so a multi-bar bracket reads as one continuous line.
        const x0 = opensHere ? barX + inBar[0].x - HEAD_W : barX
        const x1 = closesHere ? barX + inBar[inBar.length - 1].x + HEAD_W : rightX
        const topY = staffTop - SPACE * 4.6
        return (
          <g key={`v${si}`}>
            <path
              d={
                `M ${x0} ${opensHere ? topY : topY - SPACE * 1.4} ` +
                `${opensHere ? `v ${-SPACE * 1.4} ` : ''}` +
                `h ${x1 - x0} ${closesHere ? `v ${SPACE * 1.4}` : ''}`
              }
              fill="none"
              stroke="var(--ink)"
              strokeWidth={1.2}
            />
            {opensHere && (
              <text
                x={x0 + SPACE * 0.5}
                y={topY - SPACE * 0.25}
                fontSize={12}
                fontFamily="Georgia, serif"
                fill="var(--ink)"
              >
                {s.num}.
              </text>
            )}
          </g>
        )
      })}
      <BarNotes
        laid={laid}
        staffTop={staffTop}
        selection={selection}
        selectedKeys={selectedKeys}
        showLetters={showLetters}
        onSelectNote={onSelectNote}
        tieIn={tieIn}
      />
    </g>
  )
}

function SystemView({
  system,
  contentWidth,
  selection,
  selectedKeys,
  showLetters,
  onSelectNote,
  onInsertNote,
  onStaffDrop,
  onPreview,
  onClearPreview,
  tieInKeys,
  partSpans,
}: {
  system: LaidSystem
  contentWidth: number
  selection: NoteAddress | null
  selectedKeys: Set<string>
  showLetters: boolean
  onSelectNote(addr: NoteAddress, extend: boolean): void
  onInsertNote(partIndex: number, barIndex: number, noteIndex: number, pitch: Pitch): void
  onStaffDrop?(target: DropTarget, payload: string): void
  onPreview(p: Preview): void
  onClearPreview(): void
  tieInKeys: Set<string>
  partSpans: VoltaSpan[][]
}) {
  return (
    <g>
      <StaffLines y={system.staffTop} width={contentWidth} />
      {system.partLabel && (
        <text
          x={MARGIN_X - SPACE * 1.5}
          y={system.staffTop + SPACE * 2.6}
          fill="var(--ink-soft)"
          fontSize={14}
          fontStyle="italic"
          textAnchor="end"
          fontFamily="Georgia, serif"
        >
          {system.partLabel}
        </text>
      )}
      {system.bars.map((b) => (
        <BarView
          key={b.bar.id}
          laid={b}
          staffTop={system.staffTop}
          selection={selection}
          selectedKeys={selectedKeys}
          showLetters={showLetters}
          onSelectNote={onSelectNote}
          onInsertNote={onInsertNote}
          onStaffDrop={onStaffDrop}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
          tieIn={tieInKeys.has(`${b.partIndex}:${b.barIndex}`)}
          spans={partSpans[b.partIndex] ?? EMPTY_SPANS}
        />
      ))}
    </g>
  )
}

const EMPTY_SPANS: VoltaSpan[] = []

function GhostNote({ preview }: { preview: Preview }) {
  const y = preview.staffTop + positionToY(STAFF_POSITION[preview.pitch])
  return (
    <g opacity={0.4} style={{ pointerEvents: 'none' }}>
      {preview.pitch === 'HighA' && (
        <line
          x1={preview.x - HEAD_W * 1.1}
          x2={preview.x + HEAD_W * 1.1}
          y1={preview.staffTop - SPACE}
          y2={preview.staffTop - SPACE}
          stroke="var(--accent)"
          strokeWidth={1}
        />
      )}
      <Glyph x={preview.x - HEAD_W / 2} y={y} code={GLYPH.noteheadBlack} fill="var(--accent)" />
      <rect
        x={preview.x - HEAD_W / 2 + STEM_W / 2 - STEM_W / 2}
        y={y + SPACE * 0.15}
        width={STEM_W}
        height={STEM_LEN}
        fill="var(--accent)"
      />
    </g>
  )
}

export function ScoreView({
  score,
  selection,
  selectedKeys,
  showLetters = false,
  onSelectNote,
  onInsertNote,
  onBackgroundClick,
  onStaffDrop,
  cursor,
  layoutOut,
}: ScoreViewProps) {
  const keys = selectedKeys ?? EMPTY_KEYS
  const layout = React.useMemo(() => layoutScore(score), [score])
  React.useEffect(() => {
    layoutOut?.(layout)
  }, [layout, layoutOut])
  const contentWidth = layout.width - MARGIN_X * 2
  const [preview, setPreview] = React.useState<Preview | null>(null)

  // Resolved 1st/2nd ending spans per part, for the volta brackets.
  const partSpans = React.useMemo(() => score.parts.map((p) => voltaSpans(p)), [score])

  // Bars whose previous bar ends with a tie get an incoming half-arc.
  const tieInKeys = React.useMemo(() => {
    const keys = new Set<string>()
    score.parts.forEach((part, pi) =>
      part.bars.forEach((bar, bi) => {
        const last = bar.notes[bar.notes.length - 1]
        if (last?.tieToNext && (part.bars[bi + 1]?.notes.length ?? 0) > 0) {
          keys.add(`${pi}:${bi + 1}`)
        }
      }),
    )
    return keys
  }, [score])

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width="100%"
      style={{ display: 'block', background: 'var(--page)', borderRadius: 8 }}
      onClick={onBackgroundClick}
    >
      <text
        x={layout.width / 2}
        y={52}
        textAnchor="middle"
        fontSize={27}
        fontFamily="Georgia, 'Times New Roman', serif"
        fill="var(--ink)"
      >
        {score.title}
      </text>
      <text x={MARGIN_X} y={82} fontSize={14} fontStyle="italic" fontFamily="Georgia, serif" fill="var(--ink-soft)">
        {score.tuneType}
      </text>
      <text
        x={layout.width - MARGIN_X}
        y={82}
        textAnchor="end"
        fontSize={14}
        fontFamily="Georgia, serif"
        fill="var(--ink-soft)"
      >
        {score.composer}
      </text>
      {layout.systems.map((sys, i) => (
        <SystemView
          key={i}
          system={sys}
          contentWidth={contentWidth}
          selection={selection}
          selectedKeys={keys}
          showLetters={showLetters}
          onSelectNote={onSelectNote}
          onInsertNote={onInsertNote}
          onStaffDrop={onStaffDrop}
          onPreview={setPreview}
          onClearPreview={() => setPreview(null)}
          tieInKeys={tieInKeys}
          partSpans={partSpans}
        />
      ))}
      {preview && !cursor && <GhostNote preview={preview} />}
      {cursor && layout.systems[cursor.systemIndex] && (
        <line
          x1={cursor.x}
          x2={cursor.x}
          y1={layout.systems[cursor.systemIndex].staffTop - SPACE * 4}
          y2={layout.systems[cursor.systemIndex].staffTop + STAFF_HEIGHT + SPACE * 2}
          stroke="var(--accent)"
          strokeWidth={2}
          opacity={0.85}
        />
      )}
    </svg>
  )
}
