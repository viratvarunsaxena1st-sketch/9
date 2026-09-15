import { describe, it, expect } from 'vitest'
import { AudioPlayer, DELIVERY } from '../src/lib/audioPlayer.js'

/**
 * Stand-in for a Howl. Nothing fires on its own, so each test says explicitly
 * what the sound did - including doing nothing at all, which is what froze the
 * game.
 */
const fakeHowl = ({ onPlay = 'end', playReturns = 1, state = 'unloaded' } = {}) => {
  const listeners = new Map()
  const add = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(fn)
  }
  return {
    playCount: 0,
    on: add,
    once: add,
    off: (event, fn) => {
      const list = listeners.get(event) ?? []
      const i = list.indexOf(fn)
      if (i !== -1) list.splice(i, 1)
    },
    state: () => state,
    emit(event) { for (const fn of [...(listeners.get(event) ?? [])]) fn() },
    play() {
      this.playCount++
      if (onPlay) queueMicrotask(() => this.emit(onPlay))
      return playReturns
    },
    unload() { this.unloaded = true },
    listenerCount() {
      let n = 0
      for (const list of listeners.values()) n += list.length
      return n
    },
  }
}

const fakeSpeaker = ({ result = { spoken: true, reason: 'end' }, usable = true } = {}) => {
  const speaker = {
    calls: [],
    usable,
    cancelled: 0,
    speak: async (text, profile) => {
      speaker.calls.push({ text, profile })
      const r = typeof result === 'function' ? result(speaker.calls.length) : result
      if (!r.spoken && r.reason === 'silent') speaker.usable = false
      return r
    },
    cancel: () => { speaker.cancelled++ },
    isUsable: () => speaker.usable,
    isSupported: () => true,
  }
  return speaker
}

const fakeTones = ({ usable = true, played = true } = {}) => {
  const tones = {
    calls: [],
    play: async (index) => {
      tones.calls.push(index)
      return played ? { played: true, reason: 'end' } : { played: false, reason: 'unsupported' }
    },
    isUsable: () => usable,
    close: () => {},
  }
  return tones
}

const makePlayer = (opts = {}) =>
  new AudioPlayer({
    timeoutMs: 30,
    probeTimeoutMs: 30,
    speaker: fakeSpeaker(),
    tonePlayer: fakeTones(),
    ...opts,
  })

describe('recorded audio — a stimulus can never stall the game', () => {
  const fileOnly = (howl, extra = {}) =>
    makePlayer({ howlFactory: () => howl, enableFallback: false, ...extra })

  it('reports a played recording once it ends', async () => {
    const howl = fakeHowl({ onPlay: 'end' })
    const result = await fileOnly(howl).play('LettersM1/a')

    expect(result.played).toBe(true)
    expect(result.delivery).toBe(DELIVERY.FILE)
  })

  it('resolves rather than rejects when the file fails to load', async () => {
    const result = await fileOnly(fakeHowl({ onPlay: 'loaderror' })).play('LettersM1/a')
    expect(result.played).toBe(false)
  })

  // The exact shape of the freeze: a Howl that already failed during preload
  // queues the play, returns an id, then emits nothing at all, ever.
  it('times out a recording that never reports back', async () => {
    const result = await fileOnly(fakeHowl({ onPlay: null })).play('LettersM1/a')
    expect(result.played).toBe(false)
  })

  it('never throws, whatever the sound does', async () => {
    const howl = fakeHowl({ onPlay: null })
    howl.play = () => { throw new Error('AudioContext is closed') }

    const result = await fileOnly(howl).play('LettersM1/a')
    expect(result.played).toBe(false)
  })

  it('leaves no per-trial listeners behind, however the sound resolved', async () => {
    for (const onPlay of ['end', 'loaderror', null]) {
      const howl = fakeHowl({ onPlay })
      const player = fileOnly(howl)
      const baseline = (player.getHowl('x'), howl.listenerCount())

      await player.play('x')
      expect(howl.listenerCount()).toBe(baseline)
    }
  })

  it('reuses one sound object across a whole session', async () => {
    let built = 0
    const howl = fakeHowl({ onPlay: 'end' })
    const player = makePlayer({ howlFactory: () => { built++; return howl } })

    for (let i = 0; i < 40; i++) await player.play('LettersM1/a')

    expect(built).toBe(1)
    expect(howl.playCount).toBe(40)
  })
})

