/**
 * Channel admission control.
 *
 * sshd's `MaxSessions` caps concurrent channels per connection. The spike
 * measured the target server's real ceiling: the 10th channel opens and the
 * 11th fails immediately with `ChannelException(2, 'Connect failed')`. Worse,
 * once exhausted, even a cleanup command cannot open a channel — the spike's
 * own teardown failed that way.
 *
 * So admission has to be accounted for explicitly rather than discovered by
 * failure. Callers queue for a permit instead of racing to open a channel.
 *
 * @module
 */

import { SshAborted } from './errors.ts'

interface Waiter {
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly settle: () => boolean
  readonly detach: () => void
}

/** A held permit; release exactly once to return the slot. */
export interface ChannelPermit {
  /** Return the slot. Idempotent. */
  release(): void
}

/**
 * Counting semaphore with FIFO queueing and abort support.
 *
 * FIFO matters: a long-running terminal must not be able to starve the
 * control plane indefinitely, and callers that arrived first should proceed
 * first so queue latency stays predictable.
 */
export class ChannelSemaphore {
  private available: number
  private readonly waiters: Waiter[] = []
  private closedError: Error | undefined

  /**
   * @param capacity - Maximum concurrently held permits; must be >= 1.
   */
  readonly capacity: number

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`channel semaphore capacity must be a positive integer: ${capacity}`)
    }
    this.capacity = capacity
    this.available = capacity
  }

  /** Permits not currently held. */
  get free(): number {
    return this.available
  }

  /** Callers currently queued for a permit. */
  get queued(): number {
    return this.waiters.length
  }

  /**
   * Acquire one permit, queueing when none is free.
   *
   * @param signal - Optional cancellation; a queued caller rejects with
   *   {@link SshAborted} and gives up its queue position.
   * @returns A permit whose `release()` returns the slot.
   * @throws when the semaphore is closed, or the signal aborts while queued.
   */
  async acquire(signal?: AbortSignal): Promise<ChannelPermit> {
    if (this.closedError !== undefined) throw this.closedError
    signal?.throwIfAborted()
    if (this.available > 0) {
      this.available -= 1
      return this.permit()
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (): boolean => {
        if (settled) return false
        settled = true
        return true
      }
      const onAbort = (): void => {
        if (!settle()) return
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new SshAborted('aborted while waiting for an SSH channel slot'))
      }
      const detach = (): void => {
        signal?.removeEventListener('abort', onAbort)
      }
      const waiter: Waiter = {
        resolve: () => {
          detach()
          resolve()
        },
        reject: (error: Error) => {
          detach()
          reject(error)
        },
        settle,
        detach,
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    return this.permit()
  }

  /**
   * Reject every queued caller and fail all future acquisitions.
   *
   * Held permits are unaffected; their `release()` stays safe to call.
   *
   * @param error - The failure handed to queued and future callers.
   */
  close(error: Error): void {
    this.closedError ??= error
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      if (waiter !== undefined && waiter.settle()) waiter.reject(error)
    }
  }

  private permit(): ChannelPermit {
    let released = false
    return {
      release: (): void => {
        if (released) return
        released = true
        this.releaseSlot()
      },
    }
  }

  private releaseSlot(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      if (waiter !== undefined && waiter.settle()) {
        // Hand the slot straight to the queued caller; `available` stays spent.
        waiter.resolve()
        return
      }
    }
    this.available += 1
  }
}
