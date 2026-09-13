/**
 * The ssh-remote card's staged form, status line and connection actions.
 *
 * The card follows the official plugin-card pattern (the workspace's
 * `WebSearchCard` is the reference): section fields stage through a
 * {@link CardForm} over the bound `ssh-remote` scope, while the password,
 * private key and passphrase are write-only controls routed through the
 * credentials domain under fixed references — a secret literal never rides a
 * settings response. The connection status line and the four connection
 * actions (test, trust, clear trust, reconnect) forward to the `sshRemote`
 * Remote namespace, which is the browser half's only way to reach the Host's
 * connection state.
 *
 * The remotes are injected as one narrow interface so this controller is
 * testable without a transport, and so the wiring in `./index.ts` is the only
 * place that knows how the Host namespaces are addressed.
 *
 * @module @local/dsh-ssh-integration/client/ssh-card-controller
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CardForm,
  absolutePathField,
  enumField,
  nonNegativeIntField,
  rangedIntField,
  textField,
  type CardActions,
  type CardFieldState,
  type CardShell,
} from './card-form.ts'

/** Namespace of the ssh-remote section; spelled, not imported from the Host half. */
export const SSH_CARD_NS = 'ssh-remote'

/** The fixed credential references the secrets write under. */
const PASSWORD_REF = 'DSHA_SSH_PASSWORD'
const PRIVATE_KEY_REF = 'DSHA_SSH_PRIVATE_KEY'
const PASSPHRASE_REF = 'DSHA_SSH_PASSPHRASE'

/** The two login modes the section accepts. */
const AUTH_MODES = ['password', 'private-key'] as const

/**
 * The ssh-remote section as this card stages it.
 *
 * Mirrors the Host-side `SshSettings` shape; spelled here because a client
 * package must not depend on a Host package.
 */
export interface SshCardSettings {
  host?: string
  port?: number
  username?: string
  authMode?: string
  privateKeyPath?: string
  cwd?: string
  reconnectAttempts?: number
  reconnectDelayMs?: number
}

/**
 * The non-secret connection projection the `sshRemote` namespace serves.
 *
 * Same shape as the Host's wire projection: host/port/username/cwd, the
 * projected state, counters, fingerprints and a stable error code. No secret,
 * no command, no remote output ever appears here.
 */
export interface SshCardStatus {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly cwd: string
  readonly state: string
  readonly generation: number
  readonly attempt: number
  readonly fingerprint?: string
  readonly offeredFingerprint?: string
  readonly errorCode?: string
  readonly executable: boolean
}

/** What the credentials domain last reported for one reference. */
interface CredentialState {
  readonly configured: boolean
  readonly writable: boolean
}

/**
 * The remotes this card reaches, as one narrow injectable interface.
 *
 * `credentials` is the official credentials domain (`ctx.remote.credentials`);
 * `sshRemote` is the Remote namespace this integration's Host half owns.
 * Both are addressed by the wiring in `./index.ts`, never by this controller.
 */
export interface SshCardRemotes {
  readonly credentials: {
    describe(refs: readonly string[]): Promise<{
      readonly ok: boolean
      readonly value: Readonly<Record<string, CredentialState | undefined>>
    }>
    set(ref: string, value: string): Promise<{ readonly ok: boolean }>
  }
  readonly sshRemote: {
    status(): SshCardStatus
    statusStream(signal: AbortSignal): AsyncIterable<{ readonly type: string; readonly status: SshCardStatus }>
    testConnection(): Promise<{ readonly ok: boolean; readonly errorCode?: string; readonly status: SshCardStatus }>
    trustHostKey(fingerprint: string): Promise<SshCardStatus>
    clearTrustedHost(): Promise<SshCardStatus>
    reconnect(): Promise<SshCardStatus>
  }
}

/** What the ssh-remote card renders. */
export interface SshCardState extends CardShell {
  readonly host: CardFieldState
  readonly port: CardFieldState
  readonly username: CardFieldState
  readonly authMode: CardFieldState
  readonly privateKeyPath: CardFieldState
  readonly cwd: CardFieldState
  readonly reconnectAttempts: CardFieldState
  readonly reconnectDelayMs: CardFieldState
  readonly password: CardFieldState
  readonly privateKey: CardFieldState
  readonly passphrase: CardFieldState
  readonly passwordConfigured: boolean
  readonly privateKeyConfigured: boolean
  readonly passphraseConfigured: boolean
  readonly connection: SshCardStatus
}

/** The registration-side face the card's slot entry injects. */
export interface SshCardFace extends CardActions {
  readonly hooks: {
    /** Card snapshot bound by the renderer as useSshCard. */
    readonly sshCard: SnapshotStore<SshCardState>
  }
  testConnection(): Promise<void>
  trustHostKey(fingerprint: string): Promise<void>
  clearTrustedHost(): Promise<void>
  reconnect(): Promise<void>
}

/**
 * Bridge the `ssh-remote` scope, the credentials domain and the `sshRemote`
 * Remote namespace onto one card.
 */
export class SshCardController {
  private readonly form: CardForm<SshCardSettings>
  /** The card's published snapshot. */
  readonly store: SnapshotStore<SshCardState>
  private readonly credentials = new Map<string, CredentialState>()
  private connection: SshCardStatus
  private streamController = new AbortController()
  private disposed = false

  private readonly remotes: SshCardRemotes

