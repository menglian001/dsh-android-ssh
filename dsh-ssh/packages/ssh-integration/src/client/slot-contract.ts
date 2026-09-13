/**
 * The ssh-remote card's slot and locale contracts.
 *
 * `settings.plugin.item` is declared by the settings-plugins package (one
 * plugin's card inside the configurable-plugins tab, keyed by namespace). It
 * is restated here with the same shape so this external plugin's props types
 * resolve without importing that package's internals — declaration merging
 * with an identical member is a no-op for programs that already carry the
 * official declaration.
 *
 * `settings.ssh` is this plugin's own locale namespace, registered by the
 * client `apply` with the dictionaries from `./locales.ts`.
 */

/** Owner share of a plugin card (the section supplies nothing). */
export interface SshCardItemOwnerProps {
  /** Marker field: card owner props are intentionally empty. */
  children?: never
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One plugin's card inside the plugin configuration section. */
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: SshCardItemOwnerProps }
  }

  interface LocaleNamespaceMap {
    /** The ssh-remote card's dictionary namespace. */
    'settings.ssh': import('./locales.ts').SshCardLocaleKey
  }
}
