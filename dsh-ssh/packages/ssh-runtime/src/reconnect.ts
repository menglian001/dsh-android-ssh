import {
  SshConnectionLost,
  SshHostKeyChanged,
  SshHostKeyTrustRequired,
  SshRuntimeDisposed,
} from './errors.ts'

export type ReconnectState =
  | { readonly kind: 'disconnected'; readonly generation: number; readonly attempt: number }
  | { readonly kind: 'connecting'; readonly generation: number; readonly attempt: number }
  | { readonly kind: 'connected'; readonly generation: number; readonly attempt: 0 }
  | { readonly kind: 'reconnecting'; readonly generation: number; readonly attempt: number }
  | {
    readonly kind: 'trust-required'
    readonly generation: number
    readonly attempt: number
    readonly error: SshHostKeyTrustRequired | SshHostKeyChanged
  }
  | {
    readonly kind: 'failed'
    readonly generation: number
    readonly attempt: number
    readonly error: unknown
  }
  | { readonly kind: 'disposed'; readonly generation: number; readonly attempt: number }

export interface ReconnectManagerOptions<T> {
  readonly reconnectAttempts: number
  readonly reconnectDelayMs: number
  readonly open: (signal: AbortSignal) => Promise<T>
  readonly close: (value: T) => Promise<void>
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export class ReconnectManager<T> {
  private readonly options: ReconnectManagerOptions<T>
  private readonly controller = new AbortController()
  private readonly listeners = new Set<(state: ReconnectState) => void>()
  private state: ReconnectState = { kind: 'disconnected', generation: 0, attempt: 0 }
  private current: T | undefined
  private generation = 0
  private pendingConnect: Promise<T> | undefined
  private pendingRecovery: Promise<boolean> | undefined
  private lastError: unknown
  private disposed = false

  constructor(options: ReconnectManagerOptions<T>) {
    if (!Number.isSafeInteger(options.reconnectAttempts) || options.reconnectAttempts < 0) {
      throw new Error('reconnectAttempts must be a non-negative integer')
    }
    if (!Number.isSafeInteger(options.reconnectDelayMs) || options.reconnectDelayMs < 0) {
      throw new Error('reconnectDelayMs must be a non-negative integer')
    }
    this.options = options
  }

  getState(): ReconnectState {
    return this.state
  }

  subscribe(listener: (state: ReconnectState) => void): () => void {
    this.listeners.add(listener)
    this.notifyOne(listener)
    return () => { this.listeners.delete(listener) }
  }

  async get(): Promise<T> {
    this.assertActive()
    if (this.current !== undefined) return this.current
    if (this.pendingRecovery !== undefined) {
      const connected = await this.pendingRecovery
      if (connected && this.current !== undefined) return this.current
      throw this.lastError ?? new SshConnectionLost('SSH reconnect failed')
    }
    if (this.pendingConnect !== undefined) return await this.pendingConnect
    if (this.state.kind === 'failed' || this.state.kind === 'trust-required') {
      throw this.lastError ?? this.state.error
    }
    this.pendingConnect = this.openInitial()
    try {
      return await this.pendingConnect
    } finally {
      this.pendingConnect = undefined
    }
  }

  async reconnect(): Promise<T> {
    this.assertActive()
    if (this.pendingRecovery !== undefined) await this.pendingRecovery
    if (this.pendingConnect !== undefined) return await this.pendingConnect
    const previous = this.current
    this.current = undefined
    if (previous !== undefined) await this.closeSafely(previous)
    this.lastError = undefined
    this.pendingConnect = this.openInitial()
    try {
      return await this.pendingConnect
    } finally {
      this.pendingConnect = undefined
    }
  }

  async reportLoss(value: T, error: SshConnectionLost): Promise<boolean> {
    if (this.disposed) return false
    if (this.current !== value) return this.current !== undefined
    if (this.pendingRecovery !== undefined) return await this.pendingRecovery

    this.current = undefined
    this.lastError = error
    await this.closeSafely(value)
    if (this.options.reconnectAttempts === 0) {
      this.publish({ kind: 'failed', generation: this.generation, attempt: 0, error })
      return false
    }

    this.pendingRecovery = this.recover()
    try {
      return await this.pendingRecovery
    } finally {
      this.pendingRecovery = undefined
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort(new SshRuntimeDisposed('SSH reconnect manager disposed'))
    const current = this.current
    this.current = undefined
    if (current !== undefined) await this.closeSafely(current)
    await Promise.allSettled([
      this.pendingConnect ?? Promise.resolve(),
      this.pendingRecovery ?? Promise.resolve(),
    ])
    this.publish({ kind: 'disposed', generation: this.generation, attempt: 0 })
    this.listeners.clear()
  }

  private async openInitial(): Promise<T> {
    this.publish({ kind: 'connecting', generation: this.generation + 1, attempt: 0 })
    try {
      const value = await this.options.open(this.controller.signal)
      this.assertActive()
      this.current = value
      this.generation += 1
      this.lastError = undefined
      this.publish({ kind: 'connected', generation: this.generation, attempt: 0 })
      return value
    } catch (error: unknown) {
      this.lastError = error
      this.publishFailure(error, 0)
      throw error
    }
  }

  private async recover(): Promise<boolean> {
    for (let attempt = 1; attempt <= this.options.reconnectAttempts; attempt += 1) {
      if (this.disposed) return false
      this.publish({ kind: 'reconnecting', generation: this.generation, attempt })
      try {
        await (this.options.delay ?? defaultDelay)(this.options.reconnectDelayMs, this.controller.signal)
        const value = await this.options.open(this.controller.signal)
        if (this.disposed) {
          await this.closeSafely(value)
          return false
        }
        this.current = value
        this.generation += 1
        this.lastError = undefined
        this.publish({ kind: 'connected', generation: this.generation, attempt: 0 })
        return true
      } catch (error: unknown) {
        if (this.disposed || this.controller.signal.aborted) return false
        this.lastError = error
        if (isHostKeyDecision(error)) {
          this.publish({
            kind: 'trust-required',
            generation: this.generation,
            attempt,
            error,
          })
          return false
        }
        if (attempt === this.options.reconnectAttempts) {
          this.publish({ kind: 'failed', generation: this.generation, attempt, error })
          return false
        }
      }
    }
    return false
  }

  private publishFailure(error: unknown, attempt: number): void {
    if (isHostKeyDecision(error)) {
      this.publish({
        kind: 'trust-required',
        generation: this.generation,
        attempt,
        error,
      })
      return
    }
    this.publish({ kind: 'failed', generation: this.generation, attempt, error })
  }

  private publish(state: ReconnectState): void {
    this.state = state
    for (const listener of [...this.listeners]) this.notifyOne(listener)
  }

  private notifyOne(listener: (state: ReconnectState) => void): void {
    try {
      listener(this.state)
    } catch {
      // Status observers must never break transport state transitions.
    }
  }

  private async closeSafely(value: T): Promise<void> {
    try {
      await this.options.close(value)
    } catch {
      // Retiring an already-lost world is best-effort.
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new SshRuntimeDisposed('SSH reconnect manager disposed')
  }
}

function isHostKeyDecision(error: unknown): error is SshHostKeyTrustRequired | SshHostKeyChanged {
  return error instanceof SshHostKeyTrustRequired || error instanceof SshHostKeyChanged
}

async function defaultDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds === 0) {
    signal.throwIfAborted()
    return
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
