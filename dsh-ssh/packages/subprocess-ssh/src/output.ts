/**
 * Offset-based collected-output reader (port of the E2B adapter's
 * E2BOutputReader with the base64 transport layer removed — SSH channels
 * carry raw bytes, so the decoder and completion frame are unnecessary).
 *
 * Tail retention semantics are identical: `maxBytes` in memory keeping the
 * TAIL, `readFrom(fromByte)` with whole-stream coordinates, lossy reads
 * return the whole retained tail, spill files only valid while the whole
 * stream fits under the spill cap.
 *
 * @module
 */

import type { SubprocessOutputRead } from '@deepseek-ai/dsh-subprocess'

/** Bounded tail buffer for one collected stream. */
export class SshOutputReader {
  private totalBytes = 0
  private retainedBytes = 0
  private readonly chunks: Uint8Array[] = []
  private spillValid = true
  private settled = false

  readonly maxBytes: number
  private readonly spill: { path: string; maxBytes: number } | undefined

  /**
   * @param maxBytes - In-memory tail cap.
   * @param spill - Absolute remote path of the spill file when one exists,
   *   with its whole-stream byte cap.
   */
  constructor(
    maxBytes: number,
    spill?: { path: string; maxBytes: number },
  ) {
    this.maxBytes = maxBytes
    this.spill = spill
  }

  /** Feed one raw chunk from the channel. */
  push(chunk: Uint8Array): void {
    this.totalBytes += chunk.byteLength
    this.chunks.push(chunk)
    this.retainedBytes += chunk.byteLength
    while (this.retainedBytes > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0]
      const excess = this.retainedBytes - this.maxBytes
      if (head.byteLength <= excess) {
        this.chunks.shift()
        this.retainedBytes -= head.byteLength
      } else {
        this.chunks[0] = head.subarray(excess)
        this.retainedBytes -= excess
      }
    }
  }

  /** Whole-stream size so far. */
  get currentTotal(): number {
    return this.totalBytes
  }

  /** Mark the stream complete. */
  settle(): void {
    this.settled = true
  }

  /** Whether the stream has completed. */
  get isSettled(): boolean {
    return this.settled
  }

  /** Invalidate the spill (stream exceeded its cap or the file is unusable). */
  invalidateSpill(): void {
    this.spillValid = false
  }

  /** Remote spill path when the spill remains usable. */
  get spillPath(): string | undefined {
    if (this.spill === undefined) return undefined
    if (!this.spillValid) return undefined
    if (this.totalBytes > this.spill.maxBytes) return undefined
    return this.spill.path
  }

  /** Whether in-memory content was truncated (the head was dropped). */
  get truncated(): boolean {
    return this.retainedBytes < this.totalBytes
  }

  /**
   * Read everything captured since `fromByte`.
   */
  readFrom(fromByte: number): SubprocessOutputRead {
    const firstRetained = this.totalBytes - this.retainedBytes
    const lossy = fromByte < firstRetained
    const start = lossy ? 0 : Math.max(0, fromByte - firstRetained)
    let length = 0
    for (const chunk of this.chunks) length += chunk.byteLength
    const text = Buffer.concat(this.chunks).subarray(start, length).toString('utf8')
    const read: SubprocessOutputRead = {
      text,
      nextOffset: this.totalBytes,
      lossy,
    }
    const spillPath = this.spillPath
    if (spillPath !== undefined) read.spillPath = spillPath
    return read
  }
}
