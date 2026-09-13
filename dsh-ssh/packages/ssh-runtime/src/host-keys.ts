import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface HostKeyIdentity {
  readonly host: string
  readonly port: number
  readonly algorithm: string
  readonly fingerprint: string
}

export type HostKeyDecision =
  | { readonly kind: 'trusted'; readonly actual: HostKeyIdentity }
  | { readonly kind: 'trust-required'; readonly actual: HostKeyIdentity }
  | {
    readonly kind: 'changed'
    readonly expected: HostKeyIdentity
    readonly actual: HostKeyIdentity
  }

interface HostKeyFile {
  readonly version: 1
  readonly hosts: HostKeyIdentity[]
}

export function fingerprintHostKey(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
}

export function identifyHostKey(host: string, port: number, key: Buffer): HostKeyIdentity {
  return {
    host: normalizeHost(host),
    port: normalizePort(port),
    algorithm: readSshString(key),
    fingerprint: fingerprintHostKey(key),
  }
}

export class HostKeyStore {
  readonly path: string
  private writeChain: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  async check(host: string, port: number, key: Buffer): Promise<HostKeyDecision> {
    await this.writeChain
    const actual = identifyHostKey(host, port, key)
    const file = await this.load()
    const expected = file.hosts.find(item => sameEndpoint(item, actual))
    if (expected === undefined) return { kind: 'trust-required', actual }
    if (expected.algorithm === actual.algorithm && expected.fingerprint === actual.fingerprint) {
      return { kind: 'trusted', actual }
    }
    return { kind: 'changed', expected, actual }
  }

  async trust(identity: HostKeyIdentity): Promise<void> {
    const normalized = normalizeIdentity(identity)
    const operation = this.writeChain.then(async () => {
      const file = await this.load()
      const expected = file.hosts.find(item => sameEndpoint(item, normalized))
      if (expected !== undefined) {
        if (expected.algorithm === normalized.algorithm
          && expected.fingerprint === normalized.fingerprint) return
        throw new Error('remove the existing trusted host key first')
      }
      await this.save({ version: 1, hosts: [...file.hosts, normalized] })
    })
    this.writeChain = operation.catch(() => {})
    await operation
  }

  async clear(host: string, port: number): Promise<void> {
    const endpoint = { host: normalizeHost(host), port: normalizePort(port) }
    const operation = this.writeChain.then(async () => {
      const file = await this.load()
      const hosts = file.hosts.filter(item => !sameEndpoint(item, endpoint))
      if (hosts.length !== file.hosts.length) await this.save({ version: 1, hosts })
    })
    this.writeChain = operation.catch(() => {})
    await operation
  }

  private async load(): Promise<HostKeyFile> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return { version: 1, hosts: [] }
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    if (!isHostKeyFile(parsed)) throw new Error('invalid trusted host key file')
    return {
      version: 1,
      hosts: parsed.hosts.map(normalizeIdentity),
    }
  }

  private async save(file: HostKeyFile): Promise<void> {
    const parent = dirname(this.path)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(file, undefined, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      await rename(temporary, this.path)
      await chmod(this.path, 0o600)
    } catch (error: unknown) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }
}

function readSshString(key: Buffer): string {
  if (key.length < 5) throw new Error('invalid SSH host key')
  const length = key.readUInt32BE(0)
  if (length === 0 || length > key.length - 4) throw new Error('invalid SSH host key')
  const algorithm = key.subarray(4, 4 + length).toString('ascii')
  if (!/^[a-z0-9@._+-]+$/iu.test(algorithm)) throw new Error('invalid SSH host key algorithm')
  return algorithm
}

function normalizeIdentity(identity: HostKeyIdentity): HostKeyIdentity {
  const algorithm = identity.algorithm.trim()
  const fingerprint = identity.fingerprint.trim()
  if (algorithm.length === 0 || !/^SHA256:[A-Za-z0-9+/]+$/u.test(fingerprint)) {
    throw new Error('invalid trusted host key identity')
  }
  return {
    host: normalizeHost(identity.host),
    port: normalizePort(identity.port),
    algorithm,
    fingerprint,
  }
}

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase()
  if (normalized.length === 0) throw new Error('SSH host must not be blank')
  return normalized
}

function normalizePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SSH port must be an integer from 1 to 65535')
  }
  return port
}

function sameEndpoint(
  left: Pick<HostKeyIdentity, 'host' | 'port'>,
  right: Pick<HostKeyIdentity, 'host' | 'port'>,
): boolean {
  return left.host === right.host && left.port === right.port
}

function isHostKeyFile(value: unknown): value is HostKeyFile {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { version?: unknown; hosts?: unknown }
  return candidate.version === 1
    && Array.isArray(candidate.hosts)
    && candidate.hosts.every(item => {
      if (typeof item !== 'object' || item === null) return false
      const row = item as Record<string, unknown>
      return typeof row.host === 'string'
        && typeof row.port === 'number'
        && typeof row.algorithm === 'string'
        && typeof row.fingerprint === 'string'
    })
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
