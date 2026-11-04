/**
 * Assignee routing: which executor a ticket goes to, and the P0 shadow record of what routing would decide.
 *
 * The configuration lives in its own KV key rather than in `SettingsSchema` on purpose: that schema is
 * `.strict()`, so a build that added a field there would make an older build fail to parse the settings it
 * reads at startup. `ticket.value` and `decision.value` are raw JSON, so runtime fields stay ignorable.
 * Rolling back is therefore a flag or nothing at all, never a migration.
 */
import { z } from 'zod'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import { RoleModelSchema } from '../policy.ts'

/** The kind of change a request actually asks for, judged from the request itself, not from its wording. */
export const WORK_TYPES = ['copy', 'visual', 'bugfix', 'refactor', 'test', 'docs', 'infra', 'review', 'other'] as const
export type WorkType = typeof WORK_TYPES[number]
export const WorkTypeSchema = z.enum(WORK_TYPES)

/** One executor a ticket can be assigned to. `"*"` in `skills` or `scopes` matches everything, as the default agent does. */
export const AgentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  /** DSH agent preset the worker Session is created with; omitted keeps the built-in worker preset. */
  preset: z.string().min(1).optional(),
  /** Model the worker Session starts with; `null` or omitted keeps `settings.executor.model`. */
  model: RoleModelSchema.nullable().optional(),
  skills: z.array(z.string().min(1)).min(1),
  scopes: z.array(z.string().min(1)).min(1),
  concurrency: z.number().int().min(1).max(16),
  cost: z.enum(['low', 'mid', 'high']),
}).strict()
export type Agent = z.infer<typeof AgentSchema>

/** The stored routing configuration; `version` lets a later build read an older record and migrate it in code. */
export const AssigneesConfigSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  agents: z.array(AgentSchema).min(1),
}).strict()
export type AssigneesConfig = z.infer<typeof AssigneesConfigSchema>

/** The behaviour before routing existed: one worker, one model, every work type. */
export const DEFAULT_CONFIG: AssigneesConfig = {
  version: 1, enabled: false,
  agents: [{ id: 'default-worker', preset: 'dsh-superagent-worker', model: null, skills: ['*'], scopes: ['*'], concurrency: 2, cost: 'mid' }],
}

/** A fresh copy of the default, so a caller editing what it read cannot change later reads. */
const defaultConfig = (): AssigneesConfig => structuredClone(DEFAULT_CONFIG)

/**
 * Why `suggest` did not pick a specialist. A fallback still names an agent that exists in the roster,
 * chosen by `fallbackAgent`.
 */
export type Fallback = 'single' | 'noCapability' | 'lowConfidence' | 'handedBack'

/** Why a fallback chose the agent it names, in the order the roster is searched. */
type FallbackReason = 'default-worker' | 'first-wildcard' | 'first-agent'

/**
 * Choose the agent a fallback names from the roster itself. The id `default-worker` is only the first
 * choice, never an assumption: a roster the user configured may not contain it, and a shadow record
 * naming an absent agent would defer the mistake to launch time.
 */
function fallbackAgent(config: AssigneesConfig): { agent: Agent; reason: FallbackReason } {
  const preferred = config.agents.find(agent => agent.id === 'default-worker')
  if (preferred) return { agent: preferred, reason: 'default-worker' }
  // A wildcard skill can take any work type, so it is the closest thing to the old default agent.
  const wildcard = config.agents.find(agent => agent.skills.includes('*'))
  if (wildcard) return { agent: wildcard, reason: 'first-wildcard' }
  // The schema requires at least one agent, so a parsed configuration always has a first one.
  return { agent: config.agents[0]!, reason: 'first-agent' }
}

/** What routing would do for one ticket, with the evidence that decided it. */
export interface Suggestion {
  assignee: string
  score: number
  evidence: string[]
  fallback?: Fallback
}

/** A routing decision recorded while routing is not in effect, so an operator can judge it before enabling it. */
export interface ShadowRecord {
  at: string
  decisionId: string
  ticketId?: string
  workType: WorkType | null
  suggestion: Suggestion
  enabled: boolean
}

/** Read the stored configuration, falling back to the single default agent when it is absent or unreadable. */
export function loadConfig(store: Pick<Store, 'get'>): { config: AssigneesConfig; error?: string } {
  const stored = store.get(KV.assignees.config)
  if (stored === undefined) return { config: defaultConfig() }
  const parsed = AssigneesConfigSchema.safeParse(stored)
  // A broken configuration must not block startup: keep today's behaviour and report why.
  if (!parsed.success) return { config: defaultConfig(), error: parsed.error.issues[0]?.message ?? 'invalid' }
  return { config: parsed.data }
}

