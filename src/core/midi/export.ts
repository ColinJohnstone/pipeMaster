import type { Score } from '../model/types'
import { timeSigForBar } from '../model/types'
import { beats, isCompound } from '../duration'
import type { Pitch } from '../pitch'
import { expandEmbellishment } from '../embellishments/registry'
import { playOrder } from '../../audio/player'

/**
 * Standard MIDI File (format 0) export. The note grid comes straight from the
 * playback expansion (repeats and voltas honoured); a drone can be layered on
 * a second channel. Pitch mapping models the GHB's A-mixolydian scale.
 */

const TPQ = 480 // ticks per quarter note

/** Semitone offset of each written pitch from Low A (C and F are sharp). */
const SEMITONE_FROM_LOW_A: Record<Pitch, number> = {
  LowG: -2,
  LowA: 0,
  B: 2,
  C: 4,
  D: 5,
  E: 7,
  F: 9,
  HighG: 10,
  HighA: 12,
}

// Pipes sound near B-flat; place written Low A at B-flat 4 (MIDI 70).
const LOW_A_MIDI = 70

function midiNote(pitch: Pitch): number {
  return LOW_A_MIDI + SEMITONE_FROM_LOW_A[pitch]
}

interface RawEvent {
  tick: number
  durTicks: number
  note: number
  velocity: number
  channel: number
}

/** Gracenotes occupy a small fixed slice of a quarter, stolen from the note. */
const GRACE_TICKS = Math.round(TPQ / 8)

function scoreToEvents(score: Score): { events: RawEvent[]; endTick: number } {
  const events: RawEvent[] = []
  let tick = 0

  // Flatten the play order into a single note stream so ties can be merged.
  const flat = playOrder(score).flatMap(([pi, bi]) => score.parts[pi].bars[bi].notes)

  for (let i = 0; i < flat.length; i++) {
    const note = flat[i]
    let total = Math.round(beats(note.duration) * TPQ)

    // Merge a run of same-pitch tied notes into one sustained note: the tie
    // absorbs the followers' durations and suppresses their re-articulation.
    let j = i
    while (flat[j].tieToNext && flat[j + 1] && flat[j + 1].pitch === note.pitch) {
      total += Math.round(beats(flat[j + 1].duration) * TPQ)
      j++
    }

    const graces = expandEmbellishment(note.embellishment, note.pitch)
    const graceSpan = Math.min(graces.length * GRACE_TICKS, Math.max(0, total - TPQ / 8))
    const per = graces.length > 0 ? Math.floor(graceSpan / graces.length) : 0
    graces.forEach((g, gi) => {
      events.push({
        tick: tick + gi * per,
        durTicks: Math.max(1, per - 2),
        note: midiNote(g),
        velocity: 74,
        channel: 0,
      })
    })
    events.push({
      tick: tick + graceSpan,
      durTicks: Math.max(1, total - graceSpan - 2),
      note: midiNote(note.pitch),
      velocity: 92,
      channel: 0,
    })
    tick += total
    i = j // skip the notes we merged
  }
  return { events, endTick: tick }
}

// -- Byte helpers ------------------------------------------------------------

function varLen(value: number): number[] {
  const bytes = [value & 0x7f]
  let v = value >> 7
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80)
    v >>= 7
  }
  return bytes
}

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff]
const u32 = (n: number) => [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]

function chunk(id: string, data: number[]): number[] {
  return [...id.split('').map((c) => c.charCodeAt(0)), ...u32(data.length), ...data]
}

export function exportMidi(score: Score, opts: { drone?: boolean } = {}): Uint8Array {
  const { events, endTick } = scoreToEvents(score)

  if (opts.drone && endTick > 0) {
    // A sustained Low-A drone (two octaves) under the whole tune.
    for (const n of [midiNote('LowA') - 24, midiNote('LowA') - 12]) {
      events.push({ tick: 0, durTicks: endTick, note: n, velocity: 55, channel: 1 })
    }
  }

  // Turn note events into an ordered on/off stream.
  interface TimedMsg {
    tick: number
    bytes: number[]
    order: number
  }
  const msgs: TimedMsg[] = []
  events.forEach((e, i) => {
    msgs.push({ tick: e.tick, order: i * 2 + 1, bytes: [0x90 | e.channel, e.note, e.velocity] })
    msgs.push({
      tick: e.tick + e.durTicks,
      order: i * 2,
      bytes: [0x80 | e.channel, e.note, 0],
    })
  })
  // Note-offs before note-ons at the same tick to avoid clipping repeats.
  msgs.sort((a, b) => a.tick - b.tick || a.order - b.order)

  const track: number[] = []

  // Tempo meta: quarter-note BPM (compound time counts dotted crotchets).
  const ts0 = timeSigForBar(score, 0, 0)
  const quarterBpm = score.tempo * (isCompound(ts0) ? 1.5 : 1)
  const usPerQuarter = Math.round(60_000_000 / quarterBpm)
  track.push(0x00, 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff)

  // Time signature meta.
  const denomPow = Math.round(Math.log2(ts0.unit))
  track.push(0x00, 0xff, 0x58, 0x04, ts0.beats, denomPow, 24, 8)

  // Track name.
  const name = [...score.title].map((c) => c.charCodeAt(0) & 0x7f)
  track.push(0x00, 0xff, 0x03, ...varLen(name.length), ...name)

  let prevTick = 0
  for (const m of msgs) {
    track.push(...varLen(m.tick - prevTick), ...m.bytes)
    prevTick = m.tick
  }
  track.push(0x00, 0xff, 0x2f, 0x00) // end of track

  const header = chunk('MThd', [...u16(0), ...u16(1), ...u16(TPQ)])
  const trackChunk = chunk('MTrk', track)
  return new Uint8Array([...header, ...trackChunk])
}
