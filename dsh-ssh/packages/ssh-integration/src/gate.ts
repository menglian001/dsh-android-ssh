/**
 * The fail-closed execution gate.
 *
 * Every model-driven tool execution crosses the official tools registry; the
 * gate registers one *monotonic guard* there — the registry's own mechanism
 * for policies that may only deny: no later listener can turn a denial back
 * into permission, and no guard can force-allow. Its two rules are the
 * product's security boundary for conversation continuity:
 *
 * 1. NOT CONNECTED FAILS CLOSED. While the shared SSH world is not
 *    `connected`, every agent-scoped execution is denied with the stable code
 *    `ssh/not-connected`. No execution ever falls back to the phone.
 *
 * 2. ANOTHER SERVER IS READ-ONLY. An Agent is bound, at creation (or lazily
 *    on first execution for resumed sessions), to the server four-tuple it
 *    was born under: host, port, username, cwd. When the live identity no
 *    longer matches — the user switched server or remote directory — the
 *    Agent's executions are denied with `ssh/world-changed`. The old
 *    conversation stays readable; it can no longer act.
 *
 * A reconnect over the SAME four-tuple is not a switch: the world's
 * generation may advance (the runtime swaps the whole world atomically), but
 * the identity did not change, so live conversations keep executing. Deny
 * reasons carry stable codes only — never a configured host, user or path.
 *
 * The gate reads the world through one narrow subscription, the identity
 * through the settings source, and registers through the tools registry's
 * guard face — so it composes without importing transport types.
 *
 * @module @local/dsh-ssh-integration/gate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SshSettings, SshSettingsSource } from './settings.ts'

/** The execution-world state the gate watches; a projection of ReconnectState. */
export interface GateWorldState {
  /** The runtime's committed state kind (`connected`, `reconnecting`, …). */
  readonly kind: string
  /** The world's generation; advances on every whole-world swap. */
  readonly generation: number
}

/** The shared SSH world the gate watches, as one narrow subscription. */
export interface GateWorld {
  /** Observe world state replacements; invoked once with the current state. */
  subscribe(listener: (state: GateWorldState) => void): () => void
}

/** The tools registry's monotonic guard face (see `tools.guard()`). */
export interface ToolsGuardFace {
  /**
   * Register one synchronous guard: a returned string denies the execution.
   * @param guard - the check; a reason string denies, undefined allows.
   * @returns the exact disposer that unregisters the guard.
   */
  guard(guard: (exec: { agent?: { id: string } }) => string | undefined): () => void
}

/** The server identity one Agent is bound to. */
interface WorldBinding {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly cwd: string
}

/** The identity the settings currently name, or undefined while unconfigured. */
function identityOf(settings: SshSettings): WorldBinding | undefined {
  if (settings.host === '' || settings.username === '') return undefined
  return {
    host: settings.host,
    port: settings.port,
    username: settings.username,
    cwd: settings.cwd,
  }
}

/** The minimal agent face the gate keys on. */
interface AgentFace {
  readonly id: string
}

/** The deny reason for a world that is not connected. */
const NOT_CONNECTED = 'ssh/not-connected: the SSH world is not connected; connect it before running anything'

/** The deny reason for an execution outside the conversation's world. */
const WORLD_CHANGED = 'ssh/world-changed: this conversation belongs to another server or directory and is read-only'

/**
 * Bind Agents to execution worlds and deny executions that cross the line.
 */
export class SshExecutionGate {
  private readonly bindings = new Map<string, WorldBinding>()
  private readonly settings: SshSettingsSource
  private state: GateWorldState = { kind: 'disconnected', generation: 0 }

  /**
   * @param ctx - host context; the gate listens for `agent/created`.
   * @param world - the shared SSH world's state subscription.
   * @param settings - the authoritative `ssh-remote` section source.
   * @param tools - the tools registry's guard face.
   */
  constructor(
    ctx: Context,
    world: GateWorld,
    settings: SshSettingsSource,
    tools: ToolsGuardFace,
  ) {
    this.settings = settings
    world.subscribe((state) => { this.state = state })

    // agent/created carries official payload types this module does not
    // import; the bridge below keeps the registration typed at the call site.
    const on = ctx.on.bind(ctx) as unknown as (
      name: string, handler: (payload: never) => unknown,
    ) => void
    on('agent/created', (({ agent }: { agent: AgentFace }) => {
      // Bind at birth to the identity named right now — connected or not. An
      // agent born while unconfigured binds to `undefined` and re-binds on
      // its first execution, which is what a pre-configuration conversation
      // should do.
      this.bindings.set(agent.id, identityOf(this.settings.read())!)
    }) as (payload: never) => void)

    tools.guard(exec => this.reasonFor(exec))
  }

  /**
   * The monotonic denial reason for one execution, or undefined to allow.
   *
   * @param exec - the pending call; `agent` is set by the agent loop.
   * @returns a stable deny reason, or undefined.
   */
  private reasonFor(exec: { agent?: AgentFace }): string | undefined {
    if (exec?.agent === undefined) return undefined
    let binding = this.bindings.get(exec.agent.id)
    if (binding === undefined) {
      // A resumed session with no recorded binding: bind lazily to the
      // current identity. History viewing is unaffected either way.
      binding = identityOf(this.settings.read())!
      if (binding === undefined) return undefined
      this.bindings.set(exec.agent.id, binding)
    }
    if (this.state.kind !== 'connected') return NOT_CONNECTED
    const live = identityOf(this.settings.read())
    if (live === undefined
      || live.host !== binding.host || live.port !== binding.port
      || live.username !== binding.username || live.cwd !== binding.cwd) {
      return WORLD_CHANGED
    }
    return undefined
  }
}