/** Whether `agent` may take `workType` and this `repo`. */
const covers = (agent: Agent, workType: WorkType, repo: string | undefined): boolean =>
  (agent.skills.includes('*') || agent.skills.includes(workType)) && (agent.scopes.includes('*') || (repo !== undefined && agent.scopes.includes(repo)))

/** Score per cost tier, before `WEIGHTS.cost` scales it. */
const COST_SCORE: Record<Agent['cost'], number> = { low: 1, mid: 0.5, high: 0 }

/** A success rate is a fraction in [0, 1]: clamp a caller's out-of-range value, and treat a non-finite one as no history. */
const clampRate = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0)

/**
 * Weights for the four signals `suggest` ranks on. They only order candidates that already passed the
 * capability, scope and capacity filters, so tuning them changes routing preference, never eligibility.
 * The values are relative to each other; their weighted sum is compared against the absolute `MIN_SCORE`.
 */
const WEIGHTS = {
  /**
   * Capability dominates. A candidate that names the work type scores 1 (3 points); the wildcard agent
   * scores 0.25 (0.75 points), so the specialist leads by 2.25 points before load, cost or history.
   * Raising this makes capability matter even more; lowering it lets a wildcard agent compete for work
   * a specialist already covers.
   */
  skills: 3,
  /**
   * Free capacity, as the idle fraction of the agent's slots. A fully idle agent gains 2 points over a
   * saturated one, but saturated agents are filtered out before scoring, so the real contribution is
   * (0, 2]. Raising this lets load outweigh a capability gap; lowering it makes routing ignore load
   * until an agent is full.
   */
  free: 2,
  /**
   * Cost tie-break, scaled by `COST_SCORE` (low 1, mid 0.5, high 0). At 1 it can separate otherwise
   * equal agents but stays below the 2.25-point specialist advantage. Raising it starts trading
   * capability for cheapness; lowering it leaves history as the main tie-break.
   */
  cost: 1,
  /**
   * Historical success rate, in [0, 1]. At 0.5 it contributes at most half a point, so it refines
   * near-ties without overriding capability or capacity. Raising it lets past outcomes steer routing
   * strongly enough to overcome cost; lowering it reduces history to a last-resort tie-break.
   */
  history: 0.5,
} as const

/**
 * Confidence floor for assigning a candidate instead of falling back. A candidate that names the work type
 * clears it on capability alone (3 points); a wildcard candidate starts at 0.75 and needs at least 1.25 more
 * from load, cost and history. Raising it makes routing more conservative: above 3 it also rejects a
 * specialist that is nearly full, expensive and without history, because only those three can lift its base
 * score higher; lowering it routes to weaker matches.
 */
const MIN_SCORE = 2

/**
 * Choose an executor for one work type. Hard-filter on capability, repository scope and free slots, then rank
 * the survivors by the weighted sum of the four signals in `WEIGHTS`: capability 3, free capacity 2, cost 1
 * and history 0.5. A candidate that names the work type therefore leads a wildcard agent by 2.25 points
 * before load, cost and history, and a perfect score is 6.5. A lone qualifier is returned without ranking;
 * otherwise the best score is used only if it reaches `MIN_SCORE` (2), which capability alone clears for a
 * specialist, while a wildcard candidate needs 1.25 more from load, cost or history. Cases where ranking
 * cannot pick a specialist fall back to an agent that exists in the roster rather than failing, so a ticket
 * never waits on a routing decision; `Suggestion.fallback` records which rule chose the fallback.
 * @param load - how many tickets each agent already holds, by agent id; an agent at its `concurrency` is skipped.
 * @param repo - the repository the work is in, matched against each agent's `scopes`.
 * @param history - an optional success rate per agent for this work type; a value outside [0, 1] is clamped to that range.
 */
