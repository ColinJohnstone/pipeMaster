import type { Score, NoteAddress } from '../core/model/types'
import { timeSigForBar } from '../core/model/types'
import { barCapacityBeats, beats, isCompound } from '../core/duration'
import { frequency, type Pitch } from '../core/pitch'
import { expandEmbellishment } from '../core/embellishments/registry'

/** Seconds per gracenote — quick, crisp, stolen from the note it decorates. */
const GRACE_SEC = 0.052
/** A struck melody note always keeps at least this much sound. */
const MIN_MELODY_SEC = 0.06

export interface MelodyEvent {
  timeSec: number
  durSec: number
  freq: number
  pitch: Pitch
  /** Address of the melody note this event belongs to (for the cursor). */
  addr: NoteAddress | null
  isGrace: boolean
}

export interface ClickEvent {
  timeSec: number
  strong: boolean
}

/**
 * Expand repeats into a flat play order of [partIndex, barIndex].
 *
 * Semantics follow standard notation:
 * - A plain repeat (`:|`) replays from the matching `|:` (or the part start)
 *   once, then continues.
 * - First/second endings: reaching the 1st-ending group plays it, jumps back
 *   to the repeat start, replays up to the group, then plays the 2nd-ending
 *   group and continues. Bars *after* the endings are played once — the
 *   repeat boundary is the ending, not a later barline.
 */
export function playOrder(score: Score): Array<[number, number]> {
  const order: Array<[number, number]> = []
  score.parts.forEach((part, pi) => {
    const bars = part.bars
    const push = (i: number) => order.push([pi, i])
    // Each repeat section (keyed by its start bar) fires at most once, so a
    // jump back to the same start can't loop forever.
    const consumed = new Set<number>()
    let i = 0
    let repeatStart = 0

    while (i < bars.length) {
      const bar = bars[i]
      if (bar.repeatStart) repeatStart = i

      // First/second endings begin at a volta-1 bar.
      if (bar.volta === 1 && !consumed.has(repeatStart)) {
        let v1End = i
        while (v1End + 1 < bars.length && bars[v1End + 1].volta === 1) v1End++
        let v2Start = v1End + 1
        let v2End = v2Start - 1
        while (v2End + 1 < bars.length && bars[v2End + 1].volta === 2) v2End++

        for (let k = i; k <= v1End; k++) push(k) // 1st ending
        for (let k = repeatStart; k < i; k++) push(k) // repeat the section
        for (let k = v2Start; k <= v2End; k++) push(k) // 2nd ending
        consumed.add(repeatStart)
        i = v2End + 1
        continue
      }

      push(i)
      if (bar.repeatEnd && !consumed.has(repeatStart)) {
        consumed.add(repeatStart)
        i = repeatStart
        continue
      }
      i++
    }
  })
  return order
}

export interface BuildOptions {
  /** Emit a click on every beat of every bar. */
  metronome?: boolean
  /** Emit one bar of clicks before the music starts. */
  countIn?: boolean
}

