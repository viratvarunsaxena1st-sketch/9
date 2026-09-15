import { describe, it, expect } from 'vitest'
import { createSpeaker, chooseVoice } from '../src/lib/speech.js'
import { speechTextFor, voiceProfileFor, toneSpec, TONE_CAPACITY } from '../src/lib/audioText.js'

/**
 * A stand-in speechSynthesis. `behaviour` decides what happens to each
 * utterance, including the case that matters most: the API accepts it and
 * then nothing ever happens, because no voice is installed.
 */
const fakeSynth = ({ voices = [], behaviour = 'end', voicesLate = false } = {}) => {
  const listeners = {}
  const synth = {
    spoken: [],
    cancelled: 0,
    getVoices: () => (voicesLate && !synth.released ? [] : voices),
    addEventListener: (event, fn) => { (listeners[event] ??= []).push(fn) },
    removeEventListener: (event, fn) => {
      listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn)
    },
    releaseVoices: () => {
      synth.released = true
      for (const fn of listeners.voiceschanged ?? []) fn()
    },
    cancel: () => { synth.cancelled++ },
    speak: (utterance) => {
      synth.spoken.push(utterance)
      if (behaviour === 'silent') return
      queueMicrotask(() => {
        if (behaviour === 'end') { utterance.onstart?.(); utterance.onend?.() }
        if (behaviour === 'error') utterance.onerror?.({ error: 'synthesis-failed' })
        if (behaviour === 'interrupted') utterance.onerror?.({ error: 'interrupted' })
      })
    },
  }
  return synth
}

const utteranceFactory = (text) => ({ text })

const speakerWith = (synth, extra = {}) =>
  createSpeaker({
    synth,
    utteranceFactory,
    startTimeoutMs: 25,
    utteranceTimeoutMs: 60,
    voicesTimeoutMs: 25,
    ...extra,
  })

describe('speech synthesis always settles', () => {
  it('reports a spoken utterance', async () => {
    const synth = fakeSynth({ behaviour: 'end' })
    const result = await speakerWith(synth).speak('A')

    expect(result.spoken).toBe(true)
    expect(synth.spoken[0].text).toBe('A')
  })

  // The device where the API exists, accepts the utterance, and is silent
  // because no voice is installed. Waiting on onend here is the same freeze
  // the recordings caused.
  it('gives up on a device that accepts the utterance and says nothing', async () => {
    const result = await speakerWith(fakeSynth({ behaviour: 'silent' })).speak('A')

    expect(result.spoken).toBe(false)
    expect(result.reason).toBe('silent')
  })

  it('stops trying once it has proved silent, so the game can fall further back', async () => {
    const synth = fakeSynth({ behaviour: 'silent' })
    const speaker = speakerWith(synth)

    await speaker.speak('A')
    expect(speaker.isUsable()).toBe(false)

    const second = await speaker.speak('B')
    expect(second.reason).toBe('unsupported')
    expect(synth.spoken).toHaveLength(1)
  })

  it('resolves on a synthesis error without condemning the engine', async () => {
    const result = await speakerWith(fakeSynth({ behaviour: 'error' })).speak('A')
    expect(result.spoken).toBe(false)
    expect(result.reason).toBe('error')
  })

  // Our own cancel lands as an 'interrupted' error. Treating that as a fault
  // would drop a working engine to tones the first time the player hit Stop.
  it('treats an interruption as a cancellation, not a fault', async () => {
    const speaker = speakerWith(fakeSynth({ behaviour: 'interrupted' }))
    const result = await speaker.speak('A')

    expect(result.reason).toBe('cancelled')
    expect(speaker.isUsable()).toBe(true)
  })

  it('resolves when there is nothing to say', async () => {
    const result = await speakerWith(fakeSynth()).speak('')
    expect(result.reason).toBe('no-text')
  })

  it('reports unsupported rather than throwing when the API is absent', async () => {
    const speaker = createSpeaker({ synth: null, utteranceFactory: null })
    expect(speaker.isSupported()).toBe(false)
    expect((await speaker.speak('A')).reason).toBe('unsupported')
  })

  it('clears the queue before each utterance so speech cannot drift behind', async () => {
    const synth = fakeSynth({ behaviour: 'end' })
    const speaker = speakerWith(synth)

    await speaker.speak('A')
    await speaker.speak('B')

    expect(synth.cancelled).toBe(2)
  })
})