export function suggest(workType: WorkType | null, config: AssigneesConfig, load: ReadonlyMap<string, number> = new Map(),
  repo: string | undefined = undefined, history: (agent: string) => number = () => 0): Suggestion {
  const fallback = (kind: Fallback): Suggestion => {
    const { agent, reason } = fallbackAgent(config)
    return { assignee: agent.id, score: 0, evidence: [`fallback:${reason}`, `agent:${agent.id}`], fallback: kind }
  }
  // Without a work type nothing can be matched: record that, so the shadow run measures coverage.
  if (workType === null) return fallback('lowConfidence')
  const candidates = config.agents.filter(agent => covers(agent, workType, repo) && (load.get(agent.id) ?? 0) < agent.concurrency)
  if (candidates.length === 0) return fallback('noCapability')
  if (candidates.length === 1) return { assignee: candidates[0]!.id, score: 0, evidence: [`only:${candidates[0]!.id}`], fallback: 'single' }
  const scored = candidates.map(agent => {
    // A wildcard agent can take anything, but it is the fallback rather than the best match: score it below
    // any agent that names this work type, so adding a specialist is enough to start routing to it. An agent
    // that lists both still earns its explicit hit, so the wildcard only fills in when nothing names the type.
    const explicit = Math.min(1, agent.skills.filter(skill => skill === workType).length)
    const skills = Math.max(agent.skills.includes('*') ? 0.25 : 0, explicit)
    const free = 1 - (load.get(agent.id) ?? 0) / agent.concurrency
    // `history` is a rate, but the caller is not trusted: an unbounded value would outweigh capability and
    // capacity and could turn a weak match into a confident one.
    const score = WEIGHTS.skills * skills + WEIGHTS.free * free + WEIGHTS.cost * COST_SCORE[agent.cost]
      + WEIGHTS.history * clampRate(history(agent.id))
    return { agent, score, free }
  }).sort((left, right) => right.score - left.score)
  const best = scored[0]!
  // A specialist that barely beats the default is not worth a separate executor; the caller sees why.
  if (best.score < MIN_SCORE) return fallback('lowConfidence')
  return { assignee: best.agent.id, score: Number(best.score.toFixed(3)),
    evidence: [`skill:${best.agent.skills.join('|')}`, `free:${best.free.toFixed(2)}`, `cost:${best.agent.cost}`] }
}

/**
 * How many recent shadow records to keep. The record is an audit aid for judging routing before enabling it, so a
 * bounded window of recent decisions is enough; pruning the oldest keeps the KV from growing without bound. It must
 * stay comfortably larger than the volume an operator reviews at once, and small enough that storage is trivial.
 */
export const SHADOW_KEEP = 100

/**
 * Delete the oldest shadow records beyond `SHADOW_KEEP`, keeping the most recent by their `at` timestamp. Best-effort:
 * a record without a readable `at` sorts as the oldest. Reading is unaffected because only the newest records are kept,
 * and the record just written by `recordShadow` is the newest of all, so it is never removed by the prune that follows.
 */
function pruneShadow(store: Pick<Store, 'get' | 'keys' | 'delete'>): void {
  const keys = store.keys(KV.assignees.shadow)
  if (keys.length <= SHADOW_KEEP) return
  const prefix = KV.assignees.shadow.prefix
  const byAge = keys.map(key => {
    const record = store.get(KV.assignees.shadow(key.slice(prefix.length))) as ShadowRecord | undefined
    return { key, at: record?.at ?? '' }
  }).sort((left, right) => left.at.localeCompare(right.at))
  for (const { key } of byAge.slice(0, byAge.length - SHADOW_KEEP)) store.delete(key)
}

/**
 * Record what routing would have decided for an accepted ticket, without changing what happens to it.
 * Writes one KV entry per decision, then prunes the oldest shadow records beyond `SHADOW_KEEP`; nothing reads them back into the work path.
 */
export function recordShadow(store: Pick<Store, 'get' | 'set' | 'keys' | 'delete'>, input: { decisionId: string; ticketId?: string; workType: WorkType | null
  /** The repository the work is in, so a roster scoped to one repository is judged against it. */
  repo?: string; now?: Date }): ShadowRecord {
  const { config } = loadConfig(store)
  const record: ShadowRecord = { at: (input.now ?? new Date()).toISOString(), decisionId: input.decisionId,
    ...(input.ticketId ? { ticketId: input.ticketId } : {}), workType: input.workType,
    suggestion: suggest(input.workType, config, new Map(), input.repo), enabled: config.enabled }
  store.set(KV.assignees.shadow(input.decisionId), record)
  pruneShadow(store)
  return record
}

/**
 * The agent a ticket's `execution.assignee` names, or `undefined` when it names none or the configuration no longer
 * has it (an agent the operator removed while its tickets were still running). The caller then keeps today's worker.
 */
export function assignedAgent(store: Pick<Store, 'get'>, assignee: string | undefined): Agent | undefined {
  if (!assignee) return undefined
  return loadConfig(store).config.agents.find(agent => agent.id === assignee)
}

/** Read a recorded shadow decision, for the panel and for tests. */
export function readShadow(store: Pick<Store, 'get'>, decisionId: string): ShadowRecord | undefined {
  // The key is untyped in `KV` so this module stays the only place that spells the record: read it back as one.
  return store.get(KV.assignees.shadow(decisionId)) as ShadowRecord | undefined
}