export function buildEvents(
  score: Score,
  lowA: number,
  opts: BuildOptions = {},
): { events: MelodyEvent[]; clicks: ClickEvent[]; totalSec: number } {
  const events: MelodyEvent[] = []
  const clicks: ClickEvent[] = []
  const order = playOrder(score)
  let t = 0

  if (opts.countIn && order.length > 0) {
    const ts = timeSigForBar(score, order[0][0], order[0][1])
    const crotchetSec = 60 / score.tempo / (isCompound(ts) ? 1.5 : 1)
    const beatLen = (isCompound(ts) ? 1.5 : 4 / ts.unit) * crotchetSec
    const count = isCompound(ts) ? ts.beats / 3 : ts.beats
    for (let k = 0; k < count; k++) {
      clicks.push({ timeSec: t + k * beatLen, strong: k === 0 })
    }
    t += count * beatLen
  }

  for (const [pi, bi] of order) {
    const ts = timeSigForBar(score, pi, bi)
    // score.tempo counts the meter's beat (dotted crotchet in compound time).
    const crotchetSec = (60 / score.tempo) / (isCompound(ts) ? 1.5 : 1)
    const bar = score.parts[pi].bars[bi]
    if (opts.metronome) {
      const barDur = bar.notes.reduce((a, n) => a + beats(n.duration), 0) * crotchetSec
      const beatLen = (isCompound(ts) ? 1.5 : 4 / ts.unit) * crotchetSec
      const nominal = barCapacityBeats(ts) * crotchetSec
      // Click through the bar's actual length (pickup bars are short).
      for (let k = 0; k * beatLen < Math.min(barDur, nominal) - 1e-6; k++) {
        clicks.push({ timeSec: t + k * beatLen, strong: k === 0 })
      }
    }
    bar.notes.forEach((note, ni) => {
      const graces = expandEmbellishment(note.embellishment, note.pitch)
      const noteSec = beats(note.duration) * crotchetSec
      const graceTotal = Math.min(graces.length * GRACE_SEC, noteSec - MIN_MELODY_SEC)
      const graceSec = graces.length > 0 ? graceTotal / graces.length : 0
      graces.forEach((g: Pitch, gi: number) => {
        events.push({
          timeSec: t + gi * graceSec,
          durSec: graceSec,
          freq: frequency(g, lowA),
          pitch: g,
          addr: null,
          isGrace: true,
        })
      })
      events.push({
        timeSec: t + graceTotal,
        durSec: noteSec - graceTotal,
        freq: frequency(note.pitch, lowA),
        pitch: note.pitch,
        addr: { partIndex: pi, barIndex: bi, noteIndex: ni },
        isGrace: false,
      })
      t += noteSec
    })
  }
  return { events, clicks, totalSec: t }
}

/** A harmonic-stack voice — the basis of both chanter and drones. */
function makeVoice(
  ctx: AudioContext,
  dest: AudioNode,
  harmonics: number[],
  gain: number,
): { oscs: OscillatorNode[]; out: GainNode; setFreqAt(f: number, t: number): void } {
  const out = ctx.createGain()
  out.gain.value = gain
  out.connect(dest)
  const oscs = harmonics.map((h, i) => {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    g.gain.value = h
    osc.connect(g)
    g.connect(out)
    void i
    return osc
  })
  return {
    oscs,
    out,
    setFreqAt(f: number, t: number) {
      oscs.forEach((osc, i) => osc.frequency.setValueAtTime(f * (i + 1), t))
    },
  }
}

/** Bright, reedy chanter spectrum. */
const CHANTER_HARMONICS = [0.55, 0.85, 0.62, 0.5, 0.38, 0.3, 0.22, 0.16, 0.1, 0.07, 0.05, 0.035]
/** Mellower drone spectrum. */
const DRONE_HARMONICS = [0.8, 0.4, 0.28, 0.14, 0.08, 0.05]

export interface PlayerOptions {
  lowA: number
  dronesOn: boolean
  metronome?: boolean
  countIn?: boolean
}

