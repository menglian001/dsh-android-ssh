/**
 * The `ssh-remote` settings section and the three fixed credential references.
 *
 * Two rules shape everything here, and both are about where a secret may
 * live:
 *
 * 1. **No SSH secret is a settings value.** The password, private key and
 *    passphrase are stored through `ctx.credentials` under three fixed
 *    reference names and are read back only by resolving those references at
 *    the moment of use. The settings schema therefore declares NO
 *    `role('secret')` field: that role means "a value kept in the settings
 *    document, hidden only from a wire surface that remembered to ask for
 *    redaction", and a same-process reader would still get it from
 *    `scope.get()`. Modelling our secrets that way would disguise them rather
 *    than protect them. `context` carries only non-secret facts — an address,
 *    a port, a path, a retry policy.
 *
 * 2. **Validation is layered the way the official adapters layer it.** The
 *    Schemastery schema rejects what a schema can express on its own (a port
 *    outside 1..65535, a fractional retry count). Constraints that depend on
 *    the *meaning* of a field — a remote working directory must be an absolute
 *    Linux path — are enforced by {@link resolveSshSettings} and handed to
 *    `installSection`'s `validate` hook, so they refuse the write that
 *    produced the bad value instead of storing it.
 *
 * The section is published through `ctx.settings.installSection`, which is the
 * official contract for a component that owns a settings namespace: while the
 * settings service is mounted the resolved section is authoritative, and when
 * it detaches the composition entry (`profile` config) becomes authoritative
 * again. {@link SshSettingsSource} hands consumers a thunk, so a change to
 * either layer reaches the next operation without a restart.
 *
 * @module @local/dsh-ssh-integration/settings
 */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import type { SshAuthMode, SshSecretRef } from './types.ts'

/** Settings namespace owned by this plugin. */
export const SSH_SETTINGS_NAMESPACE = 'ssh-remote' as const

/** Default SSH port, used when the user has not chosen one. */
export const DEFAULT_SSH_PORT = 22

/**
 * Default delay between automatic reconnect attempts, in milliseconds.
 * Matches the SSH runtime's own default so a profile that configures neither
 * layer behaves consistently.
 */
export const DEFAULT_RECONNECT_DELAY_MS = 5_000

/**
 * The fixed credential reference names, in the order a settings card presents
 * them. These are stable identifiers, never values: the password, private key
 * and passphrase live in `ctx.credentials` under exactly these names.
 */
export const SSH_SECRET_REFS = [
  'DSHA_SSH_PASSWORD',
  'DSHA_SSH_PRIVATE_KEY',
  'DSHA_SSH_PASSPHRASE',
] as const satisfies readonly SshSecretRef[]

/** The password reference, resolved when `authMode` is `password`. */
export const SSH_PASSWORD_REF: CredentialRef = credentialRef('DSHA_SSH_PASSWORD')

/** The inline private key reference, resolved when `authMode` is `private-key`. */
export const SSH_PRIVATE_KEY_REF: CredentialRef = credentialRef('DSHA_SSH_PRIVATE_KEY')

/** The optional private-key passphrase reference. */
export const SSH_PASSPHRASE_REF: CredentialRef = credentialRef('DSHA_SSH_PASSPHRASE')

/**
 * One resolved `ssh-remote` section.
 *
 * Every field here is non-secret by construction. The three secrets are
 * addressed through {@link SSH_SECRET_REFS} and resolved by
 * {@link resolveSshCredentials}.
 */
export interface SshSettings {
  /** Server address, as typed by the user (a DNS name or an IP literal). */
  host: string
  /** SSH port; the schema bounds it to 1..65535. */
  port: number
  /** Login user name. */
  username: string
  /** Which credential reference the connection resolves. */
  authMode: SshAuthMode
  /**
   * Server-side path of the private key, when the key already lives on the
   * server. The inline key reference (`DSHA_SSH_PRIVATE_KEY`) is preferred;
   * this field exists for a deployment whose key file stays remote.
   */
  privateKeyPath: string
  /** Remote working directory every Session is bound to; absolute POSIX path. */
  cwd: string
  /** Automatic reconnect attempts after an established transport is lost; `0` disables. */
  reconnectAttempts: number
  /** Fixed delay between automatic reconnect attempts, in milliseconds. */
  reconnectDelayMs: number
  /** Owner-only known-hosts store used for TOFU host-key trust. */
  knownHostsPath: string
}

/**
 * The composition-layer defaults for {@link SshSettings}.
 *
 * A profile may override any of these in its entry config; they are the base
 * layer the user section resolves over, and the value the plugin falls back to
 * if the settings service detaches.
 */
