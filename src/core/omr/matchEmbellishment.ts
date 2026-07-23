import type { Pitch } from '../pitch'
import { EMBELLISHMENTS, type EmbellishmentType } from '../embellishments/registry'

/**
 * Reverse-match a detected gracenote pitch sequence to an embellishment.
 *
 * Embellishments are semantic in pipeMaster: the registry knows the exact
 * gracenote sequence each one expands to on a given melody pitch. So OMR can
 * detect the little noteheads before a melody note, read their pitches, and
 * look up which embellishment produces that pattern — tolerant of a missed or
 * misread gracenote via edit distance.
 */

/**
 * Edit distance from an embellishment's gracenote sequence to what was read off
 * the page.
 *
 * A registry expansion is the sequence of little notes as ENGRAVED, including
 * any at the melody note's own pitch: a doubling on C is drawn High G, C, D —
 * three gracenotes, the middle one a C — and a birl on Low A is drawn Low G,
 * Low A, Low G. Compare against the whole expansion; treating the melody-pitch
 * entry as unwritten costs a real gracenote of evidence and lets a doubling
 * lose to a half doubling.
 */
function editDistance(a: Pitch[], b: Pitch[]): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[m][n]
}

export interface EmbellishmentMatch {
  type: EmbellishmentType
  /** 0..1, how well the detected gracenotes fit the embellishment. */
  confidence: number
}

/**
 * Best embellishment for a melody pitch given detected gracenote pitches, or
 * undefined if nothing fits well enough.
 */
export function matchEmbellishment(
  melody: Pitch,
  graces: Pitch[],
): EmbellishmentMatch | undefined {
  if (graces.length === 0) return undefined

  let best: EmbellishmentType | undefined
  let bestConf = -1
  for (const def of EMBELLISHMENTS) {
    const expected = def.expand(melody)
    if (!expected || expected.length === 0) continue
    const written = expected.length
    if (Math.abs(written - graces.length) > 1) continue
    const d = editDistance(expected, graces)
    // Confidence rewards matching more of a longer pattern, so a doubling with
    // one missed gracenote beats a shorter pattern that fits equally loosely.
    const conf = 1 - d / Math.max(written, graces.length, 1)
    if (conf > bestConf) {
      bestConf = conf
      best = def.type
    }
  }

  if (best === undefined || bestConf < 0.6) return undefined
  return { type: best, confidence: bestConf }
}
