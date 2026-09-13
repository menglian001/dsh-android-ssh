/**
 * SSH-backed terminal: one PTY channel (pty-req + exec, one shot — no E2B
 * bootstrap-shell replacement needed), session-scoped termination.
 *
 * Foreground inspection uses /proc (readable over the control channel),
 * which the E2B adapter could not do — inputWaiting is a real
 * implementation here, not a hardcoded false.
 *
 * @module
 */

import { PassThrough } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { SshRuntime } from '../../ssh-runtime/src/index.ts'
import { quoteShellArg } from '../../ssh-runtime/src/quote.ts'
import {
  parsePositiveId,
  readRemoteFile,
  sessionProcessGroups,
  signalGroups,
  settleRemoteOutcome,
  waitTick,
} from './remote.ts'

const POLL_MS = 200

/** The persistent-PTY handle. */
export class SshTerminalHandle implements SubprocessTerminalHandle {
  readonly output: PassThrough
  readonly done: Promise<SubprocessOutcome>

  private _pid = -1
  private remoteSessionId = -1
  private terminated = false
  private cleanupPromise: Promise<void> | undefined
  private readonly operations = new Set<Promise<unknown>>()
  private readonly operationController = new AbortController()
  private channelRef: ClientChannel | undefined
  private readonly paths: { stateDir: string; pid: string; status: string; env: string }
  private readonly spec: SubprocessTerminalSpawnSpec
  private readonly permit: { release(): void }

  private readonly runtime: SshRuntime
  /**
   * Resolves once the PTY channel exists and the terminal published its pid.
   * `spawnTerminal` awaits this before handing the handle to a caller, so a
   * published handle can always be written to, inspected and signalled.
   */
  readonly ready: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void

  constructor(
    runtime: SshRuntime,
    spec: SubprocessTerminalSpawnSpec,
    permit: { release(): void },
    statePaths: { stateDir: string; pid: string; status: string; env: string },
  ) {
    this.runtime = runtime
    this.spec = spec
    this.permit = permit
    this.paths = statePaths
    this.output = new PassThrough()
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    void this.ready.catch(() => {})
    this.done = this.run()
    void this.done.catch(() => {})
  }

  get pid(): number {
    return this._pid
  }

