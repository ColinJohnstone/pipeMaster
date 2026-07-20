import { describe, expect, it } from 'vitest'
import { rangeAddresses, partNoteAddresses, stepAddress, addrKey } from '../src/core/model/range'
import { createDemoScore } from '../src/core/model/create'

const demo = createDemoScore()

describe('range helpers', () => {
  it('lists every note address in a part in reading order', () => {
    const addrs = partNoteAddresses(demo, 0)
    const total = demo.parts[0].bars.reduce((a, b) => a + b.notes.length, 0)
    expect(addrs.length).toBe(total)
    // First address is bar 0, note 0.
    expect(addrs[0]).toEqual({ partIndex: 0, barIndex: 0, noteIndex: 0 })
  })

  it('builds an inclusive range spanning bars', () => {
    const anchor = { partIndex: 0, barIndex: 0, noteIndex: 0 }
    const focus = { partIndex: 0, barIndex: 1, noteIndex: 0 }
    const r = rangeAddresses(demo, anchor, focus)
    // All of bar 0 plus the first note of bar 1.
    expect(r.length).toBe(demo.parts[0].bars[0].notes.length + 1)
    expect(r[0]).toEqual(anchor)
    expect(r[r.length - 1]).toEqual(focus)
  })

  it('orders the range regardless of endpoint order', () => {
    const a = { partIndex: 0, barIndex: 1, noteIndex: 0 }
    const b = { partIndex: 0, barIndex: 0, noteIndex: 0 }
    const forward = rangeAddresses(demo, b, a)
    const backward = rangeAddresses(demo, a, b)
    expect(forward).toEqual(backward)
  })

  it('collapses a cross-part range to the focus', () => {
    const a = { partIndex: 0, barIndex: 0, noteIndex: 0 }
    const b = { partIndex: 1, barIndex: 0, noteIndex: 0 }
    expect(rangeAddresses(demo, a, b)).toEqual([b])
  })

  it('steps forward and backward through the reading order', () => {
    const first = { partIndex: 0, barIndex: 0, noteIndex: 0 }
    const next = stepAddress(demo, first, 1)
    expect(next).toBeTruthy()
    expect(stepAddress(demo, next!, -1)).toEqual(first)
    expect(stepAddress(demo, first, -1)).toBeNull()
  })

  it('produces stable keys', () => {
    expect(addrKey({ partIndex: 1, barIndex: 2, noteIndex: 3 })).toBe('1:2:3')
  })
})
