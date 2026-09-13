/**
 * Remote filesystem backend for the SSH execution world: `ctx.fs` implemented
 * over SFTP (data plane) and the persistent control channel (realpath,
 * version derivation, atomic publication).
 *
 * Semantics ported verbatim from the E2B reference adapter where they are
 * substrate-independent:
 *   - targetKey = remote realpath (stable across aliases)
 *   - version = hash of stat identity facts
 *   - LF-normalized before/after diff basis; CRLF detected and restored
 *   - editText: version check BEFORE literal match, both inside the
 *     per-target critical section (withLock)
 *
 * SSH-specific substitutions:
 *   - E2B stores a version id in file metadata; SFTP has no user metadata, so
 *     the version derives from `stat -c '%i %.9Y %s'` (inode, nanosecond
 *     mtime, size). rename() changes the inode, so every atomic replace yields
 *     a fresh version; nanoseconds make same-second rewrites distinguishable.
 *   - Atomic create uses `ln -T` (hard link publication: fails if the target
 *     exists) exactly like the E2B adapter; replace uses SFTP rename, which is
 *     POSIX rename(2) semantics under the hood.
 *
 * @module
 */

import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from './dsh-fs-types.ts'
import type { SFTPWrapper } from 'ssh2'
import { quoteShellArg } from '../../ssh-runtime/src/quote.ts'
import type { SshRuntime } from '../../ssh-runtime/src/index.ts'

const BINARY_SAMPLE_BYTES = 8192

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

function decodeText(bytes: Uint8Array, displayPath: string, binarySampleBytes: number): string {
  if (bytes.subarray(0, binarySampleBytes).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  }
  let matches = 0
  let offset = 0
  for (;;) {
    const found = content.indexOf(oldString, offset)
    if (found < 0) break
    matches += 1
    offset = found + oldString.length
  }
  if (matches === 0) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && matches !== 1) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}

interface StatFacts {
  readonly type: 'file' | 'directory' | 'symlink' | 'other'
  readonly size: number
  readonly mode: number
  readonly version: ReturnType<typeof FsVersion>
}

function mapControlError(error: unknown, operation: string, displayPath: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true) {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/permission denied|operation not permitted/i.test(message)) {
    return new FsError(`cannot ${operation} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${message}`, 'FS_IO_ERROR', { cause: error })
}

/** Promisified SFTP stat/lstat with NOENT mapped to undefined. */
async function sftpStat(
  sftp: SFTPWrapper,
  path: string,
  follow: boolean,
): Promise<StatFacts | undefined> {
  const op = follow ? 'stat' : 'lstat'
  return await new Promise<StatFacts | undefined>((resolve, reject) => {
    sftp[op](path, (error, stats) => {
      if (error !== undefined && error !== null) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT'
          || /no such file/i.test(String((error as Error).message))) {
          resolve(undefined)
          return
        }
        reject(error)
        return
      }
      if (stats === undefined) {
        reject(new Error(`sftp ${op} returned no stats for ${path}`))
        return
      }
      resolve(fromSftpStats(stats))
    })
  })
}

function fromSftpStats(stats: {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  size: number
  mode: number
  atime: number
  mtime: number
}): StatFacts {
  const type: StatFacts['type'] = stats.isDirectory()
    ? 'directory'
    : stats.isFile()
      ? 'file'
      : stats.isSymbolicLink()
        ? 'symlink'
        : 'other'
  // SFTP mtime is whole seconds; add atime as extra entropy. The authoritative
  // nanosecond version comes from the control-channel stat below when needed.
  const version = FsVersion(`ssh:${createHash('sha256').update(JSON.stringify([
    stats.size, stats.mode, stats.mtime, stats.atime,
  ])).digest('hex')}`)
  return { type, size: stats.size, mode: stats.mode, version }
}

/** Remote filesystem backend sharing the world owned by `ctx.ssh`. */
export class SshFileSystem extends FileSystem {
  static inject = ['ssh'] as const

  private readonly locks = new Map<string, Promise<unknown>>()

  private readonly runtime: SshRuntime

  constructor(ctx: Context, runtime: SshRuntime) {
    super(ctx)
    this.runtime = runtime
  }

