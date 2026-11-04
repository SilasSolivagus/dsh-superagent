import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { DEFAULT_CONFIG, loadConfig, readShadow, recordShadow, suggest, type AssigneesConfig } from '../src/app/assignees.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-assignees-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const agent = (id: string, extra: Partial<AssigneesConfig['agents'][number]> = {}) => ({
  id, skills: ['*'], scopes: ['*'], concurrency: 2, cost: 'mid' as const, ...extra,
})
const config = (agents: AssigneesConfig['agents'], enabled = false): AssigneesConfig => ({ version: 1, enabled, agents })

it('falls back to the single default agent when the stored configuration is absent or unreadable', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  // Absent: today's behaviour, and no error.
  expect(loadConfig(store)).toEqual({ config: DEFAULT_CONFIG })
  expect(loadConfig(store).config.enabled).toBe(false)
  // Unreadable: keep working rather than block startup, and say why.
  store.set(KV.assignees.config, { version: 1, enabled: 'yes', agents: [] })
  const broken = loadConfig(store)
  expect(broken.config).toEqual(DEFAULT_CONFIG)
  expect(broken.error).toBeTruthy()
})

it('returns a copy of the default, so a caller cannot change what a later loadConfig() returns', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const first = loadConfig(store).config
  first.enabled = true
  first.agents[0]!.id = 'mutated'
  first.agents[0]!.skills.push('visual')
  // The default itself is untouched, and the next read of an absent configuration is its original value.
  expect(DEFAULT_CONFIG.enabled).toBe(false)
  expect(DEFAULT_CONFIG.agents[0]).toMatchObject({ id: 'default-worker', skills: ['*'] })
  expect(loadConfig(store)).toEqual({ config: DEFAULT_CONFIG })
  // The unreadable fallback is a copy too: editing it must not leak into its own next read.
  store.set(KV.assignees.config, { version: 1, enabled: 'yes', agents: [] })
  const broken = loadConfig(store)
  broken.config.enabled = true
  broken.config.agents[0]!.skills.push('visual')
  expect(loadConfig(store).config).toEqual(DEFAULT_CONFIG)
})

it('falls back to the default configuration when the stored record has an unknown version', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  // A record written by a later build: every field is valid, but this build only knows version 1.
  store.set(KV.assignees.config, { version: 2, enabled: true, agents: [agent('default-worker')] })
  // A version we cannot read must not block startup, so loading it must not throw.
  const load = () => loadConfig(store)
  expect(load).not.toThrow()
  const loaded = load()
  expect(loaded.config).toEqual(DEFAULT_CONFIG)
  // Routing stays off: an unreadable configuration must never be taken as an opt-in.
  expect(loaded.config.enabled).toBe(false)
  expect(loaded.error).toBeTruthy()
})

it('records the configuration under its own key, never inside settings', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.set(KV.assignees.config, config([agent('default-worker'), agent('ui', { skills: ['visual'] })], true))
  expect(loadConfig(store).config.agents).toHaveLength(2)
  // A settings snapshot that never mentions assignees still parses: the feature is invisible to older builds.
  expect(JSON.stringify(store.settings())).not.toContain('assignees')
})

it('names the default agent when nothing can be matched', () => {
  const cfg = config([agent('default-worker'), agent('migration', { skills: ['refactor'] })])
  expect(suggest(null, cfg).assignee).toBe('default-worker')
  expect(suggest(null, cfg).fallback).toBe('lowConfidence')
  // The wildcard default agent can take anything, so an uncovered work type still resolves to it.
  expect(suggest('docs', cfg)).toEqual({ assignee: 'default-worker', score: 0, evidence: ['only:default-worker'], fallback: 'single' })
  // Without a wildcard, an uncovered work type has no capability at all.
  const specialistOnly = config([agent('ui', { skills: ['visual'] })])
  expect(suggest('docs', specialistOnly).fallback).toBe('noCapability')
})

it('picks a single qualified agent without ranking', () => {
  const cfg = config([agent('ui', { skills: ['visual'] }), agent('migration', { skills: ['refactor'] })])
  expect(suggest('visual', cfg, new Map(), 'repo')).toEqual({ assignee: 'ui', score: 0, evidence: ['only:ui'], fallback: 'single' })
})

it('ranks a specialist above the default agent for the work type it covers', () => {
  const cfg = config([agent('default-worker'), agent('ui', { skills: ['visual', 'copy'], cost: 'low' })])
  const result = suggest('visual', cfg)
  expect(result.assignee).toBe('ui')
  expect(result.score).toBeGreaterThan(2)
  expect(result.evidence[0]).toBe('skill:visual|copy')
})

it('prefers the idle agent when two agents cover the same work type', () => {
  const cfg = config([agent('default-worker'), agent('busy', { skills: ['bugfix'] }), agent('free', { skills: ['bugfix'] })])
  const result = suggest('bugfix', cfg, new Map([['busy', 2]]))
  // `busy` holds its only slot, so it never reaches the ranking.
  expect(result.assignee).toBe('free')
  // Both idle: the higher cost score breaks the tie in favour of the cheaper agent.
  const cheap = suggest('bugfix', config([agent('default-worker'), agent('a', { skills: ['bugfix'] }), agent('b', { skills: ['bugfix'], cost: 'low' })]))
  expect(cheap.assignee).toBe('b')
})

