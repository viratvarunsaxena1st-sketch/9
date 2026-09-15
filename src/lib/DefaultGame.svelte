<script>
import Grid from "./Grid.svelte"
import LargeKey from "./LargeKey.svelte"
import SmallKey from "./SmallKey.svelte"
import { generateGame } from "./nback"
import { onDestroy } from "svelte"
import { audioPlayer, DELIVERY } from "./audioPlayer"
import { runAutoProgression } from "./autoProgression"
import { settings } from "../stores/settingsStore"
import { feedback } from "../stores/feedbackStore"
import { analytics } from "../stores/analyticsStore"
import { mobile } from "../stores/mobileStore"
import { isPlaying, gameDisplayInfo } from "../stores/gameRunningStore"
import { syncConstantChange, CONSTANT_MODE } from "../stores/constantChangeStore"
import { createTrialClock, isCancellation } from "./trialClock"
import { getGameDay } from "./utils"

/** Fallback if a game record somehow carries no trial time. */
const DEFAULT_TRIAL_TIME = 2500
/** How far past the trial clock a long stimulus may hold the next trial back. */
const AUDIO_GRACE_MS = 1000

let trials
let currentTrial
let nextTrial
let trialsIndex
let scoresheet = []
let presentation
let gameMeta = {}
let gameId = 0
let delivery = DELIVERY.FILE

const clock = createTrialClock()
const delay = (ms) => clock.delay(ms)

const resetRuntimeData = () => {
  isPlaying.set(false)
  gameDisplayInfo.set({})
  trials = []
  currentTrial = {}
  nextTrial = {}
  trialsIndex = 0
  scoresheet = []
  presentation = { highlight: false }
  gameMeta = {}
  gameId++
}

resetRuntimeData()

const applyGame = (game, isPlaying) => {
  if (!isPlaying) {
    gameMeta = { ...game.meta }
    gameDisplayInfo.set(gameMeta)
  }
}

// Keep the schedule in step when the mode is selected and when the training
// day rolls over. Guarded because syncConstantChange writes back into
// $settings, and an unguarded reactive statement would re-enter on every write.
let lastSyncKey = null
const maybeSyncSchedule = (mode, playing) => {
  if (mode !== CONSTANT_MODE || playing) return
  const key = `${mode}|${getGameDay(Date.now())}`
  if (key === lastSyncKey) return
  lastSyncKey = key
  syncConstantChange()
}
$: maybeSyncSchedule($settings.mode, $isPlaying)

$: isMobile = $mobile
$: gameSettings = $settings.gameSettings[$settings.mode]
$: game = generateGame(gameSettings, $settings, gameId)
$: applyGame(game, $isPlaying)
$: trialDisplay = $settings.feedback === 'show' ? game.trials.length - trialsIndex : ''

const trialTime = () => {
  const value = $gameDisplayInfo.trialTime
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TRIAL_TIME
}

const runTrials = async () => {
  for (let i = 0; i < trials.length; i++) {
    if (!$isPlaying) return

    selectTrial(i)
    presentation.highlight = true

    const ms = trialTime()
    const audioWait = currentTrial.audio
      ? audioPlayer.play(currentTrial.audio).then(result => {
          if (result) delivery = result.delivery
          return result
        })
      : Promise.resolve(null)
    const highlightWait = delay(Math.min(2000, Math.max(200, ms - 350)))
      .then(() => { presentation.highlight = false })
    const trialWait = delay(ms)

    await Promise.all([trialWait, highlightWait, clock.cap(audioWait, ms + AUDIO_GRACE_MS)])

    if (!$isPlaying) return
    detectMissedStimuli()
  }

  if (!$isPlaying) return
  await delay(700)
  await endGame('completed')
}

const selectTrial = (i) => {
  currentTrial = trials[i]
  if (i < trials.length - 1) {
    nextTrial = trials[i+1]
  }
  trialsIndex = i
}

