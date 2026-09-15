import { describe, it, expect } from 'vitest'
import { generateGame } from '../src/lib/nback.js'
import {
  CATALOG,
  TIER_CYCLE,
  buildTierPermutations,
  buildVariants,
  permutationId,
  projectSettings,
} from '../src/lib/constantChange.js'

const baseSettings = {
  nBack: 2, numTrials: 40, trialTime: 2500, matchChance: 25, interference: 25,
  enableAudio: true, enableShape: false, enableColor: false, enableImage: false,
  grid: 'rotate3D', rules: 'none',
  audioSource: 'letters2', colorSource: 'basic', shapeSource: 'basic', imageSource: 'voronoi',
}

const build = (overrides = {}, mode = 'constant') =>
  generateGame({ ...baseSettings, ...overrides }, { mode, theme: 'dark' })

describe('game record', () => {
  // The grid used to be read off the live settings at render time, so a
  // schedule write landing mid-session could flip the board under the player.
  it('carries the grid the game was generated with', () => {
    expect(build({ grid: 'rotate3D' }).meta.grid).toBe('rotate3D')
    expect(build({ grid: 'static2D' }).meta.grid).toBe('static2D')
  })

  it('carries the mode so Constant Change can find its own sessions again', () => {
    expect(build({}, 'constant').meta.mode).toBe('constant')
    expect(build({}, 'custom').meta.mode).toBe('custom')
  })

  it('carries the pacing the trial loop runs on', () => {
    const meta = build({ trialTime: 1800, numTrials: 150 }).meta
    expect(meta.trialTime).toBe(1800)
    expect(meta.numTrials).toBe(150)
  })

  it('a 2D grid draws from the 2D position pool', () => {
    for (const trial of build({ grid: 'static2D' }).trials) {
      expect(trial.position.split('-')).toHaveLength(2)
    }
    for (const trial of build({ grid: 'rotate3D' }).trials) {
      expect(trial.position.split('-')).toHaveLength(3)
    }
  })
})

describe('every permutation Constant Change can draw is playable', () => {
  const sample = (list) => [list[0], list[(list.length / 2) | 0], list[list.length - 1]]

  const cases = []
  for (const tier of TIER_CYCLE) {
    for (const permutation of buildTierPermutations(tier)) {
      cases.push({ tier, permutation })
    }
  }

  it('covers the whole space', () => {
    expect(cases.length).toBeGreaterThan(0)
    const ids = new Set(cases.map((c) => permutationId(c.permutation)))
    expect(ids.size).toBe(cases.length)
  })

  it('generates a complete game for every permutation and variant', () => {
    const problems = []

    for (const block of cases) {
      const id = permutationId(block.permutation)
      for (const variant of sample(buildVariants(block.permutation, CATALOG))) {
        const { gameFields } = projectSettings(block, variant, CATALOG)
        const game = build(gameFields)
        const expected = ['position', 'audio', ...block.permutation.extras.map((e) => e.family)]

        if (game.trials.length !== variant.numTrials) problems.push(`${id}: wrong trial count`)
        if (game.meta.grid !== block.permutation.position) problems.push(`${id}: wrong grid`)
        if ([...game.meta.tags].sort().join() !== [...expected].sort().join()) {
          problems.push(`${id}: tags ${game.meta.tags} want ${expected}`)
        }
        for (const trial of game.trials) {
          for (const tag of expected) {
            if (trial[tag] == null) { problems.push(`${id}: ${tag} missing on a trial`); break }
          }
        }
      }
    }

    expect(problems.slice(0, 5)).toEqual([])
  })

  it('scores every stream honestly — a claimed match really is n trials back', () => {
    const problems = []

    for (const block of cases) {
      const { gameFields } = projectSettings(block, buildVariants(block.permutation)[0], CATALOG)
      const game = build({ ...gameFields, numTrials: 40 })
      const n = game.meta.nBack

      for (let i = n; i < game.trials.length; i++) {
        for (const tag of game.meta.tags) {
          const repeats = game.trials[i][tag] === game.trials[i - n][tag]
          const claimed = game.trials[i].matches.includes(tag)
          if (repeats !== claimed) {
            problems.push(`${permutationId(block.permutation)}: ${tag} trial ${i}`)
            break
          }
        }
      }
    }

    expect(problems.slice(0, 5)).toEqual([])
  })

  // An image is drawn over the whole cell, so anything beside it is invisible
  // while still being generated and scored.
  it('never puts an image alongside a colour or a shape', () => {
    for (const block of cases) {
      const { gameFields } = projectSettings(block, buildVariants(block.permutation)[0], CATALOG)
      if (gameFields.enableImage) {
        expect(gameFields.enableColor).toBe(false)
        expect(gameFields.enableShape).toBe(false)
      }
    }
  })
})
