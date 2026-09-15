/**
 * Constant Change — scheduling engine.
 *
 * Pure and dependency-free: no DOM, no stores, no IndexedDB. Everything is a
 * function of (state, config), so it can be unit-tested and replayed.
 *
 * Two clocks run at once.
 *   LONG TERM  — the *permutation*: which modalities run and which stimulus set
 *                each one draws from. Changes only on a plateau.
 *   SHORT TERM — the *variant*: feedback, rotation, interference, trial count.
 *                Redrawn every training day.
 *
 * Both use exhaustive no-repeat pools: nothing repeats until the pool it came
 * from is empty, at which point the pool refills.
 */

// ---------------------------------------------------------------------------
// CATALOG
// ---------------------------------------------------------------------------
// Single source of truth for the permutation space. Pool sizes, the exclusion
// UI and the in-app explainer all derive from this object, so they cannot drift
// apart. Ids match quad-box's own settings values exactly.

export const CATALOG = {
  position: [
    { id: 'rotate3D', label: '3D Grid', dimension: '3d' },
    { id: 'static2D', label: '2D Grid', dimension: '2d' },
  ],
  audio: [
    { id: 'letters2', label: 'Letters M1' },
    { id: 'letters3', label: 'Letters M2' },
    { id: 'letters5', label: 'Letters F1' },
    { id: 'letters4', label: 'Letters F2' },
    { id: 'letters', label: 'Letters F3' },
    { id: 'numbers', label: 'Numbers' },
    { id: 'nato', label: 'NATO' },
    { id: 'syl5', label: '5 syllables' },
    { id: 'syl10', label: '10 syllables' },
  ],
  color: [
    { id: 'basic', label: 'Basic' },
    { id: 'gradient', label: 'Gradient' },
    { id: 'voronoi', label: 'Voronoi' },
    { id: 'generative', label: 'Generative Art' },
  ],
  shape: [
    { id: 'basic', label: 'Basic' },
    { id: 'tetris', label: 'Tetris' },
    { id: 'iconsA', label: 'Icons A' },
    { id: 'iconsB', label: 'Icons B' },
    { id: 'all', label: 'All Shapes' },
  ],
  image: [
    { id: 'voronoi', label: 'Voronoi' },
    { id: 'generative', label: 'Generative Art' },
  ],
}

/** Visual families that lift dual -> tri -> quad. */
export const EXTRA_FAMILIES = ['color', 'shape', 'image']

/**
 * Which pairs of visual families quad may use.
 *
 * Only colour+shape. This is a hard rendering constraint, not a preference:
 * trialUtils.createSvgId() short-circuits on `image`, and findBoxColor()
 * returns '' whenever an image is present. So an image drawn alongside a
 * colour or shape hides that other stimulus completely while the game still
 * generates and scores it — the player would be asked to track something
 * invisible. Colour+shape is the only renderable pair, and it is exactly what
 * quad-box already calls "quad".
 */
export const QUAD_PAIRS = [['color', 'shape']]

export const TIER_CYCLE = ['dual', 'tri', 'quad']

/** Simultaneous streams per tier. Drives the n-level handoff. */
export const MODALITY_COUNT = { dual: 2, tri: 3, quad: 4 }

// ---------------------------------------------------------------------------
// SHORT-TERM VARIANT AXES
// ---------------------------------------------------------------------------

