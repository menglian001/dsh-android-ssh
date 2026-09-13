/**
 * The one runtime constant shared by both halves of the SSH integration.
 *
 * It lives outside `./types.ts` so that module can stay type-only, and outside
 * `./index.ts` so the browser half can import it without pulling in host code.
 *
 * @module @local/dsh-ssh-integration/namespace
 */

/**
 * Settings namespace owned by this plugin. The settings card is registered
 * into `settings.plugin.item` keyed by exactly this string.
 */
export const SSH_SETTINGS_NAMESPACE = 'ssh-remote' as const
