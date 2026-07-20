import { create } from 'zustand'
import {
  applyPatches,
  enablePatches,
  produceWithPatches,
  type Patch,
} from 'immer'
import type { Score, NoteAddress } from '../core/model/types'
import { getNote } from '../core/model/types'
import {
  createBar,
  createDemoScore,
  createEmptyScore,
  createNote,
  createPart,
} from '../core/model/create'
import type { Duration, TimeSig } from '../core/duration'
import { beats } from '../core/duration'
import type { Pitch } from '../core/pitch'
import { pitchAbove, pitchBelow } from '../core/pitch'
import type { EmbellishmentType } from '../core/embellishments/registry'
import { reflowPart } from '../core/model/reflow'
import { embellishmentDef } from '../core/embellishments/registry'

enablePatches()

interface HistoryEntry {
  redo: Patch[]
  undo: Patch[]
}

export interface EditorState {
  score: Score
  selection: NoteAddress | null
  /** Duration applied to newly entered notes. */
  entryDuration: Duration
  undoStack: HistoryEntry[]
  redoStack: HistoryEntry[]
  dirtySince: number

  setSelection(sel: NoteAddress | null): void
  setEntryDuration(d: Duration): void

  newScore(): void
  loadScore(score: Score): void

  insertNote(partIndex: number, barIndex: number, noteIndex: number, pitch: Pitch): void
  insertNoteWithEmbellishment(
    partIndex: number,
    barIndex: number,
    noteIndex: number,
    pitch: Pitch,
    type: EmbellishmentType,
  ): void
  setPitch(addr: NoteAddress, pitch: Pitch): void
  stepPitch(addr: NoteAddress, dir: 1 | -1): void
  setNoteDuration(addr: NoteAddress, base: Duration['base']): void
  toggleDot(addr: NoteAddress): void
  toggleTie(addr: NoteAddress): void
  setEmbellishment(addr: NoteAddress, type: EmbellishmentType | null): void
  deleteNote(addr: NoteAddress): void

  addBar(partIndex: number, barIndex: number): void
  deleteBar(partIndex: number, barIndex: number): void
  addPart(): void
  deletePart(partIndex: number): void
  toggleRepeat(partIndex: number, barIndex: number, side: 'start' | 'end'): void
  setVolta(partIndex: number, barIndex: number, volta: 1 | 2 | null): void
  insertPickupBar(partIndex: number, barIndex: number): void
  togglePickup(partIndex: number, barIndex: number): void

  setMeta(meta: Partial<Pick<Score, 'title' | 'tuneType' | 'composer' | 'tempo'>>): void
  setTimeSig(ts: TimeSig): void

  undo(): void
  redo(): void
}

const MAX_HISTORY = 200

