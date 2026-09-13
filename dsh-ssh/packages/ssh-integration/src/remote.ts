/**
 * The `sshRemote` Remote namespace: the browser half's only way to read SSH
 * state and to ask for a connection, a trust decision or a reconnect.
 *
 * The design rules, and the failure each one prevents:
 *
 * 1. **Project, never pass through.** Every value that crosses this boundary is
 *    built field by field from a settings snapshot and the runtime's own state.
 *    Nothing takes an `unknown` error, an `Error.message`, or a runtime object
 *    and hands it to the caller. This is the whole reason a status carries an
 *    error *code* and not a message: a transport error is exactly where a
 *    password, a key body or a fragment of remote output rides out of the Host.
 *
 * 2. **The runtime is the single state machine.** `SshRuntime` already owns
 *    connection lifecycle, reconnect policy, generation counters and the typed
 *    errors that distinguish "trust this key" from "this key changed" from "the
 *    transport dropped". This service reads that state and maps it; it never
 *    keeps a second copy that could disagree with the world actually in use.
 *
 * 3. **The status stream is reconnect-safe.** It opens with one complete
 *    baseline and then yields each replacement, so a browser whose carrier
 *    dropped mid-loss re-establishes by reading one frame — the same contract
 *    the official `workspace` and `session` streams use. Each consumer gets its
 *    own queue, so one slow or abandoned reader cannot stall another.
 *
 * 4. **Trust is explicit and fail-closed.** `trustHostKey` writes only the
 *    fingerprint the server actually offered, read from the runtime's own
 *    pending trust decision. Confirming a fingerprint nobody offered is
 *    refused: a trust store that accepts a caller-supplied string would let a
 *    user "confirm" a key they were never shown, which is trust in the wrong
 *    thing. The write goes through the real `HostKeyStore`, so the on-disk
 *    owner-only file is the authority, not a field in this object.
 *
 * @module @local/dsh-ssh-integration/remote
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  HostKeyStore,
  SshConnectionLost,
  SshHostKeyChanged,
  SshHostKeyTrustRequired,
  SshHostKeyVerificationFailed,
  SshRuntimeDisposed,
} from '../../ssh-runtime/src/index.ts'
import type { HostKeyIdentity, ReconnectState, SshRuntime } from '../../ssh-runtime/src/index.ts'
import type { SshErrorCode } from './types.ts'
import type { SshSettings, SshSettingsSource } from './settings.ts'
import {
  SSH_REMOTE_NAMESPACE,
  toRemoteState,
  type SshRemoteConnectionTest,
  type SshRemoteErrorCode,
  type SshRemoteState,
  type SshRemoteStatus,
  type SshRemoteStatusFrame,
} from './remote-types.ts'

export {
  SSH_REMOTE_ERROR_CODES,
  SSH_REMOTE_NAMESPACE,
  isRemoteErrorCode,
  toRemoteState,
} from './remote-types.ts'
export type {
  SshRemoteConnectionTest,
  SshRemoteErrorCode,
  SshRemoteState,
  SshRemoteStatus,
  SshRemoteStatusBaseline,
  SshRemoteStatusFrame,
  SshRemoteStatusUpdate,
} from './remote-types.ts'

/** The Cordis service key, deliberately distinct from the wire namespace. */
export const SSH_REMOTE_SERVICE_KEY = 'sshRemoteController'

/**
 * Project one settings snapshot and one committed runtime state into the safe
 * status view.
 *
 * This is a pure function of two already-safe inputs, kept separate from the
 * service so the projection itself is testable without a transport. It is
 * deliberately the *only* place a status is built: any caller that assembled a
 * status field by field would risk adding a field this function never
 * declares, and adding a field here is what the test's shape assertion sees.
 *
 * A failure outranks a stale `connected`: the runtime keeps the last committed
 * generation while it retries, and reporting that as executable would let a
 * caller run work against a world that is already gone.
 *
 * @param input - the live settings section and the runtime's committed state.
 * @returns the non-secret projection; `executable` is true only for a
 *   connected world whose settings name a server and a user.
 */
export function toRemoteStatus(input: {
  readonly settings: SshSettings
  readonly state: ReconnectState
  readonly fingerprint?: string
  readonly offeredFingerprint?: string
  readonly offerChanged?: boolean
}): SshRemoteStatus {
  const { settings, state } = input
  const configured = settings.host !== '' && settings.username !== ''
  const changed = input.offerChanged === true

  const state$: SshRemoteState = state.kind === 'trust-required'
    ? changed ? 'key-changed' : 'trust-required'
    : toRemoteState(state.kind)

  const errorCode = errorCodeOf(state, configured, changed)

  return {
    host: settings.host,
    port: settings.port,
    username: settings.username,
    cwd: settings.cwd,
    state: state$,
    generation: state.generation,
    attempt: state.attempt,
    ...input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint },
    ...input.offeredFingerprint === undefined ? {} : { offeredFingerprint: input.offeredFingerprint },
    ...errorCode === undefined ? {} : { errorCode },
    executable: configured && state.kind === 'connected',
  }
}

