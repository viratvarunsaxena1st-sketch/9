import { describe, it, expect } from 'vitest'
import {
  CATALOG,
  DEFAULT_CONFIG,
  QUAD_PAIRS,
  TIER_CYCLE,
  advance,
  blockPeakNLevel,
  buildTierPermutations,
  buildVariants,
  createInitialState,
  describePermutation,
  improvementTarget,
  detectPlateau,
  drawUnused,
  ensureVariant,
  foldGamesIntoDays,
  forceAdvance,
  makeRng,
  nextNLevel,
  permutationId,
  projectSettings,
  startBlock,
  validateSelection,
  variantId,
} from '../src/lib/constantChange.js'

const P = CATALOG.position.length // 2
const A = CATALOG.audio.length // 9
const C = CATALOG.color.length // 4
const S = CATALOG.shape.length // 5
const I = CATALOG.image.length // 2

const day = (n) => `2026-01-${String(n).padStart(2, '0')}`
const dayOf = (ts) => day(ts)

describe('permutation space', () => {
  it('dual = grid x audio', () => {
    expect(buildTierPermutations('dual').length).toBe(P * A)
  })

  it('tri = grid x audio x every single visual set', () => {
    expect(buildTierPermutations('tri').length).toBe(P * A * (C + S + I))
  })

  it('quad = grid x audio x colour x shape only', () => {
    expect(buildTierPermutations('quad').length).toBe(P * A * C * S)
  })

  it('quad never pairs image with anything — it would render on top', () => {
    for (const p of buildTierPermutations('quad')) {
      const families = p.extras.map((e) => e.family).sort()
      expect(families).toEqual(['color', 'shape'])
    }
    expect(QUAD_PAIRS).toEqual([['color', 'shape']])
  })

  it('ids are unique across the whole space', () => {
    const ids = new Set()
    let count = 0
    for (const tier of TIER_CYCLE) {
      for (const p of buildTierPermutations(tier)) {
        ids.add(permutationId(p))
        count++
      }
    }
    expect(ids.size).toBe(count)
    expect(count).toBe(P * A + P * A * (C + S + I) + P * A * C * S)
  })

  it('ids ignore the order extras were listed in', () => {
    const a = { tier: 'quad', position: 'static2D', audio: 'nato', extras: [
      { family: 'color', set: 'neon' }, { family: 'shape', set: 'tetris' }] }
    const b = { tier: 'quad', position: 'static2D', audio: 'nato', extras: [
      { family: 'shape', set: 'tetris' }, { family: 'color', set: 'neon' }] }
    expect(permutationId(a)).toBe(permutationId(b))
  })

  it('describes a permutation with the labels the app already uses', () => {
    const p = { tier: 'tri', position: 'rotate3D', audio: 'syl10', extras: [{ family: 'shape', set: 'iconsA' }] }
    expect(describePermutation(p)).toBe('3D Grid + 10 syllables + Icons A')
  })
})

describe('exclusions', () => {
  it('narrows every tier', () => {
    const enabled = { position: ['static2D'], audio: ['nato', 'numbers'] }
    expect(buildTierPermutations('dual', CATALOG, enabled).length).toBe(2)
    expect(buildTierPermutations('quad', CATALOG, enabled).length).toBe(2 * C * S)
  })

  it('accepts a minimal allow-list', () => {
    const enabled = {
      position: ['rotate3D'], audio: ['nato'],
      color: ['basic'], shape: ['tetris'], image: [],
    }
    const v = validateSelection(CATALOG, enabled)
    expect(v.ok).toBe(true)
    expect(v.counts).toEqual({ dual: 1, tri: 2, quad: 1 })
  })

  it('blocking one permutation removes exactly that one', () => {
    const before = buildTierPermutations('dual')
    const victim = permutationId(before[0])
    const after = buildTierPermutations('dual', CATALOG, null, [victim])
    expect(after.length).toBe(before.length - 1)
    expect(after.map(permutationId).includes(victim)).toBe(false)
  })

  it('rejects a selection with no shape sets, because quad needs one', () => {
    const v = validateSelection(CATALOG, { shape: [] })
    expect(v.ok).toBe(false)
    expect(v.counts.quad).toBe(0)
  })

  it('rejects an empty audio selection', () => {
    expect(validateSelection(CATALOG, { audio: [] }).ok).toBe(false)
  })

  it('image-only visuals still leave tri playable but strand quad', () => {
    const v = validateSelection(CATALOG, { color: [], shape: [] })
    expect(v.counts.tri).toBe(P * A * I)
    expect(v.ok).toBe(false)
  })
})

