/**
 * What each recorded stimulus should become when the file is unavailable.
 *
 * The fallback has to preserve the property the task depends on: two stimuli
 * are the same if and only if they were the same before. So the mapping is
 * total, deterministic, and injective within a pool - never a hash that could
 * collide and hand the player a match that is not there.
 */

const NATO = {
  a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta', e: 'Echo', f: 'Foxtrot',
  g: 'Golf', h: 'Hotel', i: 'India', j: 'Juliet', k: 'Kilo', l: 'Lima',
  m: 'Mike', n: 'November', o: 'Oscar', p: 'Papa', q: 'Quebec', r: 'Romeo',
  s: 'Sierra', t: 'Tango', u: 'Uniform', v: 'Victor', w: 'Whiskey',
  x: 'X-ray', y: 'Yankee', z: 'Zulu',
}

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

/** Open syllables that survive most speech engines without being re-read as words. */
const ONSETS = ['b', 'd', 'f', 'g', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z']
const NUCLEI = ['a', 'e', 'i', 'o', 'u']

/** Splits 'LettersM1/a' into its folder and key. */
export const splitStimulus = (url) => {
  const [folder, key] = String(url ?? '').split('/')
  return { folder: folder ?? '', key: key ?? folder ?? '' }
}

const hash = (text) => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const seededRng = (seed) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The syllable sets are multi-syllable nonsense utterances - roughly five and
 * ten syllables, judging by the recordings. Rebuild something of the same
 * shape rather than reading out a bare letter, because the length is the
 * point: it is what loads the phonological loop.
 */
const syllables = (key, count) => {
  const rng = seededRng(hash(key))
  const out = []
  let lastOnset = null
  for (let i = 0; i < count; i++) {
    let onset = ONSETS[Math.floor(rng() * ONSETS.length)]
    if (onset === lastOnset) onset = ONSETS[(ONSETS.indexOf(onset) + 1) % ONSETS.length]
    lastOnset = onset
    out.push(onset + NUCLEI[Math.floor(rng() * NUCLEI.length)])
  }
  return out.join(' ')
}

/** The words a speech engine should say in place of a missing recording. */
export const speechTextFor = (url) => {
  const { folder, key } = splitStimulus(url)
  if (!key) return ''

  if (folder === 'Nato') return NATO[key.toLowerCase()] ?? key.toUpperCase()
  if (folder === 'Natural-Numbers') {
    const n = Number(key)
    return Number.isInteger(n) && DIGITS[n] ? DIGITS[n] : key
  }
  if (folder === 'syl5') return syllables(key, 5)
  if (folder === 'syl10') return syllables(key, 10)

  // Every Letters set. A lone capital is read as the letter name by the
  // engines that matter; lowercase gets read as the word "a".
  return key.toUpperCase()
}

/**
 * Speech parameters per audio set.
 *
 * Constant Change treats the audio set as one of its permutation dimensions,
 * so collapsing nine sets onto one identical voice would quietly delete a
 * whole axis of variation. Voice choice is best effort - the Web Speech API
 * exposes no reliable gender - so rate and pitch carry the difference when the
 * device only has one voice installed.
 */
export const VOICE_PROFILES = {
  letters2: { pitch: 0.75, rate: 0.95, prefer: 'male' },
  letters3: { pitch: 0.85, rate: 1.05, prefer: 'male' },
  letters5: { pitch: 1.25, rate: 0.95, prefer: 'female' },
  letters4: { pitch: 1.15, rate: 1.05, prefer: 'female' },
  letters: { pitch: 1.35, rate: 1.0, prefer: 'female' },
  numbers: { pitch: 1.0, rate: 0.95, prefer: null },
  nato: { pitch: 0.95, rate: 1.0, prefer: null },
  syl5: { pitch: 1.05, rate: 1.15, prefer: null },
  syl10: { pitch: 1.05, rate: 1.25, prefer: null },
}

export const voiceProfileFor = (audioSource) =>
  VOICE_PROFILES[audioSource] ?? { pitch: 1.0, rate: 1.0, prefer: null }

/**
 * The tone of last resort.
 *
 * Twenty-six distinct pitches would either climb to a shrill 7kHz or crowd
 * into steps too fine to tell apart from memory - and telling them apart from
 * memory is the entire task. So the tone carries two features instead of one:
 * nine pentatonic pitches across two comfortable octaves, each in a steady,
 * rising or falling contour. Twenty-seven combinations, all easy to hold in
 * mind, none above 1kHz.
 */
const PENTATONIC = [0, 3, 5, 7, 10]
const SHAPES = ['steady', 'rising', 'falling']
const TONE_PITCHES = 9

export const TONE_CAPACITY = TONE_PITCHES * SHAPES.length

export const toneFrequency = (pitchIndex) => {
  const i = pitchIndex % TONE_PITCHES
  const semitones = PENTATONIC[i % PENTATONIC.length] + Math.floor(i / PENTATONIC.length) * 12
  return Math.round(220 * Math.pow(2, semitones / 12) * 10) / 10
}

/** Maps a pool index to a distinct audible stimulus. Injective below TONE_CAPACITY. */
export const toneSpec = (index) => {
  const i = ((index % TONE_CAPACITY) + TONE_CAPACITY) % TONE_CAPACITY
  return {
    frequency: toneFrequency(i % TONE_PITCHES),
    shape: SHAPES[Math.floor(i / TONE_PITCHES)],
  }
}
