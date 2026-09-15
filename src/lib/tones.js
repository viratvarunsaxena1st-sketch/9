import { toneSpec } from './audioText.js'

/**
 * Synthesised tones: the layer that still works when nothing can be fetched
 * and nothing can be spoken.
 *
 * An oscillator needs no network and no installed voice, so this is the one
 * tier that cannot fail for environmental reasons. It is a poor substitute for
 * a spoken letter - the task becomes pitch memory rather than verbal memory -
 * so it only runs once the two better layers have been ruled out.
 */

const ATTACK = 0.012
const RELEASE = 0.09
const DURATION_S = 0.28

export const createTonePlayer = ({
  contextFactory = () => {
    const Ctor = typeof AudioContext !== 'undefined'
      ? AudioContext
      : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null)
    return Ctor ? new Ctor() : null
  },
} = {}) => {
  let context = null
  let unusable = false

  const getContext = () => {
    if (unusable) return null
    if (context) return context
    try {
      context = contextFactory()
    } catch (e) {
      console.warn('Could not open an audio context', e)
      context = null
    }
    if (!context) unusable = true
    return context
  }

  /**
   * Play the tone for a pool index. Resolves when the sound has finished, and
   * always resolves - a dead audio context costs one cue, not the session.
   */
  const play = async (index) => {
    const ctx = getContext()
    if (!ctx) return { played: false, reason: 'unsupported' }

    try {
      // Browsers start the context suspended until a gesture. Starting a game
      // is a gesture, so this resolves; if it does not, the catch handles it.
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        await ctx.resume()
      }

      const { frequency, shape } = toneSpec(index)
      const now = ctx.currentTime
      const end = now + DURATION_S

      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(frequency, now)

      // The contour is what makes twenty-seven stimuli distinguishable inside
      // two octaves instead of needing five.
      if (shape === 'rising') osc.frequency.linearRampToValueAtTime(frequency * 1.5, end)
      if (shape === 'falling') osc.frequency.linearRampToValueAtTime(frequency / 1.335, end)

      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(0.22, now + ATTACK)
      gain.gain.setValueAtTime(0.22, end - RELEASE)
      gain.gain.linearRampToValueAtTime(0, end)

      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now)
      osc.stop(end)

      return await new Promise((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { osc.disconnect(); gain.disconnect() } catch { /* already torn down */ }
          resolve({ played: true, reason: 'end' })
        }
        // onended is well supported, but the watchdog keeps the promise honest.
        osc.onended = finish
        const timer = setTimeout(finish, DURATION_S * 1000 + 250)
      })
    } catch (e) {
      console.warn('Tone playback failed', e)
      unusable = true
      return { played: false, reason: 'error' }
    }
  }

  const close = () => {
    if (context && typeof context.close === 'function') {
      try { context.close() } catch (e) { console.debug('Context already closed', e) }
    }
    context = null
  }

  return { play, close, isUsable: () => !unusable }
}