  async write(data: string): Promise<void> {
    await this.trackOperation(async (signal) => {
      const channel = this.channelRef
      if (channel === undefined) throw new Error('terminal is not ready')
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        channel.write(Buffer.from(data, 'utf8'), (error) => { error ? reject(error) : resolve() })
      })
    })
  }

  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return await this.trackOperation(async (signal) => {
      if (this._pid <= 0) return undefined
      signal.throwIfAborted()
      // tpgid via /proc (field 6 of stat) — real foreground group id.
      const tpgidText = await this.runtime.control(
        `ps -o tpgid= -p ${this._pid} 2>/dev/null || true`,
        { signal },
      )
      const tpgid = parsePositiveId(tpgidText.trim())
      if (tpgid === undefined || tpgid < 0) return undefined
      // inputWaiting: the foreground group is in interruptible sleep waiting
      // on the controlling terminal. Read the group leader's wchan/state.
      let inputWaiting = false
      if (tpgid > 0) {
        const wchan = await this.runtime.control(
          `ps -eo pgid=,stat= | awk '$1 == ${tpgid} && $2 ~ /^S/ { s=1 } END { if (s) print "sleep" }' || true`,
          { signal },
        )
        inputWaiting = wchan.includes('sleep')
      }
      return { processGroupId: tpgid, inputWaiting }
    })
  }

  async signalForeground(signalName: SubprocessTerminalSignal): Promise<number> {
    return await this.trackOperation(async (signal) => {
      const foreground = await this.inspectForeground()
      if (foreground === undefined) throw new Error('no foreground process group to signal')
      const tpgid = foreground.processGroupId
      // Safety gate: never SIGKILL the shell session itself (parity with the
      // E2B adapter).
      if (signalName === 'SIGKILL' && tpgid === this._pid) {
        throw new Error('terminate the terminal session instead of signalling its own group')
      }
      await signalGroups(this.runtime, [tpgid], signalName.slice(3) as 'INT' | 'TERM' | 'KILL' | 'TSTP' | 'HUP')
      return tpgid
    })
  }

  async terminate(): Promise<void> {
    this.cleanupPromise ??= this.closeAfterOperations()
    await this.cleanupPromise
  }

  // ------------------------------------------------------------------ internals

  private async trackOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.terminated) throw new Error('terminal is terminating')
    const signal = this.operationController.signal
    const promise = operation(signal)
    this.operations.add(promise)
    try {
      return await promise
    } finally {
      this.operations.delete(promise)
    }
  }

  private async run(): Promise<SubprocessOutcome> {
    const spec = this.spec
    try {
      spec.signal?.throwIfAborted()

      const world = await this.runtime.getWorld()
      const argv = spec.argv.map(quoteShellArg).join(' ')

      // Prepare the env file and stateDir, then open the PTY channel whose
      // command execs the requested argv.
      await this.runtime.control(
        `mkdir -p -- ${quoteShellArg(this.paths.stateDir)} && chmod 700 -- ${quoteShellArg(this.paths.stateDir)}`,
        { signal: spec.signal },
      )
      const envEntries = Object.entries(spec.env ?? {})
      const envText = envEntries.map(([k, v]) => `${k}=${v}`).join('\0') + '\0'
      await this.runtime.control(
        `printf %s ${quoteShellArg(envText)} > ${quoteShellArg(this.paths.env)} && chmod 600 -- ${quoteShellArg(this.paths.env)}`,
        { signal: spec.signal },
      )

      const bootstrap = [
        `dsh_term_bash="$(command -v bash)"`,
        `[[ "$dsh_term_bash" == /* && -x "$dsh_term_bash" ]] || exit 125`,
        `exec "$dsh_term_bash" --noprofile --norc -c ${quoteShellArg([
          'set +e',
          `dsh_term_pgid="$(ps -o pgid= -p "$$" | tr -d " ")"`,
          `printf '%s\\n' "$dsh_term_pgid" > ${quoteShellArg(this.paths.pid)}`,
          `cd -- ${quoteShellArg(spec.cwd)} || exit 125`,
          `mapfile -d '' -t dsh_term_env < ${quoteShellArg(this.paths.env)}`,
          `rm -f -- ${quoteShellArg(this.paths.env)}`,
          `env -i -- "\${dsh_term_env[@]}" ${argv}`,
          'dsh_term_status=$?',
          `printf '%s\\n' "$dsh_term_status" > ${quoteShellArg(this.paths.status)}`,
          'exit "$dsh_term_status"',
        ].join('\n'))}`,
      ].join('\n')

      const channel = await world.connection.openPtyChannel(bootstrap, {
        rows: spec.rows, cols: spec.cols,
      })
      this.channelRef = channel
      channel.on('data', (chunk: Buffer) => { this.output.write(chunk) })
      const exit = settleRemoteOutcome(this.runtime, channel, {
        stateDir: this.paths.stateDir,
        pid: this.paths.pid,
        status: this.paths.status,
      }, 'terminal')
      // Wait for pid publication (bounded).
      const pidDeadline = Date.now() + 10_000
      for (;;) {
        const raw = await readRemoteFile(this.runtime, this.paths.pid, {})
        const pid = parsePositiveId(raw?.trim() ?? '')
        if (pid !== undefined && pid > 1) { this._pid = pid; break }
        if (Date.now() > pidDeadline) throw new Error('terminal pid publication timed out')
        if (!await waitTick(POLL_MS)) throw new Error('terminal pid publication aborted')
      }
      // Session id for cleanup scoping.
      const sidText = await this.runtime.control(`ps -o sid= -p ${this._pid} 2>/dev/null || true`, {})
      const sid = parsePositiveId(sidText.trim())
      this.remoteSessionId = sid ?? this._pid
      // The handle is fully usable from here: channel open, pid and session
      // published. `spawnTerminal` publishes it only now.
      this.resolveReady()
      return await exit
    } catch (error: unknown) {
      this.rejectReady(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      // On any settlement, end the output stream and release the channel slot.
      this.output.end()
      this.permit.release()
    }
  }

  private async closeAfterOperations(): Promise<void> {
    this.terminated = true
    this.operationController.abort()
    await Promise.allSettled([...this.operations])
    try {
      await this.closeOnce()
    } catch (error: unknown) {
      // Allow retry on the next terminate() call.
      this.cleanupPromise = undefined
      this.terminated = false
      throw error
    }
  }

  private async closeOnce(): Promise<void> {
    const sid = this.remoteSessionId > 0 ? this.remoteSessionId : this._pid
    if (sid > 0) {
      let groups = await sessionProcessGroups(this.runtime, sid)
      if (groups.length > 0) {
        await signalGroups(this.runtime, groups, 'TERM')
        groups = await this.awaitSessionEmpty(sid, Date.now() + this.spec.graceMs, false)
      }
      if (groups.length > 0) {
        await signalGroups(this.runtime, groups, 'KILL')
        groups = await this.awaitSessionEmpty(sid, Date.now() + Math.max(1000, this.spec.graceMs), true)
      }
      if (groups.length > 0) {
        throw new Error(`terminal session survived termination: groups ${groups.join(', ')}`)
      }
    }
    // Close the PTY channel: sshd hangups the pty, kernel SIGUPs the
    // foreground group — an extra cleanup layer, not the proof.
    this.channelRef?.close()
    this.channelRef = undefined
    try {
      await this.runtime.control(`rm -rf -- ${quoteShellArg(this.paths.stateDir)}`)
    } catch { /* best effort */ }
  }

  private async awaitSessionEmpty(
    sid: number,
    deadline: number,
    kill: boolean,
  ): Promise<number[]> {
    for (;;) {
      const groups = await sessionProcessGroups(this.runtime, sid)
      if (groups.length === 0) return []
      if (Date.now() >= deadline) return groups
      if (kill) await signalGroups(this.runtime, groups, 'KILL')
      const wait = Math.min(POLL_MS, Math.max(1, deadline - Date.now()))
      if (!await waitTick(wait)) return groups
    }
  }
}
