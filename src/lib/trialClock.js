/**
 * The clock a running game keeps time by.
 *
 * Pulled out of the game components so the awkward part - what happens to a
 * wait that is still outstanding when the player hits Stop, and what happens
 * to a stimulus that never reports back - can be tested directly instead of
 * only being observable as a frozen screen.
 *
 * Two rules the whole loop depends on:
 *   1. Every wait settles. A promise that can hang is a game that can freeze.
 *   2. A settled wait stops being cancellable, and drops out of the pending
 *      set. Otherwise the set grows by several entries per trial for the whole
 *      session, and cancelling at the end rejects promises nobody is holding.
 */

export const CANCELLED = 'Game cancelled'

export const isCancellation = (e) => e instanceof Error && e.message === CANCELLED

export const createTrialClock = ({
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) => {
  const pending = new Set()

  /**
   * Wait `ms`. Rejects with a cancellation if the clock is stopped first,
   * which is how Stop and Escape unwind the loop.
   */
  const delay = (ms) => {
    let entry
    const promise = new Promise((resolve, reject) => {
      const id = setTimeoutFn(() => {
        pending.delete(entry)
        resolve()
      }, ms)

      entry = () => {
        clearTimeoutFn(id)
        pending.delete(entry)
        reject(new Error(CANCELLED))
      }
    })
    pending.add(entry)
    return promise
  }

  /**
   * Wait on `promise`, but give up after `ms` and carry on regardless.
   *
   * This is what keeps a stimulus from owning the pace of the game. Audio is a
   * cue, not a gate: a sound that is slow, silent, or never settles at all may
   * stretch one trial a little and then gets left behind. Never rejects - the
   * trial's own delay is what reports a cancellation.
   */
  const cap = (promise, ms) => new Promise((resolve) => {
    let settled = false
    let entry
    let id

    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeoutFn(id)
      pending.delete(entry)
      resolve(value)
    }

    id = setTimeoutFn(() => finish(null), ms)
    entry = () => finish(null)
    pending.add(entry)

    Promise.resolve(promise).then(finish, () => finish(null))
  })

  /** Stop the clock. Every outstanding wait settles immediately. */
  const cancelAll = () => {
    const entries = [...pending]
    pending.clear()
    for (const entry of entries) entry()
  }

  const pendingCount = () => pending.size

  return { delay, cap, cancelAll, pendingCount }
}
