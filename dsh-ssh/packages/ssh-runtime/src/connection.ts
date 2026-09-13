/**
 * Promise-style wrapper over one ssh2 `Client` connection.
 *
 * E2B's SDK hides transport lifecycle behind HTTP requests; SSH exposes it,
 * and the whole runtime design bends around that: one connection, bounded
 * channels (spike-measured MaxSessions ceiling: 10), and a transport whose
 * death means "unknown remote state" — never "processes stopped".
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { HostKeyStore } from './host-keys.ts'
import {
  SshConnectionLost,
  SshHostKeyChanged,
  SshHostKeyTrustRequired,
  SshHostKeyVerificationFailed,
} from './errors.ts'

export interface SshAuthConfig {
  /** Password authentication. */
  readonly password?: string
  /** PEM/OpenSSH private key. Mutually exclusive with `privateKeyPath`. */
  readonly privateKey?: string
  /** Path to a private key file, read at connect time. */
  readonly privateKeyPath?: string
  /** Passphrase for an encrypted private key. */
  readonly passphrase?: string
  /** SSH agent at this UNIX socket path. */
  readonly agentSocket?: string
}

export interface SshConnectConfig extends SshAuthConfig {
  readonly host: string
  readonly port?: number
  readonly username: string
  /** TCP + handshake + auth budget in milliseconds. */
  readonly connectTimeoutMs?: number
  /** ssh2 keepalive interval in milliseconds; 0 disables. */
  readonly keepAliveMs?: number
  /** Owner-only trust store used for explicit TOFU verification. */
  readonly hostKeyPolicy?: { readonly knownHosts: string }
}