const startGame = async () => {
  if ($isPlaying) {
    return
  }
  isPlaying.set(true)
  delivery = DELIVERY.FILE
  gameMeta = { ...game.meta, start: Date.now() }
  gameDisplayInfo.set(gameMeta)
  audioPlayer.cacheAudioSource(gameSettings.audioSource)
  trials = structuredClone(game.trials)
  nextTrial = trials[0]
  scoresheet = new Array(trials.length).fill().map(() => ({}))
  selectTrial(0)
  try {
    // Decide which audio tier this session runs on during the lead-in. Left to
    // the first trial, a broken sound set would spend its whole timeout there
    // and read as the game failing to start.
    await Promise.all([delay(700), clock.cap(audioPlayer.whenReady(), 1500)])
    delivery = audioPlayer.currentDelivery()
    await runTrials()
  } catch (e) {
    if (isCancellation(e)) {
      console.debug('Game cancelled', e)
      return
    }
    // Anything else used to escape as an unhandled rejection, which left the
    // game stuck mid-run with no way back except a reload. Stand the session
    // down cleanly instead, then let the error surface.
    console.error('Game loop failed', e)
    await endGame('cancelled')
    throw e
  }
}

const endGame = async (status) => {
  if (!$isPlaying) {
    return
  }

  // Stop the clock before anything else. Persisting awaits IndexedDB, and the
  // trial loop would otherwise keep running underneath - it could even reach
  // the last trial and call endGame a second time, recording the game twice.
  isPlaying.set(false)
  clock.cancelAll()
  audioPlayer.stop()

  const gameInfoRecord = { ...gameMeta, timestamp: Date.now() }
  const playedTrials = trialsIndex
  const playedSheet = status === 'completed' ? scoresheet : scoresheet.slice(0, trialsIndex)

  resetRuntimeData()
  feedback.reset()

  if (playedTrials <= gameInfoRecord.nBack) {
    console.debug('Game not recorded', playedTrials, gameInfoRecord)
    return
  }

  try {
    await analytics.scoreTrials(gameInfoRecord, playedSheet, status)
    if (status === 'completed') {
      await runAutoProgression(gameInfoRecord)
      if ($settings.mode === CONSTANT_MODE) {
        // Re-derives the day log from the game database, which may end the
        // block and draw the next permutation.
        await syncConstantChange()
        lastSyncKey = `${CONSTANT_MODE}|${getGameDay(Date.now())}`
      }
    }
  } catch (e) {
    // A failed write should cost the player one record, not the next session.
    console.error('Failed to record game', e)
  }
}

const toggleGame = () => {
  if ($isPlaying) {
    endGame('cancelled')
  } else {
    startGame()
  }
}

const detectMissedStimuli = () => {
  if (!('tags' in $gameDisplayInfo)) {
    return
  }
  let updates = {}
  for (const tag of $gameDisplayInfo.tags) {
    if (currentTrial.matches.includes(tag) &&!(tag in scoresheet[trialsIndex])) {
      scoresheet[trialsIndex][tag] = false
      updates[tag] = 'late-failure'
    } else {
      updates[tag] = 'blank'
    }
  }
  feedback.apply(updates)
}

const checkForMatch = (type) => {
  if (!$isPlaying || trialsIndex < $gameDisplayInfo.nBack) {
    return
  }

  if (type in currentTrial && !(type in scoresheet[trialsIndex])) {
    const isSuccess = currentTrial.matches.includes(type)
    scoresheet[trialsIndex][type] = isSuccess
    feedback.apply({ [type]: isSuccess ? 'success' : 'failure' })
  }
}

/** Typing in the settings drawer should not play the game behind it. */
const isTyping = (target) => {
  if (!target) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable
}

const handleKey = (event) => {
  if (isTyping(event.target)) {
    return
  }

  switch (event.code) {
    case 'Space':
      event.preventDefault()
      startGame()
      break
    case 'Escape':
      endGame('cancelled')
      break
  }

  const hotkeys = $settings.hotkeys
  for (const [action, key] of Object.entries(hotkeys)) {
    if (key.toUpperCase() === event.key.toUpperCase()) {
      checkForMatch(action)
      if (action === 'shape') {
        checkForMatch('image')
      }
    }
  }
}

