/**
 * SSH-backed subprocess handle: one exec channel per spawn, setsid tree,
 * pgid self-publication, offset-collected or piped output, TERM→KILL
 * termination over the shared control channel.
 *
 * Ported from the E2B adapter with the substrate substitutions the spike and
 * code research established:
 *   - exit code: SSH channel exit-status (protocol-level, unaffected by
 *     descendants holding fds) with the status file as cross-check fallback
 *   - output: raw channel bytes (no base64 encoder, no remote node needed)
 *   - env: still passed via a remote file read with `mapfile -d ''` — the
 *     reason is substrate-independent (argv visible in `ps`)
 *   - pgid publication window: no SDK pid exists as fallback, so a UUID-named
 *     stateDir scan (`ps -eo pid=,args=`) addresses pre-publication spawns
 *
 * @module
 */

import { PassThrough, Writable } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import { DSH_ENV_PREFIX, SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { SshRuntime } from '../../ssh-runtime/src/index.ts'

import { quoteShellArg } from '../../ssh-runtime/src/quote.ts'
import { SshOutputReader } from './output.ts'
import {
  groupAlive,
  parsePositiveId,
  readRemoteFile,
  scanStateDirProcesses,
  signalGroups,
  settleRemoteOutcome,
  waitTick,
  type RemotePaths,
} from './remote.ts'

const POLL_MS = 200
/**
 * Grace window for the pid file after the exit fact arrives: the remote write
 * and the control-channel read are not simultaneous, so a short-lived process
 * can be observed as exited before its published pgid becomes visible.
 */
const PGID_GRACE_MS = 2_000

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return mode !== 'pipe' && mode !== 'inherit'
}

function hasSpill(mode: SubprocessOutputMode): mode is SubprocessCollect & { spill: { maxBytes: number } } {
  return isCollect(mode) && mode.spill !== undefined
}

const WAIT_ABORTED = Symbol('wait aborted')

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof WAIT_ABORTED> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.resolve(WAIT_ABORTED)
  return new Promise<T | typeof WAIT_ABORTED>((resolve) => {
    const onAbort = (): void => { cleanup(); resolve(WAIT_ABORTED) }
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then((value) => { cleanup(); resolve(value) })
  })
}

/**
 * A Writable that forwards to the channel once the spawn becomes ready —
 * spawn() must return synchronously while the channel opens asynchronously.
 * (Direct port of the E2B adapter's DeferredStdin.)
 */
class DeferredStdin extends Writable {
  private readonly ready: Promise<ClientChannel>

  constructor(ready: Promise<ClientChannel>) {
    super({ decodeStrings: false })
    this.ready = ready
    this.ready.catch(() => {}) // observed by the handle's own done promise
  }

  override _write(chunk: string | Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void this.ready.then(handle => new Promise<void>((resolve, reject) => {
      handle.write(chunk, (error) => { error ? reject(error) : resolve() })
    })).then(
      () => { callback() },
      (error: unknown) => { callback(asError(error)) },
    )
  }