export function normalizeAuth(config: SshAuthConfig): Partial<ConnectConfig> {
  const password = nonBlank(config.password)
  const inlineKey = nonBlank(config.privateKey)
  const keyPath = nonBlank(config.privateKeyPath)
  const agentSocket = nonBlank(config.agentSocket)
  const passphrase = nonBlank(config.passphrase)
  const methods = [password, inlineKey, keyPath, agentSocket].filter(value => value !== undefined)
  if (methods.length !== 1) {
    throw new SshConnectionLost('ssh auth requires exactly one authentication method')
  }
  if (passphrase !== undefined && inlineKey === undefined && keyPath === undefined) {
    throw new SshConnectionLost('ssh auth passphrase requires a private key')
  }
  if (password !== undefined) return { password: config.password as string }
  if (agentSocket !== undefined) return { agent: config.agentSocket as string }
  const privateKey = inlineKey !== undefined
    ? config.privateKey as string
    : readFileSync(config.privateKeyPath as string, 'utf8')
  return passphrase !== undefined
    ? { privateKey, passphrase: config.passphrase as string }
    : { privateKey }
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

export interface HostKeyVerifier {
  readonly verify: (key: Buffer, callback: (permitted: boolean) => void) => void
  readonly failure: () => SshConnectionLost | undefined
}

export function createHostKeyVerifier(
  store: HostKeyStore,
  host: string,
  port: number,
): HostKeyVerifier {
  let verificationFailure: SshConnectionLost | undefined
  return {
    verify(key, callback) {
      void store.check(host, port, key).then((decision) => {
        if (decision.kind === 'trusted') {
          verificationFailure = undefined
          callback(true)
          return
        }
        verificationFailure = decision.kind === 'changed'
          ? new SshHostKeyChanged(decision.expected, decision.actual)
          : new SshHostKeyTrustRequired(decision.actual)
        callback(false)
      }, (error: unknown) => {
        verificationFailure = new SshHostKeyVerificationFailed({ cause: error })
        callback(false)
      })
    },
    failure() {
      return verificationFailure
    },
  }
}

/** Emitted events; the connection is an EventEmitter for close/error notice. */
export interface SshConnectionEvents {
  /** Transport died. Remote process state is unknown. */
  lost: (error: SshConnectionLost) => void
}

/**
 * One connected SSH transport. Owns nothing except the connection itself;
 * channel-level accounting lives in the runtime.
 */
export class SshConnection extends EventEmitter {
  private readonly client: Client
  private readonly config: SshConnectConfig
  private connected = false
  private lostError: SshConnectionLost | undefined

  constructor(config: SshConnectConfig) {
    super()
    this.config = config
    this.client = new Client()
  }

  /** True after 'ready' and before 'close'/'end'/'error'. */
  get isConnected(): boolean {
    return this.connected
  }

  /** The terminal transport failure, if any. */
  get lost(): SshConnectionLost | undefined {
    return this.lostError
  }

  /**
   * Connect and authenticate.
   *
   * @throws SshConnectionLost on any dial/handshake/auth failure or if the
   *   transport dies mid-connect.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.connected) return
    signal?.throwIfAborted()
    const connectConfig: ConnectConfig = {
      host: this.config.host,
      port: this.config.port ?? 22,
      username: this.config.username,
      readyTimeout: this.config.connectTimeoutMs ?? 20_000,
      keepaliveInterval: this.config.keepAliveMs ?? 15_000,
      keepaliveCountMax: 3,
    }
    const auth = this.resolveAuth()
    Object.assign(connectConfig, auth)
    const hostKeyVerifier = this.resolveHostKeyVerifier()
    if (hostKeyVerifier !== undefined) {
      connectConfig.hostVerifier = hostKeyVerifier.verify
    }

    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        cleanup()
        this.connected = true
        resolve()
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(hostKeyVerifier?.failure()
          ?? new SshConnectionLost(`ssh connect failed: ${error.message}`, { cause: error }))
      }
      const onAbort = (): void => {
        cleanup()
        this.client.end()
        reject(new SshConnectionLost('aborted during ssh connect'))
      }
      const cleanup = (): void => {
        this.client.removeListener('ready', onReady)
        this.client.removeListener('error', onError)
        signal?.removeEventListener('abort', onAbort)
      }
      this.client.once('ready', onReady)
      this.client.once('error', onError)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.client.connect(connectConfig)
    })

    this.client.on('close', () => { this.handleLost('connection closed') })
    this.client.on('end', () => { this.handleLost('connection ended') })
    this.client.on('error', (error: Error) => { this.handleLost(`connection error: ${error.message}`) })
  }

  /**
   * Open one exec channel (no PTY) and run `command`.
   *
   * The channel is returned raw; stream reading, exit-status handling and
   * closing belong to the caller.
   *
   * @throws SshConnectionLost if the transport is gone.
   */
  async openExecChannel(command: string): Promise<ClientChannel> {
    this.assertConnected()
    return await new Promise<ClientChannel>((resolve, reject) => {
      this.client.exec(command, (error, channel) => {
        if (error !== undefined && error !== null) {
          reject(this.wrapLoss(error))
          return
        }
        if (channel === undefined) {
          reject(new SshConnectionLost('ssh exec returned no channel'))
          return
        }
        resolve(channel)
      })
    })
  }

  /**
   * Open one PTY channel: `pty-req` with the given terminal geometry, then
   * exec `command`. Spike-verified: pty-req before exec, window-change via
   * `channel.setWindow`.
   *
   * @throws SshConnectionLost if the transport is gone.
   */
  async openPtyChannel(
    command: string,
    options: { rows: number; cols: number; term?: string },
  ): Promise<ClientChannel> {
    this.assertConnected()
    const { rows, cols, term = 'xterm-256color' } = options
    return await new Promise<ClientChannel>((resolve, reject) => {
      this.client.exec(command, { pty: { rows, cols, term, modes: {} } }, (error, channel) => {
        if (error !== undefined && error !== null) {
          reject(this.wrapLoss(error))
          return
        }
        if (channel === undefined) {
          reject(new SshConnectionLost('ssh pty exec returned no channel'))
          return
        }
        resolve(channel)
      })
    })
  }

  /**
   * Open the SFTP subsystem channel.
   *
   * @throws SshConnectionLost if the transport is gone.
   */
  async openSftp(): Promise<SFTPWrapper> {
    this.assertConnected()
    return await new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((error, sftp) => {
        if (error !== undefined && error !== null) {
          reject(this.wrapLoss(error))
          return
        }
        if (sftp === undefined) {
          reject(new SshConnectionLost('ssh sftp returned no channel'))
          return
        }
        resolve(sftp)
      })
    })
  }

  /** End the transport gracefully. Idempotent. */
  end(): void {
    if (this.lostError !== undefined) return
    try {
      this.client.end()
    } catch {
      // A dead client can throw on end; the loss is already recorded.
    }
  }

  /** Resolve ssh2 auth options from config. */
  private resolveAuth(): Partial<ConnectConfig> {
    return normalizeAuth(this.config)
  }

  private resolveHostKeyVerifier(): HostKeyVerifier {
    const policy = this.config.hostKeyPolicy
    if (policy === undefined || nonBlank(policy.knownHosts) === undefined) {
      throw new SshHostKeyVerificationFailed({
        cause: new Error('SSH trusted host key store is not configured'),
      })
    }
    return createHostKeyVerifier(
      new HostKeyStore(policy.knownHosts),
      this.config.host,
      this.config.port ?? 22,
    )
  }

  private assertConnected(): void {
    if (this.lostError !== undefined) throw this.lostError
    if (!this.connected) throw new SshConnectionLost('ssh connection is not established')
  }

  private wrapLoss(error: Error): SshConnectionLost {
    if (this.lostError !== undefined) return this.lostError
    return new SshConnectionLost(error.message, { cause: error })
  }

  private handleLost(reason: string): void {
    if (this.lostError !== undefined) return
    this.connected = false
    this.lostError = new SshConnectionLost(`ssh transport lost: ${reason}`)
    this.emit('lost', this.lostError)
  }
}