it('lets the agent with a better history win between otherwise identical agents, worth 0.5', () => {
  const cfg = config([agent('default-worker'), agent('a', { skills: ['bugfix'] }), agent('b', { skills: ['bugfix'] })])
  // Same capability, cost and idle slots: with no history the stable order keeps `a` in front.
  const baseline = suggest('bugfix', cfg)
  expect(baseline.assignee).toBe('a')
  // History breaks that tie: the agent with success rate 1 for this work type wins.
  const boosted = suggest('bugfix', cfg, new Map(), undefined, id => (id === 'b' ? 1 : 0))
  expect(boosted.assignee).toBe('b')
  // The history weight is 0.5, so the winning score rises by exactly that much.
  expect(boosted.score - baseline.score).toBe(0.5)
})

it('leaves the existing ranking unchanged when history returns 0', () => {
  const cfg = config([agent('default-worker'), agent('a', { skills: ['bugfix'], cost: 'low' }), agent('b', { skills: ['bugfix'] })])
  // Cost already decides this ranking: `a` is cheaper.
  const baseline = suggest('bugfix', cfg)
  expect(baseline.assignee).toBe('a')
  // A zero success rate adds nothing, so neither the winner nor its score moves.
  expect(suggest('bugfix', cfg, new Map(), undefined, () => 0)).toEqual(baseline)
  // Among otherwise identical agents, zero history also keeps the stable order rather than reordering it.
  const twins = config([agent('default-worker'), agent('first', { skills: ['bugfix'] }), agent('second', { skills: ['bugfix'] })])
  expect(suggest('bugfix', twins, new Map(), undefined, () => 0)).toEqual(suggest('bugfix', twins))
})

it('respects repository scopes', () => {
  const cfg = config([agent('default-worker'), agent('sandbox', { skills: ['infra'], scopes: ['silas/sandbox'] })])
  expect(suggest('infra', cfg, new Map(), 'silas/sandbox').assignee).toBe('sandbox')
  // Outside its scope the specialist is filtered out, and the wildcard default covers the work.
  expect(suggest('infra', cfg, new Map(), 'other/repo')).toEqual({ assignee: 'default-worker', score: 0, evidence: ['only:default-worker'], fallback: 'single' })
})

it('records what routing would have decided and leaves the ticket alone', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.set(KV.assignees.config, config([agent('default-worker'), agent('ui', { skills: ['visual'] })]))
  const record = recordShadow(store, { decisionId: 'decision-1', ticketId: 'ticket-1', workType: 'visual', now: new Date('2026-11-04T00:00:00.000Z') })
  expect(record.enabled).toBe(false)
  expect(record.suggestion.assignee).toBe('ui')
  expect(record.at).toBe('2026-11-04T00:00:00.000Z')
  // Readable back by decision, and nothing else was written.
  expect(readShadow(store, 'decision-1')).toEqual(record)
  expect(store.tickets.list()).toEqual([])
})

it('records enabled=true and still writes the suggestion', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.set(KV.assignees.config, config([agent('default-worker'), agent('ui', { skills: ['visual'] })], true))
  const record = recordShadow(store, { decisionId: 'decision-enabled', ticketId: 'ticket-2', workType: 'visual', now: new Date('2026-11-04T00:00:00.000Z') })
  expect(record.enabled).toBe(true)
  // Turning routing on still records the suggestion, so an operator can compare it with the real assignment.
  expect(record.suggestion.assignee).toBe('ui')
  // Both fields survive the round trip through the store.
  expect(readShadow(store, 'decision-enabled')).toEqual(record)
})

it('records the work type through the route tool and leaves the ticket unchanged', async () => {
  const h = await startRuntime()
  try {
    const trigger = feishu('7', '@bot 把 README 第一行的错字改掉')
    h.runtime.receive(trigger); await h.runtime.idle()
    const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: trigger.id,
      title: 'README 第一行错字', worktree_name: 'fix-readme-typo', acknowledgement: '改掉 README 第一行的错字', work_type: 'copy' }] })
    expect((results as { shadow: unknown }[])[0]!.shadow).toEqual({ assignee: 'default-worker', workType: 'copy', fallback: 'single' })
    // Routing is recorded, not applied: the ticket is accepted exactly as before, with no assignee.
    const ticket = h.runtime.store.tickets.open()[0]!
    // P0 writes no runtime field at all: the assignment path is untouched.
    expect(Object.keys(ticket.execution ?? {})).not.toContain('assignee')
    const keys = h.runtime.store.keys('assignees-shadow:')
    expect(keys).toHaveLength(1)
    expect(readShadow(h.runtime.store, keys[0]!.slice('assignees-shadow:'.length))).toMatchObject({ ticketId: ticket.id, workType: 'copy', enabled: false })
  } finally { await h.stop() }
})

it('measures work-type coverage: an accept that names none is recorded with no suggestion', async () => {
  const h = await startRuntime()
  try {
    const trigger = feishu('8', '@bot 顺手看下这段文案')
    h.runtime.receive(trigger); await h.runtime.idle()
    const { results } = await h.runTool(h.runtime.masterId, 'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: trigger.id,
      title: '文案', worktree_name: 'copy-check', acknowledgement: '看一下这段文案' }] })
    expect((results as { shadow: unknown }[])[0]!.shadow).toEqual({ assignee: 'default-worker', workType: null, fallback: 'lowConfidence' })
    const keys = h.runtime.store.keys('assignees-shadow:')
    expect(readShadow(h.runtime.store, keys[0]!.slice('assignees-shadow:'.length))).toMatchObject({ workType: null, enabled: false })
  } finally { await h.stop() }
})
