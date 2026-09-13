import { posix } from 'node:path'
import type {
  SubprocessSpawnSpec,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

const MAX_TIMER_DELAY_MS = 2_147_483_000
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

export function validateSpawnSpec(spec: SubprocessSpawnSpec): void {
  validateCommon(spec)
  spec.signal?.throwIfAborted()
}

export function validateTerminalSpec(spec: SubprocessTerminalSpawnSpec): void {
  validateCommon(spec)
  if (!Number.isSafeInteger(spec.rows) || spec.rows < 1) {
    throw new Error(`terminal rows must be a positive integer: ${spec.rows}`)
  }
  if (!Number.isSafeInteger(spec.cols) || spec.cols < 1) {
    throw new Error(`terminal cols must be a positive integer: ${spec.cols}`)
  }
  spec.signal?.throwIfAborted()
}

function validateCommon(spec: {
  argv: readonly string[]
  cwd: string
  graceMs: number
  env?: Readonly<Record<string, string | undefined>>
}): void {
  const program = spec.argv[0]
  if (program === undefined || program.length === 0) {
    throw new Error('argv must contain a non-empty program')
  }
  if (!posix.isAbsolute(spec.cwd)) {
    throw new Error(`cwd must be an absolute Linux path: ${spec.cwd}`)
  }
  if (!Number.isSafeInteger(spec.graceMs)
    || spec.graceMs <= 0
    || spec.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`graceMs out of range: ${spec.graceMs}`)
  }
  for (const [name, value] of Object.entries(spec.env ?? {})) {
    if (!ENV_NAME.test(name)) throw new Error(`invalid environment name: ${JSON.stringify(name)}`)
    if (value !== undefined && value.includes('\0')) {
      throw new Error(`invalid environment value for ${name}: NUL is not allowed`)
    }
  }
}