export const SshSettingsDefaults: SshSettings = {
  host: '',
  port: DEFAULT_SSH_PORT,
  username: '',
  authMode: 'password',
  privateKeyPath: '',
  cwd: '',
  reconnectAttempts: 0,
  reconnectDelayMs: DEFAULT_RECONNECT_DELAY_MS,
  knownHostsPath: '',
}

/** The two login methods, as a schema-usable tuple. */
const AUTH_MODES = ['password', 'private-key'] as const satisfies readonly SshAuthMode[]

/**
 * Schemastery schema for the `ssh-remote` section.
 *
 * Step and range violations are rejected here; the one rule with no schema
 * expression — that `cwd` must be an absolute Linux path — is enforced by
 * {@link resolveSshSettings}, which {@link installSshSettingsSection} wires
 * into `installSection`'s `validate` hook. The schema deliberately declares no
 * `role('secret')` field; see the module docblock.
 */
export const SshSettingsSchema: z<SshSettings> = z.object({
  host: z.string().default(SshSettingsDefaults.host),
  port: z.number().step(1).min(1).max(65_535).default(SshSettingsDefaults.port),
  username: z.string().default(SshSettingsDefaults.username),
  authMode: z.union(AUTH_MODES).default(SshSettingsDefaults.authMode),
  privateKeyPath: z.string().default(SshSettingsDefaults.privateKeyPath),
  cwd: z.string().default(SshSettingsDefaults.cwd),
  reconnectAttempts: z.number().step(1).min(0).default(SshSettingsDefaults.reconnectAttempts),
  reconnectDelayMs: z.number().step(1).min(0).default(SshSettingsDefaults.reconnectDelayMs),
  knownHostsPath: z.string().default(SshSettingsDefaults.knownHostsPath),
})

/**
 * Validate one already schema-admitted section and detach it.
 *
 * Programmatic construction can bypass Schemastery normalization, so the rules
 * Schemastery cannot express are re-judged here — both for the composition
 * entry at load and for every user snapshot, exactly as the official adapters
 * do.
 *
 * @param input - raw or schema-resolved settings section.
 * @returns the validated, detached section.
 * @throws {Error} when `cwd` is set but is not an absolute POSIX path.
 */
export function resolveSshSettings(input: Partial<SshSettings>): SshSettings {
  const section = SshSettingsSchema(input as SshSettings) as SshSettings
  const cwd = section.cwd
  if (typeof cwd !== 'string') {
    throw new Error('ssh-remote: cwd must be a string')
  }
  if (cwd !== '') {
    if (!posix.isAbsolute(cwd)) {
      throw new Error(`ssh-remote: cwd must be an absolute Linux path: ${cwd}`)
    }
    if (cwd.includes('//') || cwd.length > 1 && cwd.endsWith('/')) {
      throw new Error(`ssh-remote: cwd must be a normalized absolute Linux path: ${cwd}`)
    }
  }
  return { ...section }
}

/**
 * What an operation resolved from `ctx.credentials` for one settings snapshot.
 *
 * This is the shape that must never be logged, serialized into a status view,
 * or handed to anything that is not the SSH connection itself.
 */
export type SshResolvedCredentials =
  | { readonly mode: 'password'; readonly password: string }
  | {
    readonly mode: 'private-key'
    /** Inline key material, or `undefined` when the key is read from {@link SshSettings.privateKeyPath}. */
    readonly privateKey?: string
    /** Passphrase for an encrypted key, when one is stored. */
    readonly passphrase?: string
    /** Server-side key path, when the key is not carried inline. */
    readonly privateKeyPath?: string
  }

/**
 * Resolve the credentials an SSH operation needs, right now.
 *
 * Resolution is deliberately per call and never cached: the credentials seam
 * documents that consumers "re-resolve at each operation", which is what lets
 * a rotated password or a newly imported key reach the very next operation
 * without restarting the plugin or the app. Caching here would silently break
 * that contract, so nothing in this module keeps a value between calls.
 *
 * A missing secret is a failure, never an empty string: an empty stored value
 * is absent everywhere per the seam's own rule, and `resolve` returning
 * `undefined` means the user has not configured that slot yet.
 *
 * @param ctx - context carrying the `credentials` service.
 * @param settings - the settings snapshot this operation runs against.
 * @returns the credential material for the snapshot's `authMode`.
 * @throws {Error} when the credentials service is absent, when the required
 *   reference is unconfigured, or when `private-key` mode has neither an
 *   inline key nor a key path.
 */
export async function resolveSshCredentials(
  ctx: Context,
  settings: Pick<SshSettings, 'authMode' | 'privateKeyPath'>,
): Promise<SshResolvedCredentials> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new Error(
      'ssh-remote: the credentials service is required to resolve SSH secrets'
      + ` (${SSH_SECRET_REFS.join(', ')}); mount the credentials provider`,
    )
  }
  return await resolveSshCredentialsWith(credentials, settings)
}