  override _final(callback: (error?: Error | null) => void): void {
    // SSH channel EOF is the clean stdin close.
    void this.ready.then(handle => { handle.end() }).then(
      () => { callback() },
      (error: unknown) => { callback(asError(error)) },
    )
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * The remote bootstrap script body (runs under setsid in its own session).
 *
 * A guard process is part of the tree: `setsid` deliberately detaches the tree
 * from the controlling terminal so termination can be group-scoped, and the
 * side effect is that a host that dies without cleaning up (SIGKILL, crash,
 * lost network) leaves the tree running. The guard watches the sshd-side
 * ancestor that owns this channel and terminates the group when it goes away,
 * so the remote world cannot accumulate orphans that no host still tracks.
 */
function innerScript(paths: RemotePaths, spec: SubprocessSpawnSpec): string {
  const stdoutRedirect = hasSpill(spec.stdio.stdout)
    ? `> >(tee --output-error=warn-nopipe >(head -c ${spec.stdio.stdout.spill.maxBytes} > ${quoteShellArg(paths.stdout)}) 2>/dev/null)`
    : ''
  const stderrRedirect = hasSpill(spec.stdio.stderr)
    ? `2> >(tee --output-error=warn-nopipe >(head -c ${spec.stdio.stderr.spill.maxBytes} > ${quoteShellArg(paths.stderr)}) 2>/dev/null)`
    : ''
  return [
    'set +e',
    'dsh_ssh_pgid="$(ps -o pgid= -p "$$" | tr -d " ")"',
    `printf '%s\\n' "$dsh_ssh_pgid" > ${quoteShellArg(paths.pid)}`,
    // The channel owner is this session's grandparent (setsid's parent), which
    // sshd reaps when the channel closes. Captured before the guard starts so
    // the guard never has to walk a changing process tree.
    'dsh_ssh_owner="$(ps -o ppid= -p "$PPID" 2>/dev/null | tr -d " ")"',
    `mapfile -d '' -t dsh_ssh_env < ${quoteShellArg(paths.environment)}`,
    `rm -f -- ${quoteShellArg(paths.environment)}`,
    `cd -- ${quoteShellArg(spec.cwd)} || exit 125`,
    // Orphan guard: poll the channel owner, then TERM/KILL our own group. It
    // runs in the group it guards, so it dies with a normal termination and
    // never outlives the work it protects.
    'if [ -n "$dsh_ssh_owner" ] && [ "$dsh_ssh_owner" -gt 1 ]; then',
    '  (',
    '    while kill -0 "$dsh_ssh_owner" 2>/dev/null; do sleep 5; done',
    `    kill -TERM -- "-$dsh_ssh_pgid" 2>/dev/null`,
    '    sleep 5',
    `    kill -KILL -- "-$dsh_ssh_pgid" 2>/dev/null`,
    '  ) &',
    '  dsh_ssh_guard=$!',
    'fi',
    `env -i -- "\${dsh_ssh_env[@]}" "$@" ${stdoutRedirect} ${stderrRedirect}`.trimEnd(),
    'dsh_ssh_status=$?',
    `printf '%s\\n' "$dsh_ssh_status" > ${quoteShellArg(paths.status)}`,
    // Retire the guard on a normal exit so it cannot signal a reused pgid.
    'if [ -n "${dsh_ssh_guard:-}" ]; then kill "$dsh_ssh_guard" 2>/dev/null; fi',
    'wait',
    'exit "$dsh_ssh_status"',
  ].join('\n')
}

/** One SSH-exec-backed process tree with its own session. */
export class SshSubprocessHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly collected: {
    stdout?: SshOutputReader
    stderr?: SshOutputReader
  }
  readonly done: Promise<SubprocessOutcome>

  private remotePid = -1
  private quiescenceProven = false
  private terminationAttempt: Promise<boolean> | undefined
  private terminationFailure: Error | undefined
  private readonly terminationController = new AbortController()
  private readonly commandState: { promise: Promise<ClientChannel | undefined> }
  private readonly readyState: { promise: Promise<ClientChannel> }
  private readonly abortListener: () => void
  private readonly readers: { stdout?: SshOutputReader; stderr?: SshOutputReader }

  private readonly runtime: SshRuntime
  private readonly spec: SubprocessSpawnSpec
  private readonly paths: RemotePaths

  constructor(
    runtime: SshRuntime,
    spec: SubprocessSpawnSpec,
    paths: RemotePaths,
  ) {
    this.runtime = runtime
    this.spec = spec
    this.paths = paths
    let resolveCommand: (value: ClientChannel | undefined) => void
    this.commandState = { promise: new Promise((resolve) => { resolveCommand = resolve }) }
    let resolveReady: (value: ClientChannel) => void
    let rejectReady: (error: Error) => void
    this.readyState = { promise: new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject }) }
    void this.readyState.promise.catch(() => {})

    if (spec.stdio.stdin === 'pipe') {
      this.stdin = new DeferredStdin(this.readyState.promise)
    }

    const makePipe = (): InstanceType<typeof PassThrough> => new PassThrough()
    const makeReader = (mode: SubprocessOutputMode, spillPath: string): SshOutputReader | undefined => {
      if (!isCollect(mode)) return undefined
      return new SshOutputReader(
        mode.maxBytes,
        mode.spill !== undefined ? { path: spillPath, maxBytes: mode.spill.maxBytes } : undefined,
      )
    }
    this.readers = {
      stdout: makeReader(spec.stdio.stdout, paths.stdout),
      stderr: makeReader(spec.stdio.stderr, paths.stderr),
    }
    this.collected = this.readers
    if (spec.stdio.stdout === 'pipe') this.stdout = makePipe()
    if (spec.stdio.stderr === 'pipe') this.stderr = makePipe()

    this.abortListener = (): void => { this.terminate() }
    spec.signal?.addEventListener('abort', this.abortListener, { once: true })