describe('voice selection', () => {
  const voices = [
    { name: 'Daniel', lang: 'en-GB', localService: true },
    { name: 'Samantha', lang: 'en-US', localService: true, default: true },
    { name: 'Amelie', lang: 'fr-FR', localService: true },
    { name: 'Remote Bot', lang: 'en-US', localService: false },
  ]

  it('prefers a local English voice', () => {
    expect(chooseVoice(voices, {}).name).toBe('Samantha')
  })

  it('follows the profile hint when a matching voice exists', () => {
    expect(chooseVoice(voices, { prefer: 'male' }).name).toBe('Daniel')
    expect(chooseVoice(voices, { prefer: 'female' }).name).toBe('Samantha')
  })

  it('is deterministic, so a set sounds like itself all block', () => {
    const a = chooseVoice(voices, { prefer: 'male' })
    const b = chooseVoice(voices, { prefer: 'male' })
    expect(a.name).toBe(b.name)
  })

  it('falls back rather than failing when nothing matches the hint', () => {
    const only = [{ name: 'Robot', lang: 'de-DE', localService: true }]
    expect(chooseVoice(only, { prefer: 'female' }).name).toBe('Robot')
    expect(chooseVoice([], { prefer: 'male' })).toBeNull()
  })

  it('waits for engines that publish their voices late', async () => {
    const voice = { name: 'Daniel', lang: 'en-GB', localService: true }
    const synth = fakeSynth({ voices: [voice], voicesLate: true })
    const speaker = speakerWith(synth, { voicesTimeoutMs: 200 })

    const pending = speaker.loadVoices()
    setTimeout(() => synth.releaseVoices(), 5)

    expect(await pending).toHaveLength(1)
  })

  it('gives up on the voice list instead of hanging when it never arrives', async () => {
    const synth = fakeSynth({ voices: [], voicesLate: true })
    expect(await speakerWith(synth).loadVoices()).toEqual([])
  })
})

describe('what the fallback actually says', () => {
  it('reads letters as letters', () => {
    expect(speechTextFor('LettersM1/a')).toBe('A')
    expect(speechTextFor('LettersF3/q')).toBe('Q')
  })

  it('reads digits as words', () => {
    expect(speechTextFor('Natural-Numbers/3')).toBe('three')
    expect(speechTextFor('Natural-Numbers/8')).toBe('eight')
  })

  it('reads the NATO set as its call signs', () => {
    expect(speechTextFor('Nato/j')).toBe('Juliet')
    expect(speechTextFor('Nato/x')).toBe('X-ray')
  })

  // The syllable sets are long nonsense utterances - roughly five and ten
  // syllables. Their length is the load, so the fallback has to keep it.
  it('rebuilds the syllable sets at the right length', () => {
    expect(speechTextFor('syl5/c').split(' ')).toHaveLength(5)
    expect(speechTextFor('syl10/c').split(' ')).toHaveLength(10)
  })

  it('says the same thing for the same stimulus every time', () => {
    expect(speechTextFor('syl10/k')).toBe(speechTextFor('syl10/k'))
  })

  // If two stimuli spoke alike the player would hear a match that was not
  // there, and be marked wrong for saying so.
  it('never says the same thing for two different stimuli', () => {
    for (const folder of ['syl5', 'syl10']) {
      const keys = 'abcdefghijklmnopqrstuv'.split('')
      const spoken = keys.map((k) => speechTextFor(`${folder}/${k}`))
      expect(new Set(spoken).size).toBe(keys.length)
    }
  })

  it('gives every audio set its own voice profile', () => {
    const sets = ['letters2', 'letters3', 'letters5', 'letters4', 'letters', 'numbers', 'nato', 'syl5', 'syl10']
    const profiles = sets.map((s) => JSON.stringify(voiceProfileFor(s)))
    expect(new Set(profiles).size).toBe(sets.length)
  })

  it('has a profile for an unknown set rather than undefined', () => {
    expect(voiceProfileFor('something-else').rate).toBe(1.0)
  })
})

describe('the tone of last resort', () => {
  it('covers the largest pool without repeating itself', () => {
    expect(TONE_CAPACITY).toBeGreaterThanOrEqual(26)
    const specs = Array.from({ length: 26 }, (_, i) => toneSpec(i))
    expect(new Set(specs.map((s) => `${s.frequency}:${s.shape}`)).size).toBe(26)
  })

  it('stays in a range that is comfortable to hold in mind', () => {
    const freqs = Array.from({ length: TONE_CAPACITY }, (_, i) => toneSpec(i).frequency)
    expect(Math.min(...freqs)).toBeGreaterThanOrEqual(200)
    expect(Math.max(...freqs)).toBeLessThanOrEqual(1000)
  })

  it('is stable for a given index', () => {
    expect(toneSpec(7)).toEqual(toneSpec(7))
  })
})
