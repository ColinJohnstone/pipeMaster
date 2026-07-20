import { describe, expect, it, beforeEach } from 'vitest'
import { useStore } from '../src/state/store'
import { createDemoScore } from '../src/core/model/create'

const st = () => useStore.getState()

function loadFresh() {
  st().loadScore(createDemoScore())
}

describe('clipboard and range editing (store)', () => {
  beforeEach(loadFresh)

  it('copies a single note and pastes a duplicate after it', () => {
    st().setSelection({ partIndex: 0, barIndex: 0, noteIndex: 0 })
    const total = (p = 0) =>
      st().score.parts[p].bars.reduce((a, b) => a + b.notes.length, 0)
    const before = total()
    const pitch = st().score.parts[0].bars[0].notes[0].pitch
    st().copySelection()
    st().pasteClipboard()
    // One more note in the part (bar 0 is full, so reflow may spill it onward).
    expect(total()).toBe(before + 1)
    // The pasted note sits right after the original, same pitch, new id.
    expect(st().score.parts[0].bars[0].notes[1].pitch).toBe(pitch)
    expect(st().score.parts[0].bars[0].notes[1].id).not.toBe(
      st().score.parts[0].bars[0].notes[0].id,
    )
  })

  it('copies a multi-note range and pastes all of them', () => {
    st().setSelection({ partIndex: 0, barIndex: 0, noteIndex: 0 })
    st().selectRangeTo({ partIndex: 0, barIndex: 0, noteIndex: 2 }) // 3 notes
    st().copySelection()
    expect(st().clipboard?.length).toBe(3)
    const partNotesBefore = st().score.parts[0].bars.reduce((a, b) => a + b.notes.length, 0)
    st().pasteClipboard()
    const partNotesAfter = st().score.parts[0].bars.reduce((a, b) => a + b.notes.length, 0)
    expect(partNotesAfter).toBe(partNotesBefore + 3)
  })

  it('cut removes the range and keeps it on the clipboard', () => {
    st().setSelection({ partIndex: 0, barIndex: 0, noteIndex: 0 })
    st().selectRangeTo({ partIndex: 0, barIndex: 0, noteIndex: 1 }) // 2 notes
    const before = st().score.parts[0].bars[0].notes.length
    st().cutSelection()
    expect(st().clipboard?.length).toBe(2)
    expect(st().score.parts[0].bars[0].notes.length).toBe(before - 2)
  })

  it('deleteSelection removes a whole range at once', () => {
    st().setSelection({ partIndex: 0, barIndex: 0, noteIndex: 0 })
    st().selectRangeTo({ partIndex: 0, barIndex: 0, noteIndex: 2 })
    st().deleteSelection()
    expect(st().score.parts[0].bars[0].notes.length).toBe(2) // demo bar 0 had 5 notes
  })

  it('duplicatePart inserts a copy right after', () => {
    const parts = st().score.parts.length
    const firstBarNotes = st().score.parts[0].bars[0].notes.map((n) => n.pitch)
    st().duplicatePart(0)
    expect(st().score.parts.length).toBe(parts + 1)
    // The copy matches the original pitch-for-pitch but has fresh ids.
    expect(st().score.parts[1].bars[0].notes.map((n) => n.pitch)).toEqual(firstBarNotes)
    expect(st().score.parts[1].id).not.toBe(st().score.parts[0].id)
  })

  it('undo reverses a paste', () => {
    st().setSelection({ partIndex: 0, barIndex: 0, noteIndex: 0 })
    const before = st().score.parts[0].bars[0].notes.length
    st().copySelection()
    st().pasteClipboard()
    st().undo()
    expect(st().score.parts[0].bars[0].notes.length).toBe(before)
  })
})
