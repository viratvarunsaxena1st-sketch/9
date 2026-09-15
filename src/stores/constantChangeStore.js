import { writable, get } from 'svelte/store'
import { settings } from './settingsStore'
import { isPlaying } from './gameRunningStore'
import { getGamesTimeRange } from '../lib/gamedb'
import { getGameDay } from '../lib/utils'
import {
  CATALOG,
  DEFAULT_CONFIG,
  STATE_VERSION,
  advance,
  buildVariants,
  createInitialState,
  ensureVariant,
  foldGamesIntoDays,
  forceAdvance,
  projectSettings,
  startBlock,
  validateSelection,
} from '../lib/constantChange.js'

const STORAGE_KEY = 'quad-box-constant-change'
export const CONSTANT_MODE = 'constant'

const rng = () => Math.random()

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

const loadState = () => {
  if (typeof localStorage === 'undefined') return createInitialState()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return createInitialState()
    const saved = JSON.parse(raw)
    if (saved?.version !== STATE_VERSION) return createInitialState()
    // Merge config forward so a new knob gets its default instead of undefined.
    saved.config = { ...DEFAULT_CONFIG, ...(saved.config ?? {}) }
    return saved
  } catch (e) {
    console.error('Failed to load Constant Change state:', e)
    return createInitialState()
  }
}

const saveState = (state) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch (e) {
    console.error('Failed to save Constant Change state:', e)
  }
}

const store = writable(loadState())

const commit = (state) => {
  saveState(state)
  store.set(state)
}

// ---------------------------------------------------------------------------
// writing into the app's settings
// ---------------------------------------------------------------------------

/**
 * Push the scheduler's decisions into settings in a single diffed write.
 * Diffing matters: DefaultGame regenerates its game whenever $settings
 * changes, so an unconditional write would loop.
 */
const writeToSettings = (gameFields, globalFields, nBack) => {
  const $settings = get(settings)
  const current = $settings.gameSettings?.[CONSTANT_MODE] ?? {}

  let changed = false
  const nextGame = { ...current }
  for (const [key, value] of Object.entries(gameFields)) {
    if (nextGame[key] !== value) {
      nextGame[key] = value
      changed = true
    }
  }
  if (nBack != null && nextGame.nBack !== nBack) {
    nextGame.nBack = nBack
    changed = true
  }

  const next = { ...$settings }
  for (const [key, value] of Object.entries(globalFields)) {
    if (next[key] !== value) {
      next[key] = value
      changed = true
    }
  }

  if (!changed) return
  next.gameSettings = { ...($settings.gameSettings ?? {}), [CONSTANT_MODE]: nextGame }
  settings.set(next)
}

/**
 * Hold writes back while a game is in flight.
 *
 * The first sync fires on mount and has to wait on IndexedDB, so a player who
 * presses play straight away can have the schedule land underneath them: trial
 * count, interference and grid would all change during a run that had already
 * been generated. The same applies to "Change now" and "New day draw" tapped
 * from the drawer mid-game. Queue the write and let it land when play stops.
 */
let pendingWrite = null

isPlaying.subscribe((playing) => {
  if (playing || !pendingWrite) return
  const { gameFields, globalFields, nBack } = pendingWrite
  pendingWrite = null
  writeToSettings(gameFields, globalFields, nBack)
})

