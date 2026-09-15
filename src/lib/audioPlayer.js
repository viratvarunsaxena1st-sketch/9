import { Howl } from "howler"
import { getAudioPool } from "./constants.js"
import { speechTextFor, voiceProfileFor } from "./audioText.js"
import { createSpeaker } from "./speech.js"
import { createTonePlayer } from "./tones.js"

/**
 * Audio delivery, in descending order of fidelity.
 *
 * Recorded files are the real stimulus set. When they cannot be loaded the
 * game falls back to speaking the same items, and when nothing can be spoken
 * it falls back to tones. Each tier is worse than the last, so the chain only
 * ever descends, and only on evidence.
 */
export const DELIVERY = {
  FILE: 'file',
  SPEECH: 'speech',
  TONE: 'tone',
  NONE: 'none',
}

/**
 * Longest a single recording may hold the trial loop open.
 *
 * Every recorded stimulus is under three seconds. The cap exists so that a
 * sound which never reports 'end' - a decode that stalls, a Howl that errored
 * before we attached a listener, a backgrounded tab - cannot leave the game
 * waiting forever.
 */
const PLAY_TIMEOUT_MS = 4000

/** How long to wait for a verdict on the sound files before a game starts. */
const PROBE_TIMEOUT_MS = 1500

const isIOS = () => typeof navigator !== 'undefined' && /iP(ad|hone|od)/.test(navigator.userAgent)

/**
 * Web Audio loads through XHR, which the browser refuses on a file:// page, so
 * every recording fails there. HTML5 Audio loads through an <audio> element,
 * which is allowed. Forcing html5 off disk is what lets the recordings play at
 * all when the build is opened straight from the filesystem.
 */
const isFileProtocol = () => typeof location !== 'undefined' && location.protocol === 'file:'

export const shouldUseHtml5Audio = () => isIOS() || isFileProtocol()

export class AudioPlayer {
  /**
   * Everything external is injectable so the failure paths can be exercised
   * without a browser, sound files, or an installed voice - which is the whole
   * point, since every one of them used to end in a frozen game.
   */
  constructor({
    howlFactory = null,
    timeoutMs = PLAY_TIMEOUT_MS,
    probeTimeoutMs = PROBE_TIMEOUT_MS,
    speaker = null,
    tonePlayer = null,
    enableFallback = true,
  } = {}) {
    this.audioCache = new Map()
    this.failed = new Set()
    this.location = 'audio/'
    this.howlFactory = howlFactory
    this.timeoutMs = timeoutMs
    this.probeTimeoutMs = probeTimeoutMs
    this.enableFallback = enableFallback

    this.speaker = speaker ?? createSpeaker()
    this.tonePlayer = tonePlayer ?? createTonePlayer()

    /** Set once a recording has failed, so later trials skip the file layer. */
    this.filesUnavailable = false
    this.delivery = DELIVERY.FILE
    this.audioSource = null
    this.toneIndex = new Map()
    this.readyPromise = Promise.resolve()
  }

  createHowl(url) {
    const prefix = this.location + url
    const howl = this.howlFactory
      ? this.howlFactory(url)
      : new Howl({
          src: [prefix + '.opus', prefix + '.mp3'],
          volume: 1.0,
          html5: shouldUseHtml5Audio(),
        })
    // Remember failures at the Howl level too. A Howl that 404s or fails to
    // decode never fires 'end' afterwards, so playing it again would hang.
    howl.once('loaderror', () => this.markFileFailure(url))
    return howl
  }

  markFileFailure(url) {
    this.failed.add(url)
    this.filesUnavailable = true
  }

  preload(url) {
    if (this.audioCache.has(url)) return
    this.audioCache.set(url, this.createHowl(url))
  }

  getHowl(url) {
    if (!this.audioCache.has(url)) {
      this.audioCache.set(url, this.createHowl(url))
    }
    return this.audioCache.get(url)
  }

  /**
   * Play one stimulus. Resolves with { played, delivery, reason } and never
   * rejects - audio is a cue, not a gate, so a broken stimulus costs the
   * player that cue rather than the session.
   */
  async play(url) {
    if (!url) return { played: false, delivery: DELIVERY.NONE, reason: 'no-stimulus' }

    if (!this.filesUnavailable && !this.failed.has(url)) {
      const result = await this.playSoundAsync(this.getHowl(url), url)
      if (result.played) {
        this.delivery = DELIVERY.FILE
        return { played: true, delivery: DELIVERY.FILE, reason: result.reason }
      }
    }

    if (!this.enableFallback) {
      return { played: false, delivery: DELIVERY.NONE, reason: 'unavailable' }
    }
    return this.playFallback(url)
  }