export class Player {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private droneNodes: OscillatorNode[] = []
  private melodyNodes: OscillatorNode[] = []
  private raf = 0
  private stopTimer: number | null = null

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.5
      const comp = this.ctx.createDynamicsCompressor()
      this.master.connect(comp)
      comp.connect(this.ctx.destination)
    }
    void this.ctx.resume()
    return this.ctx
  }

  get playing(): boolean {
    return this.melodyNodes.length > 0
  }

  get dronesRunning(): boolean {
    return this.droneNodes.length > 0
  }

  startDrones(lowA: number) {
    const ctx = this.ensureCtx()
    if (this.droneNodes.length) return
    const t = ctx.currentTime + 0.02
    // Two tenors an octave below Low A (slightly detuned against each other
    // for shimmer) and a bass two octaves below.
    const configs = [
      { f: lowA / 2, detune: -1.5, gain: 0.1 },
      { f: lowA / 2, detune: 1.5, gain: 0.1 },
      { f: lowA / 4, detune: 0, gain: 0.14 },
    ]
    for (const cfg of configs) {
      const voice = makeVoice(ctx, this.master!, DRONE_HARMONICS, cfg.gain)
      voice.oscs.forEach((o) => {
        o.detune.value = cfg.detune
        o.start(t)
      })
      voice.setFreqAt(cfg.f, t)
      voice.out.gain.setValueAtTime(0, t)
      voice.out.gain.linearRampToValueAtTime(cfg.gain, t + 0.8)
      this.droneNodes.push(...voice.oscs)
    }
  }

  stopDrones() {
    const t = this.ctx?.currentTime ?? 0
    this.droneNodes.forEach((o) => o.stop(t + 0.1))
    this.droneNodes = []
  }

  /** A short percussive metronome click (woodblock-ish). */
  private scheduleClick(ctx: AudioContext, at: number, strong: boolean) {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = strong ? 1600 : 1050
    const peak = strong ? 0.28 : 0.17
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(peak, at + 0.002)
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05)
    osc.connect(g)
    g.connect(this.master!)
    osc.start(at)
    osc.stop(at + 0.06)
    this.melodyNodes.push(osc)
  }

  /**
   * Play a score. onTick receives the sounding melody note's address for the
   * playback cursor; onEnd fires when the tune finishes or is stopped.
   */
  start(
    score: Score,
    opts: PlayerOptions,
    onTick: (addr: NoteAddress | null) => void,
    onEnd: () => void,
  ) {
    this.stopMelody()
    const ctx = this.ensureCtx()
    if (opts.dronesOn) this.startDrones(opts.lowA)

    const { events, clicks, totalSec } = buildEvents(score, opts.lowA, {
      metronome: opts.metronome,
      countIn: opts.countIn,
    })
    if (events.length === 0) {
      onEnd()
      return
    }
    const t0 = ctx.currentTime + 0.12
    // The chanter starts silent, first sound at the first melody event so a
    // count-in isn't accompanied by a held note.
    const firstMelodyAt = events[0].timeSec
    const voice = makeVoice(ctx, this.master!, CHANTER_HARMONICS, 0.16)
    voice.oscs.forEach((o) => o.start(t0))
    voice.setFreqAt(events[0].freq, t0)
    voice.out.gain.setValueAtTime(0, t0)
    voice.out.gain.setValueAtTime(0, t0 + firstMelodyAt - 0.005)
    voice.out.gain.linearRampToValueAtTime(0.16, t0 + firstMelodyAt + 0.015)
    for (const ev of events) {
      voice.setFreqAt(ev.freq, t0 + ev.timeSec)
    }
    voice.out.gain.setValueAtTime(0.16, t0 + totalSec - 0.02)
    voice.out.gain.linearRampToValueAtTime(0, t0 + totalSec + 0.05)
    voice.oscs.forEach((o) => o.stop(t0 + totalSec + 0.1))
    this.melodyNodes = voice.oscs

    for (const c of clicks) this.scheduleClick(ctx, t0 + c.timeSec, c.strong)

    const melody = events.filter((e) => !e.isGrace)
    const tick = () => {
      const now = ctx.currentTime - t0
      if (now >= totalSec) return
      let current: NoteAddress | null = null
      for (const ev of melody) {
        if (ev.timeSec <= now) current = ev.addr
        else break
      }
      onTick(current)
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)

    this.stopTimer = window.setTimeout(() => {
      this.stopMelody()
      onEnd()
    }, (totalSec + 0.2) * 1000)
  }

  stopMelody() {
    cancelAnimationFrame(this.raf)
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    const t = this.ctx?.currentTime ?? 0
    this.melodyNodes.forEach((o) => {
      try {
        o.stop(t + 0.05)
      } catch {
        // already stopped
      }
    })
    this.melodyNodes = []
  }

  stopAll() {
    this.stopMelody()
    this.stopDrones()
  }
}

export const player = new Player()
