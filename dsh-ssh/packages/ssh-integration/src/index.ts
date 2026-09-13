/**
 * SSH integration, host half.
 *
 * Owns the `ssh-remote` settings namespace, the SSH credentials, host-key
 * trust decisions, the Session-to-execution-world binding and the fail-closed
 * execution gate. It is a *named function plugin*: cordis instantiates
 * function plugins from their named exports, and a `default` export would
 * change that instantiation, so none is provided.
 *
 * Task 2 scope: the settings section and the credential references are live.
 * The Remote API, session binding and gate are added by Tasks 3, 5 and 6 into
 * this file and its siblings.
 *
 * @module @local/dsh-ssh-integration
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SshExecutionGate } from './gate.ts'
import type { ToolsGuardFace } from './gate.ts'
import { createSshSettingsSource, resolveSshSettings } from './settings.ts'
import type { SshSettings, SshSettingsSource } from './settings.ts'
import { HostKeyStore } from '../../ssh-runtime/src/index.ts'
import type { SshRuntime } from '../../ssh-runtime/src/index.ts'
import { SshRemoteService } from './remote.ts'
import { bindRuntimeToSettings } from './wiring.ts'

export type {
  ExecutionWorldIdentity,
  SshAuthMode,
  SshConnectionState,
  SshErrorCode,
  SshSecretRef,
  SshSettingsNamespace,
  SshStatusView,
} from './types.ts'
export { SSH_SETTINGS_NAMESPACE } from './namespace.ts'
export {
  createSshSettingsSource,
  DEFAULT_RECONNECT_DELAY_MS,
  DEFAULT_SSH_PORT,
  installSshSettingsSection,
  resolveSshCredentials,
  resolveSshSettings,
  SSH_PASSPHRASE_REF,
  SSH_PASSWORD_REF,
  SSH_PRIVATE_KEY_REF,
  SSH_SECRET_REFS,
  SshSettingsDefaults,
  SshSettingsSchema,
} from './settings.ts'
export type { SshResolvedCredentials, SshSettings, SshSettingsSource } from './settings.ts'

/** Stable plugin name; also the identity the loader reports for this fiber. */
export const name = 'ssh-integration'

/**
 * Services this plugin binds to.
 *
 * `ssh` is the shared execution world owned by `@local/dsh-ssh-runtime` (the
 * bundle guarantees it is loaded beside this plugin), and `tools` is the
 * official tools registry whose monotonic guard face carries the execution
 * gate. The settings and credentials services stay optional: the section is
 * an optional composition source when they are absent.
 */
export const inject: string[] = ['ssh', 'tools']

/**
 * Plugin configuration.
 *
 * These are the composition-layer (profile) settings for the SSH execution
 * world. Every one of them is also owned by the `ssh-remote` settings
 * namespace, so the card can override it at runtime: whatever is set here
 * becomes the section's base layer, and whatever the user saves wins over it.
 * None of these fields is secret — the password, private key and passphrase
 * live in `ctx.credentials` under fixed reference names.
 */
export interface Config {
  /** Server address; empty means the user has not configured the world yet. */
  host?: string
  /** SSH port. */
  port?: number
  /** Login user name. */
  username?: string
  /** Which credential reference the connection resolves. */
  authMode?: 'password' | 'private-key'
  /** Server-side private key path, when the key is not carried inline. */
  privateKeyPath?: string
  /** Remote working directory Sessions are bound to; must be absolute. */
  cwd?: string
  /** Automatic reconnect attempts after a lost transport; `0` disables. */
  reconnectAttempts?: number
  /** Fixed delay between automatic reconnect attempts, in milliseconds. */
  reconnectDelayMs?: number
  /** Owner-only known-hosts store used for TOFU host-key trust. */
  knownHostsPath?: string
}

/**
 * Schemastery schema for {@link Config}.
 *
 * The field-level constraints are shared with the `ssh-remote` settings
 * section (see `./settings.ts`) so a profile entry and a saved section can
 * never disagree about what a valid value is.
 */
export const Config: z<Config> = z.object({
  host: z.string(),
  port: z.number().step(1).min(1).max(65_535),
  username: z.string(),
  authMode: z.union(['password', 'private-key']),
  privateKeyPath: z.string(),
  cwd: z.string(),
  reconnectAttempts: z.number().step(1).min(0),
  reconnectDelayMs: z.number().step(1).min(0),
  knownHostsPath: z.string(),
})

/**
 * Install the SSH integration into a host context.
 *
 * Registers the `ssh-remote` settings section, with this plugin's own
 * composition config as the base layer, and exposes the live settings source
 * on the context as `sshSettings` so the gate and the Remote API added by
 * later tasks read the currently authoritative section rather than a snapshot
 * taken at load.
 *
 * @param ctx - host context.
 * @param config - validated plugin config, used as the section's base layer.
 */
export function apply(ctx: Context, config: Config): void {
  const entry = resolveSshSettings(config as Partial<SshSettings>)
  const source = createSshSettingsSource(ctx, entry)
  ctx.provide('sshSettings', source)

  // The shared execution world and the tools registry are hard injects, so
  // both are live by the time the loader calls apply. The guard below only
  // serves direct apply() calls that bypass the loader's inject contract
  // (settings-only benches): without both services there is nothing to wire
  // beyond the section itself.
  const runtime = ctx.get('ssh') as SshRuntime | undefined
  const tools = ctx.get('tools') as ToolsGuardFace | undefined
  if (runtime === undefined || tools === undefined) return

  // Follow the section: a save in the card (or a changed profile entry) must
  // rebuild the runtime's endpoint, or the card would be inert. The
  // credentials service resolves the secrets the section names.
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    ctx.effect(() => bindRuntimeToSettings({
      runtime,
      settings: source,
      credentials,
    }), 'ssh-remote: runtime follows settings')
  }

  // The Remote control API: status, trust decisions and reconnect, over the
  // runtime and the section the settings card renders.
  new SshRemoteService(ctx, {
    runtime,
    settings: source,
    knownHostsPath: entry.knownHostsPath,
  })

  // The fail-closed gate: bind every Agent to the world it was born under,
  // deny execution while disconnected, and make switched-server conversations
  // read-only.
  new SshExecutionGate(ctx, runtime, source, tools)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The currently authoritative `ssh-remote` section.
     *
     * Read it per operation: the value tracks the mounted settings service and
     * falls back to the composition entry when that service detaches.
     */
    sshSettings: SshSettingsSource
  }
}