  /** Speech first, tones only once speech has proved itself unusable. */
  async playFallback(url) {
    if (this.speaker?.isUsable()) {
      const text = speechTextFor(url)
      const { spoken, reason } = await this.speaker.speak(text, voiceProfileFor(this.audioSource))
      if (spoken) {
        this.delivery = DELIVERY.SPEECH
        return { played: true, delivery: DELIVERY.SPEECH, reason }
      }
      if (reason === 'cancelled') {
        return { played: false, delivery: DELIVERY.SPEECH, reason }
      }
    }

    if (this.tonePlayer?.isUsable()) {
      const { played, reason } = await this.tonePlayer.play(this.toneIndexFor(url))
      if (played) {
        this.delivery = DELIVERY.TONE
        return { played: true, delivery: DELIVERY.TONE, reason }
      }
    }

    this.delivery = DELIVERY.NONE
    return { played: false, delivery: DELIVERY.NONE, reason: 'unavailable' }
  }

  /**
   * A stimulus must map to the same tone every time, and two stimuli must
   * never share one. Indexing against the loaded pool guarantees both; the
   * hash is only a backstop for a url from outside the current set.
   */
  toneIndexFor(url) {
    if (this.toneIndex.has(url)) return this.toneIndex.get(url)
    let h = 0
    for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0
    return Math.abs(h)
  }

  playSoundAsync(howl, url) {
    return new Promise((resolve) => {
      let settled = false
      let timeoutId

      const finish = (played, reason) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        // Howler keeps these in per-event arrays. Without removing them they
        // accumulate on every trial, because a cached Howl is reused for the
        // whole session and a listener that never fires is never cleared.
        howl.off('end', onEnd)
        howl.off('loaderror', onError)
        howl.off('playerror', onError)
        resolve({ played, reason })
      }

      const onEnd = () => finish(true, 'end')
      const onError = () => {
        this.markFileFailure(url)
        finish(false, 'error')
      }

      howl.on('end', onEnd)
      howl.on('loaderror', onError)
      howl.on('playerror', onError)

      timeoutId = setTimeout(() => finish(false, 'timeout'), this.timeoutMs)

      try {
        const id = howl.play()
        if (id == null) finish(false, 'error')
      } catch (e) {
        console.warn('Audio playback failed', url, e)
        this.markFileFailure(url)
        finish(false, 'error')
      }
    })
  }

  cacheAudioSource(audioSource) {
    const pool = getAudioPool(audioSource)
    if (!Array.isArray(pool) || pool.length === 0) {
      console.warn('Unknown audio source', audioSource)
      this.readyPromise = Promise.resolve()
      return
    }

    this.audioSource = audioSource
    this.toneIndex = new Map(pool.map((url, index) => [url, index]))
    pool.forEach((audio) => this.preload(audio))
    this.readyPromise = this.probe(pool[0])
  }

  /**
   * Settle on a delivery tier before the first trial rather than during it.
   *
   * Without this the first stimulus of a broken session pays the full file
   * timeout before falling back, which reads to the player as the game failing
   * to start. Always resolves.
   */
  probe(url) {
    if (this.filesUnavailable) return Promise.resolve(DELIVERY.SPEECH)

    const howl = this.getHowl(url)
    if (typeof howl.state === 'function' && howl.state() === 'loaded') {
      return Promise.resolve(DELIVERY.FILE)
    }

    return new Promise((resolve) => {
      let settled = false
      const finish = (delivery) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        howl.off('load', onLoad)
        howl.off('loaderror', onError)
        resolve(delivery)
      }

      const onLoad = () => finish(DELIVERY.FILE)
      const onError = () => {
        this.markFileFailure(url)
        finish(DELIVERY.SPEECH)
      }

      howl.on('load', onLoad)
      howl.on('loaderror', onError)
      // A slow network is not a broken one: on timeout keep the files and let
      // the per-trial path decide if they really are gone.
      const timer = setTimeout(() => finish(DELIVERY.FILE), this.probeTimeoutMs)
    })
  }

  /** Resolves once the delivery tier for this source has been settled. */
  whenReady() {
    return this.readyPromise ?? Promise.resolve()
  }

  /** What the player will actually hear, for reporting in the UI. */
  currentDelivery() {
    if (!this.filesUnavailable) return DELIVERY.FILE
    if (this.speaker?.isUsable()) return DELIVERY.SPEECH
    if (this.tonePlayer?.isUsable()) return DELIVERY.TONE
    return DELIVERY.NONE
  }

  stop() {
    this.speaker?.cancel()
  }

  clearCache() {
    for (const howl of this.audioCache.values()) {
      try {
        howl.unload()
      } catch (e) {
        console.debug('Failed to unload sound', e)
      }
    }
    this.audioCache.clear()
    this.failed.clear()
    this.filesUnavailable = false
    this.delivery = DELIVERY.FILE
  }
}

export const audioPlayer = new AudioPlayer()