/** The minimal credentials face the resolution core needs. */
export interface CredentialsResolver {
  /** Resolve one reference, or `undefined` when that slot is unconfigured. */
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
}

/**
 * The credentials core, independent of how the service is reached.
 *
 * Split out so callers that already hold the credentials face (the settings
 * wiring) resolve the same way this module's `ctx`-based entry does, instead
 * of re-implementing the reference rules or fabricating a Context.
 *
 * @param credentials - the credentials seam.
 * @param settings - the settings snapshot this operation runs against.
 * @returns the credential material for the snapshot's `authMode`.
 */
export async function resolveSshCredentialsWith(
  credentials: CredentialsResolver,
  settings: Pick<SshSettings, 'authMode' | 'privateKeyPath'>,
): Promise<SshResolvedCredentials> {
  if (settings.authMode === 'password') {
    const hit = await credentials.resolve(SSH_PASSWORD_REF)
    if (hit === undefined) {
      throw new Error(
        'ssh-remote: no password is stored for credential reference DSHA_SSH_PASSWORD;'
        + ' set it through the credentials service',
      )
    }
    return { mode: 'password', password: hit.value }
  }

  // Private-key mode: the inline reference wins, and a server-side path is the
  // fallback for a deployment whose key never leaves the server.
  const inline = await credentials.resolve(SSH_PRIVATE_KEY_REF)
  const keyPath = settings.privateKeyPath.trim()
  if (inline === undefined && keyPath === '') {
    throw new Error(
      'ssh-remote: no private key is stored for credential reference DSHA_SSH_PRIVATE_KEY,'
      + ' and no ssh-remote.privateKeyPath is configured',
    )
  }

  // The passphrase is resolved only for an inline key: a key read from the
  // server side is opened by its own file, and reading a passphrase we would
  // not use would widen the secret's exposure for nothing.
  const passphrase = inline === undefined ? undefined : await credentials.resolve(SSH_PASSPHRASE_REF)

  return {
    mode: 'private-key',
    ...inline === undefined ? { privateKeyPath: keyPath } : { privateKey: inline.value },
    ...passphrase === undefined ? {} : { passphrase: passphrase.value },
  }
}

/**
 * The authoritative settings for one plugin instance.
 *
 * `read` returns the currently authoritative section: the resolved user
 * section while the settings service is mounted, the composition entry once it
 * detaches. Consumers call it per operation rather than capturing a snapshot,
 * so a saved change is visible to the next command.
 */
export interface SshSettingsSource {
  /** The currently authoritative section. */
  read(): SshSettings
  /**
   * Observe commits to the authoritative section. The callback receives the
   * new section after each commit; the disposer removes the observer.
   * @param callback - invoked with the next authoritative section.
   * @returns the disposer removing this observer.
   */
  watch(callback: (next: SshSettings) => void): () => void
}

/**
 * Install the `ssh-remote` settings section through the official seam.
 *
 * Uses `ctx.settings.installSection`, which registers the namespace with the
 * composition entry as its base layer, points `setSource` at the resolved
 * scope while settings are mounted, and restores the entry when they detach.
 * Validation is handed to the same call so a write producing an unusable
 * section is refused at the write rather than stored.
 *
 * When no settings service is mounted this registers nothing and the entry
 * stays authoritative — the documented optional-dependency behavior.
 *
 * @param ctx - the plugin's own context.
 * @param entry - composition-layer settings from the profile.
 * @param hooks - `setSource`/`onChange` sinks owned by the caller.
 */
export function installSshSettingsSection(
  ctx: Context,
  entry: SshSettings,
  hooks: SettingsSectionHooks<SshSettings>,
): void {
  const validated = resolveSshSettings(entry)
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(
      ctx,
      SSH_SETTINGS_NAMESPACE,
      SshSettingsSchema,
      validated,
      {
        ...hooks,
        validate: (value) => {
          resolveSshSettings(value)
          hooks.validate?.(value)
        },
      },
    )
  })
}

/**
 * Build the authoritative source for one plugin instance.
 *
 * @param ctx - the plugin's own context.
 * @param entry - composition-layer settings from the profile.
 * @returns the source consumers read per operation.
 */
export function createSshSettingsSource(ctx: Context, entry: SshSettings): SshSettingsSource {
  let current = (): SshSettings => resolveSshSettings(entry)
  const listeners = new Set<(next: SshSettings) => void>()
  installSshSettingsSection(ctx, entry, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      const next = current()
      for (const listener of [...listeners]) listener(next)
    },
  })
  return {
    read: () => current(),
    watch: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
  }
}