const applyToSettings = (gameFields, globalFields, nBack) => {
  if (get(isPlaying)) {
    // Fold into any earlier pending write so the newest decision wins.
    pendingWrite = {
      gameFields: { ...(pendingWrite?.gameFields ?? {}), ...gameFields },
      globalFields: { ...(pendingWrite?.globalFields ?? {}), ...globalFields },
      nBack: nBack != null ? nBack : pendingWrite?.nBack ?? null,
    }
    return
  }
  writeToSettings(gameFields, globalFields, nBack)
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

const isConstantGame = (game) => game?.mode === CONSTANT_MODE

/**
 * Bring the schedule up to date and push it into settings.
 *
 * The day log is rebuilt from the game database on every sync rather than
 * accumulated, so the schedule self-heals if a session is missed, if history
 * is deleted, or if the app is used on another device and synced back.
 */
const currentTier = (state) => {
  const cycle = ['dual', 'tri', 'quad']
  return cycle[state.cycleIndex % cycle.length]
}

let queue = Promise.resolve()

export const syncConstantChange = () => {
  queue = queue.then(runSync).catch((e) => {
    console.error('Constant Change sync failed:', e)
  })
  return queue
}

const runSync = async () => {
  const state = get(store)
  const now = Date.now()

  let seededNLevel = null
  if (!state.current) {
    startBlock(state, currentTier(state), state.config.seedNLevel, rng, now)
    seededNLevel = state.current.startNLevel
  }

  const games = await getGamesTimeRange(
    new Date(state.current.startedAt),
    new Date(now + 24 * 60 * 60 * 1000),
  )
  const days = foldGamesIntoDays(games.filter(isConstantGame), getGameDay)

  const result = advance(state, days, rng, now)
  if (result.switched) seededNLevel = state.current.startNLevel

  const variant = ensureVariant(state, getGameDay(now), rng)
  commit(state)

  const { gameFields, globalFields } = projectSettings(state.current, variant, CATALOG)
  applyToSettings(gameFields, globalFields, seededNLevel)

  return result
}

// ---------------------------------------------------------------------------
// public actions
// ---------------------------------------------------------------------------

export const constantChange = {
  subscribe: store.subscribe,

  /** Change permutation now, without waiting for a plateau. */
  changeNow: async () => {
    const state = get(store)
    const now = Date.now()
    if (!state.current) return
    forceAdvance(state, rng, now)
    ensureVariant(state, getGameDay(now), rng)
    commit(state)
    const { gameFields, globalFields } = projectSettings(state.current, state.current.variant, CATALOG)
    applyToSettings(gameFields, globalFields, state.current.startNLevel)
  },

  /** Redraw today's short-term variant without touching the permutation. */
  rerollVariant: () => {
    const state = get(store)
    if (!state.current) return
    state.current.variantDay = null
    ensureVariant(state, getGameDay(Date.now()), rng)
    commit(state)
    const { gameFields, globalFields } = projectSettings(state.current, state.current.variant, CATALOG)
    applyToSettings(gameFields, globalFields, null)
  },

  /**
   * Toggle one catalog option in or out of rotation. Refuses the change if it
   * would strand a tier, since an empty pool deadlocks the mode.
   */
  toggleOption: (family, id) => {
    const state = get(store)
    const all = CATALOG[family].map((o) => o.id)
    const enabled = { ...(state.enabled ?? {}) }
    const currentList = enabled[family] ?? all
    const nextList = currentList.includes(id)
      ? currentList.filter((x) => x !== id)
      : [...currentList, id]
    enabled[family] = all.filter((x) => nextList.includes(x))

    const check = validateSelection(CATALOG, enabled, state.blocked)
    if (!check.ok) return check

    state.enabled = enabled
    commit(state)
    return check
  },

  /** Never draw this exact permutation again. */
  blockPermutation: (permutationId) => {
    const state = get(store)
    if (state.blocked.includes(permutationId)) return
    const blocked = [...state.blocked, permutationId]
    const check = validateSelection(CATALOG, state.enabled, blocked)
    if (!check.ok) return check
    state.blocked = blocked
    commit(state)
    return check
  },

  unblockPermutation: (permutationId) => {
    const state = get(store)
    state.blocked = state.blocked.filter((x) => x !== permutationId)
    commit(state)
  },

  setConfig: (key, value) => {
    const state = get(store)
    state.config = { ...state.config, [key]: value }
    commit(state)
  },

  /** Clear the used-permutation pools without changing the current block. */
  resetPools: () => {
    const state = get(store)
    state.pools = { dual: [], tri: [], quad: [] }
    if (state.current) state.current.variantPool = []
    commit(state)
  },

  reset: () => {
    const fresh = createInitialState()
    commit(fresh)
  },
}

/** Read-only helpers for the settings panel. */
export const describeVariantPool = (block) =>
  block ? buildVariants(block.permutation, CATALOG).length : 0