export const VARIANT_AXES = {
  feedback: ['show', 'hide'],
  rotationSpeed: [0, 200], // 3D only; collapsed away on a 2D grid
  interference: [10, 25, 40],
  numTrials: [40, 100, 150, 200],
}

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  /** n-level the very first time Constant Change runs. */
  seedNLevel: 2,
  minNLevel: 1,
  maxNLevel: 12, // matches the app's own n-back ceiling

  /** 'relative' => day3 >= day1 * 1.15 ; 'absolute' => day3 >= day1 + 15 */
  improvementMode: 'relative',
  improvementThreshold: 15,

  /**
   * Floor under the relative target, in accuracy points.
   *
   * A multiplicative target collapses as accuracy approaches zero: 0 * 1.15 is
   * still 0, and 0 >= 0 reads as "improving", so a player scoring nothing would
   * be told they were progressing and the permutation would never change. The
   * floor keeps a real gain required at the bottom of the range. It is small
   * enough that it never binds anywhere else: at 15% accuracy the relative
   * target is already 17.3, well past 17.
   */
  minImprovementPoints: 2,

  /** Training days of flat n required before a plateau can fire. */
  plateauWindow: 3,

  /**
   * quad -> dual handoff.
   *   false (default): n * 2   — keeps the ladder self-consistent
   *   true:            n / 2   — the literal reading of the brief
   */
  literalQuadToDualHalving: false,

  /** Avoid drawing the same permutation twice across a pool refill. */
  avoidImmediateRepeat: true,

  /** 'day' locks the variant for a whole training day; 'session' redraws it. */
  variantScope: 'day',
}

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so runs can be replayed in tests. */
export function makeRng(seed = 1) {
  let a = seed >>> 0
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (list, rng) => list[Math.floor(rng() * list.length)]

// ---------------------------------------------------------------------------
// PERMUTATION SPACE
// ---------------------------------------------------------------------------

/**
 * { tier, position, audio, extras: [{ family, set }, ...] }
 * extras is empty for dual, one entry for tri, a QUAD_PAIRS pair for quad.
 */

export function permutationId(p) {
  const extras = p.extras
    .map((e) => `${e.family}:${e.set}`)
    .slice()
    .sort()
    .join('+')
  return `${p.tier}|${p.position}|${p.audio}${extras ? '|' + extras : ''}`
}

export function describePermutation(p, catalog = CATALOG) {
  const label = (family, id) => catalog[family].find((o) => o.id === id)?.label ?? id
  const parts = [label('position', p.position), label('audio', p.audio)]
  for (const e of p.extras) parts.push(label(e.family, e.set))
  return parts.join(' + ')
}

/** Normalise an enabled map into arrays of ids. null/undefined = everything on. */
function resolveEnabled(catalog, enabled) {
  const out = {}
  for (const family of Object.keys(catalog)) {
    const all = catalog[family].map((o) => o.id)
    const chosen = enabled?.[family]
    out[family] = chosen == null ? all : all.filter((id) => chosen.includes(id))
  }
  return out
}

/** Every permutation for one tier, after exclusions. Deterministic ordering. */
export function buildTierPermutations(tier, catalog = CATALOG, enabled = null, blocked = []) {
  const on = resolveEnabled(catalog, enabled)
  const blockedSet = new Set(blocked)
  const out = []

  const extraCombos = []
  if (tier === 'dual') {
    extraCombos.push([])
  } else if (tier === 'tri') {
    for (const family of EXTRA_FAMILIES) {
      for (const set of on[family]) extraCombos.push([{ family, set }])
    }
  } else if (tier === 'quad') {
    for (const [fa, fb] of QUAD_PAIRS) {
      for (const a of on[fa]) {
        for (const b of on[fb]) {
          extraCombos.push([
            { family: fa, set: a },
            { family: fb, set: b },
          ])
        }
      }
    }
  }

  for (const position of on.position) {
    for (const audio of on.audio) {
      for (const extras of extraCombos) {
        const p = { tier, position, audio, extras }
        if (!blockedSet.has(permutationId(p))) out.push(p)
      }
    }
  }
  return out
}

export function buildAllPermutations(catalog = CATALOG, enabled = null, blocked = []) {
  const out = {}
  for (const tier of TIER_CYCLE) out[tier] = buildTierPermutations(tier, catalog, enabled, blocked)
  return out
}

/** Exclusions must never strand the rotation. */
export function validateSelection(catalog = CATALOG, enabled = null, blocked = []) {
  const on = resolveEnabled(catalog, enabled)
  const errors = []

  if (on.position.length === 0) errors.push('Enable at least one grid.')
  if (on.audio.length === 0) errors.push('Enable at least one audio set.')

  const withSets = EXTRA_FAMILIES.filter((f) => on[f].length > 0)
  if (withSets.length === 0) errors.push('Tri n-back needs at least one colour, shape or image set.')

  const quadOk = QUAD_PAIRS.some(([a, b]) => on[a].length > 0 && on[b].length > 0)
  if (!quadOk) errors.push('Quad n-back needs at least one colour set and one shape set.')

  const perms = buildAllPermutations(catalog, enabled, blocked)
  for (const tier of TIER_CYCLE) {
    if (perms[tier].length === 0) errors.push(`No ${tier} permutations remain after exclusions.`)
  }

  return {
    ok: errors.length === 0,
    errors,
    counts: Object.fromEntries(TIER_CYCLE.map((t) => [t, perms[t].length])),
    total: TIER_CYCLE.reduce((n, t) => n + perms[t].length, 0),
  }
}

// ---------------------------------------------------------------------------
// SHORT-TERM VARIANTS
// ---------------------------------------------------------------------------

export function variantId(v) {
  return [
    `fb-${v.feedback}`,
    v.rotationSpeed === null ? 'rot-na' : `rot${v.rotationSpeed}`,
    `int${v.interference}`,
    `tr${v.numTrials}`,
  ].join('|')
}

/**
 * Rotation speed only matters on a 3D grid, so that axis collapses on 2D
 * rather than wasting half the pool on visually identical duplicates.
 * 3D => 48 variants, 2D => 24.
 */
export function buildVariants(permutation, catalog = CATALOG) {
  const posDef = catalog.position.find((o) => o.id === permutation.position)
  const rotations = posDef?.dimension === '3d' ? VARIANT_AXES.rotationSpeed : [null]

  const out = []
  for (const feedback of VARIANT_AXES.feedback) {
    for (const rotationSpeed of rotations) {
      for (const interference of VARIANT_AXES.interference) {
        for (const numTrials of VARIANT_AXES.numTrials) {
          out.push({ feedback, rotationSpeed, interference, numTrials })
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// NO-REPEAT DRAW
// ---------------------------------------------------------------------------

/**
 * Draw from `all`, skipping anything in `used`. When everything has been used
 * the pool refills; on a refill the item we just came from is skipped so the
 * reset never surfaces as a back-to-back repeat.
 */
export function drawUnused(all, used, rng, { avoid = null, idOf } = {}) {
  const usedSet = new Set(used)
  let remaining = all.filter((x) => !usedSet.has(idOf(x)))
  let didReset = false

  if (remaining.length === 0) {
    didReset = true
    remaining = all.slice()
    if (avoid && remaining.length > 1) {
      const trimmed = remaining.filter((x) => idOf(x) !== avoid)
      if (trimmed.length > 0) remaining = trimmed
    }
    used = []
  }

  const item = pick(remaining, rng)
  return { item, used: [...used, idOf(item)], didReset }
}

// ---------------------------------------------------------------------------
// PLATEAU DETECTION
// ---------------------------------------------------------------------------

/**
 * `days` is the current block's training days, oldest first:
 *   { date, nLevel, accuracy }   nLevel = highest n that day, accuracy = 0-100 mean
 *
 * Fires only when the last N training days share an identical n-level AND the
 * newest day failed to beat the oldest of that window by the threshold.
 * A falling n-level breaks the streak and so never triggers a switch on its own.
 */
/**
 * Accuracy the newest day of the window has to reach for the block to count as
 * still improving. Relative mode is floored so the target cannot collapse to
 * zero along with the score it is derived from.
 */
export function improvementTarget(baseline, config = DEFAULT_CONFIG) {
  if (config.improvementMode === 'absolute') {
    return baseline + config.improvementThreshold
  }
  const relative = baseline * (1 + config.improvementThreshold / 100)
  const floor = baseline + (config.minImprovementPoints ?? 0)
  return Math.max(relative, floor)
}

export function detectPlateau(days, config = DEFAULT_CONFIG) {
  const w = config.plateauWindow
  if (days.length < w) {
    return {
      plateau: false,
      reason: `${days.length} of ${w} training days logged`,
      daysToGo: w - days.length,
    }
  }

  const window = days.slice(-w)
  const flat = window.every((d) => d.nLevel === window[0].nLevel)
  if (!flat) {
    return {
      plateau: false,
      reason: `n-level moved across the last ${w} days (${window.map((d) => d.nLevel).join(', ')})`,
    }
  }

  const first = window[0]
  const last = window[w - 1]
  const target = improvementTarget(first.accuracy, config)

  if (last.accuracy >= target) {
    return {
      plateau: false,
      reason: `still improving — ${last.accuracy.toFixed(1)}% clears the ${target.toFixed(1)}% target`,
      target,
    }
  }

  return {
    plateau: true,
    reason: `n stuck at ${first.nLevel} for ${w} days and ${last.accuracy.toFixed(1)}% missed the ${target.toFixed(1)}% target`,
    target,
    nLevel: first.nLevel,
  }
}

// ---------------------------------------------------------------------------
// N-LEVEL HANDOFF
// ---------------------------------------------------------------------------

/**
 *   dual -> tri   n * 2/3   (brief: "divided by 3/2")
 *   tri  -> quad  n * 3/4   (brief: "divided by 4/3")
 *   quad -> dual  n * 4/2   (brief says "divided by 2" — see the PDF)
 *
 * General form: n_next = floor(n_peak * modalities_from / modalities_to)
 */
export function nextNLevel(fromTier, toTier, maxN, config = DEFAULT_CONFIG) {
  let scaled
  if (config.literalQuadToDualHalving && fromTier === 'quad' && toTier === 'dual') {
    scaled = Math.floor(maxN / 2)
  } else {
    scaled = Math.floor((maxN * MODALITY_COUNT[fromTier]) / MODALITY_COUNT[toTier])
  }
  return Math.max(config.minNLevel, Math.min(config.maxNLevel, scaled))
}

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

export const STATE_VERSION = 1

export function createInitialState(config = {}) {
  return {
    version: STATE_VERSION,
    config: { ...DEFAULT_CONFIG, ...config },
    enabled: null, // null = everything on
    blocked: [],
    cycleIndex: 0,
    pools: { dual: [], tri: [], quad: [] }, // used permutation ids per tier
    lastDrawn: { dual: null, tri: null, quad: null },
    current: null,
    history: [],
  }
}

/**
 * Begin a new block. `startedAt` is a timestamp; games recorded from this
 * moment on belong to the block, which is how the day log stays derived from
 * the real game history rather than accumulated separately.
 */
export function startBlock(state, tier, nLevel, rng, startedAt, catalog = CATALOG) {
  const all = buildTierPermutations(tier, catalog, state.enabled, state.blocked)
  if (all.length === 0) throw new Error(`No ${tier} permutations available — check exclusions.`)

  const draw = drawUnused(all, state.pools[tier], rng, {
    avoid: state.config.avoidImmediateRepeat ? state.lastDrawn[tier] : null,
    idOf: permutationId,
  })

  state.pools[tier] = draw.used
  state.lastDrawn[tier] = permutationId(draw.item)
  state.current = {
    tier,
    permutation: draw.item,
    permutationId: permutationId(draw.item),
    startNLevel: nLevel,
    startedAt,
    days: [],
    variantPool: [],
    variant: null,
    variantDay: null,
    poolDidReset: draw.didReset,
    poolSize: all.length,
  }
  return state.current
}

export function ensureBlock(state, rng, startedAt, catalog = CATALOG) {
  if (!state.current) {
    startBlock(state, TIER_CYCLE[state.cycleIndex], state.config.seedNLevel, rng, startedAt, catalog)
  }
  return state.current
}

/** Highest n reached during the current block, falling back to its start level. */
export function blockPeakNLevel(block) {
  return block.days.reduce((max, d) => Math.max(max, d.nLevel), block.startNLevel)
}

// ---------------------------------------------------------------------------
// DAY VARIANT
// ---------------------------------------------------------------------------

/**
 * Draw the variant for `day` if it has not been drawn yet. With
 * variantScope 'day' the draw is sticky for the whole training day, so every
 * session that day shares one trial count and interference level — which is
 * what makes comparing day 1 with day 3 meaningful.
 */
export function ensureVariant(state, day, rng, catalog = CATALOG) {
  const block = state.current
  if (!block) return null
  const sticky = state.config.variantScope === 'day'
  if (sticky && block.variant && block.variantDay === day) return block.variant

  const all = buildVariants(block.permutation, catalog)
  const draw = drawUnused(all, block.variantPool, rng, { idOf: variantId })
  block.variantPool = draw.used
  block.variant = draw.item
  block.variantDay = day
  return draw.item
}

// ---------------------------------------------------------------------------
// ADVANCE
// ---------------------------------------------------------------------------

/**
 * Replace the block's day log with freshly derived days and decide whether the
 * permutation should change. `days` comes from the game database, so the
 * scheduler self-heals if a session is missed or history is deleted.
 *
 * Returns { switched, verdict, from?, to? }.
 */
export function advance(state, days, rng, now, catalog = CATALOG) {
  const block = state.current
  if (!block) return { switched: false, verdict: { plateau: false, reason: 'no block' } }

  block.days = days

  const verdict = detectPlateau(block.days, state.config)
  if (!verdict.plateau) return { switched: false, verdict }

  const fromTier = block.tier
  const toTier = TIER_CYCLE[(state.cycleIndex + 1) % TIER_CYCLE.length]
  const peak = blockPeakNLevel(block)
  const carried = nextNLevel(fromTier, toTier, peak, state.config)

  state.history.unshift({
    tier: fromTier,
    permutationId: block.permutationId,
    label: describePermutation(block.permutation, catalog),
    days: block.days.length,
    startNLevel: block.startNLevel,
    peakNLevel: peak,
    carried,
    toTier,
    endedAt: now,
    reason: verdict.reason,
  })
  state.history = state.history.slice(0, 40)

  state.cycleIndex = (state.cycleIndex + 1) % TIER_CYCLE.length
  const next = startBlock(state, toTier, carried, rng, now, catalog)

  return {
    switched: true,
    verdict,
    from: { tier: fromTier, peakNLevel: peak },
    to: { tier: toTier, nLevel: carried, label: describePermutation(next.permutation, catalog) },
  }
}

/** Force a change without a plateau (the "Change now" button). */
export function forceAdvance(state, rng, now, catalog = CATALOG) {
  const block = state.current
  if (!block) return null
  const fromTier = block.tier
  const toTier = TIER_CYCLE[(state.cycleIndex + 1) % TIER_CYCLE.length]
  const peak = blockPeakNLevel(block)
  const carried = nextNLevel(fromTier, toTier, peak, state.config)

  state.history.unshift({
    tier: fromTier,
    permutationId: block.permutationId,
    label: describePermutation(block.permutation, catalog),
    days: block.days.length,
    startNLevel: block.startNLevel,
    peakNLevel: peak,
    carried,
    toTier,
    endedAt: now,
    reason: 'changed manually',
  })
  state.history = state.history.slice(0, 40)

  state.cycleIndex = (state.cycleIndex + 1) % TIER_CYCLE.length
  return startBlock(state, toTier, carried, rng, now, catalog)
}

// ---------------------------------------------------------------------------
// SETTINGS PROJECTION
// ---------------------------------------------------------------------------

/**
 * Project the active block + variant onto quad-box's settings shape.
 *
 * `gameFields` go into settings.gameSettings.constant, `globalFields` are
 * app-wide. nBack is deliberately absent: the scheduler seeds it when a block
 * starts and auto-progression owns it from then on.
 */
export function projectSettings(block, variant, catalog = CATALOG) {
  const extras = Object.fromEntries(block.permutation.extras.map((e) => [e.family, e.set]))
  const posDef = catalog.position.find((o) => o.id === block.permutation.position)

  const gameFields = {
    grid: block.permutation.position,
    enableAudio: true,
    audioSource: block.permutation.audio,
    enableColor: 'color' in extras,
    enableShape: 'shape' in extras,
    enableImage: 'image' in extras,
    rules: 'none',
  }
  // Only overwrite a source when that channel is actually in play, so a
  // disabled channel keeps its last value instead of flickering in the UI.
  if ('color' in extras) gameFields.colorSource = extras.color
  if ('shape' in extras) gameFields.shapeSource = extras.shape
  if ('image' in extras) gameFields.imageSource = extras.image

  const globalFields = {}
  if (variant) {
    gameFields.numTrials = variant.numTrials
    gameFields.interference = variant.interference
    globalFields.feedback = variant.feedback
    if (posDef?.dimension === '3d' && variant.rotationSpeed !== null) {
      globalFields.rotationSpeed = variant.rotationSpeed
    }
  }

  return { gameFields, globalFields }
}

// ---------------------------------------------------------------------------
// DERIVING TRAINING DAYS FROM GAME HISTORY
// ---------------------------------------------------------------------------

/**
 * Fold scored game records into training days.
 *
 * `games` are quad-box game records that already went through
 * addScoreMetadata (so they carry total.percent). Several sessions on one day
 * collapse into a single day: the day's n-level is the highest n played, and
 * the day's accuracy is the mean across those sessions.
 *
 * `dayOf` maps a timestamp to a day key — pass getGameDay so the 4am cutoff
 * the rest of the app uses applies here too.
 */
export function foldGamesIntoDays(games, dayOf) {
  const byDay = new Map()

  for (const game of games) {
    if (game.status !== 'completed') continue
    if (typeof game.nBack !== 'number') continue
    const percent = game?.total?.percent
    if (typeof percent !== 'number') continue

    const key = dayOf(game.timestamp)
    if (!byDay.has(key)) byDay.set(key, { date: key, nLevel: 0, accuracies: [], timestamp: game.timestamp })
    const day = byDay.get(key)
    day.nLevel = Math.max(day.nLevel, game.nBack)
    day.accuracies.push(percent * 100)
    day.timestamp = Math.min(day.timestamp, game.timestamp)
  }

  return [...byDay.values()]
    .map((d) => ({
      date: d.date,
      nLevel: d.nLevel,
      accuracy: d.accuracies.reduce((a, b) => a + b, 0) / d.accuracies.length,
      sessions: d.accuracies.length,
      timestamp: d.timestamp,
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
}
