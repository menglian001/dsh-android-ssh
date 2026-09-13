/**
 * Forward the saved `ssh-remote` section into the SSH runtime.
 *
 * The runtime owns the transport; the section owns the endpoint. Nothing in
 * either module knows about the other, so this thin binding is what makes the
 * settings card real: when a save lands (or the profile entry changes), the
 * new host/port/username/cwd/retry policy is resolved together with the
 * credentials it names and handed to {@link SshRuntime.reconfigure}. A
 * section that is not yet usable (no endpoint, or no resolvable secret) is
 * left alone rather than half-applied, so the runtime never dials a partial
 * world.
 *
 * @module @local/dsh-ssh-integration/wiring
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SshRuntime } from '../../ssh-runtime/src/index.ts'
import type { Config as SshRuntimeConfig } from '../../ssh-runtime/src/index.ts'
import type { SshSettings, SshSettingsSource } from './settings.ts'
import { resolveSshCredentialsWith, type CredentialsResolver } from './settings.ts'

/** The credentials seam this binding resolves secrets through. */
export type CredentialsFace = CredentialsResolver

/** Options for {@link bindRuntimeToSettings}. */
export interface RuntimeSettingsBindingOptions {
  /** The runtime whose connection policy follows the section. */
  readonly runtime: Pick<SshRuntime, 'cwd' | 'reconfigure'>
  /** The live `ssh-remote` section. */
  readonly settings: SshSettingsSource
  /** The credentials seam used to resolve the section's secrets. */
  readonly credentials: CredentialsFace
}

/**
 * Build one runtime configuration from a section and its resolved secrets.
 *
 * @param settings - the authoritative section.
 * @param secrets - the credential material for the section's `authMode`.
 * @returns a configuration ready for `reconfigure`, or `undefined` when the
 *   section does not yet name a usable world (missing endpoint or secret).
 */
function configFor(
  settings: SshSettings,
  secrets: { password?: string; privateKey?: string; privateKeyPath?: string; passphrase?: string },
): SshRuntimeConfig | undefined {
  const host = settings.host.trim()
  const username = settings.username.trim()
  if (host === '' || username === '') return undefined
  return {
    host,
    port: settings.port,
    username,
    password: secrets.password,
    privateKey: secrets.privateKey,
    privateKeyPath: secrets.privateKeyPath,
    passphrase: secrets.passphrase,
    // TOFU store the runtime checks and the Remote API writes.
    hostKeyPolicy: settings.knownHostsPath === '' ? undefined : { knownHosts: settings.knownHostsPath },
    cwd: settings.cwd === '' ? undefined : settings.cwd,
    reconnectAttempts: settings.reconnectAttempts,
    reconnectDelayMs: settings.reconnectDelayMs,
  } as SshRuntimeConfig
}

/**
 * Keep the runtime's endpoint in step with the section.
 *
 * The binding pushes once immediately (so a section saved in a previous run is
 * adopted at boot) and again after every commit. A push that cannot build a
 * complete configuration is skipped: the runtime stays on its previous world,
 * which the gate already treats as "not executable" when the endpoint is
 * empty. Resolutions that throw (a missing secret) are swallowed for the same
 * reason — the card surfaces the missing-field error itself.
 *
 * @param options - the runtime, the section source and the credentials seam.
 * @returns a disposer removing the section observer.
 */
export function bindRuntimeToSettings(options: RuntimeSettingsBindingOptions): () => void {
  const { runtime, settings, credentials } = options

  const push = async (section: SshSettings): Promise<void> => {
    let secrets: Awaited<ReturnType<typeof resolveSshCredentialsWith>>
    try {
      secrets = await resolveSshCredentialsWith(credentials, section)
    } catch {
      // No secret yet, or no credentials service: nothing to dial. The card
      // reports the missing field; the runtime keeps its previous world.
      return
    }
    const config = configFor(section, secrets)
    if (config === undefined) return
    await runtime.reconfigure(config)
  }

  // Adopt whatever the section already holds, then follow every commit.
  void push(settings.read()).catch(() => {})
  return settings.watch((next) => {
    void push(next).catch(() => {})
  })
}