describe('short-term variants', () => {
  it('2D drops the rotation axis: 24 variants, 3D keeps it: 48', () => {
    const flat = { tier: 'dual', position: 'static2D', audio: 'nato', extras: [] }
    const cube = { tier: 'dual', position: 'rotate3D', audio: 'nato', extras: [] }
    expect(buildVariants(flat).length).toBe(2 * 3 * 4)
    expect(buildVariants(cube).length).toBe(2 * 2 * 3 * 4)
  })

  it('every variant is distinct', () => {
    const cube = { tier: 'dual', position: 'rotate3D', audio: 'nato', extras: [] }
    expect(new Set(buildVariants(cube).map(variantId)).size).toBe(48)
  })

  it('only ever draws the values the brief specified', () => {
    const cube = { tier: 'dual', position: 'rotate3D', audio: 'nato', extras: [] }
    for (const v of buildVariants(cube)) {
      expect([10, 25, 40].includes(v.interference)).toBe(true)
      expect([40, 100, 150, 200].includes(v.numTrials)).toBe(true)
      expect([0, 200].includes(v.rotationSpeed)).toBe(true)
      expect(['show', 'hide'].includes(v.feedback)).toBe(true)
    }
  })
})

describe('no-repeat pools', () => {
  it('exhausts the pool before anything repeats', () => {
    const rng = makeRng(42)
    const all = buildTierPermutations('dual')
    let used = []
    const seen = []
    for (let i = 0; i < all.length; i++) {
      const d = drawUnused(all, used, rng, { idOf: permutationId })
      expect(d.didReset).toBe(false)
      used = d.used
      seen.push(permutationId(d.item))
    }
    expect(new Set(seen).size).toBe(all.length)
  })

  it('refills once empty', () => {
    const rng = makeRng(7)
    const all = buildTierPermutations('dual')
    const d = drawUnused(all, all.map(permutationId), rng, { idOf: permutationId })
    expect(d.didReset).toBe(true)
    expect(d.used.length).toBe(1)
  })

  it('does not repeat across the refill boundary', () => {
    const rng = makeRng(3)
    const all = buildTierPermutations('dual')
    const last = permutationId(all[2])
    for (let i = 0; i < 40; i++) {
      const d = drawUnused(all, all.map(permutationId), rng, { avoid: last, idOf: permutationId })
      expect(permutationId(d.item)).not.toBe(last)
    }
  })
})