  private get cwd(): string {
    return this.runtime.cwd
  }

  private async sftp(): Promise<SFTPWrapper> {
    const world = await this.runtime.getWorld()
    return await world.sftp.get()
  }

  override async resolve(
    path: string,
    opts?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.cwd, path)
    try {
      // realpath -m: canonicalizes without requiring existence. The control
      // channel's stdout framing carries the line verbatim; realpath -m output
      // cannot contain a newline.
      const canonical = await this.runtime.control(
        `realpath -m -- ${quoteShellArg(displayPath)}`,
        { signal: opts?.signal },
      )
      assertNotAborted(opts?.signal, 'resolve')
      return { targetKey: FsTargetKey(canonical.trim()), displayPath }
    } catch (error: unknown) {
      throw mapControlError(error, 'resolve', displayPath, opts?.signal)
    }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target)
    if (!posix.isAbsolute(path)) {
      throw new Error(`fs-ssh: expected an absolute process path: ${JSON.stringify(path)}`)
    }
    return `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const parentPath = String(parent.targetKey)
    const childPath = String(child.targetKey)
    if (parentPath === childPath) return true
    return childPath.startsWith(`${parentPath}/`)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, 'stat')
    try {
      const facts = await this.statFacts(String(target.targetKey), signal)
      if (facts === undefined) return undefined
      return {
        version: facts.version,
        type: facts.type === 'symlink' ? 'other' : facts.type,
        ...(facts.type === 'file' ? { size: facts.size } : {}),
      }
    } catch (error: unknown) {
      throw mapControlError(error, 'stat', target.displayPath, signal)
    }
  }

  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    const displayPath = posix.resolve(opts?.cwd ?? this.cwd, path)
    try {
      const sftp = await this.sftp()
      // lstat MUST NOT follow the final component — symlink detection depends
      // on it. SFTP lstat is exactly that.
      const facts = await sftpStat(sftp, displayPath, false)
      if (facts === undefined) return undefined
      return {
        version: facts.version,
        type: facts.type,
        ...(facts.type === 'file' ? { size: facts.size } : {}),
      }
    } catch (error: unknown) {
      throw mapControlError(error, 'lstat', displayPath, signal)
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const bytes = await this.readAll(target, signal, undefined)
    return decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const info = await this.stat(target, signal)
    if (info === undefined) {
      throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    }
    if (info.type !== 'file') {
      throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    // Whole-file read with a text-validated decode; chunking happens after the
    // cross-chunk decode validation. Large-file streaming can arrive later;
    // semantics match readText exactly.
    const bytes = await this.readAll(target, signal, undefined)
    const text = decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES)
    const self = this
    async function* chunks(): AsyncGenerator<string> {
      assertNotAborted(signal, 'stream')
      yield* self.splitIntoChunks(text)
    }
    return chunks()
  }

  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const info = await this.stat(target, signal)
    if (info === undefined) {
      throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    }
    if (info.type !== 'file') {
      throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(
        `cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes} byte limit`,
        'FS_TOO_LARGE',
      )
    }
    const bytes = await this.readAll(target, signal, maxBytes)
    if (bytes.byteLength > maxBytes) {
      throw new FsError(
        `cannot read "${target.displayPath}": content grew past the ${maxBytes} byte limit while reading`,
        'FS_TOO_LARGE',
      )
    }
    return bytes
  }

  override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(range.offset) || range.offset < 0
      || !Number.isSafeInteger(range.length) || range.length < 0) {
      throw new FsError('byte range offset and length must be non-negative integers', 'FS_IO_ERROR')
    }
    assertNotAborted(signal, 'read')
    const info = await this.stat(target, signal)
    if (info === undefined) {
      throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    }
    if (info.type !== 'file') {
      throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (range.length === 0 || (info.size !== undefined && range.offset >= info.size)) {
      return Buffer.alloc(0)
    }
    const sftp = await this.sftp()
    let handle: Buffer | undefined
    try {
      const openedHandle = await new Promise<Buffer>((resolve, reject) => {
        sftp.open(String(target.targetKey), 'r', (error, opened) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(opened)
        })
      })
      handle = openedHandle
      const result = Buffer.allocUnsafe(range.length)
      let written = 0
      while (written < range.length) {
        assertNotAborted(signal, 'read')
        const bytesRead = await new Promise<number>((resolve, reject) => {
          sftp.read(
            openedHandle,
            result,
            written,
            range.length - written,
            range.offset + written,
            (error, count) => {
              if (error !== undefined && error !== null) reject(error)
              else resolve(count)
            },
          )
        })
        if (bytesRead === 0) break
        written += bytesRead
      }
      return result.subarray(0, written)
    } catch (error: unknown) {
      throw mapControlError(error, 'read', target.displayPath, signal)
    } finally {
      const handleToClose = handle
      if (handleToClose !== undefined) {
        await new Promise<void>((resolve) => {
          sftp.close(handleToClose, () => { resolve() })
        })
      }
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    assertNotAborted(signal, 'list')
    try {
      const info = await this.stat(target, signal)
      if (info === undefined) {
        throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      if (info.type !== 'directory') {
        throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
      }
      const sftp = await this.sftp()
      const names = await new Promise<string[]>((resolve, reject) => {
        sftp.readdir(String(target.targetKey), (error, list) => {
          if (error !== undefined && error !== null) reject(error)
          else resolve(list.map(entry => entry.filename))
        })
      })
      const entries: FsDirEntry[] = []
      // readdir order is unspecified; the contract demands stable name order.
      // localeCompare over sorted names, like the E2B adapter.
      for (const name of names.sort((left, right) => left.localeCompare(right))) {
        if (name === '.' || name === '..') continue
        const childPath = posix.join(String(target.targetKey), name)
        const facts = await sftpStat(sftp, childPath, true)
        entries.push({
          name,
          type: facts === undefined || facts.type === 'symlink' ? 'other' : facts.type,
          target: { targetKey: FsTargetKey(childPath), displayPath: posix.join(target.displayPath, name) },
          ...(facts?.type === 'file' ? { size: facts.size, version: facts.version } : {}),
        })
      }
      return entries
    } catch (error: unknown) {
      throw mapControlError(error, 'list', target.displayPath, signal)
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return await this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing !== undefined && existing.type !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(existing, expected, target)
      const before = existing === undefined ? null : await this.readForDiff(target, signal)
      const version = await this.writeAtomic(target, content, existing, expected?.kind === 'createIfAbsent', signal)
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return await this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, signal)
      if (existing === undefined) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (existing.type !== 'file') {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      // Version guard BEFORE literal match — stale reports FS_STALE_VERSION,
      // never FS_EDIT_NOT_FOUND.
      if (expected !== undefined && existing.version !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readAll(target, signal, undefined)
      const before = normalizeLineEndings(decodeText(raw, target.displayPath, BINARY_SAMPLE_BYTES))
      const after = literalEdit(before, edit, target.displayPath)
      const storage = restoreLineEndings(after, detectsCrlf(decodeText(raw, target.displayPath, BINARY_SAMPLE_BYTES)))
      const version = await this.writeAtomic(target, storage, existing, false, signal)
      return { version, before, after }
    })
  }

  // ---------------------------------------------------------------- helpers

  private *splitIntoChunks(text: string, size = 64 * 1024): Generator<string> {
    for (let offset = 0; offset < text.length; offset += size) {
      yield text.slice(offset, offset + size)
    }
  }

  /**
   * Authoritative stat facts with the nanosecond version: `stat -c` over the
   * control channel. Falls back to SFTP stats (second-granularity) only for
   * the type probe when the control plane is uninteresting — callers that
   * compare versions always come through here.
   */
  private async statFacts(path: string, signal?: AbortSignal): Promise<StatFacts | undefined> {
    assertNotAborted(signal, 'stat')
    try {
      // %i inode, %.9Y mtime ns, %s size, %f raw mode, %F type string
      const out = await this.runtime.control(
        `stat -c '%i|%.9Y|%s|%f|%F' -- ${quoteShellArg(path)} 2>/dev/null || printf absent`,
        { signal },
      )
      if (out.trim() === 'absent') return undefined
      const [inode, mtimeNs, size, modeHex, typeString] = out.trim().split('|')
      const version = FsVersion(`ssh:${createHash('sha256').update(
        JSON.stringify([inode, mtimeNs, size, modeHex]),
      ).digest('hex')}`)
      const type: StatFacts['type'] = typeString.startsWith('directory')
        ? 'directory'
        : typeString.startsWith('regular file')
          ? 'file'
          : typeString.startsWith('symbolic link')
            ? 'symlink'
            : 'other'
      return { type, size: Number(size), mode: Number.parseInt(modeHex, 16), version }
    } catch (error: unknown) {
      throw mapControlError(error, 'stat', path, signal)
    }
  }

  private async probe(path: string, displayPath: string, signal?: AbortSignal): Promise<StatFacts | undefined> {
    return await this.statFacts(path, signal)
  }

  private checkWriteIntent(
    existing: StatFacts | undefined,
    expected: FsWriteIntent | undefined,
    target: FsTarget,
  ): void {
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined || existing.version !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    }
  }

  private async readForDiff(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      const bytes = await this.readAll(target, signal, undefined)
      return normalizeLineEndings(decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES))
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw error
    }
  }

  /** Full read over SFTP with no cap (size-checked by callers where needed). */
  private async readAll(target: FsTarget, signal: AbortSignal | undefined, _maxBytes: number | undefined): Promise<Uint8Array> {
    assertNotAborted(signal, 'read')
    const sftp = await this.sftp()
    return await new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Buffer[] = []
      const stream = sftp.createReadStream(String(target.targetKey))
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('error', (error: Error) => reject(mapControlError(error, 'read', target.displayPath, signal)))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('close', () => {
        // 'close' after 'end' with no error means complete.
      })
    })
  }

  /**
   * Atomic write: staging file in the SAME directory (same filesystem, so
   * rename never crosses devices), then either `ln -T` publication (guarded
   * create — fails if the target exists) or SFTP rename (replace).
   */
  private async writeAtomic(
    target: FsTarget,
    content: string,
    existing: StatFacts | undefined,
    createIfAbsent: boolean,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof FsVersion>> {
    assertNotAborted(signal, 'write')
    const targetPath = String(target.targetKey)
    const temporary = posix.join(posix.dirname(targetPath), `.dsh-${randomUUID()}.tmp`)
    let staged = false
    try {
      const sftp = await this.sftp()
      await this.writeSftpFile(sftp, temporary, content)
      staged = true
      // Preserve the original mode on replace; 600 for creates.
      const mode = existing === undefined ? 0o600 : existing.mode & 0o777
      await this.runtime.control(`chmod ${mode.toString(8)} -- ${quoteShellArg(temporary)}`, { signal })
      assertNotAborted(signal, 'write')
      if (createIfAbsent) {
        const targetArg = quoteShellArg(targetPath)
        const publication = await this.runtime.control(
          `if ln -T -- ${quoteShellArg(temporary)} ${targetArg}; then printf created; elif test -e ${targetArg} || test -L ${targetArg}; then printf exists; else exit 1; fi`,
          { signal },
        )
        if (publication.trim() === 'exists') {
          throw new FsError(
            `cannot overwrite existing "${target.displayPath}" without reading it first`,
            'FS_NOT_OBSERVED',
          )
        }
      } else {
        await new Promise<void>((resolve, reject) => {
          sftp.rename(temporary, targetPath, (error) => {
            if (error !== undefined && error !== null) reject(error)
            else resolve()
          })
        })
      }
      // Post-write version: the authoritative nanosecond stat.
      const facts = await this.statFacts(targetPath, signal)
      if (facts === undefined) throw new Error('fs-ssh: written target absent after publication')
      return facts.version
    } catch (error: unknown) {
      if (staged) {
        try {
          await this.runtime.control(`rm -f -- ${quoteShellArg(temporary)}`, { signal: undefined })
        } catch { /* best effort */ }
      }
      throw mapControlError(error, 'write', target.displayPath, signal)
    }
  }

  private writeSftpFile(sftp: SFTPWrapper, path: string, content: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(path)
      stream.on('error', reject)
      stream.on('close', () => resolve())
      stream.end(Buffer.from(content, 'utf8'))
    })
  }

  private async withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }
}

export default SshFileSystem
