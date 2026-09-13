/**
 * Wire vocabulary of the `sshRemote` Remote namespace.
 *
 * Two rules shape this module:
 *
 * 1. **Everything here is non-secret by construction.** A status is read by the
 *    browser half and by the settings card, so it carries only facts the user
 *    already sees in that card (an address, a port, a login name, a remote
 *    directory), runtime counters, a host-key fingerprint — which is a public
 *    key's digest, not a secret — and a stable error *code*. It carries no
 *    password, no key material, no passphrase, no command and no remote output.
 *    There is deliberately no `message` field: an error message is the one
 *    place a secret most easily rides out of the Host, so failures cross as a
 *    code the browser maps to localized copy.
 *
 * 2. **The failure vocabulary is declared once, next to the code that throws
 *    it.** `RemoteErrorDetailsMap` is declaration-merged so the Typert codec
 *    generator and the browser face see the same codes, and every code names
 *    only non-secret context.
 *
 * This module is TYPE-ONLY apart from the frozen code tuple, so it stays safe
 * to import from the browser half.
 *
 * @module @local/dsh-ssh-integration/remote-types
 */

import type { SshConnectionState, SshErrorCode } from './types.ts'

/** The Typert wire namespace this package owns. */
export const SSH_REMOTE_NAMESPACE = 'sshRemote' as const

/**
 * The stable codes this namespace can fail with.
 *
 * These are the Remote-level vocabulary, so they are a superset of
 * {@link SshErrorCode}'s execution-time codes: the Remote API additionally has
 * to describe "nothing is configured yet" and "the host key is unknown to the
 * trust store" — states a caller of the settings card hits long before any
 * command runs.
 */
export const SSH_REMOTE_ERROR_CODES = Object.freeze([
  'ssh/not-configured',
  'ssh/not-connected',
  'ssh/trust-required',
  'ssh/host-key-changed',
  'ssh/auth-failed',
  'ssh/connect-timeout',
  'ssh/unknown-host-key',
  'ssh/internal',
] as const)

/** One code from {@link SSH_REMOTE_ERROR_CODES}. */
export type SshRemoteErrorCode = (typeof SSH_REMOTE_ERROR_CODES)[number]

/** Every projection state the settings card renders. */
export type SshRemoteState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'trust-required'
  | 'key-changed'
  | 'exhausted'
  | 'disposed'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The `ssh-remote` section has no server configured yet. */
    'ssh/not-configured': { readonly host: string }
    /** No live SSH transport is established right now. */
    'ssh/not-connected': { readonly state: SshRemoteState; readonly attempt: number }
    /** The server's host key is not trusted yet; confirm the offered fingerprint first. */
    'ssh/trust-required': { readonly host: string; readonly port: number; readonly fingerprint: string }
    /** A previously trusted host key changed; the world stays closed until the user decides. */
    'ssh/host-key-changed': {
      readonly host: string
      readonly port: number
      readonly expected: string
      readonly actual: string
    }
    /** Dialing or authenticating failed. */
    'ssh/auth-failed': { readonly host: string; readonly port: number }
    /** The connection attempt ran out of time. */
    'ssh/connect-timeout': { readonly host: string; readonly port: number }
    /** The fingerprint to confirm was never offered by the server, so trust would be unfounded. */
    'ssh/unknown-host-key': { readonly fingerprint: string }
    /** The trust store or the runtime failed in a way this API does not classify further. */
    'ssh/internal': { readonly operation: string }
  }
}

/**
 * The safe projection of the SSH execution world.
 *
 * Every field is either a value the user typed into the settings card, a
 * runtime counter, a public fingerprint, or a stable code. There is no field
 * that could carry remote content.
 */
export interface SshRemoteStatus {
  /** Configured server address, or empty when not configured. */
  readonly host: string
  /** Configured SSH port. */
  readonly port: number
  /** Configured login name, or empty when not configured. */
  readonly username: string
  /** Configured remote working directory, or empty when not configured. */
  readonly cwd: string
  /** Current connection state, already projected onto the wire vocabulary. */
  readonly state: SshRemoteState
  /** Monotonic generation of the connected world; increments on reconnect. */
  readonly generation: number
  /** Reconnect attempt counter within the current loss episode. */
  readonly attempt: number
  /** Trusted server host-key fingerprint, absent while the server is untrusted. */
  readonly fingerprint?: string
  /**
   * Fingerprint the server offered while the user's decision is pending —
   * first contact (TOFU) or a changed key. Absent otherwise.
   */
  readonly offeredFingerprint?: string
  /** Stable code explaining why the world is not executable, when it is not. */
  readonly errorCode?: SshRemoteErrorCode
  /** Whether commands, prompts and tools may run against this world. */
  readonly executable: boolean
}

/** Opening frame of the status stream: the complete current projection. */
export interface SshRemoteStatusBaseline {
  readonly type: 'baseline'
  readonly status: SshRemoteStatus
}

/** One replacement after the projection changed. */
export interface SshRemoteStatusUpdate {
  readonly type: 'status'
  readonly status: SshRemoteStatus
}

/**
 * One frame of the reconnect-safe status stream.
 *
 * The first frame is always a baseline, so a browser that reconnects in the
 * middle of a loss never has to infer the current state from a gap.
 */
export type SshRemoteStatusFrame = SshRemoteStatusBaseline | SshRemoteStatusUpdate

/**
 * Outcome of an explicit connection test.
 *
 * `ok: true` means a transport was established and torn down for the test;
 * `ok: false` carries a stable code, never the transport's own message.
 */
export type SshRemoteConnectionTest =
  | { readonly ok: true; readonly status: SshRemoteStatus }
  | { readonly ok: false; readonly errorCode: SshRemoteErrorCode; readonly status: SshRemoteStatus }

/**
 * Project the runtime's user-facing execution state onto the wire state.
 *
 * Kept beside the wire vocabulary so the mapping is visible in one place:
 * the runtime's `key-changed` and the Remote API's `key-changed` are the same
 * fact, spelled once.
 *
 * The input accepts both vocabularies: the user-facing {@link SshConnectionState}
 * plus the three runtime-only kinds (`reconnecting`, `failed`, `disposed`) that
 * the reconnect state machine commits but the settings card renders under
 * different names. They are spelled here, rather than imported from the
 * Node-side runtime, so this module stays importable from the browser half.
 * @param state - the runtime's execution state.
 * @returns the state the settings card renders.
 */
export function toRemoteState(
  state: SshConnectionState | 'reconnecting' | 'failed' | 'disposed',
): SshRemoteState {
  switch (state) {
    case 'reconnecting': return 'retrying'
    case 'failed': return 'exhausted'
    case 'disposed': return 'disposed'
    default: return state
  }
}

/** Narrow a projected code back to the declared vocabulary. */
export function isRemoteErrorCode(value: string): value is SshRemoteErrorCode {
  return (SSH_REMOTE_ERROR_CODES as readonly string[]).includes(value)
}
