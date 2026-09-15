# Bug fix pass — "after the first trial, nothing happens"

## The freeze

`startGame` preloads the whole audio pool, then `playTrial` waited on
`Promise.all([audioWait, presentationWait, trialWait])`.

`audioPlayer.play()` returned a promise that only settled on Howler's `end`,
`loaderror` or `playerror`. If the preload had **already failed** by the time
trial 1 played, the Howl was in a failed state: Howler queued the playback,
returned a sound id, and then emitted nothing at all. The promise never
settled, `Promise.all` never resolved, and the loop stopped dead.

The first stimulus was already on screen — `presentation.highlight = true`
happens before the await — so you saw exactly one trial and then silence. No
error, no rejection, no modal. Only a reload got you out.

The usual trigger is opening the build straight off disk. Howler's Web Audio
path loads through XHR, which browsers refuse on a `file://` page, so every
sound fails. `vite.config.js` is set up so `dist/index.html` works off disk,
which is how this was most likely hit. The same failure fires on any 404 or
decode error when served over http.

The second failure mode was just as bad: when `loaderror` *did* arrive first,
it rejected with a Howler **sound id**, not an `Error`. `startGame`'s catch
tested `e.message === 'Game cancelled'`, which is `undefined` on a number, so
it rethrew into an unhandled rejection and left `isPlaying` stuck true.

## Fixes

### Audio can no longer stall or kill a session — `src/lib/audioPlayer.js`

* `play()` never rejects. It resolves with `{ played, reason }` on end, on
  failure, or on a watchdog timeout, so a silent sound costs one cue rather
  than the session.
* HTML5 Audio is forced on `file://` (and still on iOS). An `<audio>` element
  *can* load file URLs where Web Audio's XHR cannot, so the build now actually
  plays sound when opened off disk.
* Failed URLs are remembered and skipped instead of waited on again. A dead
  audio set costs a couple of timeouts, not one per trial.
* Listeners are removed on every settle. They were accumulating on a cached
  Howl for the whole session — several hundred over a 200-trial run.
* `cacheAudioSource` ignores an unknown source instead of throwing.
* `clearCache()` unloads its Howls rather than dropping the references.
* The class is exported and takes an injectable `howlFactory`, so every
  failure path is testable without a browser.

### Audio falls back instead of going quiet — `speech.js`, `tones.js`, `audioText.js`

When the recordings cannot be loaded the game now speaks the stimuli rather
than running silently, and drops to tones only if nothing can be spoken.

**Tier 1 — recordings.** Unchanged, plus the `file://` fix above.

**Tier 2 — speech synthesis.** Each stimulus maps to words: letters to letter
names, `Natural-Numbers/3` to "three", `Nato/j` to "Juliet". The syllable sets
are rebuilt at their original length — the recordings are roughly five and ten
syllables, and that length is the phonological load, so reading out a bare
letter would quietly make the set easier. Rebuilt syllables are deterministic
and checked to be collision-free, because two stimuli that sound alike would
hand the player a match that is not there.

Each audio set keeps its own voice profile. Constant Change treats the audio
set as a permutation dimension, so collapsing nine sets onto one identical
voice would delete a whole axis of variation. Voice choice is best effort — the
Web Speech API exposes no gender — so rate and pitch carry the difference on a
device with only one voice installed.

**Tier 3 — tones.** An oscillator needs no network and no installed voice, so
this tier cannot fail for environmental reasons. Twenty-six distinct pitches
would either climb to a shrill 7kHz or crowd into steps too fine to recall, so
a tone carries two features: nine pentatonic pitches across two octaves, each
steady, rising or falling. Twenty-seven combinations, none above 1kHz.

The chain only ever descends, and only on evidence:

* One recording failing marks the whole set unavailable, so later trials skip
  the file layer instead of each paying a full timeout the first time it comes
  up.
* Speech is condemned only by the failure that matters — the API accepting an
  utterance and then never firing `start`, which is what a device with no
  installed voice does. Waiting on `onend` there is the same freeze the
  recordings caused, so there is a watchdog on it.
* An `interrupted` error is our own `cancel()` landing, not a fault, and does
  not drop a working engine to tones the first time the player hits Stop.

The tier is settled during the 700ms lead-in rather than during trial one, so a
broken sound set does not read as the game failing to start. A banner names
what the player is actually hearing.

### The trial clock is now its own module — `src/lib/trialClock.js`

