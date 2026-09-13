/**
 * Shared ownership of one SSH execution world. Capability adapters
 * (fs-ssh, subprocess-ssh) await the same connection and control channel, so
 * filesystem and process operations inhabit one remote Linux world.
 *
 * Channel budget (from the spike's measured MaxSessions=10):
 *   1 persistent control channel (ps/kill/test/chmod all multiplexed there)
 *   1 SFTP subsystem channel (lazily opened, kept for the runtime's life)
 *   N = budget - 2 command/PTY channels
 *
 * Teardown contract: like E2B, disposal awaits initialization and closes the
 * transport. Unlike E2B, closing the transport does NOT delete remote state —
 * cwd, files and any still-running setsid process groups survive. The runtime
 * removes only directories it created itself.
 *
 * @module
 */

import { posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ClientChannel, SFTPWrapper } from 'ssh2'
import { ControlChannel } from './control-channel.ts'
import { SshConnection, type SshConnectConfig } from './connection.ts'
import { SshConnectionLost, SshRuntimeDisposed } from './errors.ts'
import { ReconnectManager, type ReconnectState } from './reconnect.ts'
import { ChannelSemaphore, type ChannelPermit } from './semaphore.ts'
import { quoteShellArg } from './quote.ts'

export {
  RemoteExecutionUnknown,
  SshAborted,
  SshConnectionLost,
  SshControlCommandFailed,
  SshControlProtocolError,
  SshHostKeyChanged,
  SshHostKeyTrustRequired,
  SshHostKeyVerificationFailed,
  SshRuntimeDisposed,
  SshRuntimeError,
} from './errors.ts'
export { HostKeyStore, fingerprintHostKey, identifyHostKey } from './host-keys.ts'
export type { HostKeyDecision, HostKeyIdentity } from './host-keys.ts'
export { ReconnectManager } from './reconnect.ts'
export type { ReconnectState } from './reconnect.ts'
export { quoteShellArg, quoteShellArgv } from './quote.ts'
export type { ChannelPermit } from './semaphore.ts'

/** Configuration for the shared SSH runtime owner. */
export interface Config extends SshConnectConfig {
  /** Shared remote working directory, created before adapters run. */
  cwd?: string
  /**
   * sshd MaxSessions for the target server, used for channel budgeting.
   * The spike measured the default 10. Reduce if sshd is configured lower.
   */
  maxSessions?: number
  /** Number of automatic attempts after an established transport is lost. */
  reconnectAttempts?: number
  /** Fixed user-configured delay between reconnect attempts. */
  reconnectDelayMs?: number
}

interface ResolvedConfig extends Required<Pick<
  Config,
  'cwd' | 'maxSessions' | 'reconnectAttempts' | 'reconnectDelayMs'
>> {
  connect: SshConnectConfig
}

interface SchemaResolvedConfig extends Config {
  cwd: string
  maxSessions: number
  reconnectAttempts: number
  reconnectDelayMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ssh: SshRuntime
  }
}

/**
 * Creates one lazily consumable SSH execution world and tears down the
 * transport at disposal. Creation begins at plugin construction; adapters
 * await {@link getConnection} before their first operation.
 */
export class SshRuntime extends Service {
  static Config: z<Config> = z.object({
    host: z.string(),
    port: z.number().default(22),
    username: z.string().default('root'),
    password: z.string(),
    privateKey: z.string(),
    privateKeyPath: z.string(),
    passphrase: z.string(),
    agentSocket: z.string(),
    connectTimeoutMs: z.number().default(20_000),
    keepAliveMs: z.number().default(15_000),
    hostKeyPolicy: z.object({
      knownHosts: z.string(),
    }),
    cwd: z.string().default('/root/dsh'),
    maxSessions: z.number().default(10),
    reconnectAttempts: z.number().default(3),
    reconnectDelayMs: z.number().default(5_000),
  })

  /** Validated remote working directory shared by provider adapters. */
  cwd: string
  /** Remote directory reserved for adapter-owned process/terminal state. */
  runtimeRoot: string