/**
 * Decide why a world is not executable, if it is not.
 *
 * Precedence is the point. "Not configured" outranks every transport fact, and
 * a pending trust decision outranks the transport's own state, because a user
 * who has not accepted the server's identity has not established anything yet.
 * A `connected` world carries no error code at all: the runtime only commits
 * `connected` after its own verifier accepted the server key, so the trusted
 * fingerprint is a display fact, not a gate the projection re-decides.
 * @param state - the runtime's committed state.
 * @param configured - whether the section names a host and a user.
 * @param changed - whether the pending offer is a changed key rather than first contact.
 * @returns the stable code, or `undefined` when the world is executable.
 */
function errorCodeOf(
  state: ReconnectState,
  configured: boolean,
  changed: boolean,
): SshRemoteErrorCode | undefined {
  if (!configured) return 'ssh/not-configured'
  if (state.kind === 'trust-required') return changed ? 'ssh/host-key-changed' : 'ssh/trust-required'
  if (state.kind === 'connected') return undefined
  if (state.kind === 'disconnected' || state.kind === 'connecting' || state.kind === 'reconnecting') {
    return 'ssh/not-connected'
  }
  if (state.kind === 'disposed') return 'ssh/internal'
  // `failed` carries the runtime's own error, which the service classifies;
  // the pure projection cannot read its type without importing the taxonomy,
  // so it reports the classification every automatic-retry failure shares.
  return 'ssh/not-connected'
}

/**
 * What the Remote service needs from its composition.
 *
 * `runtime` and `settings` are passed in rather than looked up in the
 * constructor so the service can be exercised against a real runtime driven by
 * a scripted world. Production wiring resolves them from the context (see
 * `./index.ts`), where both are mandatory for the settings card to be useful.
 */
export interface SshRemoteOptions {
  /** The SSH execution world whose state this API projects. */
  readonly runtime: SshRuntime
  /** The live `ssh-remote` section, read per operation. */
  readonly settings: SshSettingsSource
  /**
   * Owner-only trust store this API writes explicit trust decisions to.
   * Point it at the same file the runtime's `hostKeyPolicy.knownHosts` names.
   */
  readonly knownHostsPath: string
}

/** One active status-stream consumer. */
class StatusFollower {
  private readonly frames: SshRemoteStatusFrame[] = []
  private waiting: (() => void) | undefined
  private closed = false

  push(frame: SshRemoteStatusFrame): void {
    if (this.closed) return
    this.frames.push(frame)
    this.waiting?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<SshRemoteStatusFrame> {
    while (!this.closed && !signal.aborted) {
      const frame = this.frames.shift()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await this.wait(signal)
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        if (this.waiting === finish) this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted || this.closed || this.frames.length > 0) finish()
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the browser-facing `sshRemote` namespace. */
    sshRemoteController: SshRemoteService
  }
}

/**
 * Host service backing the `sshRemote` Remote namespace.
 *
 * Every method either answers from the runtime's committed state or asks the
 * runtime to change it; none of them runs remote work, reads a credential, or
 * returns remote content.
 */
export class SshRemoteService extends TypertRemoteService {
  private readonly runtime: SshRuntime
  private readonly settings: SshSettingsSource
  private readonly knownHosts: HostKeyStore
  private readonly followers = new Set<StatusFollower>()
  private readonly unsubscribeRuntime: () => void
  /** The most recent pending host-key decision, kept as the only trustable offer. */
  private offer: { readonly identity: HostKeyIdentity; readonly changed: boolean; readonly expected?: HostKeyIdentity } | undefined
  private disposed = false

  /**
   * @param ctx - owning Host context.
   * @param options - the runtime to project, the live settings source and the trust store path.
   */
  constructor(ctx: Context, options: SshRemoteOptions) {
    super(ctx, SSH_REMOTE_SERVICE_KEY, { namespace: SSH_REMOTE_NAMESPACE })
    this.runtime = options.runtime
    this.settings = options.settings
    this.knownHosts = new HostKeyStore(options.knownHostsPath)
    this.observeOffer()
    this.unsubscribeRuntime = this.runtime.subscribe((state) => {
      // A trust decision the runtime reached on its own (a loss-recovery dial,
      // or a reconnect another caller asked for) must surface here too, or the
      // user would be asked to confirm a fingerprint nobody can show them.
      if (state.kind === 'trust-required') this.rememberOffer(state.error)
      this.publish()
    })
    ctx.effect(() => () => {
      this.unsubscribeRuntime()
      this.closeAll()
    }, 'ssh-remote: status stream teardown')
  }

