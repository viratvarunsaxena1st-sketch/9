/**
 * Speech synthesis, treated as unreliable - because it is.
 *
 * The failure that matters is not an exception. It is a device where
 * `speechSynthesis` exists, `speak()` is accepted without complaint, and then
 * nothing is ever heard and no event is ever fired, because no voice is
 * installed. Waiting on `onend` there is the same freeze that recorded audio
 * caused. Every path here is on a clock.
 */

/** No 'start' by now and we assume there is no voice behind the API. */
const START_TIMEOUT_MS = 900
/** Absolute ceiling for one utterance, generous enough for a ten-syllable set. */
const UTTERANCE_TIMEOUT_MS = 6000
/** How long to wait for the voice list, which several engines populate late. */
const VOICES_TIMEOUT_MS = 1000

const MALE_HINTS = ['male', 'david', 'daniel', 'alex', 'fred', 'george', 'james', 'thomas', 'rishi', 'aaron']
const FEMALE_HINTS = ['female', 'samantha', 'victoria', 'karen', 'moira', 'tessa', 'fiona', 'zira', 'susan', 'allison']

const matchesHint = (voice, hints) => {
  const name = `${voice.name ?? ''} ${voice.voiceURI ?? ''}`.toLowerCase()
  return hints.some((hint) => name.includes(hint))
}

/**
 * Pick a stable voice for a profile.
 *
 * The Web Speech API exposes no gender, so name hints are the only signal
 * available and they are wrong often enough that the caller must not depend on
 * them. Selection is deterministic: the same profile always gets the same
 * voice, which is what keeps an audio set sounding like itself across a block.
 */
export const chooseVoice = (voices, profile = {}) => {
  if (!Array.isArray(voices) || voices.length === 0) return null

  const local = voices.filter((v) => v.localService !== false)
  const pool = local.length ? local : voices
  const english = pool.filter((v) => String(v.lang ?? '').toLowerCase().startsWith('en'))
  const candidates = english.length ? english : pool

  if (profile.prefer) {
    const hints = profile.prefer === 'male' ? MALE_HINTS : FEMALE_HINTS
    const hinted = candidates.filter((v) => matchesHint(v, hints))
    if (hinted.length) return hinted[0]
  }

  const preferred = candidates.find((v) => v.default) ?? candidates[0]
  return preferred ?? null
}

export const createSpeaker = ({
  synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null,
  utteranceFactory = typeof SpeechSynthesisUtterance !== 'undefined'
    ? (text) => new SpeechSynthesisUtterance(text)
    : null,
  startTimeoutMs = START_TIMEOUT_MS,
  utteranceTimeoutMs = UTTERANCE_TIMEOUT_MS,
  voicesTimeoutMs = VOICES_TIMEOUT_MS,
} = {}) => {
  const supported = Boolean(synth && utteranceFactory)
  let unusable = !supported
  let voicesPromise = null

  /**
   * Resolve the voice list, tolerating engines that populate it after a
   * 'voiceschanged' event and engines that never populate it at all.
   */
  const loadVoices = () => {
    if (voicesPromise) return voicesPromise

    voicesPromise = new Promise((resolve) => {
      if (!supported) return resolve([])

      const read = () => {
        try {
          return synth.getVoices() ?? []
        } catch {
          return []
        }
      }

      const initial = read()
      if (initial.length) return resolve(initial)

      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (typeof synth.removeEventListener === 'function') {
          synth.removeEventListener('voiceschanged', finish)
        }
        resolve(read())
      }

      const timer = setTimeout(finish, voicesTimeoutMs)
      if (typeof synth.addEventListener === 'function') {
        synth.addEventListener('voiceschanged', finish)
      }
    })

    return voicesPromise
  }

  /**
   * Speak, and always settle. Resolves { spoken, reason } - it is up to the
   * caller whether a failure is worth falling further back for.
   */
  const speak = async (text, profile = {}) => {
    if (unusable) return { spoken: false, reason: 'unsupported' }
    if (!text) return { spoken: false, reason: 'no-text' }

    const voices = await loadVoices()
    const voice = chooseVoice(voices, profile)

    return new Promise((resolve) => {
      let settled = false
      let started = false
      let startTimer
      let endTimer

      const finish = (spoken, reason) => {
        if (settled) return
        settled = true
        clearTimeout(startTimer)
        clearTimeout(endTimer)
        if (!spoken && reason === 'silent') {
          // The API accepted the utterance and nothing happened. Stop asking.
          unusable = true
        }
        resolve({ spoken, reason })
      }

      let utterance
      try {
        utterance = utteranceFactory(text)
      } catch (e) {
        console.warn('Speech synthesis could not build an utterance', e)
        unusable = true
        return finish(false, 'unsupported')
      }

      if (voice) utterance.voice = voice
      if (profile.rate) utterance.rate = profile.rate
      if (profile.pitch) utterance.pitch = profile.pitch
      utterance.onstart = () => {
        started = true
        clearTimeout(startTimer)
      }
      utterance.onend = () => finish(true, 'end')
      utterance.onerror = (event) => {
        // 'interrupted' and 'canceled' are our own cancel() landing, not a
        // fault of the engine - they must not condemn speech for the session.
        const kind = event?.error ?? 'error'
        if (kind === 'interrupted' || kind === 'canceled') return finish(false, 'cancelled')
        finish(false, 'error')
      }

      startTimer = setTimeout(() => {
        if (!started) finish(false, 'silent')
      }, startTimeoutMs)

      endTimer = setTimeout(() => finish(started, started ? 'timeout' : 'silent'), utteranceTimeoutMs)

      try {
        // Queued utterances drift behind a paced task, so each trial clears
        // whatever is still pending before speaking.
        synth.cancel()
        synth.speak(utterance)
      } catch (e) {
        console.warn('Speech synthesis rejected an utterance', e)
        finish(false, 'error')
      }
    })
  }

  const cancel = () => {
    if (!supported) return
    try {
      synth.cancel()
    } catch (e) {
      console.debug('Nothing to cancel', e)
    }
  }

  return {
    speak,
    cancel,
    loadVoices,
    isSupported: () => supported,
    isUsable: () => !unusable,
  }
}
