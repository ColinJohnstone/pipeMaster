import React from 'react'
import { useStore } from './state/store'
import { ScoreView, type CursorPos, type DropTarget } from './render/ScoreView'
import type { NoteAddress, Score } from './core/model/types'
import { getNote } from './core/model/types'
import type { Duration } from './core/duration'
import type { EmbellishmentType } from './core/embellishments/registry'
import { PITCH_LABELS, LOW_A_HZ } from './core/pitch'
import { EmbellishmentGrid } from './editor/EmbellishmentGrid'
import { PhotoImport } from './editor/PhotoImport'
import { player } from './audio/player'
import {
  downloadBww,
  downloadMidi,
  downloadMusicXml,
  downloadScore,
  loadAutosave,
  pickScoreFile,
  saveAutosave,
} from './persistence/idb'
import { MARGIN_X, type ScoreLayout } from './layout/layout'

// Bravura single-note glyphs for the duration palette.
const DURATION_GLYPHS: Array<{ base: Duration['base']; code: number; name: string }> = [
  { base: 1, code: 0xe1d2, name: 'Semibreve' },
  { base: 2, code: 0xe1d3, name: 'Minim' },
  { base: 4, code: 0xe1d5, name: 'Crotchet' },
  { base: 8, code: 0xe1d7, name: 'Quaver' },
  { base: 16, code: 0xe1d9, name: 'Semiquaver' },
  { base: 32, code: 0xe1db, name: 'Demisemiquaver' },
]

const TIME_SIGS = ['2/4', '3/4', '4/4', '5/4', '6/8', '9/8', '12/8', '2/2'] as const

function nextAddr(score: Score, addr: NoteAddress, dir: 1 | -1): NoteAddress | null {
  let { partIndex, barIndex, noteIndex } = addr
  noteIndex += dir
  for (;;) {
    const part = score.parts[partIndex]
    if (!part) return null
    const bar = part.bars[barIndex]
    if (bar && noteIndex >= 0 && noteIndex < bar.notes.length) {
      return { partIndex, barIndex, noteIndex }
    }
    if (dir === 1) {
      barIndex++
      if (barIndex >= part.bars.length) {
        partIndex++
        barIndex = 0
      }
      noteIndex = 0
    } else {
      barIndex--
      if (barIndex < 0) {
        partIndex--
        if (partIndex < 0) return null
        barIndex = score.parts[partIndex].bars.length - 1
      }
      noteIndex = (score.parts[partIndex]?.bars[barIndex]?.notes.length ?? 0) - 1
      if (noteIndex < 0) continue
    }
    if (partIndex >= score.parts.length) return null
  }
}