Extracted from the component so the awkward parts are testable instead of
only observable as a frozen screen. Two guarantees:

1. **Every wait settles.** `cap(promise, ms)` gives up on a stimulus that never
   answers. Audio may stretch a trial by up to a second and is then left
   behind — pacing belongs to the trial clock.
2. **A settled wait stops being cancellable** and leaves the pending set.
   Previously the cancel list grew by three entries per trial for the whole
   session, and cancelling at the end rejected promises nobody was holding.

### Game loop — `src/lib/DefaultGame.svelte`

* The recursive `playTrial` is now an iterative loop.
* Any unexpected error stands the session down cleanly instead of escaping as
  an unhandled rejection with the game wedged mid-run.
* `endGame` stops the clock **before** persisting. It used to await IndexedDB
  first, so pressing Stop let trials keep running underneath — and the loop
  could reach the last trial and call `endGame` a second time, recording the
  same session twice.
* A failed write now costs one record, not the next session.
* Keyboard handling ignores events from inputs and selects. Adjusting the
  n-back slider with the arrow keys and then pressing space used to start a
  game behind the open drawer.
* A non-blocking banner appears if audio cannot load, so a silent run is
  explained rather than mysterious.

### Rotation speed of 0 — `src/lib/Grid.svelte`

Constant Change draws `rotationSpeed: 0` ("Still") as one of its two rotation
values, and the settings slider reaches 0 too. `3400 / 0` is `Infinity`, which
is not a valid `animation-duration`; the browser dropped the declaration and
the cube kept spinning at whatever it was doing before. **Half of every 3D
variant was affected.** Zero now pauses the animation on its start pose.

### The grid followed live settings, not the running game

`$: grid = gameDisplayInfo.grid ?? ...` was missing its store prefix, so it
read a property off the store *object* — always `undefined` — and silently fell
through to the live setting. A schedule write landing mid-session could flip
the board under the player. `grid` now travels on the game record
(`nbackGame.js`) and is read as `$gameDisplayInfo.grid`.

### Plateau detection could never fire at zero — `src/lib/constantChange.js`

The relative target is `accuracy × 1.15`. At zero that is zero, and `0 >= 0`
reads as "still improving", so a player scoring nothing was told they were
progressing and their block never ended. Added `minImprovementPoints` (2) as a
floor under the relative target. It only binds at the bottom of the range — at
15% accuracy the relative target is already 17.25, past the 17 the floor asks
for — so nothing else changes.

### Schedule writes no longer land mid-game — `src/stores/constantChangeStore.js`

The first sync fires on mount and waits on IndexedDB, so pressing play straight
away could have trial count, interference and grid rewritten during a run that
had already been generated. The same applied to "Change now" and "New day draw"
tapped from the drawer. Writes now queue and land when play stops.

### Smaller things

* `settings.update()` called with no arguments spread a literal `undefined`
  key into the saved settings on every slider change. Fixed, and the stray key
  is stripped on load.
* `Drawer`'s `if (!$settings.mode === 'tally')` compared a boolean to a string
  and never fired. Harmless where it sits today, wrong the moment anything else
  calls it.

## Tests

`npm test`

| File | Covers |
| --- | --- |
| `tests/trialClock.test.js` | waits settle, cancellation unwinds the loop, nothing accumulates over 200 trials, a stimulus that never answers is left behind |
| `tests/audioPlayer.test.js` | every failure path resolves rather than rejecting or hanging; the fallback chain descends on evidence; failed sounds are skipped; no listener leak |
| `tests/speech.test.js` | the silent-device watchdog, interruption handling, late-arriving voice lists, and the stimulus-to-words mapping (including collision-freedom) |
| `tests/gameLoopIntegration.test.js` | the regression end to end — a full session completes with sound that never reports back, or that always fails |
| `tests/gameRecord.test.js` | grid, mode and pacing on the record; all 576 permutations generate a complete, honestly scored game |
| `tests/constantChange.test.js` | the existing scheduler suite, plus the zero-accuracy plateau floor |
| `tests/nbackGame.test.js` | unchanged |

## Still worth knowing

`audioPlayer.location` is the relative path `audio/`, resolved against the
document URL rather than the Vite base. That is correct for a site served at a
directory URL, but a page served at a path with no trailing slash would resolve
it one level too high. It has not been changed, since nothing in the current
deployment hits it.