describe('plateau detection', () => {
  const d = (nLevel, accuracy, i) => ({ date: day(i), nLevel, accuracy })

  it('needs a full window first', () => {
    expect(detectPlateau([d(2, 50, 1), d(2, 50, 2)]).plateau).toBe(false)
  })

  it('ignores a rising n-level', () => {
    expect(detectPlateau([d(2, 60, 1), d(3, 60, 2), d(4, 60, 3)]).plateau).toBe(false)
  })

  it('a falling n-level is allowed and does not trigger a change', () => {
    expect(detectPlateau([d(4, 60, 1), d(3, 55, 2), d(2, 50, 3)]).plateau).toBe(false)
  })

  it('holds off while the 15% relative gain is met', () => {
    const r = detectPlateau([d(3, 60, 1), d(3, 65, 2), d(3, 69, 3)])
    expect(r.plateau).toBe(false)
    expect(r.target).toBe(69)
  })

  it('fires when n is flat and the gain falls short', () => {
    const r = detectPlateau([d(3, 60, 1), d(3, 65, 2), d(3, 68, 3)])
    expect(r.plateau).toBe(true)
    expect(r.nLevel).toBe(3)
  })

  it('fires when accuracy went backwards', () => {
    expect(detectPlateau([d(3, 70, 1), d(3, 65, 2), d(3, 60, 3)]).plateau).toBe(true)
  })

  it('only looks at the most recent window', () => {
    expect(detectPlateau([d(2, 10, 1), d(5, 90, 2), d(3, 60, 3), d(3, 65, 4), d(3, 61, 5)]).plateau).toBe(true)
  })

  it('absolute mode needs 15 percentage points', () => {
    const cfg = { ...DEFAULT_CONFIG, improvementMode: 'absolute' }
    expect(detectPlateau([d(3, 60, 1), d(3, 65, 2), d(3, 74, 3)], cfg).plateau).toBe(true)
    expect(detectPlateau([d(3, 60, 1), d(3, 65, 2), d(3, 75, 3)], cfg).plateau).toBe(false)
  })

  it('mastery always plateaus — the bar is unreachable near the ceiling', () => {
    expect(detectPlateau([d(3, 95, 1), d(3, 96, 2), d(3, 97, 3)]).plateau).toBe(true)
  })

  it('respects a widened window', () => {
    const cfg = { ...DEFAULT_CONFIG, plateauWindow: 4 }
    const flat = [d(3, 60, 1), d(3, 60, 2), d(3, 60, 3)]
    expect(detectPlateau(flat, cfg).plateau).toBe(false)
    expect(detectPlateau([...flat, d(3, 60, 4)], cfg).plateau).toBe(true)
  })
})

describe('the improvement target cannot collapse', () => {
  const flat = (accuracy) => [
    { date: 'a', nLevel: 3, accuracy },
    { date: 'b', nLevel: 3, accuracy },
    { date: 'c', nLevel: 3, accuracy },
  ]

  // A multiplicative target derived from zero is zero, and zero clears zero.
  // A player scoring nothing was told they were improving, so their block
  // never ended and the permutation never changed.
  it('a player stuck at zero still plateaus', () => {
    expect(detectPlateau(flat(0)).plateau).toBe(true)
  })

  it('a real gain from zero is still counted as improvement', () => {
    const climbing = flat(0)
    climbing[2] = { date: 'c', nLevel: 3, accuracy: 10 }
    expect(detectPlateau(climbing).plateau).toBe(false)
  })

  it('the floor only binds at the bottom of the range', () => {
    expect(improvementTarget(0)).toBe(2)
    expect(improvementTarget(4)).toBe(6)
    // 15 * 1.15 = 17.25, already past the 17 the floor would ask for.
    expect(improvementTarget(15)).toBeCloseTo(17.25)
    expect(improvementTarget(60)).toBeCloseTo(69)
  })

  it('absolute mode is unaffected by the floor', () => {
    expect(improvementTarget(0, { improvementMode: 'absolute', improvementThreshold: 15 })).toBe(15)
    expect(improvementTarget(40, { improvementMode: 'absolute', improvementThreshold: 15 })).toBe(55)
  })
})

describe('n-level handoff', () => {
  it('dual to tri divides by 3/2', () => {
    expect(nextNLevel('dual', 'tri', 6)).toBe(4)
    expect(nextNLevel('dual', 'tri', 7)).toBe(4)
    expect(nextNLevel('dual', 'tri', 8)).toBe(5)
  })

  it('tri to quad divides by 4/3', () => {
    expect(nextNLevel('tri', 'quad', 4)).toBe(3)
    expect(nextNLevel('tri', 'quad', 8)).toBe(6)
  })

  it('quad to dual scales back up by 2', () => {
    expect(nextNLevel('quad', 'dual', 3)).toBe(6)
  })

  it('a full lap at flat performance returns to the same dual level', () => {
    const tri = nextNLevel('dual', 'tri', 6)
    const quad = nextNLevel('tri', 'quad', tri)
    expect(nextNLevel('quad', 'dual', quad)).toBe(6)
  })

  it('literal halving collapses the ladder, which is why it is not the default', () => {
    const cfg = { ...DEFAULT_CONFIG, literalQuadToDualHalving: true }
    const tri = nextNLevel('dual', 'tri', 4, cfg)
    const quad = nextNLevel('tri', 'quad', tri, cfg)
    expect(nextNLevel('quad', 'dual', quad, cfg)).toBe(cfg.minNLevel)
  })

  it('clamps to the app n-back range', () => {
    expect(nextNLevel('dual', 'tri', 1)).toBe(1)
    expect(nextNLevel('quad', 'dual', 12)).toBe(12)
  })
})

