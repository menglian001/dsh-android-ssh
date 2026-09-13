/**
 * The persistent control channel: one long-lived exec channel running
 * `/bin/bash --noprofile --norc -s`, fed commands on stdin, responses framed
 * by UUID markers on stdout.
 *
 * The spike proved the mechanism (sub-millisecond round trips, stable framing
 * across many commands) and simultaneously proved why it must exist: sshd's
 * MaxSessions made channel 11 fail instantly, and once exhausted even cleanup
 * commands could not run. The E2B adapter's "one exec channel per control
 * command" model is not viable over SSH.
 *
 * Protocol: each request is sent as one line
 *   <command> 2>&1; printf '\n%s %s\n' '<marker>' "$?"
 * The marker is `dsh-ctl-<uuid4>` — unpredictable, cannot collide with
 * command output in practice. Everything on stdout after the previous
 * request's marker line, up to and excluding this request's marker line, is
 * this command's output; the marker line itself carries the exit status as
 * its second field.
 *
 * Disconnect rule: a dead channel rejects pending and future requests with
 * {@link SshConnectionLost}, which never proves remote quiescence.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { ClientChannel } from 'ssh2'
import {
  SshAborted,
  SshConnectionLost,
  SshControlCommandFailed,
  SshControlProtocolError,
  SshRuntimeDisposed,
} from './errors.ts'

export interface ControlRequest {
  /** Command to execute. Must be a single line (no raw newlines). */
  readonly command: string
  /** Marker timeout in milliseconds; defaults to 30s. */
  readonly timeoutMs?: number
  /** Cancellation while queued or in flight. */
  readonly signal?: AbortSignal
}

export interface ControlResult {
  readonly exitStatus: number
  readonly stdout: string
}

interface Pending {
  readonly command: string
  readonly marker: string
  readonly timeoutMs: number
  readonly signal: AbortSignal | undefined
  readonly onAbort: () => void
  readonly resolve: (result: ControlResult) => void
  readonly reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
  settled: boolean
}

/** How much unmatched output we buffer before declaring protocol failure. */
const MAX_UNMATCHED_BYTES = 1 << 20

/**
 * Serialize control commands over one persistent channel. Strictly FIFO:
 * one request in flight; the rest queue.
 */
export class ControlChannel {
  private channel: ClientChannel | undefined
  private pending: Pending | undefined
  private readonly queue: Pending[] = []
  private stdoutText = ''
  private closed = false
  private failure: Error | undefined
  private stderrTail = ''
  private readonly open: () => Promise<ClientChannel>

  /**
   * @param open - Opens the underlying exec channel. Called once at start().
   */
  constructor(open: () => Promise<ClientChannel>) {
    this.open = open
  }

  /**
   * Open the channel and prove the protocol with a liveness probe.
   *
   * @throws whatever `open` rejects with, or a protocol error if the probe
   *   fails.
   */
  async start(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw this.failure ?? new SshRuntimeDisposed('control channel is closed')
    if (this.channel !== undefined) return
    signal?.throwIfAborted()
    const channel = await this.open()
    this.channel = channel
    channel.on('data', (chunk: Buffer) => { this.onData(chunk) })
    channel.on('close', () => { this.onClose() })
    // stderr of the framing shell itself: keep a bounded tail for diagnostics.
    channel.stderr.on('data', (chunk: Buffer) => { this.consumeStderr(chunk) })
    this.stderrTail = ''
    // Liveness probe doubles as banner drain: `true` output is only the marker.
    await this.run({ command: 'true', timeoutMs: 10_000, signal })
  }

