import type { DetectedNote } from './recognize'
import type { Score } from '../model/types'
import { newId } from '../model/types'
import { createNote } from '../model/create'
import type { TimeSig } from '../duration'
import { barCapacityBeats } from '../duration'

/**
 * Build an editable Score from recognised noteheads. Pitches, embellishments,
 * and augmentation dots are carried over; durations are approximate (filled
 * noteheads default to quavers), so the user still tidies rhythm in the editor.
 */
export function omrToScore(
  notes: DetectedNote[],
  timeSig: TimeSig,
  title: string,
): Score {
  const quaversPerBar = Math.max(1, Math.round(barCapacityBeats(timeSig) / 0.5))
  const bars = []
  for (let i = 0; i < notes.length; i += quaversPerBar) {
    const slice = notes.slice(i, i + quaversPerBar)
    bars.push({
      id: newId('b'),
      notes: slice.map((n) =>
        createNote(n.pitch, { base: 8, dots: n.dotted ? 1 : 0 }, n.embellishment),
      ),
    })
  }
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