describe('folding game records into training days', () => {
  const game = (ts, nBack, percent, extra = {}) => ({
    timestamp: ts, nBack, status: 'completed', total: { percent }, ...extra,
  })

  it('takes the highest n and the mean accuracy of a day', () => {
    const days = foldGamesIntoDays([game(1, 2, 0.6), game(1, 3, 0.8)], dayOf)
    expect(days.length).toBe(1)
    expect(days[0].nLevel).toBe(3)
    expect(days[0].accuracy).toBe(70)
    expect(days[0].sessions).toBe(2)
  })

  it('skips cancelled games and tombstones', () => {
    const rows = [game(1, 3, 0.9), game(1, 9, 0.1, { status: 'cancelled' }), { timestamp: 1, status: 'tombstone' }]
    const days = foldGamesIntoDays(rows, dayOf)
    expect(days[0].nLevel).toBe(3)
    expect(days[0].sessions).toBe(1)
  })

  it('returns days oldest first regardless of input order', () => {
    const days = foldGamesIntoDays([game(3, 2, 0.5), game(1, 2, 0.5), game(2, 2, 0.5)], dayOf)
    expect(days.map((d) => d.date)).toEqual([day(1), day(2), day(3)])
  })
})

describe('block lifecycle', () => {
  const flatDays = (n, level, acc) =>
    Array.from({ length: n }, (_, i) => ({ date: day(i + 1), nLevel: level, accuracy: acc }))

  it('starts on dual', () => {
    const state = createInitialState()
    startBlock(state, 'dual', 3, makeRng(1), 1000)
    expect(state.current.tier).toBe('dual')
    expect(state.current.startNLevel).toBe(3)
  })

  it('walks dual to tri to quad and back to dual', () => {
    const state = createInitialState({ seedNLevel: 6 })
    const rng = makeRng(11)
    startBlock(state, 'dual', 6, rng, 0)
    const seen = []
    for (let i = 0; i < 4; i++) {
      seen.push(state.current.tier)
      advance(state, flatDays(3, 6, 50), rng, i * 1000)
    }
    expect(seen).toEqual(['dual', 'tri', 'quad', 'dual'])
  })

  it('carries the peak n across a change, not the starting n', () => {
    const state = createInitialState()
    const rng = makeRng(5)
    startBlock(state, 'dual', 3, rng, 0)
    const days = [
      { date: day(1), nLevel: 3, accuracy: 50 },
      { date: day(2), nLevel: 9, accuracy: 50 },
      { date: day(3), nLevel: 3, accuracy: 50 },
      { date: day(4), nLevel: 3, accuracy: 50 },
      { date: day(5), nLevel: 3, accuracy: 50 },
    ]
    const res = advance(state, days, rng, 1000)
    expect(res.switched).toBe(true)
    expect(res.from.peakNLevel).toBe(9)
    expect(state.current.startNLevel).toBe(6) // floor(9 * 2/3)
  })

  it('a change resets the day-variant pool', () => {
    const state = createInitialState()
    const rng = makeRng(9)
    startBlock(state, 'dual', 3, rng, 0)
    ensureVariant(state, day(1), rng)
    ensureVariant(state, day(2), rng)
    expect(state.current.variantPool.length).toBe(2)
    advance(state, flatDays(3, 3, 50), rng, 1000)
    expect(state.current.variantPool.length).toBe(0)
  })

  it('keeps the block alive while the player improves', () => {
    const state = createInitialState()
    const rng = makeRng(21)
    startBlock(state, 'dual', 3, rng, 0)
    const days = [
      { date: day(1), nLevel: 3, accuracy: 40 },
      { date: day(2), nLevel: 3, accuracy: 48 },
      { date: day(3), nLevel: 3, accuracy: 58 },
    ]
    expect(advance(state, days, rng, 1000).switched).toBe(false)
    expect(state.history.length).toBe(0)
  })

  it('records why each block ended', () => {
    const state = createInitialState()
    const rng = makeRng(33)
    startBlock(state, 'dual', 4, rng, 0)
    advance(state, flatDays(3, 4, 55), rng, 1000)
    expect(state.history.length).toBe(1)
    expect(state.history[0].tier).toBe('dual')
    expect(state.history[0].days).toBe(3)
    expect(typeof state.history[0].reason).toBe('string')
  })

  it('a forced change still advances the tier and the ladder', () => {
    const state = createInitialState()
    const rng = makeRng(4)
    startBlock(state, 'dual', 6, rng, 0)
    forceAdvance(state, rng, 500)
    expect(state.current.tier).toBe('tri')
    expect(state.current.startNLevel).toBe(4)
    expect(state.history[0].reason).toBe('changed manually')
  })

  it('the day variant is sticky within a day and redrawn the next', () => {
    const state = createInitialState()
    const rng = makeRng(77)
    startBlock(state, 'dual', 3, rng, 0)
    const a = ensureVariant(state, day(1), rng)
    const b = ensureVariant(state, day(1), rng)
    expect(variantId(a)).toBe(variantId(b))
    const c = ensureVariant(state, day(2), rng)
    expect(variantId(c)).not.toBe(variantId(a))
  })

  it('peak n falls back to the block start before any days are logged', () => {
    const state = createInitialState()
    startBlock(state, 'quad', 5, makeRng(1), 0)
    expect(blockPeakNLevel(state.current)).toBe(5)
  })
})

