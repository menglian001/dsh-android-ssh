/**
 * SSH integration, browser half.
 *
 * Contributes exactly one card to the official settings surface —
 * `settings.plugin.item`, keyed by the `ssh-remote` namespace — and nothing
 * else. It adds no navigation, no global layout CSS and no custom page: the
 * official dsh UI stays authoritative, and the browser half is an affordance
 * only, never the security boundary.
 *
 * This entry is a thin shell: the registration logic lives in `./register.ts`
 * (pure TypeScript, covered by `node --test`), and this file only supplies the
 * `.tsx` card component to it. Like the host half this is a *named function
 * plugin* with no `default` export, because a default export changes loader
 * instantiation.
 *
 * @module @local/dsh-ssh-integration/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { SshCard } from './SshCard.tsx'
import { applySshCard, inject } from './register.ts'

export {
  applySshCard,
  inject,
  SSH_CARD_LOCALE_NS,
} from './register.ts'
export type { SshCardComponent, SshCardSlotsFace } from './register.ts'
export type { SshCardItemOwnerProps } from './slot-contract.ts'
export type {
  CardActions, CardFieldSpec, CardFieldState, CardSecretSpec, CardShell,
} from './card-form.ts'
export {
  CardForm, absolutePathField, enumField, nonNegativeIntField,
  numberField, rangedIntField, textField,
} from './card-form.ts'
export type {
  SshCardFace, SshCardRemotes, SshCardSettings, SshCardState, SshCardStatus,
} from './ssh-card-controller.ts'
export { SSH_CARD_NS, SshCardController } from './ssh-card-controller.ts'
export type { SshCardLocaleKey } from './locales.ts'
export type { SshCardProps } from './SshCard.tsx'

/**
 * Install the SSH settings card into a client context.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  applySshCard(
    ctx,
    SshCard,
    (ctx as unknown as { slots: import('./register.ts').SshCardSlotsFace }).slots,
  )
}