export const useStore = create<EditorState>((set, get) => {
  /** Run an edit against the score, recording history patches. */
  function apply(recipe: (draft: Score) => void, selection?: NoteAddress | null) {
    const { score, undoStack } = get()
    const [next, redo, undo] = produceWithPatches(score, recipe)
    if (redo.length === 0) return
    set({
      score: next,
      undoStack: [...undoStack.slice(-MAX_HISTORY + 1), { redo, undo }],
      redoStack: [],
      dirtySince: Date.now(),
      ...(selection !== undefined ? { selection } : {}),
    })
  }

  /**
   * Insert a note object at a position, reflow the part so a full bar spills
   * into the next one, then select the note at wherever it ended up.
   */
  function insertNoteObj(
    partIndex: number,
    barIndex: number,
    noteIndex: number,
    note: ReturnType<typeof createNote>,
  ) {
    apply((d) => {
      const bar = d.parts[partIndex]?.bars[barIndex]
      if (!bar) return
      const idx = Math.min(noteIndex, bar.notes.length)
      bar.notes.splice(idx, 0, note)
      reflowPart(d, partIndex, barIndex)
    })
    const bars = get().score.parts[partIndex]?.bars ?? []
    for (let bi = barIndex; bi < bars.length; bi++) {
      const ni = bars[bi].notes.findIndex((n) => n.id === note.id)
      if (ni >= 0) {
        set({ selection: { partIndex, barIndex: bi, noteIndex: ni } })
        return
      }
    }
  }

  return {
    score: createDemoScore(),
    selection: null,
    entryDuration: { base: 4, dots: 0 },
    undoStack: [],
    redoStack: [],
    dirtySince: 0,

    setSelection: (selection) => set({ selection }),
    setEntryDuration: (entryDuration) => set({ entryDuration }),

    newScore: () =>
      set({
        score: createEmptyScore(),
        selection: null,
        undoStack: [],
        redoStack: [],
        dirtySince: Date.now(),
      }),

    loadScore: (score) =>
      set({ score, selection: null, undoStack: [], redoStack: [], dirtySince: Date.now() }),

    insertNote: (partIndex, barIndex, noteIndex, pitch) => {
      const { entryDuration } = get()
      insertNoteObj(partIndex, barIndex, noteIndex, createNote(pitch, { ...entryDuration }))
    },

    insertNoteWithEmbellishment: (partIndex, barIndex, noteIndex, pitch, type) => {
      const { entryDuration } = get()
      // Only attach the embellishment if it's valid on this pitch.
      const valid = embellishmentDef(type).expand(pitch) !== null
      insertNoteObj(
        partIndex,
        barIndex,
        noteIndex,
        createNote(pitch, { ...entryDuration }, valid ? type : undefined),
      )
    },

    setPitch: (addr, pitch) =>
      apply((d) => {
        const n = getNote(d, addr)
        if (n) n.pitch = pitch
      }),

    stepPitch: (addr, dir) =>
      apply((d) => {
        const n = getNote(d, addr)
        if (!n) return
        const next = dir === 1 ? pitchAbove(n.pitch) : pitchBelow(n.pitch)
        if (next) n.pitch = next
      }),

    setNoteDuration: (addr, base) =>
      apply((d) => {
        const n = getNote(d, addr)
        if (!n) return
        n.duration = { base, dots: n.duration.dots }
        // A longer note may now overflow its bar.
        reflowPart(d, addr.partIndex, addr.barIndex)
      }),

    toggleDot: (addr) =>
      apply((d) => {
        const n = getNote(d, addr)
        if (!n) return
        n.duration = { ...n.duration, dots: n.duration.dots === 0 ? 1 : 0 }
        reflowPart(d, addr.partIndex, addr.barIndex)
      }),

    toggleTie: (addr) =>
      apply((d) => {
        const n = getNote(d, addr)
        if (n) n.tieToNext = !n.tieToNext
      }),

    setEmbellishment: (addr, type) =>
      apply((d) => {
        const n = getNote(d, addr)
        if (!n) return
        if (type === null) {
          delete n.embellishment
          return
        }
        // Ignore embellishments that don't exist on this melody pitch.
        if (embellishmentDef(type).expand(n.pitch) === null) return
        if (n.embellishment?.type === type) delete n.embellishment
        else n.embellishment = { type }
      }),

    deleteNote: (addr) => {
      const { score } = get()
      const bar = score.parts[addr.partIndex]?.bars[addr.barIndex]
      if (!bar || !bar.notes[addr.noteIndex]) return
      const nextSel: NoteAddress | null =
        bar.notes.length > 1
          ? { ...addr, noteIndex: Math.max(0, addr.noteIndex - 1) }
          : null
      apply((d) => {
        d.parts[addr.partIndex].bars[addr.barIndex].notes.splice(addr.noteIndex, 1)
      }, nextSel)
    },

    addBar: (partIndex, barIndex) =>
      apply((d) => {
        d.parts[partIndex]?.bars.splice(barIndex + 1, 0, createBar())
      }),

    deleteBar: (partIndex, barIndex) =>
      apply(
        (d) => {
          const part = d.parts[partIndex]
          if (!part) return
          part.bars.splice(barIndex, 1)
          if (part.bars.length === 0) part.bars.push(createBar())
        },
        null,
      ),

    addPart: () =>
      apply((d) => {
        d.parts.push(createPart(4))
      }),

    deletePart: (partIndex) =>
      apply(
        (d) => {
          if (d.parts.length <= 1) return
          d.parts.splice(partIndex, 1)
        },
        null,
      ),

    toggleRepeat: (partIndex, barIndex, side) =>
      apply((d) => {
        const bar = d.parts[partIndex]?.bars[barIndex]
        if (!bar) return
        if (side === 'start') bar.repeatStart = !bar.repeatStart
        else bar.repeatEnd = !bar.repeatEnd
      }),

    setVolta: (partIndex, barIndex, volta) =>
      apply((d) => {
        const bar = d.parts[partIndex]?.bars[barIndex]
        if (!bar) return
        if (volta === null) delete bar.volta
        else bar.volta = volta
      }),

    insertPickupBar: (partIndex, barIndex) => {
      const cap = beats(get().entryDuration)
      const newBar = createBar()
      newBar.pickup = cap
      apply((d) => {
        const part = d.parts[partIndex]
        if (!part) return
        part.bars.splice(barIndex, 0, newBar)
      })
      // Select the new (empty) pickup bar so the next click lands in it.
      const bars = get().score.parts[partIndex]?.bars ?? []
      const bi = bars.findIndex((b) => b.id === newBar.id)
      if (bi >= 0) set({ selection: { partIndex, barIndex: bi, noteIndex: 0 } })
    },

    togglePickup: (partIndex, barIndex) =>
      apply((d) => {
        const bar = d.parts[partIndex]?.bars[barIndex]
        if (!bar) return
        if (bar.pickup !== undefined) {
          delete bar.pickup
          return
        }
        // Seal at the bar's current content, or one entry-note if it's empty.
        const used = bar.notes.reduce((a, n) => a + beats(n.duration), 0)
        bar.pickup = used > 0 ? used : beats(get().entryDuration)
        reflowPart(d, partIndex, barIndex)
      }),

    setMeta: (meta) =>
      apply((d) => {
        Object.assign(d, meta)
      }),

    setTimeSig: (ts) =>
      apply((d) => {
        d.timeSig = ts
      }),

    undo: () => {
      const { undoStack, redoStack, score } = get()
      const entry = undoStack[undoStack.length - 1]
      if (!entry) return
      set({
        score: applyPatches(score, entry.undo),
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, entry],
        selection: null,
        dirtySince: Date.now(),
      })
    },

    redo: () => {
      const { undoStack, redoStack, score } = get()
      const entry = redoStack[redoStack.length - 1]
      if (!entry) return
      set({
        score: applyPatches(score, entry.redo),
        undoStack: [...undoStack, entry],
        redoStack: redoStack.slice(0, -1),
        selection: null,
        dirtySince: Date.now(),
      })
    },
  }
})
