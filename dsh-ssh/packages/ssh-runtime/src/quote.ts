/**
 * Shell argument quoting for the remote POSIX world.
 *
 * Unlike the E2B adapter, an SSH `exec` request carries a single command
 * string with no argv vector alternative, so every opaque value MUST be
 * quoted here. There is no escape hatch.
 *
 * @module
 */

/**
 * Quote one opaque argument into a single shell word.
 *
 * Single quotes suppress all interpolation; an embedded single quote is
 * emitted as `'"'"'` (close, quoted-quote, reopen), which is the only
 * POSIX-portable spelling.
 *
 * @param value - Exact argument value to preserve byte for byte.
 * @returns A single shell word that expands to exactly `value`.
 */
export function quoteShellArg(value: string): string {
  return `'${value.replaceAll('\'', '\'"\'"\'')}'`
}

/**
 * Quote an argv vector into a space-joined command string.
 *
 * @param argv - Arguments to quote; the first entry is the executable.
 * @returns A command string safe to hand to a remote shell.
 */
export function quoteShellArgv(argv: readonly string[]): string {
  return argv.map(quoteShellArg).join(' ')
}
