/**
 * Error taxonomy for the SSH execution world.
 *
 * The critical distinction from the E2B reference: a lost SSH connection is
 * NOT a vanished world. E2B treats `SandboxNotFoundError` as proof of
 * quiescence because deleting a sandbox really does destroy every process in
 * it. SSH has no such guarantee — the spike confirmed that a `setsid` process
 * group survives its originating channel closing, which is exactly what
 * tree-scoped termination relies on. Mapping a dropped connection onto
 * "already quiescent" would silently leak remote process trees.
 *
 * @module
 */

import type { HostKeyIdentity } from './host-keys.ts'

/** Base class for every fault this runtime raises. */
export class SshRuntimeError extends Error {
  override readonly name: string = 'SshRuntimeError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/**
 * The SSH transport dropped. Remote processes may still be running.
 *
 * Callers must never treat this as proof that a process tree stopped. The
 * correct response is to reconnect and re-probe, or to surface "quiescence
 * could not be proven" upward.
 */
export class SshConnectionLost extends SshRuntimeError {
  override readonly name: string = 'SshConnectionLost'

  /**
   * Always false. Present so call sites that would otherwise reach for an
   * E2B-style "world is gone, treat as stopped" shortcut have to read this
   * flag and confront the answer.
   */
  readonly provesQuiescence = false as const

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** First contact with a server key. The caller must show and explicitly trust it. */
export class SshHostKeyTrustRequired extends SshConnectionLost {
  override readonly name = 'SshHostKeyTrustRequired'
  readonly actual: HostKeyIdentity

  constructor(actual: HostKeyIdentity) {
    super(`SSH host key trust required for ${actual.host}:${actual.port} (${actual.fingerprint})`)
    this.actual = actual
  }
}

/** A previously trusted endpoint presented a different server key. */
export class SshHostKeyChanged extends SshConnectionLost {
  override readonly name = 'SshHostKeyChanged'
  readonly expected: HostKeyIdentity
  readonly actual: HostKeyIdentity

  constructor(expected: HostKeyIdentity, actual: HostKeyIdentity) {
    super(`SSH host key changed for ${actual.host}:${actual.port}`)
    this.expected = expected
    this.actual = actual
  }
}

/** The trust store or verifier failed; the connection is denied fail-closed. */
export class SshHostKeyVerificationFailed extends SshConnectionLost {
  override readonly name = 'SshHostKeyVerificationFailed'

  constructor(options?: { cause?: unknown }) {
    super('SSH host key verification failed', options)
  }
}

/** A transport loss left a remote process/terminal result unprovable. */
export class RemoteExecutionUnknown extends SshConnectionLost {
  override readonly name = 'RemoteExecutionUnknown'
  readonly operationId: string
  readonly stateDir: string
  readonly kind: 'process' | 'terminal'

  constructor(options: {
    operationId: string
    stateDir: string
    kind: 'process' | 'terminal'
    cause?: unknown
  }) {
    super(`remote ${options.kind} execution state is unknown (${options.operationId})`, {
      cause: options.cause,
    })
    this.operationId = options.operationId
    this.stateDir = options.stateDir
    this.kind = options.kind
  }
}

/** The runtime is disposing or already disposed; no new work is accepted. */
export class SshRuntimeDisposed extends SshRuntimeError {
  override readonly name = 'SshRuntimeDisposed'
}

/** A control-plane command exited non-zero. Carries the observed exit status. */
export class SshControlCommandFailed extends SshRuntimeError {
  override readonly name = 'SshControlCommandFailed'
  readonly command: string
  readonly exitStatus: number
  readonly stdout: string
  readonly stderr: string

  constructor(command: string, exitStatus: number, stdout: string, stderr: string) {
    super(
      `ssh control command exited ${exitStatus}: ${command}`
      + (stderr.trim().length > 0 ? ` — ${stderr.trim().slice(0, 400)}` : ''),
    )
    this.command = command
    this.exitStatus = exitStatus
    this.stdout = stdout
    this.stderr = stderr
  }
}

/** The control channel's framing protocol was violated (marker desync). */
export class SshControlProtocolError extends SshRuntimeError {
  override readonly name = 'SshControlProtocolError'
}

/** No channel slot became available before the caller's deadline or signal. */
export class SshChannelExhausted extends SshRuntimeError {
  override readonly name = 'SshChannelExhausted'
}

/** An operation was aborted through its `AbortSignal`. */
export class SshAborted extends SshRuntimeError {
  override readonly name = 'SshAborted'
}