    this.done = this.run(resolveCommand!, resolveReady!, rejectReady!)
    void this.done.catch(() => {})
  }

  /**
   * The process-group id the remote bootstrap published, or -1 before
   * publication and when the spawn failed. SSH never carries a remote pid, so
   * this is the published pgid — the id every signal and liveness probe uses.
   */
  get pid(): number {
    return this.remotePid
  }

  /** The pgid to address, re-reading the published file when not yet cached. */
  private async addressablePgid(): Promise<number | undefined> {
    if (this.remotePid > 0) return this.remotePid
    return await this.probePgid()
  }

  async terminate(): Promise<void> {
    this.terminationController.abort()
    this.stdout?.destroy()
    this.stderr?.destroy()
    this.terminationAttempt ??= this.terminateRemote()
    await this.terminationAttempt
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.quiescenceProven) return true
    if (this.terminationAttempt !== undefined) {
      await this.terminationAttempt
      this.throwTerminationFailure()
      return this.quiescenceProven
    }
    const channel = await waitWithSignal(this.readyState.promise, signal)
    if (channel === WAIT_ABORTED) return false
    if (!(channel instanceof Object)) {
      // ready rejected — fall back to command state
      const command = await waitWithSignal(this.commandState.promise, signal)
      if (command === WAIT_ABORTED) return false
      if (command === undefined) { this.markQuiescent(); return true }
    }
    for (;;) {
      this.throwTerminationFailure()
      const pgid = await this.addressablePgid()
      if (pgid === undefined) { this.markQuiescent(); return true }
      if (!(await groupAlive(this.runtime, pgid))) { this.markQuiescent(); return true }
      if (!await waitTick(POLL_MS, signal)) return false
    }
  }

  private async run(
    resolveCommand: (value: ClientChannel | undefined) => void,
    resolveReady: (value: ClientChannel) => void,
    rejectReady: (error: Error) => void,
  ): Promise<SubprocessOutcome> {
    const spec = this.spec
    let permit: { release(): void } | undefined
    let stateDirCreated = false
    try {
      spec.signal?.throwIfAborted()
      permit = await this.runtime.acquireChannelSlot(spec.signal)

      // Claim ownership before the mkdir commits: a cancellation racing a
      // committed creation must still reach the cleanup path (removal
      // tolerates an absent path, a missed removal leaks).
      stateDirCreated = true
      await this.runtime.control(
        `mkdir -p -- ${quoteShellArg(this.paths.stateDir)} && chmod 700 -- ${quoteShellArg(this.paths.stateDir)}`,
        { signal: spec.signal },
      )

      // The environment is NUL-separated bytes, so it cannot travel inside a
      // shell command string (a NUL terminates the argument). SFTP writes the
      // raw buffer, and the file keeps argv out of `ps` output.
      const ambient = await this.readAmbientEnvironment(spec.signal)
      await this.writeEnvironmentFile(serializeEnv(ambient, spec.env))

      const argv = spec.argv.map(quoteShellArg).join(' ')
      const bootstrap = [
        `mapfile -d '' -t dsh_ssh_env < ${quoteShellArg(this.paths.environment)}`,
        'dsh_ssh_setsid="$(command -v setsid)"',
        'dsh_ssh_bash="$(command -v bash)"',
        'dsh_ssh_env_bin="$(command -v env)"',
        'for dsh_ssh_tool in "$dsh_ssh_setsid" "$dsh_ssh_bash" "$dsh_ssh_env_bin"; do',
        '  [[ "$dsh_ssh_tool" == /* && -x "$dsh_ssh_tool" ]] || exit 125',
        'done',
        `exec "$dsh_ssh_env_bin" -i -- "\${dsh_ssh_env[@]}" "$dsh_ssh_setsid" --wait -- "$dsh_ssh_bash" -c ${quoteShellArg(innerScript(this.paths, spec))} dsh-ssh ${argv}`,
      ].join('\n')

      const world = await this.runtime.getWorld()
      const channel = await world.connection.openExecChannel(bootstrap)
      resolveCommand(channel)

      channel.on('data', (chunk: Buffer) => { this.dispatchOutput('stdout', chunk) })
      channel.stderr.on('data', (chunk: Buffer) => { this.dispatchOutput('stderr', chunk) })

      // Observe the exit BEFORE waiting for pgid publication: a process can
      // exit before it publishes, and the publication poll needs that fact to
      // escape its loop.
      const exiting = this.awaitExit(channel)
      void exiting.then((facts) => { this.exitFacts = facts }, () => {})

      // Settle stdin BEFORE polling for the pgid. `ignore` and the batch shape
      // both close stdin immediately, and a reader that never sees EOF would
      // otherwise keep the tree alive while the poll waits on it. Only `pipe`
      // defers, because the caller owns that stream's lifetime.
      const stdin = spec.stdio.stdin
      if (stdin === 'ignore') {
        channel.end()
      } else if (typeof stdin === 'object') {
        // Batch stdin is best effort: a process may exit before reading it
        // (`head -1`), and the exit code plus output stay authoritative.
        try {
          channel.write(stdin.data)
          channel.end()
        } catch (_batchStdinFailure) {
          // Deliberately ignored; see above.
        }
      }

      const pgid = await this.waitForProcessGroupId()
      if (pgid > 0) this.remotePid = pgid

      // Publish readiness so a piped writer can start; a reader like `cat`
      // cannot exit until it sees the EOF that writer eventually sends.
      resolveReady(channel)

      return await exiting
    } catch (error: unknown) {
      resolveCommand(undefined)
      rejectReady(asError(error))
      // A rejected handle must not leave a live remote process behind.
      await this.rollbackPublishedFailure(asError(error))
      throw asError(error)
    } finally {
      if (stateDirCreated) await this.cleanupStateDir()
      permit?.release()
    }
  }

  /**
   * Remove per-spawn state. Spill files live in the same directory and stay
   * readable after exit, so a spawn that configured spilling keeps them and
   * drops only the private control files.
   */
  private async cleanupStateDir(): Promise<void> {
    const keepSpills = hasSpill(this.spec.stdio.stdout) || hasSpill(this.spec.stdio.stderr)
    const command = keepSpills
      ? `rm -f -- ${quoteShellArg(this.paths.pid)} ${quoteShellArg(this.paths.status)} ${quoteShellArg(this.paths.environment)}`
      : `rm -rf -- ${quoteShellArg(this.paths.stateDir)}`
    try {
      await this.runtime.control(command)
    } catch (_cleanupFailure) {
      // The command result is authoritative; leftovers cannot fail the spawn.
    }
  }

  /**
   * Read the remote ambient environment and scrub it, so the child inherits a
   * usable PATH without inheriting harness-managed or credential-shaped
   * entries. base64 carries the NUL-separated payload through the control
   * channel's line framing.
   */
  private async readAmbientEnvironment(signal?: AbortSignal): Promise<Record<string, string>> {
    const encoded = await this.runtime.control('env -0 | base64 -w0', { signal })
    const raw = Buffer.from(encoded.trim(), 'base64').toString('utf8')
    const scrubbed: Record<string, string> = {}
    for (const entry of raw.split('\0')) {
      if (entry.length === 0) continue
      const separator = entry.indexOf('=')
      if (separator <= 0) continue
      const name = entry.slice(0, separator)
      if (name.startsWith(DSH_ENV_PREFIX)) continue
      if (SENSITIVE_ENV_PATTERN.test(name)) continue
      scrubbed[name] = entry.slice(separator + 1)
    }
    return scrubbed
  }

  /** Write the NUL-separated environment file over SFTP with mode 600. */
  private async writeEnvironmentFile(contents: string): Promise<void> {
    const world = await this.runtime.getWorld()
    const sftp = await world.sftp.get()
    await new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(this.paths.environment, { mode: 0o600 })
      stream.on('error', reject)
      stream.on('close', () => { resolve() })
      stream.end(Buffer.from(contents, 'utf8'))
    })
  }

  private dispatchOutput(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const reader = this.readers[stream]
    const pipe = stream === 'stdout' ? this.stdout : this.stderr
    const mode = stream === 'stdout' ? this.spec.stdio.stdout : this.spec.stdio.stderr
    if (reader !== undefined) reader.push(chunk)
    if (mode === 'pipe' && pipe !== undefined) {
      pipe.write(chunk)
    } else if (mode === 'inherit') {
      const target = stream === 'stdout' ? process.stdout : process.stderr
      if (!target.destroyed) target.write(chunk)
    }
  }

  /**
   * Resolve the exit facts. The SSH `exit-status` / `exit-signal` channel
   * request is the protocol-level answer and arrives even when a descendant
   * still holds an output descriptor. The status file written by the remote
   * bootstrap is the cross-check for the case where the channel closes without
   * ever delivering one.
   */
  private async awaitExit(channel: ClientChannel): Promise<SubprocessOutcome> {
    return await settleRemoteOutcome(this.runtime, channel, this.paths, 'process')
  }

  /**
   * Poll for the pgid the remote bootstrap publishes.
   *
   * SSH never carries a remote pid, so this file is the only way to address
   * the tree. Returns -1 when the process exited without publishing — but only
   * after a grace window, because the exit fact can reach the host before the
   * file write becomes visible through the control channel, and one control
   * round trip is not instantaneous.
   */
  private async waitForProcessGroupId(): Promise<number> {
    let graceDeadline: number | undefined
    for (;;) {
      const raw = await readRemoteFile(this.runtime, this.paths.pid, {})
      const text = raw?.trim()
      const pid = text !== undefined ? parsePositiveId(text) : undefined
      // pgid 1 is init's group; `kill -- -1` would signal every process.
      if (pid !== undefined && pid > 1) return pid
      if (this.exitFacts !== undefined) {
        graceDeadline ??= Date.now() + PGID_GRACE_MS
        if (Date.now() >= graceDeadline) return -1
      }
      await waitTick(POLL_MS)
    }
  }

  private exitFacts: SubprocessOutcome | undefined

  private async probePgid(): Promise<number | undefined> {
    const raw = await readRemoteFile(this.runtime, this.paths.pid, {})
    const text = raw?.trim()
    return text !== undefined ? parsePositiveId(text) : undefined
  }

  private async terminateRemote(): Promise<boolean> {
    try {
      const pgid = await this.addressablePgid()
      if (pgid === undefined || pgid <= 1) {
        // Pre-publication: fallback scan by stateDir UUID.
        const pids = await scanStateDirProcesses(this.runtime, this.paths.stateDir)
        if (pids.length === 0) { this.markQuiescent(); return true }
        await signalGroups(this.runtime, pids.map(p => -p).map(p => Math.abs(p)).map(p => -p), 'TERM')
      } else {
        await signalGroups(this.runtime, [pgid], 'TERM')
      }
      const deadline = Date.now() + this.spec.graceMs
      for (;;) {
        const pgidNow = await this.addressablePgid()
        const alive = pgidNow !== undefined && pgidNow > 1 && await groupAlive(this.runtime, pgidNow)
        if (!alive) { this.markQuiescent(); return true }
        if (Date.now() >= deadline) break
        if (!await waitTick(POLL_MS)) break
      }
      // Escalate to KILL.
      const pgidNow = await this.addressablePgid()
      if (pgidNow !== undefined && pgidNow > 1) {
        await signalGroups(this.runtime, [pgidNow], 'KILL')
      } else {
        const pids = await scanStateDirProcesses(this.runtime, this.paths.stateDir)
        for (const pid of pids) await signalGroups(this.runtime, [pid], 'KILL')
      }
      const deadline2 = Date.now() + Math.max(1000, this.spec.graceMs)
      for (;;) {
        const pgidFinal = await this.addressablePgid()
        const alive = pgidFinal !== undefined && pgidFinal > 1 && await groupAlive(this.runtime, pgidFinal)
        if (!alive) { this.markQuiescent(); return true }
        if (Date.now() >= deadline2) {
          throw new Error(`process group remained live after force termination (pgid ${pgidFinal})`)
        }
        if (!await waitTick(POLL_MS)) break
      }
      this.markQuiescent()
      return true
    } catch (error: unknown) {
      this.terminationFailure = asError(error)
      return false
    }
  }

  private async rollbackPublishedFailure(error: Error): Promise<void> {
    if (this.remotePid <= 0) return
    try {
      await this.terminateRemote()
    } catch (rollbackError: unknown) {
      throw new AggregateError([error, asError(rollbackError)], error.message)
    }
  }

  private throwTerminationFailure(): void {
    if (this.terminationFailure !== undefined && !this.quiescenceProven) {
      throw this.terminationFailure
    }
  }

  private markQuiescent(): void {
    this.quiescenceProven = true
    this.terminationFailure = undefined
    this.readers.stdout?.settle()
    this.readers.stderr?.settle()
    this.stdout?.end()
    this.stderr?.end()
  }
}

/**
 * Serialize the child environment into NUL-separated `name=value` pairs.
 *
 * The scrubbed remote ambient environment is the base; explicit entries are
 * layered on top so a deliberately forwarded credential survives the scrub,
 * and `undefined` acts as a tombstone that removes an ambient entry.
 */
function serializeEnv(
  ambient: Record<string, string>,
  explicit: NodeJS.ProcessEnv | undefined,
): string {
  const merged: Record<string, string> = { ...ambient }
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (name.length === 0 || name.includes('=') || name.includes('\0')) {
      throw new Error(`invalid environment name: ${JSON.stringify(name)}`)
    }
    if (value === undefined) {
      delete merged[name]
      continue
    }
    merged[name] = value
  }
  const entries = Object.entries(merged).map(([name, value]) => `${name}=${value}`)
  return entries.length === 0 ? '' : `${entries.join('\0')}\0`
}