describe('projection onto quad-box settings', () => {
  const project = (tier, position, extras, variant) =>
    projectSettings(
      { tier, permutation: { tier, position, audio: 'nato', extras } },
      variant,
    )

  it('a dual block turns every visual channel off', () => {
    const { gameFields } = project('dual', 'rotate3D', [],
      { feedback: 'show', rotationSpeed: 0, interference: 10, numTrials: 40 })
    expect(gameFields.enableAudio).toBe(true)
    expect(gameFields.enableColor).toBe(false)
    expect(gameFields.enableShape).toBe(false)
    expect(gameFields.enableImage).toBe(false)
    expect(gameFields.audioSource).toBe('nato')
  })

  it('a quad block enables colour and shape with the drawn sources', () => {
    const { gameFields, globalFields } = project('quad', 'rotate3D',
      [{ family: 'color', set: 'gradient' }, { family: 'shape', set: 'iconsB' }],
      { feedback: 'hide', rotationSpeed: 200, interference: 40, numTrials: 150 })
    expect(gameFields.enableColor).toBe(true)
    expect(gameFields.colorSource).toBe('gradient')
    expect(gameFields.enableShape).toBe(true)
    expect(gameFields.shapeSource).toBe('iconsB')
    expect(gameFields.enableImage).toBe(false)
    expect(gameFields.numTrials).toBe(150)
    expect(gameFields.interference).toBe(40)
    expect(globalFields.feedback).toBe('hide')
    expect(globalFields.rotationSpeed).toBe(200)
  })

  it('leaves rotation speed alone on a 2D grid', () => {
    const { gameFields, globalFields } = project('tri', 'static2D',
      [{ family: 'image', set: 'generative' }],
      { feedback: 'show', rotationSpeed: null, interference: 25, numTrials: 100 })
    expect(gameFields.grid).toBe('static2D')
    expect(gameFields.enableImage).toBe(true)
    expect(gameFields.imageSource).toBe('generative')
    expect('rotationSpeed' in globalFields).toBe(false)
  })

  it('never writes nBack — auto-progression owns it once a block is running', () => {
    const { gameFields } = project('dual', 'rotate3D', [],
      { feedback: 'show', rotationSpeed: 0, interference: 10, numTrials: 40 })
    expect('nBack' in gameFields).toBe(false)
  })

  it('does not clobber the source of a channel that is switched off', () => {
    const { gameFields } = project('dual', 'rotate3D', [], null)
    expect('colorSource' in gameFields).toBe(false)
    expect('shapeSource' in gameFields).toBe(false)
  })
})
