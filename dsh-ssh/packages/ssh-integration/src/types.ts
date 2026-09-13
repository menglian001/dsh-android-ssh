/**
 * Shared, transport-agnostic vocabulary for the SSH integration package.
 *
 * This module is TYPE-ONLY on purpose: both the host half and the browser half
 * import from it, so it must contribute nothing to a runtime bundle. The
 * exports test asserts the compiled module has zero runtime keys — the runtime
 * `SSH_SETTINGS_NAMESPACE` constant therefore lives in `./namespace.ts`.
 *
 * Secrets never appear in any type here. Credentials are addressed by fixed
 * reference *names* and resolved through `ctx.credentials` at the moment of
 * use; everything that crosses a Remote response boundary is already a
 * non-secret projection.
 *
 * @module @local/dsh-ssh-integration/types
 */

/** Settings namespace owned by this plugin; see `./namespace.ts` for the value. */
export type SshSettingsNamespace = 'ssh-remote'

/** How the user authenticates to the SSH server. */
export type SshAuthMode = 'password' | 'private-key'

/**
 * Fixed credential reference names.
 *
 * These are stable identifiers, not values: the password, private key and
 * passphrase live in `ctx.credentials` under exactly these names and are never
 * read back through a normal settings read.
 */
export type SshSecretRef =
  | 'DSHA_SSH_PASSWORD'
  | 'DSHA_SSH_PRIVATE_KEY'
  | 'DSHA_SSH_PASSPHRASE'

/** User-visible connection state of the SSH execution world. */
export type SshConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'trust-required'
  | 'key-changed'
  | 'retrying'
  | 'exhausted'

/** Stable error codes surfaced to the settings card and the gate. */
export type SshErrorCode =
  | 'ssh/not-configured'
  | 'ssh/not-connected'
  | 'ssh/trust-required'
  | 'ssh/host-key-changed'
  | 'ssh/auth-failed'
  | 'ssh/connect-timeout'
  | 'ssh/sftp-unavailable'
  | 'ssh/cwd-unavailable'
  | 'ssh/world-mismatch'
  | 'ssh/status-unknown'
  | 'ssh/internal'

/**
 * Safe, secret-free projection of the current SSH world.
 *
 * Every field is either non-sensitive configuration already visible in the
 * settings card, or a runtime counter. The credentials, the raw key material
 * and any server data never appear here.
 */
export interface SshStatusView {
  /** Configured server address, or empty when not configured. */
  readonly host: string
  /** Configured SSH port. */
  readonly port: number
  /** Configured username, or empty when not configured. */
  readonly username: string
  /** Configured remote working directory, or empty when not configured. */
  readonly cwd: string
  /** Current connection state. */
  readonly state: SshConnectionState
  /** Monotonic generation of the connected world; increments on reconnect. */
  readonly generation: number
  /** Reconnect attempt counter within the current loss episode. */
  readonly attempt: number
  /** Trusted server host-key fingerprint, or undefined while untrusted. */
  readonly fingerprint?: string
  /**
   * Fingerprint offered by the server when it is not yet trusted (TOFU) or
   * when it changed. Present only while the user's decision is pending.
   */
  readonly offeredFingerprint?: string
  /** Stable error code when the world is not executable. */
  readonly errorCode?: SshErrorCode
  /** Whether commands, prompts and tools may run against this world. */
  readonly executable: boolean
}

/**
 * Identity of the execution world a Session is bound to.
 *
 * Non-secret by construction: it is the canonical input to
 * `executionWorldId`, which hashes these fields to detect a world switch.
 */
export interface ExecutionWorldIdentity {
  /** Server address. */
  readonly host: string
  /** SSH port. */
  readonly port: number
  /** SSH username. */
  readonly username: string
  /** Trusted host-key fingerprint. */
  readonly fingerprint: string
  /** Remote working directory the Session executes in. */
  readonly cwd: string
}

/** Host half plugin export shape (named function plugin, no default export). */
export interface SshIntegrationHostExports {
  readonly name: string
  readonly inject: readonly string[]
  readonly apply: (ctx: unknown, config: unknown) => void
}

/** Client half plugin export shape (named function plugin, no default export). */
export interface SshIntegrationClientExports {
  readonly inject: readonly string[]
  readonly apply: (ctx: unknown) => void
}