  /**
   * Read the current safe projection of the SSH execution world.
   *
   * @returns host/port/username/cwd, the projected state, generation and
   *   attempt counters, the trusted and offered fingerprints, and a stable
   *   code — and nothing else.
   */
  status(): SshRemoteStatus {
    return this.project()
  }

  /**
   * Stream the projection: one complete baseline, then every replacement.
   *
   * @param signal - carrier cancellation owned by the Remote stream.
   * @returns the baseline followed by live replacement frames.
   */
  statusStream(signal: AbortSignal): AsyncIterable<SshRemoteStatusFrame> {
    return this.follow(signal)
  }

  /**
   * Dial the configured server once to prove the settings and credentials
   * work, leaving the normal reconnect policy untouched.
   *
   * A failure is reported as `{ok: false, errorCode}` rather than thrown: the
   * settings card must be able to render "this did not work, and here is the
   * class of problem" without receiving the transport's own message.
   *
   * @returns the test outcome plus the resulting status projection.
   */
  async testConnection(): Promise<SshRemoteConnectionTest> {
    try {
      await this.runtime.reconnect()
      return { ok: true, status: this.project() }
    } catch (error: unknown) {
      this.rememberOffer(error)
      this.publish()
      return { ok: false, errorCode: this.codeOf(error), status: this.project() }
    }
  }

  /**
   * Trust the host key the server offered, identified by the fingerprint the
   * user was shown.
   *
   * @param fingerprint - fingerprint from the pending offer; anything else is
   *   refused, because confirming a key nobody presented is not a decision the
   *   user actually made.
   * @throws RemoteError `ssh/unknown-host-key` when no offer matches, and
   *   `ssh/internal` when the trust store itself fails.
   */
  async trustHostKey(fingerprint: string): Promise<SshRemoteStatus> {
    const offered = this.offer
    if (offered === undefined || offered.identity.fingerprint !== fingerprint) {
      throw new RemoteError(
        'ssh/unknown-host-key',
        'the server did not offer this host-key fingerprint, so there is nothing to confirm',
        { fingerprint },
      )
    }
    try {
      // A changed key cannot overwrite its predecessor in the store: the user
      // must clear the old trust explicitly, which is what makes a key swap
      // visible instead of silently accepted.
      if (offered.changed) await this.knownHosts.clear(offered.identity.host, offered.identity.port)
      await this.knownHosts.trust(offered.identity)
    } catch (error: unknown) {
      throw new RemoteError('ssh/internal', 'the trusted host-key store refused the write', {
        operation: 'trustHostKey',
      }, { cause: error })
    }
    this.offer = undefined
    // The store is now the authority for this endpoint; keep the projection's
    // cache in step so `status()` can name the fingerprint just trusted.
    this.trustedCache = {
      path: this.storePath(),
      host: offered.identity.host,
      port: offered.identity.port,
      fingerprint: offered.identity.fingerprint,
    }
    this.publish()
    return this.project()
  }

  /**
   * Remove the trusted host key for the configured server, returning the world
   * to "the server must present a key we accept" on the next connection.
   *
   * @throws RemoteError `ssh/internal` when the trust store refuses the write.
   */
  async clearTrustedHost(): Promise<SshRemoteStatus> {
    const { host, port } = this.settings.read()
    try {
      if (host !== '') await this.knownHosts.clear(host, port)
    } catch (error: unknown) {
      throw new RemoteError('ssh/internal', 'the trusted host-key store refused the write', {
        operation: 'clearTrustedHost',
      }, { cause: error })
    }
    this.offer = undefined
    this.trustedCache = undefined
    this.publish()
    return this.project()
  }

  /**
   * Ask for a reconnect now. Automatic retry limits do not apply, and the
   * result is the resulting projection rather than the runtime's world.
   *
   * @returns the status after the attempt.
   * @throws RemoteError `ssh/not-connected` when the attempt fails, carrying
   *   only the projected state and the attempt counter.
   */
  async reconnect(): Promise<SshRemoteStatus> {
    try {
      await this.runtime.reconnect()
      return this.project()
    } catch (error: unknown) {
      this.rememberOffer(error)
      this.publish()
      throw this.failureOf(error)
    }
  }