  /**
   * @param scope - the bound settings scope for the `ssh-remote` namespace.
   * @param remotes - the credentials domain and the sshRemote namespace.
   */
  constructor(
    scope: SettingsScope<SshCardSettings>,
    remotes: SshCardRemotes,
  ) {
    this.remotes = remotes
    this.form = new CardForm(
      scope,
      [
        textField('host'),
        rangedIntField('port', 1, 65_535),
        textField('username'),
        enumField('authMode', AUTH_MODES),
        textField('privateKeyPath'),
        absolutePathField('cwd'),
        nonNegativeIntField('reconnectAttempts'),
        nonNegativeIntField('reconnectDelayMs'),
      ],
      [
        { field: 'password', write: text => this.writeCredential(PASSWORD_REF, text) },
        { field: 'privateKey', write: text => this.writeCredential(PRIVATE_KEY_REF, text) },
        { field: 'passphrase', write: text => this.writeCredential(PASSPHRASE_REF, text) },
      ],
    )
    this.connection = this.remotes.sshRemote.status()
    this.store = this.form.bind(() => this.projection())
    void this.readCredentials()
    void this.followStream()
  }

  /** Card actions over the staged form. */
  readonly edit: CardActions['edit'] = (field, text) => { this.form.actions().edit(field, text) }

  /** @inheritdoc */
  readonly resetField: CardActions['resetField'] = (field) => { this.form.actions().resetField(field) }

  /** @inheritdoc */
  readonly save: CardActions['save'] = () => { this.form.actions().save() }

  /** @inheritdoc */
  readonly discard: CardActions['discard'] = () => { this.form.actions().discard() }

  /** Write the staged form. */
  async saveNow(): Promise<void> { await this.form.save() }

  /** Ask the Host to dial once and report the outcome. */
  async testConnection(): Promise<void> {
    const result = await this.remotes.sshRemote.testConnection()
    this.connection = result.status
    this.store.set(this.projection())
  }

  /** Confirm the host key the server offered. */
  async trustHostKey(fingerprint: string): Promise<void> {
    this.connection = await this.remotes.sshRemote.trustHostKey(fingerprint)
    this.store.set(this.projection())
  }

  /** Remove the trusted host key for the configured server. */
  async clearTrustedHost(): Promise<void> {
    this.connection = await this.remotes.sshRemote.clearTrustedHost()
    this.store.set(this.projection())
  }

  /** Ask for a reconnect now, outside the automatic retry policy. */
  async reconnect(): Promise<void> {
    this.connection = await this.remotes.sshRemote.reconnect()
    this.store.set(this.projection())
  }

  /** Build the face the card's slot registration injects. */
  inject(): SshCardFace {
    return {
      hooks: { sshCard: this.store },
      edit: this.edit,
      resetField: this.resetField,
      save: this.save,
      discard: this.discard,
      testConnection: () => this.voidCall(() => this.testConnection()),
      trustHostKey: fingerprint => this.voidCall(() => this.trustHostKey(fingerprint)),
      clearTrustedHost: () => this.voidCall(() => this.clearTrustedHost()),
      reconnect: () => this.voidCall(() => this.reconnect()),
    }
  }

  /** Stop following the status stream. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.streamController.abort()
  }

  /** The card's projection: the form shell, every field and the status line. */
  private projection(): SshCardState {
    return {
      ...this.form.shell(),
      host: this.form.field('host'),
      port: this.form.field('port'),
      username: this.form.field('username'),
      authMode: this.form.field('authMode'),
      privateKeyPath: this.form.field('privateKeyPath'),
      cwd: this.form.field('cwd'),
      reconnectAttempts: this.form.field('reconnectAttempts'),
      reconnectDelayMs: this.form.field('reconnectDelayMs'),
      password: this.form.field('password'),
      privateKey: this.form.field('privateKey'),
      passphrase: this.form.field('passphrase'),
      passwordConfigured: this.credentials.get(PASSWORD_REF)?.configured ?? false,
      privateKeyConfigured: this.credentials.get(PRIVATE_KEY_REF)?.configured ?? false,
      passphraseConfigured: this.credentials.get(PASSPHRASE_REF)?.configured ?? false,
      connection: this.connection,
    }
  }

  /** Read the three fixed references from the credentials domain. */
  private async readCredentials(): Promise<void> {
    const refs = [PASSWORD_REF, PRIVATE_KEY_REF, PASSPHRASE_REF]
    const response = await this.remotes.credentials.describe(refs)
    if (!response.ok) return
    for (const ref of refs) {
      const view = response.value[ref]
      this.credentials.set(ref, { configured: view?.configured ?? false, writable: view?.writable ?? true })
    }
    this.store.set(this.projection())
  }

  /** Write one credential, then re-read whether the Host now holds it. */
  private async writeCredential(ref: string, value: string): Promise<boolean> {
    await this.remotes.credentials.set(ref, value)
    await this.readCredentials()
    return this.credentials.get(ref)?.configured ?? false
  }

  /** Mirror the status stream into the status line. */
  private async followStream(): Promise<void> {
    try {
      for await (const frame of this.remotes.sshRemote.statusStream(this.streamController.signal)) {
        if (this.disposed) return
        this.connection = frame.status
        this.store.set(this.projection())
      }
    } catch {
      // The carrier dropped; the wiring's reconnect handling re-establishes.
    }
  }

  /** Run one action without surfacing its rejection to a caller that cannot. */
  private async voidCall(action: () => Promise<void>): Promise<void> {
    try {
      await action()
    } catch {
      // Connection actions report through the status line, not exceptions.
    }
  }
}