export default function App() {
  const s = useStore()
  const [instrument, setInstrument] = React.useState<'pipes' | 'practiceChanter'>('pipes')
  const [dronesOn, setDronesOn] = React.useState(true)
  const [metronome, setMetronome] = React.useState(false)
  const [countIn, setCountIn] = React.useState(false)
  const [isPlaying, setIsPlaying] = React.useState(false)
  const [playingAddr, setPlayingAddr] = React.useState<NoteAddress | null>(null)
  const [showPhotoImport, setShowPhotoImport] = React.useState(false)
  const layoutRef = React.useRef<ScoreLayout | null>(null)

  const selectedNote = s.selection ? getNote(s.score, s.selection) : undefined

  // Load autosaved work once on startup.
  React.useEffect(() => {
    loadAutosave().then((saved) => {
      if (saved) useStore.getState().loadScore(saved)
    })
  }, [])

  // Debounced autosave.
  React.useEffect(() => {
    if (s.dirtySince === 0) return
    const t = setTimeout(() => saveAutosave(useStore.getState().score), 600)
    return () => clearTimeout(t)
  }, [s.score, s.dirtySince])

  const stopPlayback = React.useCallback(() => {
    // Drones sound only while a tune is playing — stop everything.
    player.stopAll()
    setIsPlaying(false)
    setPlayingAddr(null)
  }, [])

  const startPlayback = React.useCallback(() => {
    player.start(
      useStore.getState().score,
      { lowA: LOW_A_HZ[instrument], dronesOn, metronome, countIn },
      setPlayingAddr,
      () => {
        player.stopDrones()
        setIsPlaying(false)
        setPlayingAddr(null)
      },
    )
    setIsPlaying(true)
  }, [instrument, dronesOn, metronome, countIn])

  const toggleDrones = () => {
    const next = !dronesOn
    setDronesOn(next)
    // If a tune is playing, add or remove the drones live.
    if (isPlaying) {
      if (next) player.startDrones(LOW_A_HZ[instrument])
      else player.stopDrones()
    }
  }

  // A palette item dropped on the staff: insert a note of that length, or
  // apply an embellishment (to the note under the pointer, else a new note).
  const handleStaffDrop = React.useCallback(
    (target: DropTarget, payload: string) => {
      let data: { kind: string; base?: Duration['base']; type?: EmbellishmentType }
      try {
        data = JSON.parse(payload)
      } catch {
        return
      }
      const st = useStore.getState()
      if (data.kind === 'note' && data.base) {
        st.setEntryDuration({ base: data.base, dots: 0 })
        st.insertNote(target.partIndex, target.barIndex, target.index, target.pitch)
      } else if (data.kind === 'emb' && data.type) {
        if (target.noteIndex !== undefined) {
          st.setEmbellishment(
            { partIndex: target.partIndex, barIndex: target.barIndex, noteIndex: target.noteIndex },
            data.type,
          )
        } else {
          st.insertNoteWithEmbellishment(
            target.partIndex,
            target.barIndex,
            target.index,
            target.pitch,
            data.type,
          )
        }
      }
    },
    [],
  )

  // Keyboard shortcuts.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return
      }
      const st = useStore.getState()
      const sel = st.selection
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) st.redo()
        else st.undo()
        return
      }
      if (e.key === ' ') {
        e.preventDefault()
        if (player.playing) stopPlayback()
        else startPlayback()
        return
      }
      if (e.key === 'Escape') {
        st.setSelection(null)
        return
      }
      if (!sel) return
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          st.stepPitch(sel, 1)
          break
        case 'ArrowDown':
          e.preventDefault()
          st.stepPitch(sel, -1)
          break
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault()
          const n = nextAddr(st.score, sel, e.key === 'ArrowRight' ? 1 : -1)
          if (n) st.setSelection(n)
          break
        }
        case 'Delete':
        case 'Backspace':
        case 'x':
          st.deleteNote(sel)
          break
        case '1':
          st.setNoteDuration(sel, 1)
          break
        case '2':
          st.setNoteDuration(sel, 2)
          break
        case '3':
          st.setNoteDuration(sel, 4)
          break
        case '4':
          st.setNoteDuration(sel, 8)
          break
        case '5':
          st.setNoteDuration(sel, 16)
          break
        case '6':
          st.setNoteDuration(sel, 32)
          break
        case '.':
          st.toggleDot(sel)
          break
        case 't':
          st.toggleTie(sel)
          break
        case 'g':
          st.setEmbellishment(sel, 'gGrace')
          break
        case 'e':
          st.setEmbellishment(sel, 'eGrace')
          break
        case 'd':
          st.setEmbellishment(sel, 'doubling')
          break
        case 's':
          st.setEmbellishment(sel, 'strike')
          break
        case 'b':
          st.setEmbellishment(sel, 'birl')
          break
        case 'r':
          st.setEmbellishment(sel, 'grip')
          break
        case 'l':
          st.setEmbellishment(sel, 'taorluath')
          break
        case 'w':
          st.setEmbellishment(sel, 'throwD')
          break
        case '0':
          st.setEmbellishment(sel, null)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [startPlayback, stopPlayback])

  // Map the sounding note to a cursor line position in the layout.
  const cursor: CursorPos | null = React.useMemo(() => {
    if (!playingAddr || !layoutRef.current) return null
    const layout = layoutRef.current
    for (let si = 0; si < layout.systems.length; si++) {
      for (const bar of layout.systems[si].bars) {
        if (bar.partIndex === playingAddr.partIndex && bar.barIndex === playingAddr.barIndex) {
          const ln = bar.notes[playingAddr.noteIndex]
          if (ln) return { systemIndex: si, x: MARGIN_X + bar.x + ln.x }
        }
      }
    }
    return null
  }, [playingAddr])

  const parseTs = (v: string) => {
    const [a, b] = v.split('/').map(Number)
    s.setTimeSig({ beats: a, unit: b as 2 | 4 | 8 })
  }
  const tsValue = `${s.score.timeSig.beats}/${s.score.timeSig.unit}`

  const selBar = s.selection
    ? s.score.parts[s.selection.partIndex]?.bars[s.selection.barIndex]
    : undefined

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          pipe<span>Master</span>
        </div>
        <div className="tb-group">
          <button onClick={() => { stopPlayback(); s.newScore() }}>New</button>
          <button
            onClick={async () => {
              const opened = await pickScoreFile()
              if (opened) {
                stopPlayback()
                s.loadScore(opened.score)
                if (opened.warnings.length > 0) {
                  alert(
                    `Imported with ${opened.warnings.length} warning(s):\n\n${opened.warnings
                      .slice(0, 12)
                      .join('\n')}${opened.warnings.length > 12 ? '\n…' : ''}`,
                  )
                }
              }
            }}
          >
            Open
          </button>
          <button onClick={() => setShowPhotoImport(true)} title="Import from a photo of sheet music">
            📷 Photo
          </button>
          <button onClick={() => downloadScore(s.score)}>Save</button>
          <select
            value=""
            title="Export"
            onChange={(e) => {
              switch (e.target.value) {
                case 'bww':
                  downloadBww(s.score)
                  break
                case 'midi':
                  downloadMidi(s.score)
                  break
                case 'musicxml':
                  downloadMusicXml(s.score)
                  break
                case 'pdf':
                  window.print()
                  break
              }
              e.currentTarget.value = ''
            }}
          >
            <option value="">Export…</option>
            <option value="bww">Bagpipe Music Writer (.bww)</option>
            <option value="musicxml">MusicXML (.musicxml)</option>
            <option value="midi">MIDI (.mid)</option>
            <option value="pdf">Print / PDF</option>
          </select>
        </div>
        <div className="tb-group">
          <button onClick={s.undo} disabled={s.undoStack.length === 0} title="Undo (⌘Z)">
            ↩ Undo
          </button>
          <button onClick={s.redo} disabled={s.redoStack.length === 0} title="Redo (⌘⇧Z)">
            ↪ Redo
          </button>
        </div>
        <div className="tb-group">
          <button
            className={isPlaying ? 'playing' : 'primary'}
            onClick={() => (isPlaying ? stopPlayback() : startPlayback())}
            title="Play/Stop (Space)"
          >
            {isPlaying ? '■ Stop' : '▶ Play'}
          </button>
          <button className={dronesOn ? 'active' : ''} onClick={toggleDrones} title="Toggle drones">
            Drones
          </button>
          <button
            className={metronome ? 'active' : ''}
            onClick={() => setMetronome((m) => !m)}
            title="Metronome click on each beat"
          >
            Metro
          </button>
          <button
            className={countIn ? 'active' : ''}
            onClick={() => setCountIn((c) => !c)}
            title="One bar of clicks before playback"
          >
            Count-in
          </button>
          <select
            value={instrument}
            onChange={(e) => setInstrument(e.target.value as 'pipes' | 'practiceChanter')}
            title="Instrument"
          >
            <option value="pipes">Highland pipes</option>
            <option value="practiceChanter">Practice chanter</option>
          </select>
          <input
            className="tempo"
            type="number"
            min={40}
            max={200}
            value={s.score.tempo}
            onChange={(e) => s.setMeta({ tempo: Number(e.target.value) || 80 })}
            title="Tempo (BPM)"
          />
        </div>
        <div className="spacer" />
        <div className="tb-group">
          <select value={tsValue} onChange={(e) => parseTs(e.target.value)} title="Time signature">
            {TIME_SIGS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="body">
        <div className="sidebar">
          <div className="side-section">
            <h3>Note length</h3>
            <div className="palette">
              {DURATION_GLYPHS.map((d) => (
                <button
                  key={d.base}
                  className={`glyph${s.entryDuration.base === d.base && (!selectedNote || selectedNote.duration.base === d.base) ? ' active' : ''}`}
                  title={`${d.name} — drag onto the staff, or click then click the staff`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      'application/x-pm',
                      JSON.stringify({ kind: 'note', base: d.base }),
                    )
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => {
                    s.setEntryDuration({ base: d.base, dots: 0 })
                    if (s.selection) s.setNoteDuration(s.selection, d.base)
                  }}
                >
                  {String.fromCodePoint(d.code)}
                </button>
              ))}
              <button
                title="Dotted (.)"
                className={selectedNote && selectedNote.duration.dots > 0 ? 'active' : ''}
                disabled={!s.selection}
                onClick={() => s.selection && s.toggleDot(s.selection)}
              >
                •
              </button>
              <button
                title="Tie to next note (t)"
                className={selectedNote?.tieToNext ? 'active' : ''}
                disabled={!s.selection}
                onClick={() => s.selection && s.toggleTie(s.selection)}
              >
                ⌢ Tie
              </button>
            </div>
          </div>

          <div className="side-section">
            <EmbellishmentGrid
              selectedNote={selectedNote}
              onApply={(type) => s.selection && s.setEmbellishment(s.selection, type)}
              onClear={() => s.selection && s.setEmbellishment(s.selection, null)}
            />
          </div>

          <div className="side-section">
            <h3>Bars &amp; parts</h3>
            <div className="palette">
              <button
                onClick={() =>
                  s.addBar(
                    s.selection?.partIndex ?? s.score.parts.length - 1,
                    s.selection?.barIndex ?? s.score.parts[s.score.parts.length - 1].bars.length - 1,
                  )
                }
              >
                + Bar
              </button>
              <button
                disabled={!s.selection}
                onClick={() => s.selection && s.deleteBar(s.selection.partIndex, s.selection.barIndex)}
              >
                − Bar
              </button>
              <button onClick={s.addPart}>+ Part</button>
              <button
                disabled={s.score.parts.length <= 1 || !s.selection}
                onClick={() => s.selection && s.deletePart(s.selection.partIndex)}
              >
                − Part
              </button>
            </div>
          </div>

          <div className="side-section">
            <h3>Repeats &amp; endings</h3>
            <div className="palette">
              <button
                disabled={!s.selection}
                className={selBar?.repeatStart ? 'active' : ''}
                title="Start repeat on this bar"
                onClick={() =>
                  s.selection && s.toggleRepeat(s.selection.partIndex, s.selection.barIndex, 'start')
                }
              >
                ‖: Start
              </button>
              <button
                disabled={!s.selection}
                className={selBar?.repeatEnd ? 'active' : ''}
                title="End repeat on this bar"
                onClick={() =>
                  s.selection && s.toggleRepeat(s.selection.partIndex, s.selection.barIndex, 'end')
                }
              >
                End :‖
              </button>
              <button
                disabled={!s.selection}
                className={selBar?.volta === 1 ? 'active' : ''}
                title="Mark as 1st ending"
                onClick={() =>
                  s.selection &&
                  s.setVolta(
                    s.selection.partIndex,
                    s.selection.barIndex,
                    selBar?.volta === 1 ? null : 1,
                  )
                }
              >
                1st ending
              </button>
              <button
                disabled={!s.selection}
                className={selBar?.volta === 2 ? 'active' : ''}
                title="Mark as 2nd ending"
                onClick={() =>
                  s.selection &&
                  s.setVolta(
                    s.selection.partIndex,
                    s.selection.barIndex,
                    selBar?.volta === 2 ? null : 2,
                  )
                }
              >
                2nd ending
              </button>
            </div>
          </div>

          <div className="side-section">
            <h3>Tune details</h3>
            <div className="meta-grid">
              <label>
                Title
                <input value={s.score.title} onChange={(e) => s.setMeta({ title: e.target.value })} />
              </label>
              <label>
                Type
                <input
                  value={s.score.tuneType}
                  onChange={(e) => s.setMeta({ tuneType: e.target.value })}
                  placeholder="March, Reel…"
                />
              </label>
              <label>
                Composer
                <input
                  value={s.score.composer}
                  onChange={(e) => s.setMeta({ composer: e.target.value })}
                />
              </label>
            </div>
          </div>
        </div>

        <div className="score-area">
          <div className="score-page">
            <ScoreView
              score={s.score}
              selection={s.selection}
              onSelectNote={s.setSelection}
              onInsertNote={s.insertNote}
              onBackgroundClick={() => s.setSelection(null)}
              onStaffDrop={handleStaffDrop}
              cursor={cursor}
              layoutOut={(l) => {
                layoutRef.current = l
              }}
            />
          </div>
        </div>
      </div>

      {showPhotoImport && (
        <PhotoImport
          timeSig={s.score.timeSig}
          onImport={(score) => {
            stopPlayback()
            s.loadScore(score)
          }}
          onClose={() => setShowPhotoImport(false)}
        />
      )}

      <div className="statusbar">
        <span>
          {selectedNote
            ? `${PITCH_LABELS[selectedNote.pitch]} — bar ${(s.selection?.barIndex ?? 0) + 1}, part ${(s.selection?.partIndex ?? 0) + 1}`
            : 'Click the staff to add notes; click a note to select it'}
        </span>
        <span className="spacer" />
        <span>
          <kbd>↑↓</kbd> pitch <kbd>←→</kbd> select <kbd>1–6</kbd> length <kbd>.</kbd> dot{' '}
          <kbd>d</kbd> doubling <kbd>g</kbd>/<kbd>e</kbd> grace <kbd>s</kbd> strike <kbd>b</kbd>{' '}
          birl <kbd>r</kbd> grip <kbd>l</kbd> taorluath <kbd>w</kbd> throw <kbd>0</kbd> clear{' '}
          <kbd>Space</kbd> play
        </span>
      </div>
    </div>
  )
}