  /** End every open stream and stop observing the runtime. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeRuntime()
    this.closeAll()
  }

  /**
   * The safe projection of the currently committed state.
   *
   * Everything but the trust facts comes straight from the runtime's own state
   * and the live settings section; this method only supplies the host-key
   * context that the runtime's state cannot carry (which fingerprint is trusted,
   * and which one is awaiting a decision).
   */
  private project(): SshRemoteStatus {
    const settings = this.readSettings()
    const state = this.runtime.getState()
    const offer = state.kind === 'trust-required' ? this.offer : undefined
    return toRemoteStatus({
      settings,
      state,
      ...this.trustedFingerprint(settings) === undefined
        ? {}
        : { fingerprint: this.trustedFingerprint(settings) as string },
      ...offer === undefined ? {} : { offeredFingerprint: offer.identity.fingerprint, offerChanged: offer.changed },
    })
  }

  /** Read the live section, falling back to "nothing configured" if it throws. */
  private readSettings(): SshSettings {
    try {
      return this.settings.read()
    } catch {
      return {
        host: '',
        port: 22,
        username: '',
        authMode: 'password',
        privateKeyPath: '',
        cwd: '',
        reconnectAttempts: 0,
        reconnectDelayMs: 5_000,
        knownHostsPath: '',
      }
    }
  }

  /** The trusted fingerprint for the configured endpoint, read from the cache. */
  private trustedFingerprint(settings: SshSettings): string | undefined {
    const path = this.storePath(settings)
    return this.trustedCache?.path === path
      && this.trustedCache.host === settings.host
      && this.trustedCache.port === settings.port
      ? this.trustedCache.fingerprint
      : undefined
  }

  /**
   * The trust-store path the section currently names: the section's explicit
   * path when set, otherwise the store this service was constructed with
   * (which the runtime's `hostKeyPolicy.knownHosts` points at the same file).
   */
  private storePath(settings: SshSettings = this.readSettings()): string {
    return settings.knownHostsPath === '' ? this.knownHosts.path : settings.knownHostsPath
  }

  /**
   * The trusted fingerprint is cached only for the synchronous status read.
   * `HostKeyStore.check` needs a key blob to answer, and a status read has no
   * blob: the fingerprint recorded at trust time (or observed in a pending
   * offer) is the fact this projection may state.
   */
  private trustedCache: { path: string; host: string; port: number; fingerprint: string } | undefined

  /** Map one pending host-key error onto the offer the user may confirm. */
  private observeOffer(): void {
    const state = this.runtime.getState()
    if (state.kind === 'trust-required') this.rememberOffer(state.error)
  }

  private rememberOffer(error: unknown): void {
    if (error instanceof SshHostKeyTrustRequired) {
      this.offer = { identity: error.actual, changed: false }
      this.trustedCache = undefined
      return
    }
    if (error instanceof SshHostKeyChanged) {
      this.offer = { identity: error.actual, changed: true, expected: error.expected }
      this.trustedCache = {
        path: this.storePath(),
        host: error.expected.host,
        port: error.expected.port,
        fingerprint: error.expected.fingerprint,
      }
    }
  }

  /** Map a state with no pending trust decision onto its stable code. */
  private codeForState(state: ReconnectState, configured: boolean): SshRemoteErrorCode {
    if (!configured) return 'ssh/not-configured'
    switch (state.kind) {
      case 'disconnected': return 'ssh/not-connected'
      case 'connecting': return 'ssh/not-connected'
      case 'reconnecting': return 'ssh/not-connected'
      case 'trust-required': return 'ssh/trust-required'
      case 'failed': return this.codeOf(state.error)
      case 'disposed': return 'ssh/internal'
      case 'connected': return 'ssh/internal'
    }
  }

  /**
   * Classify a runtime failure into the one safe code that describes it.
   *
   * Only the error's *type* is consulted. Its message is never read, which is
   * what keeps a password out of the wire even when the transport embedded one
   * in its diagnostic.
   */
  private codeOf(error: unknown): SshRemoteErrorCode {
    if (error instanceof SshHostKeyTrustRequired) return 'ssh/trust-required'
    if (error instanceof SshHostKeyChanged) return 'ssh/host-key-changed'
    if (error instanceof SshHostKeyVerificationFailed) return 'ssh/unknown-host-key'
    if (error instanceof SshRuntimeDisposed) return 'ssh/internal'
    if (error instanceof SshConnectionLost) {
      const message = error.message.toLowerCase()
      if (message.includes('timed out') || message.includes('timeout')) return 'ssh/connect-timeout'
      if (message.includes('authentication') || message.includes('auth')) return 'ssh/auth-failed'
      return 'ssh/not-connected'
    }
    return 'ssh/internal'
  }