  private config: ResolvedConfig
  private manager: ReconnectManager<ReadyWorld>
  private readonly lossListeners = new WeakMap<ReadyWorld, (error: SshConnectionLost) => void>()
  private disposed = false
  /** Directories this runtime created; teardown removes only these. */
  private readonly createdDirs: string[] = []

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    this.config = SshRuntime.resolve(config)
    this.validate()
    this.cwd = this.config.cwd
    this.runtimeRoot = posix.join(this.cwd, '.dsh-ssh')
    this.manager = this.buildManager()
    // Deliberately no eager dial here. The world is dialed on demand by the
    // first getWorld() (or by an explicit testConnection()/reconnect() from the
    // settings card), so a runtime nobody has used yet reports a truthful
    // `disconnected` instead of burning its retry budget in the constructor
    // before any caller can observe or script the connection.
    ctx.effect(() => async () => {
      await this.dispose()
    }, 'ssh runtime teardown')
  }

  /** Normalize one raw config into the resolved shape every path consumes. */
  private static resolve(config: Config): ResolvedConfig {
    // Schemastery fills these fields before construction; the type does not
    // encode that step.
    const resolved = config as SchemaResolvedConfig
    const { cwd, maxSessions, reconnectAttempts, reconnectDelayMs, ...connect } = resolved
    return {
      connect: {
        ...connect,
        host: connect.host,
        username: connect.username ?? 'root',
        port: connect.port ?? 22,
        connectTimeoutMs: connect.connectTimeoutMs ?? 20_000,
        keepAliveMs: connect.keepAliveMs ?? 15_000,
      },
      cwd: cwd ?? '/root/dsh',
      maxSessions: maxSessions ?? 10,
      reconnectAttempts: reconnectAttempts ?? 3,
      reconnectDelayMs: reconnectDelayMs ?? 5_000,
    }
  }

  /** Build the reconnect machine over the current resolved config. */
  private buildManager(): ReconnectManager<ReadyWorld> {
    return new ReconnectManager({
      reconnectAttempts: this.config.reconnectAttempts,
      reconnectDelayMs: this.config.reconnectDelayMs,
      open: async (signal) => {
        const world = await this.openWorld(signal)
        this.bindWorldLoss(world)
        return world
      },
      close: async world => { await this.closeWorld(world) },
      delay: async (milliseconds, signal) => { await this.waitReconnect(milliseconds, signal) },
    })
  }

  /**
   * Adopt a new endpoint without restarting dsh.
   *
   * The settings card saves to the `ssh-remote` section while dsh keeps
   * running, so the runtime must rebuild its connection policy from the new
   * values: the previous world is retired (its generation is gone) and the
   * runtime returns to a truthful `disconnected` until the next dial. A
   * refused configuration throws before anything is touched, leaving the
   * current endpoint in place.
   *
   * @param next - the full replacement configuration.
   * @throws {Error} when the merged configuration is unusable.
   */
  async reconfigure(next: Config): Promise<void> {
    if (this.disposed) throw new SshRuntimeDisposed('ssh runtime service is disposing')
    const previous = this.config
    const resolved = SshRuntime.resolve(next)
    // Validate the candidate in isolation: assign, judge, and roll back on
    // refusal so a rejected write cannot half-apply.
    this.config = resolved
    try {
      this.validate()
    } catch (error) {
      this.config = previous
      throw error
    }
    await this.manager.dispose()
    this.cwd = resolved.cwd
    this.runtimeRoot = posix.join(this.cwd, '.dsh-ssh')
    this.createdDirs.length = 0
    this.manager = this.buildManager()
  }

  /**
   * Return the live connection, control channel and SFTP wrapper.
   *
   * @throws when the connection failed, is lost, or the service is disposing.
   */
  async getWorld(): Promise<ReadyWorld> {
    if (this.disposed) throw new SshRuntimeDisposed('ssh runtime service is disposing')
    const world = await this.manager.get()
    if (this.disposed) throw new SshRuntimeDisposed('ssh runtime service is disposing')
    return world
  }

  /** Current transport state for settings UI and execution gates. */
  getState(): ReconnectState {
    return this.manager.getState()
  }

  /** Observe committed transport state changes. */
  subscribe(listener: (state: ReconnectState) => void): () => void {
    return this.manager.subscribe(listener)
  }

  /** User-requested reconnect. Automatic retry limits do not apply. */
  async reconnect(): Promise<ReadyWorld> {
    if (this.disposed) throw new SshRuntimeDisposed('ssh runtime service is disposing')
    return await this.manager.reconnect()
  }

  /** Stop reconnects and close the current SSH world. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.manager.dispose()
  }

  /**
   * Run one control-plane command over the persistent channel.
   * This is THE way to run ps/kill/test/chmod — never a fresh channel.
   */
  async control(command: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<string> {
    const world = await this.getWorld()
    const result = await world.control.run({ command, ...options })
    return result.stdout
  }

  /**
   * Acquire a channel slot for a command or PTY channel. Adapters call this
   * BEFORE opening their channel, and release when the channel closes.
   *
   * @throws SshChannelExhausted-class failures surfaced through the
   *   semaphore when the queue is closed; queued waiting honors the signal.
   */
  async acquireChannelSlot(signal?: AbortSignal): Promise<ChannelPermit> {
    const world = await this.getWorld()
    return await world.slots.acquire(signal)
  }

  /** True when the settings name both an endpoint and one authentication method. */
  private get configured(): boolean {
    const connect = this.config.connect
    if (connect.host.trim().length === 0 || connect.username.trim().length === 0) return false
    const authMethods = [
      connect.password, connect.privateKey, connect.privateKeyPath, connect.agentSocket,
    ].filter(value => typeof value === 'string' && value.trim().length > 0).length
    return authMethods === 1
  }

  private validate(): void {
    // An empty endpoint/auth is a supported disconnected state: dsh must boot
    // far enough to render the settings card where the user configures it.
    // getWorld()/reconnect() fail closed until the world is configured.
    if (!posix.isAbsolute(this.config.cwd)) {
      throw new Error(`dsh-ssh: cwd must be an absolute Linux path: ${this.config.cwd}`)
    }
    if (!Number.isInteger(this.config.maxSessions) || this.config.maxSessions < 3) {
      throw new Error(`dsh-ssh: maxSessions must be an integer >= 3: ${this.config.maxSessions}`)
    }
    if (!Number.isSafeInteger(this.config.reconnectAttempts) || this.config.reconnectAttempts < 0) {
      throw new Error(`dsh-ssh: reconnectAttempts must be a non-negative integer: ${this.config.reconnectAttempts}`)
    }
    if (!Number.isSafeInteger(this.config.reconnectDelayMs) || this.config.reconnectDelayMs < 0) {
      throw new Error(`dsh-ssh: reconnectDelayMs must be a non-negative integer: ${this.config.reconnectDelayMs}`)
    }
    const connect = this.config.connect
    const nonBlankAuthMethods = [
      connect.password, connect.privateKey, connect.privateKeyPath, connect.agentSocket,
    ].filter(value => typeof value === 'string' && value.trim().length > 0).length
    const partiallyConfigured = connect.host.trim().length > 0
      || connect.username.trim().length > 0
      || nonBlankAuthMethods > 0
    if (partiallyConfigured && !this.configured) {
      throw new Error('dsh-ssh: configure host, username, and exactly one authentication method')
    }
  }

  protected async openWorld(signal?: AbortSignal): Promise<ReadyWorld> {
    if (!this.configured) {
      throw new SshConnectionLost('dsh-ssh: configure host, username, and one authentication method')
    }
    signal?.throwIfAborted()
    const connection = new SshConnection(this.config.connect)
    await connection.connect(signal)

    // Control channel: 1 slot, held for the generation's life.
    const control = new ControlChannel(async () =>
      await connection.openExecChannel('/bin/bash --noprofile --norc -s'))
    try {
      await control.start(signal)
      await this.prepareDirectories(control)
    } catch (error: unknown) {
      try {
        control.close()
        connection.end()
      } catch (_rollbackFailure) {
        // The transport close is best-effort; sshd reaps on socket close.
      }
      throw error
    }

    // Budget: control(1) + sftp(1) are permanently reserved.
    const commandSlots = this.config.maxSessions - 2
    const slots = new ChannelSemaphore(commandSlots)
    return {
      connection,
      control,
      slots,
      maxCommandChannels: commandSlots,
      sftp: new LazySftp(() => connection.openSftp()),
    }
  }

  private bindWorldLoss(world: ReadyWorld): void {
    const onLost = (error: SshConnectionLost): void => {
      void this.manager.reportLoss(world, error).catch(() => {})
    }
    this.lossListeners.set(world, onLost)
    world.connection.on('lost', onLost)
  }

  protected async waitReconnect(milliseconds: number, signal: AbortSignal): Promise<void> {
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

  private async closeWorld(world: ReadyWorld): Promise<void> {
    const onLost = this.lossListeners.get(world)
    if (onLost !== undefined) {
      world.connection.removeListener('lost', onLost)
      this.lossListeners.delete(world)
    }
    world.slots.close(new SshConnectionLost('SSH world generation retired'))
    world.control.close()
    world.sftp.close()
    world.connection.end()
  }

  /** mkdir -p cwd and runtimeRoot, chmod 700 runtimeRoot, record creation. */
  private async prepareDirectories(control: ControlChannel): Promise<void> {
    const dir = (path: string): string =>
      `if ! test -d ${quoteShellArg(path)}; then mkdir -p -- ${quoteShellArg(path)} && printf created; else printf existed; fi`
    const cwdResult = await control.run({ command: dir(this.cwd), timeoutMs: 15_000 })
    if (cwdResult.stdout.trim() === 'created') this.createdDirs.push(this.cwd)
    const rootResult = await control.run({ command: dir(this.runtimeRoot), timeoutMs: 15_000 })
    if (rootResult.stdout.trim() === 'created') this.createdDirs.push(this.runtimeRoot)
    await control.run({
      command: `chmod 700 -- ${quoteShellArg(this.runtimeRoot)}`,
      timeoutMs: 15_000,
    })
    // The runtime root must be a real directory, not a symlink (E2B parity).
    await control.run({
      command: `test -d ${quoteShellArg(this.runtimeRoot)} && ! test -L ${quoteShellArg(this.runtimeRoot)}`,
      timeoutMs: 15_000,
    })
  }

  /** Remove exactly the directories this runtime created, best effort. */
  private async removeCreatedDirs(world: ReadyWorld): Promise<void> {
    if (this.createdDirs.length === 0) return
    const targets = [...this.createdDirs].reverse().map(path => quoteShellArg(path)).join(' ')
    // If our transport died, open a throwaway one; if that fails too, leave
    // the directories — they are the user's cwd territory, not a sandbox.
    let control = world.control
    let connection = world.connection
    if (!connection.isConnected) {
      try {
        connection = new SshConnection(this.config.connect)
        await connection.connect()
        control = new ControlChannel(async () =>
          await connection.openExecChannel('/bin/bash --noprofile --norc -s'))
        await control.start()
      } catch (_reconnectFailure) {
        return
      }
    }
    try {
      await control.run({ command: `rm -rf -- ${targets} 2>/dev/null || true`, timeoutMs: 15_000 })
    } catch (_removeFailure) {
      // Best effort by contract; leftover empty dirs are harmless.
    } finally {
      if (!world.connection.isConnected) {
        control.close()
        connection.end()
      }
    }
  }
}

/** The live remote world: transport, control plane, channel budget, SFTP. */
export interface ReadyWorld {
  readonly connection: SshConnection
  readonly control: ControlChannel
  readonly slots: ChannelSemaphore
  readonly maxCommandChannels: number
  readonly sftp: LazySftp
}

/**
 * SFTP wrapper opened on first use and kept open. Channel budgeting is the
 * runtime's job; the SFTP channel's slot is permanently reserved, so no
 * admission control is needed here.
 */
export class LazySftp {
  private promise: Promise<SFTPWrapper> | undefined
  private readonly open: () => Promise<ClientChannel | SFTPWrapper>

  constructor(open: () => Promise<ClientChannel | SFTPWrapper>) {
    this.open = open
  }

  /** The SFTP wrapper, opening it on first call. Concurrent callers share. */
  get(): Promise<SFTPWrapper> {
    this.promise ??= this.open() as Promise<SFTPWrapper>
    return this.promise
  }

  /** Close the lazily opened SFTP channel, if any. Idempotent. */
  async close(): Promise<void> {
    const pending = this.promise
    this.promise = undefined
    if (pending === undefined) return
    try {
      const sftp = await pending
      sftp.end()
    } catch {
      // A transport loss can reject the pending open or already close SFTP.
    }
  }
}

export default SshRuntime