const suppressKey = (event) => {
  event.preventDefault()
}

document.addEventListener('keydown', handleKey)

onDestroy(async () => {
  await endGame('cancelled')
  document.removeEventListener('keydown', handleKey)
})

</script>


<Grid trial={currentTrial} {nextTrial} {presentation} {gameId} />
{#if delivery === DELIVERY.SPEECH || delivery === DELIVERY.TONE || delivery === DELIVERY.NONE}
<div class="absolute top-2 left-1/2 -translate-x-1/2 z-20 alert alert-warning text-xs py-1 px-3 w-auto max-w-[90svw]">
  {#if delivery === DELIVERY.SPEECH}
    Sound files unavailable — speaking the stimuli instead.
  {:else if delivery === DELIVERY.TONE}
    Sound files and speech unavailable — using tones instead.
  {:else}
    Audio is unavailable on this device, so the game is running silently.
  {/if}
</div>
{/if}
{#if isMobile}
<div class="stretch grid grid-rows-[1fr_7fr_2fr] md:grid-rows-[1fr_8fr_2fr] gap-1">
  <div class="w-full h-full flex items-center justify-between row-start-1 p-8">
    <div class="text-4xl ml-2 select-none opacity-30" >{trialDisplay}</div>
    <button class="game-button text-4xl p-8 md:p-10"
      on:click={toggleGame}
      on:keydown={suppressKey}
      on:keypress={suppressKey}
      on:keyup={suppressKey}
      tabindex="-1"
    >{#if $isPlaying} Stop {:else} Play {/if}</button>
  </div>
  <div class="grid grid-cols-[repeat(auto-fit,minmax(0,1fr))] grid-rows-1 max-w-full gap-1 row-start-3 md:mt-6">
    <SmallKey field="position" display="Position" isPlaying={$isPlaying} {checkForMatch}></SmallKey>
    <SmallKey field="color" display="Color" isPlaying={$isPlaying} {checkForMatch}></SmallKey>
    <SmallKey field="shape" display="Shape" isPlaying={$isPlaying} {checkForMatch}></SmallKey>
    <SmallKey field="image" display="Image" isPlaying={$isPlaying} {checkForMatch}></SmallKey>
    <SmallKey field="audio" display="Audio" isPlaying={$isPlaying} {checkForMatch}></SmallKey>
  </div>
</div>
{:else}
<div class="stretch grid grid-cols-[1fr_3fr_3fr_1fr] grid-rows-[1fr_6fr_1fr]">
  <div class="w-full h-full flex items-center justify-between col-start-1 col-span-4 px-2">
    <div></div>
    <button class="game-button text-5xl px-12 py-10 max-w-[90%] mr-4"
      on:click={toggleGame}
      on:keydown={suppressKey}
      on:keypress={suppressKey}
      on:keyup={suppressKey}
      tabindex="-1"
    >{#if $isPlaying} Stop {:else} Play {/if}</button>
  </div>
  <div class="game-button-lg-group row-start-2 col-start-1 pr-24">
    {#if !gameSettings.enableImage}
    <LargeKey field="color" display="Color" isPlaying={$isPlaying} {checkForMatch}></LargeKey>
    {/if}
    <LargeKey field="position" display="Position" isPlaying={$isPlaying} {checkForMatch}></LargeKey>
  </div>
  <div class="game-button-lg-group row-start-2 col-start-4 pl-24">
    {#if gameSettings.enableImage}
    <LargeKey field="image" display="Image" isPlaying={$isPlaying} {checkForMatch}></LargeKey>
    {:else}
    <LargeKey field="shape" display="Shape" isPlaying={$isPlaying} {checkForMatch}></LargeKey>
    {/if}
    <LargeKey field="audio" display="Audio" isPlaying={$isPlaying} {checkForMatch}></LargeKey>
  </div>
  <div class="w-full h-full flex items-center justify-center text-6xl ml-6 row-start-3 col-start-4 select-none opacity-30">{trialDisplay}</div>
</div>
{/if}