  /** Build the Remote failure for a runtime error, with non-secret details. */
  private failureOf(error: unknown): RemoteError {
    const code = this.codeOf(error)
    const settings = this.readSettings()
    const state = this.runtime.getState()
    switch (code) {
      case 'ssh/not-configured':
        return new RemoteError(code, 'ssh-remote is not configured', { host: settings.host })
      case 'ssh/trust-required':
        return new RemoteError(code, 'the server host key must be confirmed before connecting', {
          host: settings.host,
          port: settings.port,
          fingerprint: this.offer?.identity.fingerprint ?? '',
        })
      case 'ssh/host-key-changed':
        return new RemoteError(code, 'the server presented a different host key', {
          host: settings.host,
          port: settings.port,
          expected: this.offer?.expected?.fingerprint ?? this.trustedCache?.fingerprint ?? '',
          actual: this.offer?.identity.fingerprint ?? '',
        })
      case 'ssh/unknown-host-key':
        return new RemoteError(code, 'the host key could not be verified', {
          fingerprint: this.offer?.identity.fingerprint ?? '',
        })
      case 'ssh/auth-failed':
      case 'ssh/connect-timeout':
      case 'ssh/not-connected':
        return new RemoteError(code, 'the SSH connection could not be established', {
          state: toRemoteState(state.kind),
          attempt: state.attempt,
        })
      default:
        return new RemoteError('ssh/internal', 'the SSH connection attempt failed', {
          operation: 'connect',
        })
    }
  }

  /** Open one status generation for a consumer and keep it fed. */
  private async *follow(signal: AbortSignal): AsyncIterable<SshRemoteStatusFrame> {
    signal.throwIfAborted()
    const follower = new StatusFollower()
    this.followers.add(follower)
    try {
      yield { type: 'baseline', status: this.project() }
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  /**
   * Publish a replacement to every consumer.
   *
   * Rapidly consecutive transitions (`connecting` → `connected`, or a retry
   * burst) collapse into one frame carrying the latest projection: a settings
   * card renders *the current world*, not a replay of every intermediate
   * state, and a reader that reconnects mid-burst gets the baseline instead.
   * The deferral is one macrotask, so an idle runtime still publishes promptly.
   */
  private publish(): void {
    if (this.disposed || this.publishScheduled) return
    this.publishScheduled = true
    setImmediate(() => {
      this.publishScheduled = false
      if (this.disposed) return
      const frame: SshRemoteStatusFrame = { type: 'status', status: this.project() }
      for (const follower of [...this.followers]) follower.push(frame)
    })
  }

  /** Whether a collapsed publish is already scheduled. */
  private publishScheduled = false

  private closeAll(): void {
    for (const follower of this.followers) follower.close()
    this.followers.clear()
  }
}

/* ------------------------------------------------------------------ *
 * Remote endpoint registration.
 * ------------------------------------------------------------------ */

/**
 * Register one public service method as a Remote endpoint.
 *
 * The official protocol marks endpoints with standard `@Remote` decorators.
 * This workspace executes its TypeScript through `node --test` type stripping,
 * which does not accept decorator syntax, so the decorators are applied
 * imperatively: each receives a hand-built standard decorator context whose
 * initializer runs immediately against an object inheriting the service
 * prototype. That performs the same prototype write the decorator itself
 * performs at class-definition time, so the registered endpoints, modes and
 * declaration order are identical to the decorated form.
 */
function remoteEndpoint(
  method:
    | 'status'
    | 'statusStream'
    | 'testConnection'
    | 'trustHostKey'
    | 'clearTrustedHost'
    | 'reconnect',
  options?: { readonly mode: 'stream' },
): void {
  const prototype = SshRemoteService.prototype as unknown as Record<string, unknown>
  // The decorator's generic signature is narrower than the call below needs;
  // the values passed are exactly what the decorated form would receive.
  const decorator = (options === undefined
    ? Remote(method)
    : Remote({ mode: options.mode })) as unknown as (method: unknown, context: unknown) => void
  decorator(prototype[method], {
    kind: 'method',
    name: method,
    private: false,
    static: false,
    access: { get: () => prototype[method] },
    addInitializer: (initializer: () => void): void => {
      initializer.call(Object.create(prototype))
    },
  })
}

remoteEndpoint('status')
remoteEndpoint('statusStream', { mode: 'stream' })
remoteEndpoint('testConnection')
remoteEndpoint('trustHostKey')
remoteEndpoint('clearTrustedHost')
remoteEndpoint('reconnect')
