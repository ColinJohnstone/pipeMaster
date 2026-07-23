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
 * the page, with one important allowance: an expansion may contain the melody
 * note itself (a doubling on C expands to High G, C, D), and that note is played
 * but NOT drawn as a little note — the page shows only High G and D. Skipping
 * such an entry therefore costs nothing, otherwise a doubling can never match
 * its own printed form and loses out to some shorter pattern.
 */
function editDistance(a: Pitch[], b: Pitch[], melody?: Pitch): number {
  const skip = (p: Pitch) => (melody !== undefined && p === melody ? 0 : 1)
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) dp[i][0] = dp[i - 1][0] + skip(a[i - 1])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + skip(a[i - 1]),
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
    // Compare lengths against what is actually DRAWN — entries equal to the
    // melody note are played, not written (see editDistance).
    const written = expected.filter((p) => p !== melody).length
    if (Math.abs(written - graces.length) > 1) continue
    const d = editDistance(expected, graces, melody)
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