describe('falling back to speech when the files are gone', () => {
  it('speaks the stimulus instead of going silent', async () => {
    const speaker = fakeSpeaker()
    const player = makePlayer({ howlFactory: () => fakeHowl({ onPlay: 'loaderror' }), speaker })

    const result = await player.play('LettersM1/a')

    expect(result.played).toBe(true)
    expect(result.delivery).toBe(DELIVERY.SPEECH)
    expect(speaker.calls[0].text).toBe('A')
  })

  it('says the right words for each kind of stimulus set', async () => {
    const speaker = fakeSpeaker()
    const player = makePlayer({ howlFactory: () => fakeHowl({ onPlay: 'loaderror' }), speaker })

    await player.play('Nato/j')
    await player.play('Natural-Numbers/3')
    await player.play('LettersF2/q')

    expect(speaker.calls.map((c) => c.text)).toEqual(['Juliet', 'three', 'Q'])
  })

  // Without this every url in the pool pays a full file timeout the first time
  // it comes up - 26 stalls spread through a session that is already broken.
  it('stops retrying the files once one has failed', async () => {
    const howls = []
    const player = makePlayer({
      howlFactory: () => { const h = fakeHowl({ onPlay: 'loaderror' }); howls.push(h); return h },
    })

    await player.play('LettersM1/a')
    await player.play('LettersM1/b')
    await player.play('LettersM1/c')

    expect(player.filesUnavailable).toBe(true)
    expect(howls.filter((h) => h.playCount > 0)).toHaveLength(1)
  })

  it('keeps one voice profile for the whole audio set', async () => {
    const speaker = fakeSpeaker()
    const player = makePlayer({ howlFactory: () => fakeHowl({ onPlay: 'loaderror' }), speaker })
    player.cacheAudioSource('letters2')

    await player.play('LettersM1/a')
    await player.play('LettersM1/b')

    expect(speaker.calls[0].profile).toEqual(speaker.calls[1].profile)
    expect(speaker.calls[0].profile.prefer).toBe('male')
  })

  it('gives different audio sets different voices', async () => {
    const profileFor = async (source, url) => {
      const speaker = fakeSpeaker()
      const player = makePlayer({ howlFactory: () => fakeHowl({ onPlay: 'loaderror' }), speaker })
      player.cacheAudioSource(source)
      await player.play(url)
      return speaker.calls[0].profile
    }

    const male = await profileFor('letters2', 'LettersM1/a')
    const female = await profileFor('letters5', 'LettersF1/a')

    expect(male.prefer).not.toEqual(female.prefer)
    expect(male.pitch).not.toBe(female.pitch)
  })
})

describe('falling back to tones when nothing can be spoken', () => {
  // The device where the speech API exists, accepts the utterance, and is
  // silent because no voice is installed.
  it('drops to tones when speech turns out to be unusable', async () => {
    const speaker = fakeSpeaker({ result: { spoken: false, reason: 'silent' } })
    const tones = fakeTones()
    const player = makePlayer({
      howlFactory: () => fakeHowl({ onPlay: 'loaderror' }), speaker, tonePlayer: tones,
    })

    const result = await player.play('LettersM1/a')

    expect(result.played).toBe(true)
    expect(result.delivery).toBe(DELIVERY.TONE)
    expect(tones.calls).toHaveLength(1)
  })

  it('stops asking speech once it has proved silent', async () => {
    const speaker = fakeSpeaker({ result: { spoken: false, reason: 'silent' } })
    const player = makePlayer({ howlFactory: () => fakeHowl({ onPlay: 'loaderror' }), speaker })

    await player.play('LettersM1/a')
    await player.play('LettersM1/b')
    await player.play('LettersM1/c')

    expect(speaker.calls).toHaveLength(1)
  })

  // If two stimuli shared a tone the player would hear a match that was not
  // there, and the scoring would call them wrong for it.
  it('gives every item in a pool its own tone', async () => {
    const speaker = fakeSpeaker({ usable: false })
    const tones = fakeTones()
    const player = makePlayer({
      howlFactory: () => fakeHowl({ onPlay: 'loaderror' }), speaker, tonePlayer: tones,
    })
    player.cacheAudioSource('nato')

    const pool = [...player.toneIndex.keys()]
    for (const url of pool) await player.play(url)

    expect(pool).toHaveLength(26)
    expect(new Set(tones.calls).size).toBe(26)
  })

  it('reports silence honestly when every layer is gone', async () => {
    const player = makePlayer({
      howlFactory: () => fakeHowl({ onPlay: 'loaderror' }),
      speaker: fakeSpeaker({ usable: false }),
      tonePlayer: fakeTones({ usable: false }),
    })

    const result = await player.play('LettersM1/a')

    expect(result.played).toBe(false)
    expect(result.delivery).toBe(DELIVERY.NONE)
    expect(player.currentDelivery()).toBe(DELIVERY.NONE)
  })
})

describe('choosing a tier before the game starts', () => {
  it('settles on the recordings when they load', async () => {
    const player = makePlayer({ howlFactory: () => fakeHowl({ onPlay: 'end' }) })
    player.cacheAudioSource('letters2')

    player.audioCache.get('LettersM1/a').emit('load')
    await player.whenReady()

    expect(player.currentDelivery()).toBe(DELIVERY.FILE)
  })

  it('settles on speech when the recordings error, before any trial runs', async () => {
    const player = makePlayer({ howlFactory: () => fakeHowl({ onPlay: null }) })
    player.cacheAudioSource('letters2')

    player.audioCache.get('LettersM1/a').emit('loaderror')
    await player.whenReady()

    expect(player.currentDelivery()).toBe(DELIVERY.SPEECH)
  })

  // A slow network is not a broken one.
  it('keeps the recordings when the probe simply times out', async () => {
    const player = makePlayer({ howlFactory: () => fakeHowl({ onPlay: null }), probeTimeoutMs: 20 })
    player.cacheAudioSource('letters2')

    await player.whenReady()
    expect(player.currentDelivery()).toBe(DELIVERY.FILE)
  })

  it('ignores an audio source it does not recognise instead of throwing', async () => {
    const player = makePlayer({ howlFactory: () => fakeHowl() })
    expect(() => player.cacheAudioSource('not-a-real-set')).not.toThrow()
    await player.whenReady()
  })

  it('releases sounds and forgets failures when the cache is cleared', async () => {
    const howl = fakeHowl({ onPlay: 'loaderror' })
    const player = makePlayer({ howlFactory: () => howl })
    await player.play('LettersM1/a')
    expect(player.filesUnavailable).toBe(true)

    player.clearCache()

    expect(howl.unloaded).toBe(true)
    expect(player.audioCache.size).toBe(0)
    expect(player.filesUnavailable).toBe(false)
  })
})
