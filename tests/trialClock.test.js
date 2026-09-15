import { describe, it, expect } from 'vitest'
import { createTrialClock, isCancellation, CANCELLED } from '../src/lib/trialClock.js'

/**
 * A tiny controllable timer queue. Real timers would make these tests slow and
 * flaky, and the thing under test is ordering, not duration.
 */
const fakeTimers = () => {
  let now = 0
  let seq = 0
  const timers = new Map()
  return {
    setTimeoutFn: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + (ms || 0), fn, order: id })
      return id
    },
    clearTimeoutFn: (id) => { timers.delete(id) },
    /** Fire everything due at or before `now + ms`, in time order. */
    advance: (ms) => {
      now += ms
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= now)
        .sort((a, b) => a[1].at - b[1].at || a[1].order - b[1].order)
      for (const [id, t] of due) {
        timers.delete(id)
        t.fn()
      }
    },
    outstanding: () => timers.size,
  }
}

/** Let queued microtasks run so promise chains settle before we assert. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const settle = (promise) => {
  const state = { status: 'pending', value: undefined }
  promise.then(
    (v) => { state.status = 'resolved'; state.value = v },
    (e) => { state.status = 'rejected'; state.value = e },
  )
  return state
}

describe('trial clock — delays', () => {
  it('resolves once its time is up', async () => {
    const t = fakeTimers()
    const clock = createTrialClock(t)
    const wait = settle(clock.delay(2500))

    t.advance(2400)
    await flush()
    expect(wait.status).toBe('pending')

    t.advance(100)
    await flush()
    expect(wait.status).toBe('resolved')
  })

  it('a settled delay stops counting as pending', async () => {
    const t = fakeTimers()
    const clock = createTrialClock(t)
    clock.delay(100)
    expect(clock.pendingCount()).toBe(1)

    t.advance(100)
    await flush()
    expect(clock.pendingCount()).toBe(0)
  })

  it('does not accumulate waits across a long session', async () => {
    const t = fakeTimers()
    const clock = createTrialClock(t)

    // 200 trials, three waits each — the shape of a full Constant Change run.
    for (let i = 0; i < 200; i++) {
      clock.delay(2500)
      clock.delay(2150)
      clock.cap(Promise.resolve('sound'), 3500)
      t.advance(3500)
      await flush()
    }

    expect(clock.pendingCount()).toBe(0)
    expect(t.outstanding()).toBe(0)
  })

  it('cancelling rejects every outstanding wait with a cancellation', async () => {
    const t = fakeTimers()
    const clock = createTrialClock(t)
    const a = settle(clock.delay(2500))
    const b = settle(clock.delay(2150))

    clock.cancelAll()
    await flush()

    expect(a.status).toBe('rejected')
    expect(b.status).toBe('rejected')
    expect(a.value.message).toBe(CANCELLED)
    expect(isCancellation(a.value)).toBe(true)
    expect(clock.pendingCount()).toBe(0)
  })

  it('cancelling a wait that already fired does nothing', async () => {
    const t = fakeTimers()
    const clock = createTrialClock(t)
    const wait = settle(clock.delay(100))

    t.advance(100)
    await flush()
    clock.cancelAll()
    await flush()

    expect(wait.status).toBe('resolved')
  })
})

describe('trial clock — capped waits', () => {
  it('passes the value through when the stimulus answers in time', async () => {
    const t = fakeTimers()
    const clock = createTrialClock(t)
    const wait = settle(clock.cap(Promise.resolve({ played: true }), 3500))

    await flush()
    expect(wait.status).toBe('resolved')
    expect(wait.value).toEqual({ played: true })
  })

  // The stall that froze the app: a sound that never reports back.
  it('gives up on a stimulus that never settles', async () => {
    const t = fakeTimers()
    const clock = createTrialClock(t)
    const neverSettles = new Promise(() => {})
    const wait = settle(clock.cap(neverSettles, 3500))

    await flush()
    expect(wait.status).toBe('pending')

    t.advance(3500)
    await flush()
    expect(wait.status).toBe('resolved')
    expect(wait.value).toBeNull()
  })

  it('a rejected stimulus does not reject the trial', async () => {
    const t = fakeTimers()
    const clock = createTrialClock(t)
    const wait = settle(clock.cap(Promise.reject(new Error('loaderror')), 3500))

    await flush()
    expect(wait.status).toBe('resolved')
    expect(wait.value).toBeNull()
  })

  it('cancelling resolves a capped wait rather than rejecting it', async () => {
    const t = fakeTimers()
    const clock = createTrialClock(t)
    const wait = settle(clock.cap(new Promise(() => {}), 3500))

    clock.cancelAll()
    await flush()

    // The trial's own delay reports the cancellation; the stimulus must not
    // produce a second rejection with nothing left holding it.
    expect(wait.status).toBe('resolved')
  })

  it('clears its timer once the stimulus wins the race', async () => {
    const t = fakeTimers()
    const clock = createTrialClock(t)
    clock.cap(Promise.resolve('done'), 3500)

    await flush()
    expect(t.outstanding()).toBe(0)
    expect(clock.pendingCount()).toBe(0)
  })
})

describe('trial loop guarantees', () => {
  // The regression itself: one trial, then silence forever.
  it('a whole run completes even when no stimulus ever settles', async () => {
    const t = fakeTimers()
    const clock = createTrialClock(t)
    const trialTime = 2500
    const grace = 1000
    let completed = 0

    const run = (async () => {
      for (let i = 0; i < 12; i++) {
        const silent = new Promise(() => {})
        await Promise.all([
          clock.delay(trialTime),
          clock.cap(silent, trialTime + grace),
        ])
        completed++
      }
    })()

    const finished = settle(run)
    for (let i = 0; i < 12; i++) {
      t.advance(trialTime + grace)
      await flush()
    }

    expect(finished.status).toBe('resolved')
    expect(completed).toBe(12)
  })

  // A dead stimulus may stretch a trial, but only by the grace it was given -
  // it never gets to set the pace on its own.
  it('a stalled stimulus stretches a trial by the grace and no more', async () => {
    const t = fakeTimers()
    const clock = createTrialClock(t)
    const wait = settle(Promise.all([
      clock.delay(2500),
      clock.cap(new Promise(() => {}), 3500),
    ]))

    t.advance(3499)
    await flush()
    expect(wait.status).toBe('pending')

    t.advance(1)
    await flush()
    expect(wait.status).toBe('resolved')
  })

  // Which is why the player marks a source dead after one failure: a stimulus
  // that answers immediately keeps the trial on its own clock.
  it('a stimulus that answers at once leaves the trial time untouched', async () => {
    const t = fakeTimers()
    const clock = createTrialClock(t)
    const wait = settle(Promise.all([
      clock.delay(2500),
      clock.cap(Promise.resolve({ played: false }), 3500),
    ]))

    t.advance(2500)
    await flush()
    expect(wait.status).toBe('resolved')
  })

  it('stopping mid-run unwinds the loop as a cancellation', async () => {
    const t = fakeTimers()
    const clock = createTrialClock(t)
    let completed = 0

    const run = (async () => {
      for (let i = 0; i < 12; i++) {
        await Promise.all([clock.delay(2500), clock.cap(Promise.resolve(null), 3500)])
        completed++
      }
    })()

    const finished = settle(run)
    t.advance(2500)
    await flush()
    expect(completed).toBe(1)

    clock.cancelAll()
    await flush()

    expect(finished.status).toBe('rejected')
    expect(isCancellation(finished.value)).toBe(true)
    expect(completed).toBe(1)
  })
})