  private consumeStderr(chunk: Buffer): void {
    this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4096)
  }

  /**
   * Run one control command.
   *
   * @throws SshControlCommandFailed when the command exits non-zero.
   * @throws SshConnectionLost when the transport dies.
   * @throws SshAborted when the signal fires while queued or in flight.
   * @throws SshControlProtocolError on framing violation (marker never
   *   arrives, invalid exit status, runaway output without marker).
   */
  run(request: ControlRequest): Promise<ControlResult> {
    if (this.closed) {
      return Promise.reject(this.failure ?? new SshRuntimeDisposed('control channel is closed'))
    }
    if (this.channel === undefined) {
      return Promise.reject(new SshControlProtocolError('control channel not started'))
    }
    try {
      request.signal?.throwIfAborted()
    } catch (error: unknown) {
      return Promise.reject(error)
    }
    if (request.command.includes('\n')) {
      return Promise.reject(new SshControlProtocolError(
        'control command must be a single line',
      ))
    }
    const marker = `dsh-ctl-${randomUUID()}`
    return new Promise<ControlResult>((resolve, reject) => {
      const pending: Pending = {
        command: request.command,
        marker,
        timeoutMs: request.timeoutMs ?? 30_000,
        signal: request.signal,
        onAbort: () => { this.settle(pending, new SshAborted('control command aborted')) },
        resolve,
        reject,
        timer: undefined,
        settled: false,
      }
      this.queue.push(pending)
      request.signal?.addEventListener('abort', pending.onAbort, { once: true })
      this.pump()
    })
  }

  /** Tear down. Queued and pending requests reject with SshRuntimeDisposed. */
  close(): void {
    this.fail(new SshRuntimeDisposed('control channel closed by caller'))
  }

  private pump(): void {
    if (this.pending !== undefined || this.queue.length === 0) return
    const next = this.queue.shift()
    if (next === undefined) return
    if (this.closed || this.channel === undefined) {
      this.settle(next, this.failure ?? new SshRuntimeDisposed('control channel closed'))
      return
    }
    this.pending = next
    next.timer = setTimeout(() => {
      this.settle(
        next,
        new SshControlProtocolError(
          `control command timed out after ${next.timeoutMs}ms: ${next.command.slice(0, 200)}`,
        ),
      )
    }, next.timeoutMs)
    // The leading \n guarantees the marker starts on a fresh line even when
    // the command's output lacks a trailing newline; the parser strips exactly
    // one trailing newline from the extracted stdout, so output is preserved.
    // The subshell isolates `exit`/`cd`/variable assignments — a bare `exit`
    // would otherwise terminate the framing shell and lose the marker.
    const line = `( ${next.command} ) 2>&1; printf '\\n%s %s\\n' '${next.marker}' "$?"\n`
    this.channel.write(line)
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return
    this.stdoutText += chunk.toString('utf8')
    if (this.pending === undefined) {
      // Nothing in flight (should not happen in FIFO order, but be safe):
      // keep only a bounded tail.
      this.boundBuffer()
      return
    }
    const marker = this.pending.marker
    const markerStart = this.findMarkerLine(this.stdoutText, marker)
    if (markerStart < 0) {
      this.boundBuffer()
      return
    }
    const lineEnd = this.stdoutText.indexOf('\n', markerStart)
    if (lineEnd < 0) return // marker line incomplete
    const prefix = `${marker} `
    const statusText = this.stdoutText.slice(markerStart + prefix.length, lineEnd).trim()
    const exitStatus = Number.parseInt(statusText, 10)
    const pending = this.pending
    if (!Number.isInteger(exitStatus) || exitStatus < 0 || exitStatus > 255) {
      this.settle(
        pending,
        new SshControlProtocolError(
          `control marker carried invalid exit status ${JSON.stringify(statusText)}`,
        ),
      )
      return
    }
    const stdout = this.stdoutText.slice(0, markerStart).replace(/\n$/, '')
    this.stdoutText = this.stdoutText.slice(lineEnd + 1)
    if (exitStatus === 0) {
      this.settle(pending, { exitStatus: 0, stdout })
    } else {
      this.settle(pending, new SshControlCommandFailed(pending.command, exitStatus, stdout, this.stderrTail))
    }
  }

  /**
   * Find the start of the marker line: the marker followed by a space, at
   * the start of a line (offset 0 or right after '\n'). Coincidental marker
   * text mid-line is skipped. Returns -1 until the line is fully present.
   */
  private findMarkerLine(text: string, marker: string): number {
    const prefix = `${marker} `
    let from = 0
    for (;;) {
      const at = text.indexOf(prefix, from)
      if (at < 0) return -1
      if (at === 0 || text[at - 1] === '\n') return at
      from = at + 1
    }
  }

  private boundBuffer(): void {
    if (this.stdoutText.length > MAX_UNMATCHED_BYTES) {
      // 1 MiB of output without a marker on a control command is protocol
      // breakage, not a slow command.
      const pending = this.pending
      if (pending !== undefined) {
        this.settle(
          pending,
          new SshControlProtocolError(
            `control command produced >1MiB without a marker: ${pending.command.slice(0, 200)}`,
          ),
        )
      } else {
        this.stdoutText = this.stdoutText.slice(-8192)
      }
    }
  }

  private settle(pending: Pending, outcome: ControlResult | Error): void {
    if (pending.settled) return
    pending.settled = true
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.onAbort)
    const wasInFlight = this.pending === pending
    if (wasInFlight) this.pending = undefined
    else {
      const index = this.queue.indexOf(pending)
      if (index >= 0) this.queue.splice(index, 1)
    }
    if (outcome instanceof Error) pending.reject(outcome)
    else pending.resolve(outcome)
    if (outcome instanceof SshControlProtocolError) {
      // Framing is broken; the channel can no longer be trusted.
      this.fail(outcome)
      return
    }
    if (wasInFlight) this.pump()
    else this.pump()
  }

  private onClose(): void {
    this.fail(new SshConnectionLost('control channel closed by remote'))
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.failure = error
    const pending = this.pending
    this.pending = undefined
    if (pending !== undefined && !pending.settled) {
      pending.settled = true
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.signal?.removeEventListener('abort', pending.onAbort)
      pending.reject(new SshConnectionLost(`control command lost: ${error.message}`))
    }
    for (const queued of this.queue.splice(0)) {
      if (queued.settled) continue
      queued.settled = true
      if (queued.timer !== undefined) clearTimeout(queued.timer)
      queued.signal?.removeEventListener('abort', queued.onAbort)
      queued.reject(new SshConnectionLost(`control command lost: ${error.message}`))
    }
  }
}
