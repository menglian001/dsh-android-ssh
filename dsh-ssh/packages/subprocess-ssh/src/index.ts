/**
 * SSH subprocess provider: `ctx.subprocess` over the SSH execution world.
 *
 * @module
 */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { SshRuntime } from '../../ssh-runtime/src/index.ts'
import { quoteShellArg } from '../../ssh-runtime/src/quote.ts'
import { SshSubprocessHandle } from './process.ts'
import { SshTerminalHandle } from './terminal.ts'
import { remotePathsFor } from './remote.ts'
import { validateSpawnSpec, validateTerminalSpec } from './validate.ts'

/** Subprocess provider over the shared SSH world owned by `ctx.ssh`. */
export class SshSubprocessRuntime extends SubprocessRuntime {
  static inject = ['ssh'] as const

  private readonly runtime: SshRuntime
  private readonly live = new Set<SubprocessHandle>()
  private readonly terminals = new Set<SubprocessTerminalHandle>()

  constructor(ctx: Context, runtime: SshRuntime) {
    super(ctx)
    this.runtime = runtime
    ctx.effect(() => async () => {
      await this.dispose()
    }, 'ssh subprocess teardown')
  }

  /** Retain an ordinary handle until its complete managed range is empty. */
  trackProcess(handle: SubprocessHandle): void {
    this.live.add(handle)
    const release = async (): Promise<void> => {
      await handle.waitForExit()
      this.live.delete(handle)
    }
    void handle.done.then(release, release).catch(() => {})
  }

  /** Retain a terminal until its top-level result settles. */
  trackTerminal(handle: SubprocessTerminalHandle): void {
    this.terminals.add(handle)
    void handle.done.then(
      () => { this.terminals.delete(handle) },
      () => { this.terminals.delete(handle) },
    )
  }

  /** Terminate every still-owned handle and await observation of remote exit. */
  async dispose(): Promise<void> {
    await this.disposeManagedHandles()
  }

  private async disposeManagedHandles(): Promise<void> {
    const pending: Promise<unknown>[] = []
    for (const handle of this.live) {
      handle.terminate()
      pending.push(Promise.all([
        handle.done.catch(() => {}),
        handle.waitForExit(),
      ]).then(() => { this.live.delete(handle) }))
    }
    for (const terminal of this.terminals) {
      pending.push(terminal.terminate().then(() => {
        this.terminals.delete(terminal)
      }))
    }
    const outcomes = await Promise.allSettled(pending)
    const failures = outcomes
      .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      .map(outcome => outcome.reason as unknown)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'SSH subprocess teardown failed')
    }
  }

  override async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('resolveExecutable: empty command')
    signal?.throwIfAborted()
    const posix = await import('node:path').then(m => m.posix)
    if (posix.isAbsolute(command)) {
      // Non-zero exit (not a regular executable file) throws.
      await this.runtime.control(
        `test -f ${quoteShellArg(command)} -a -x ${quoteShellArg(command)}`,
        { signal },
      )
      signal?.throwIfAborted()
      return command
    }
    if (command.includes('/')) {
      throw new Error(`resolveExecutable: relative executable paths are not supported: ${command}`)
    }
    const pathAssign = env?.PATH !== undefined ? `PATH=${quoteShellArg(env.PATH)} ` : ''
    const out = await this.runtime.control(
      `${pathAssign}command -v -- ${quoteShellArg(command)}`,
      { signal },
    )
    signal?.throwIfAborted()
    const executable = out.trim()
    if (executable.includes('\n')
      || (!posix.isAbsolute(executable) && !executable.includes('/'))) {
      throw new Error(`resolveExecutable: invalid lookup result: ${JSON.stringify(out)}`)
    }
    return posix.resolve(this.runtime.cwd, executable)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    validateSpawnSpec(spec)
    const paths = remotePathsFor(this.runtime.runtimeRoot)
    const handle = new SshSubprocessHandle(this.runtime, spec, paths)
    this.trackProcess(handle)
    return handle
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    validateTerminalSpec(spec)
    const permit = await this.runtime.acquireChannelSlot(spec.signal)
    const stateDir = posix.join(this.runtime.runtimeRoot, 'term', crypto.randomUUID())
    const paths = {
      stateDir,
      pid: posix.join(stateDir, 'pid'),
      status: posix.join(stateDir, 'status'),
      env: posix.join(stateDir, 'env'),
    }
    try {
      const handle = new SshTerminalHandle(this.runtime, spec, permit, paths)
      // Publish only a usable handle: the PTY channel is open and the terminal
      // published its pid and session id. A setup failure rolls back here
      // instead of surfacing later as "terminal is not ready".
      try {
        await handle.ready
      } catch (setupFailure: unknown) {
        await handle.terminate().catch(() => {})
        throw setupFailure
      }
      this.trackTerminal(handle)
      return handle
    } catch (error: unknown) {
      permit.release()
      throw error
    }
  }
}

import { randomUUID as cryptoUuid } from 'node:crypto'
const crypto = { randomUUID: cryptoUuid }

export default SshSubprocessRuntime
