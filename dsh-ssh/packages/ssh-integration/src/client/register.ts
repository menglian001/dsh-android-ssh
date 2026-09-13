/**
 * The ssh-remote card's registration logic, isolated from its `.tsx`
 * component so the whole wiring is testable under `node --test`.
 *
 * `applySshCard` composes the card the same way the official plugin cards
 * are composed: it registers the card's dictionaries, binds the `ssh-remote`
 * settings scope and the two remote faces (the credentials domain and the
 * `sshRemote` namespace) onto a {@link SshCardController}, and registers the
 * component into `settings.plugin.item` keyed by the namespace. The component
 * arrives as a parameter — `./index.ts` passes the `.tsx` card — so this
 * module stays free of any file the TypeScript stripper cannot load.
 *
 * @module @local/dsh-ssh-integration/client/register
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SSH_CARD_NS, SshCardController } from './ssh-card-controller.ts'
import type { SshCardRemotes } from './ssh-card-controller.ts'
import type { SshCardProps } from './SshCard.tsx'
import { en, zh } from './locales.ts'

/** Dictionary namespace owned by this plugin's card. */
export const SSH_CARD_LOCALE_NS = 'settings.ssh'

/** The card component: takes the renderer-bound props, renders or declines. */
export type SshCardComponent = (props: SshCardProps) => unknown

/**
 * The `ctx.slots` registry face this plugin uses.
 *
 * The full `SlotRegistry` type lives in the workspace's renderer package,
 * which this external plugin does not depend on; the two members below are the
 * official card-registration calls (see `ui-settings-plugins`'s client index),
 * restated so the assembly point stays typed. The renderer supplies the real
 * registry at runtime.
 */
export interface SshCardSlotsFace {
  inject(key: 'settings.plugin.item', factory: () => Generator<unknown, void, unknown>): void
  register(options: {
    name: 'settings.plugin.item'
    key: string
    locale: string
    inject: () => unknown
  }, component: SshCardComponent): unknown
}

/**
 * Client services the card plugin binds to.
 *
 * `settingsScope` gives the card its namespaced read/write access, `slots`
 * is how the card registers into `settings.plugin.item`, `locale` carries the
 * card's dictionaries, and the `remote.*` pair are the credentials domain and
 * the `sshRemote` Remote namespace the card's status line and actions reach.
 */
export const inject = ['slots', 'locale', 'settingsScope', 'remote', 'remote.credentials']

/**
 * Install the SSH settings card into a client context.
 *
 * @param ctx - the browser plugin context.
 * @param component - the card component (`./index.ts` passes the `.tsx` card).
 * @param slots - the slots registry face (the renderer's `ctx.slots`).
 */
export function applySshCard(ctx: ClientContext, component: SshCardComponent, slots: SshCardSlotsFace): void {
  ctx.effect(() => ctx.locale.register(SSH_CARD_LOCALE_NS, { zh, en }), 'ssh-integration: card dictionaries')

  // The remote faces are addressed here, once, so the controller stays a pure
  // consumer of the two narrow interfaces. The shapes are the official client
  // halves' own (`ctx.remote.credentials` per the credentials domain, and the
  // `sshRemote` namespace this integration's host half owns); the assertion is
  // the type bridge for a face whose declaration package this plugin does not
  // import.
  const remotes: SshCardRemotes = {
    credentials: (ctx as unknown as {
      remote: { credentials: SshCardRemotes['credentials'] }
    }).remote.credentials,
    sshRemote: (ctx as unknown as {
      remote: { sshRemote: SshCardRemotes['sshRemote'] }
    }).remote.sshRemote,
  }

  const controller = new SshCardController(
    ctx.settingsScope.bind({ namespace: SSH_CARD_NS }),
    remotes,
  )
  ctx.effect(() => () => { controller.dispose() }, 'ssh-integration: card status stream')

  slots.inject('settings.plugin.item', function* () {
    yield slots.register({
      name: 'settings.plugin.item',
      key: SSH_CARD_NS,
      locale: SSH_CARD_LOCALE_NS,
      inject: () => controller.inject(),
    }, component)
  })
}
