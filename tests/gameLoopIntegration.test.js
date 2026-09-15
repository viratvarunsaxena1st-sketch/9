import { describe, it, expect } from 'vitest'
import { AudioPlayer } from '../src/lib/audioPlayer.js'
import { createTrialClock, isCancellation } from '../src/lib/trialClock.js'
import { generateGame } from '../src/lib/nback.js'

/**
 * The regression, end to end.
 *
 * A game froze after its first trial because the trial loop waited on an audio
 * promise that never settled - the sound had already failed during preload, so
 * Howler queued the playback and then emitted nothing at all, ever. No error,
 * no rejection, nothing to catch: the screen simply stopped.
 *
 * These tests run the real clock against the real audio player, with sounds
 * that behave exactly that badly, and assert that the session still finishes.
 */

/** A sound object that accepts a play and then goes quiet forever. */
const deadHowl = () => ({
  on() {}, off() {}, once() {},
  play() { return 1 },
  unload() {},
})

const settings = {
  nBack: 2, numTrials: 12, trialTime: 25, matchChance: 25, interference: 25,
  enableAudio: true, enableShape: false, enableColor: false, enableImage: false,
  grid: 'rotate3D', rules: 'none',
  audioSource: 'letters2', colorSource: 'basic', shapeSource: 'basic', imageSource: 'voronoi',
}

/** The shape of DefaultGame's loop, with the parts that actually broke. */
const playSession = async ({ audioPlayer, clock }) => {
  const game = generateGame(settings, { mode: 'constant', theme: 'dark' })
  const trials = structuredClone(game.trials)
  const ms = game.meta.trialTime
  const scoresheet = []
  let silent = false

  for (let i = 0; i < trials.length; i++) {
    const audioWait = trials[i].audio
      ? audioPlayer.play(trials[i].audio).then((r) => {
          if (r && r.played === false && r.reason !== 'no-stimulus') silent = true
          return r
        })
      : Promise.resolve(null)

    await Promise.all([clock.delay(ms), clock.cap(audioWait, ms + 30)])
    scoresheet.push({})
  }

  return { completedTrials: scoresheet.length, total: trials.length, silent }
}

describe('a session survives broken audio', () => {
  it('runs every trial when no sound ever reports back', async () => {
    const audioPlayer = new AudioPlayer({ howlFactory: deadHowl, timeoutMs: 15 })
    const result = await playSession({ audioPlayer, clock: createTrialClock() })

    expect(result.completedTrials).toBe(result.total)
    expect(result.completedTrials).toBe(12)
    expect(result.silent).toBe(true)
  })

  it('runs every trial when every sound fails to load', async () => {
    const failing = () => {
      const listeners = []
      return {
        on: (event, fn) => { if (event === 'loaderror') listeners.push(fn) },
        once: (event, fn) => { if (event === 'loaderror') listeners.push(fn) },
        off() {},
        play() { queueMicrotask(() => listeners.forEach((fn) => fn())); return 1 },
        unload() {},
      }
    }
    const audioPlayer = new AudioPlayer({ howlFactory: failing, timeoutMs: 15 })
    const result = await playSession({ audioPlayer, clock: createTrialClock() })

    expect(result.completedTrials).toBe(12)
    expect(result.silent).toBe(true)
  })

  it('does not sit through a timeout once a sound is known to be broken', async () => {
    const audioPlayer = new AudioPlayer({ howlFactory: deadHowl, timeoutMs: 200 })
    const clock = createTrialClock()

    const started = Date.now()
    const result = await playSession({ audioPlayer, clock })
    const elapsed = Date.now() - started

    expect(result.completedTrials).toBe(12)
    // Twelve trials at a 200ms audio timeout each would be 2.4 seconds. Once a
    // sound is marked unavailable it is skipped, so only the first few cost
    // anything, and the trial clock carries the rest.
    expect(elapsed).toBeLessThan(1500)
  })

  it('leaves nothing pending on the clock after a clean finish', async () => {
    const audioPlayer = new AudioPlayer({ howlFactory: deadHowl, timeoutMs: 15 })
    const clock = createTrialClock()
    await playSession({ audioPlayer, clock })

    await new Promise((r) => setTimeout(r, 60))
    expect(clock.pendingCount()).toBe(0)
  })

  it('stopping part way through unwinds as a cancellation, not a crash', async () => {
    const audioPlayer = new AudioPlayer({ howlFactory: deadHowl, timeoutMs: 15 })
    const clock = createTrialClock()

    // Land the stop while a trial is actually in flight, the way the Stop
    // button and Escape do.
    const stop = setTimeout(() => clock.cancelAll(), 70)

    let thrown = null
    try {
      await playSession({ audioPlayer, clock })
    } catch (e) {
      thrown = e
    }
    clearTimeout(stop)

    expect(thrown).not.toBe(null)
    expect(isCancellation(thrown)).toBe(true)
  })
})
