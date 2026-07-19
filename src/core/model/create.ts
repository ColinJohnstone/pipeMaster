import type { Bar, Note, Part, Score } from './types'
import { newId } from './types'
import type { Duration, TimeSig } from '../duration'
import type { Pitch } from '../pitch'
import type { EmbellishmentType } from '../embellishments/registry'

export function createNote(
  pitch: Pitch,
  duration: Duration,
  embellishment?: EmbellishmentType,
): Note {
  return {
    id: newId('n'),
    pitch,
    duration,
    ...(embellishment ? { embellishment: { type: embellishment } } : {}),
  }
}

export function createBar(notes: Note[] = []): Bar {
  return { id: newId('b'), notes }
}

export function createPart(barCount: number): Part {
  return {
    id: newId('p'),
    bars: Array.from({ length: barCount }, () => createBar()),
  }
}

export function createEmptyScore(opts?: Partial<Pick<Score, 'title' | 'tuneType' | 'composer' | 'timeSig' | 'tempo'>>): Score {
  return {
    version: 1,
    id: newId('score'),
    title: opts?.title ?? 'Untitled Tune',
    tuneType: opts?.tuneType ?? 'March',
    composer: opts?.composer ?? '',
    timeSig: opts?.timeSig ?? { beats: 4, unit: 4 },
    tempo: opts?.tempo ?? 80,
    parts: [createPart(4)],
  }
}

const q: Duration = { base: 4, dots: 0 }
const qd: Duration = { base: 4, dots: 1 }
const e: Duration = { base: 8, dots: 0 }
const s: Duration = { base: 16, dots: 0 }
const h: Duration = { base: 2, dots: 0 }

/** A demo tune exercising embellishments, dots, beams, repeats, and ties. */
export function createDemoScore(): Score {
  const ts: TimeSig = { beats: 4, unit: 4 }
  const part1: Part = {
    id: newId('p'),
    bars: [
      {
        id: newId('b'),
        repeatStart: true,
        notes: [
          createNote('LowA', q, 'gGrace'),
          createNote('B', e),
          createNote('C', e),
          createNote('D', q, 'doubling'),
          createNote('E', q, 'gGrace'),
        ],
      },
      {
        id: newId('b'),
        notes: [
          createNote('F', qd, 'doubling'),
          createNote('E', e),
          createNote('D', q, 'throwD'),
          createNote('B', q, 'gGrace'),
        ],
      },
      {
        id: newId('b'),
        notes: [
          createNote('E', e, 'grip'),
          createNote('D', e),
          createNote('C', e),
          createNote('B', e),
          createNote('LowA', q, 'birl'),
          createNote('LowA', q, 'dGrace'),
        ],
      },
      {
        id: newId('b'),
        repeatEnd: true,
        notes: [
          createNote('C', q, 'doubling'),
          createNote('B', e),
          createNote('LowA', e),
          { ...createNote('LowA', h, 'taorluath'), tieToNext: false },
        ],
      },
    ],
  }
  const part2: Part = {
    id: newId('p'),
    bars: [
      {
        id: newId('b'),
        notes: [
          createNote('HighA', q, 'thumbGrace'),
          createNote('HighG', e, 'doubling'),
          createNote('F', e),
          createNote('E', q, 'doubling'),
          createNote('D', s),
          createNote('C', s),
          createNote('B', s),
          createNote('LowA', s),
        ],
      },
      {
        id: newId('b'),
        notes: [
          createNote('B', q, 'bubbly'),
          createNote('C', e),
          createNote('D', e),
          createNote('E', q, 'pele'),
          createNote('F', q, 'eGrace'),
        ],
      },
      {
        id: newId('b'),
        notes: [
          createNote('HighG', q, 'doubling'),
          createNote('E', e),
          createNote('C', e),
          { ...createNote('D', q, 'gStrike'), tieToNext: true },
          createNote('D', q),
        ],
      },
      {
        id: newId('b'),
        notes: [
          createNote('C', e, 'doubling'),
          createNote('B', e),
          createNote('LowA', q, 'gGraceBirl'),
          createNote('LowA', h),
        ],
      },
    ],
  }
  return {
    version: 1,
    id: newId('score'),
    title: 'Demo Tune',
    tuneType: '4/4 March',
    composer: 'pipeMaster',
    timeSig: ts,
    tempo: 80,
    parts: [part1, part2],
  }
}
