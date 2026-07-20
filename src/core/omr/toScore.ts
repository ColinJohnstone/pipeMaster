import type { DetectedNote } from './recognize'
import type { Score } from '../model/types'
import { newId } from '../model/types'
import { createNote } from '../model/create'
import type { TimeSig } from '../duration'
import { barCapacityBeats, beats } from '../duration'

/**
 * Build an editable Score from recognised noteheads. Pitches, embellishments,
 * durations (from beam/flag/stem analysis), and dots are carried over. Notes
 * are packed into bars up to the meter's capacity; recognition isn't perfect,
 * so the user still tidies the odd rhythm in the editor.
 */
export function omrToScore(
  notes: DetectedNote[],
  timeSig: TimeSig,
  title: string,
): Score {
  const cap = barCapacityBeats(timeSig)
  const bars: { id: string; notes: ReturnType<typeof createNote>[] }[] = []
  let current: ReturnType<typeof createNote>[] = []
  let used = 0
  for (const n of notes) {
    const dur = { base: n.base, dots: (n.dotted ? 1 : 0) as 0 | 1 }
    const nb = beats(dur)
    // Start a new bar when this note would overflow the current one.
    if (current.length > 0 && used + nb > cap + 1e-6) {
      bars.push({ id: newId('b'), notes: current })
      current = []
      used = 0
    }
    current.push(createNote(n.pitch, dur, n.embellishment))
    used += nb
  }
  if (current.length > 0) bars.push({ id: newId('b'), notes: current })
  if (bars.length === 0) bars.push({ id: newId('b'), notes: [] })

  return {
    version: 1,
    id: newId('score'),
    title: title || 'Imported from photo',
    tuneType: '',
    composer: '',
    timeSig,
    tempo: 80,
    parts: [{ id: newId('p'), bars }],
  }
}
