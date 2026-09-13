/**
 * Shared runtime state and error mapping for the SSH subprocess provider.
 *
 * @module
 */

import type { ClientChannel } from 'ssh2'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import type { SshRuntime } from '../../ssh-runtime/src/index.ts'
import { RemoteExecutionUnknown, SshConnectionLost } from '../../ssh-runtime/src/index.ts'
import { quoteShellArg } from '../../ssh-runtime/src/quote.ts'
import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Per-spawn remote state directory layout (mirror of the E2B adapter). */
export interface RemotePaths {
  /** Directory holding all per-spawn state; name embeds a UUID for fallback scans. */
  stateDir: string
  pid: string
  status: string
  environment: string
  stdout: string
  stderr: string
}

export function remotePathsFor(runtimeRoot: string): RemotePaths {
  const stateDir = posix.join(runtimeRoot, 'proc', randomUUID())
  return {
    stateDir,
    pid: posix.join(stateDir, 'pid'),
    status: posix.join(stateDir, 'status'),
    environment: posix.join(stateDir, 'env'),
    stdout: posix.join(stateDir, 'stdout'),
    stderr: posix.join(stateDir, 'stderr'),
  }
}

/** True when the id is a safe positive integer usable as a process/group id. */
export function isValidId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/** Parse a strict positive decimal id; undefined on any deviation. */
export function parsePositiveId(text: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(text)) return undefined
  const value = Number.parseInt(text, 10)
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * Fallback scan for the pgid-publication window: find live processes whose
 * command line references this spawn's unique state directory. SSH cannot
 * know the remote pid (the protocol never carries one), so a spawn that dies
 * before writing its pid file is only addressable through this scan.
 */
export async function scanStateDirProcesses(
  runtime: SshRuntime,
  stateDir: string,
  options?: { signal?: AbortSignal },
): Promise<number[]> {
  const out = await runtime.control(
    `ps -eo pid=,args= | grep -F -- ${quoteShellArg(stateDir)} | grep -v grep || true`,
    options,
  )
  const pids: number[] = []
  for (const line of out.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const pid = parsePositiveId(trimmed.split(/\s+/)[0] ?? '')
    if (pid !== undefined && pid > 1) pids.push(pid)
  }
  return pids
}

/**
 * Signal one or more process groups by negative id. Errors are tolerated the
 * same way the E2B adapter tolerates them: a group that is already gone is
 * not an error.
 */
export async function signalGroups(
  runtime: SshRuntime,
  groups: readonly number[],
  signal: 'TERM' | 'KILL' | 'INT' | 'HUP' | 'TSTP',
  options?: { signal?: AbortSignal },
): Promise<void> {
  if (groups.length === 0) return
  const args = groups.map(g => `-${g}`).join(' ')
  // exit 0 when at least one group received it; "no such process" is fine.
  await runtime.control(
    `kill -${signal} -- ${args} 2>/dev/null; exit 0`,
    options,
  )
}

/** Live members of the process group (excluding zombies/dead). */
export async function groupAlive(
  runtime: SshRuntime,
  pgid: number,
  options?: { signal?: AbortSignal },
): Promise<boolean> {
  const out = await runtime.control(
    `set -o pipefail; ps -eo pgid=,stat= | awk '$1 == ${pgid} && $2 !~ /^[ZXx]/ { l=1 } END { if (l) print "live" }' || true`,
    options,
  )
  return out.includes('live')
}

/** All live process groups in the session (excluding zombies/dead). */
export async function sessionProcessGroups(
  runtime: SshRuntime,
  sid: number,
  options?: { signal?: AbortSignal },
): Promise<number[]> {
  const out = await runtime.control(
    `set -o pipefail; ps -eo sid=,pgid=,stat= | awk '$1 == ${sid} && $3 !~ /^[ZXx]/ { print $2 }' || true`,
    options,
  )
  const groups = new Set<number>()
  for (const line of out.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const value = parsePositiveId(trimmed)
    if (value !== undefined && value > 1) groups.add(value)
  }
  return [...groups]
}

/** Wait one bounded tick; resolves false when the signal aborted first. */
export async function waitTick(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted === true) return false
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Read a remote file's trimmed content, or undefined when absent. */
export async function readRemoteFile(
  runtime: SshRuntime,
  path: string,
  options?: { signal?: AbortSignal },
): Promise<string | undefined> {
  const out = await runtime.control(
    `if test -f ${quoteShellArg(path)}; then cat ${quoteShellArg(path)}; else printf '__dsh_absent__'; fi`,
    options,
  )
  return out === '__dsh_absent__' ? undefined : out
}

/**
 * Settle one remote process/terminal result without treating channel loss as
 * proof of exit. Protocol exit facts win; otherwise persisted status is the
 * only successful reconciliation result. Missing or unprovable state rejects
 * as RemoteExecutionUnknown and never replays the operation.
 */
export function settleRemoteOutcome(
  runtime: SshRuntime,
  channel: ClientChannel,
  paths: Pick<RemotePaths, 'stateDir' | 'pid' | 'status'>,
  kind: 'process' | 'terminal',
): Promise<SubprocessOutcome> {
  return new Promise<SubprocessOutcome>((resolve, reject) => {
    let settled = false
    let transportError: unknown
    const settle = (outcome: SubprocessOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    const unknown = (cause?: unknown): void => {
      if (settled) return
      settled = true
      reject(new RemoteExecutionUnknown({
        operationId: posix.basename(paths.stateDir),
        stateDir: paths.stateDir,
        kind,
        cause,
      }))
    }
    const reconcile = async (): Promise<void> => {
      if (settled) return
      try {
        const rawStatus = await readRemoteFile(runtime, paths.status)
        const status = parseExitStatus(rawStatus)
        if (status !== undefined) {
          settle({ exitCode: status, signal: null })
          return
        }
        const rawPid = await readRemoteFile(runtime, paths.pid)
        const pid = parsePositiveId(rawPid?.trim() ?? '')
        if (pid !== undefined && pid > 1) {
          await groupAlive(runtime, pid)
        }
        unknown(transportError)
      } catch (error: unknown) {
        unknown(transportError ?? error)
      }
    }
    channel.on('exit', (code: number | null, signal?: string | null) => {
      if (typeof signal === 'string' && signal.length > 0) {
        const normalized = signal.startsWith('SIG') ? signal : `SIG${signal}`
        settle({ exitCode: null, signal: normalized as SubprocessOutcome['signal'] })
        return
      }
      if (code !== null) settle({ exitCode: code, signal: null })
    })
    channel.on('error', (error: Error) => {
      transportError = error
      void reconcile()
    })
    channel.on('close', () => { void reconcile() })
  })
}

function parseExitStatus(raw: string | undefined): number | undefined {
  const text = raw?.trim()
  if (text === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(text)) return undefined
  const value = Number.parseInt(text, 10)
  return value <= 255 ? value : undefined
}

export { SshConnectionLost }
