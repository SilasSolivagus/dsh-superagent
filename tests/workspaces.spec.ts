import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { SettingsSchema, type Settings } from '../src/policy.ts'
import type { Ticket } from '../src/core/index.ts'
import { sweepWorkspaces, workspaceDue, workspaceRetentionMs } from '../src/app/workspaces.ts'

const DAY = 86_400_000
const stateDir = '/srv/state'
const settings = (days: number): Settings => SettingsSchema.parse({ executor: { workspaceRetentionDays: days } })
const ended = (at: string) => ({ at, by: 'executor' as const, outcome: 'merged' as const })
const execution = (name: string, directory = join(stateDir, 'work', name)) => ({ name, directory, assignment: '' })
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 'ticket', title: 't', decisionId: 'd', mandate: {} as never,
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: '', triggerIds: [] },
  ...overrides })

describe('workspaceRetentionMs', () => {
  it('turns the configured days into milliseconds and 0 disables removal', () => {
    expect(workspaceRetentionMs(settings(0))).toBe(0)
    expect(workspaceRetentionMs(settings(3))).toBe(3 * DAY)
  })
})

describe('workspaceDue', () => {
  const now = Date.parse('2026-11-10T00:00:00Z')
  it('keeps a live ticket, an ended one without a directory, and everything while retention is 0', () => {
    expect(workspaceDue(ticket({}), settings(7), now)).toBe(false)
    expect(workspaceDue(ticket({ ended: ended('2026-11-01T00:00:00Z') }), settings(7), now)).toBe(false)
    expect(workspaceDue(ticket({ ended: ended('2026-11-01T00:00:00Z'), execution: execution('fix-a-thing-5b5cd7fac427') }), settings(0), now)).toBe(false)
  })
  it('removes an ended ticket only after its retention elapses', () => {
    const base = { ended: ended('2026-11-09T00:00:00Z'), execution: execution('fix-a-thing-5b5cd7fac427') }
    expect(workspaceDue(ticket(base), settings(7), now)).toBe(false)
    expect(workspaceDue(ticket({ ...base, ended: ended('2026-11-02T00:00:00Z') }), settings(7), now)).toBe(true)
  })
  it('keeps a ticket that still follows an unmerged pull request', () => {
    const base = { ended: ended('2026-11-01T00:00:00Z'), execution: execution('fix-a-thing-5b5cd7fac427') }
    const open = { follows: [{ thread: 'github:12', own: true }] }
    const closed = { follows: [{ thread: 'github:12', own: true, closed: { at: '2026-11-03T00:00:00Z', outcome: 'merged' as const } }] }
    expect(workspaceDue(ticket({ ...base, ...open }), settings(7), now)).toBe(false)
    expect(workspaceDue(ticket({ ...base, ...closed }), settings(7), now)).toBe(true)
  })
})

describe('sweepWorkspaces', () => {
  const now = Date.parse('2026-11-10T00:00:00Z')
  it('removes due directories under the root and returns their paths', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const due = ticket({ ended: ended('2026-11-01T00:00:00Z'), execution: execution('fix-a-thing-5b5cd7fac427') })
    const removed = await sweepWorkspaces([due], settings(7), stateDir, now, remove)
    expect(removed).toEqual([join(stateDir, 'work', 'fix-a-thing-5b5cd7fac427')])
    expect(remove).toHaveBeenCalledWith(join(stateDir, 'work', 'fix-a-thing-5b5cd7fac427'))
  })
  it('skips tickets whose stored directory no longer matches the expected path, and unmerged PRs', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const foreign = ticket({ ended: ended('2026-11-01T00:00:00Z'), execution: execution('fix-a-thing-5b5cd7fac427', '/elsewhere/fix-a-thing-5b5cd7fac427') })
    const openPr = ticket({ ended: ended('2026-11-01T00:00:00Z'), execution: execution('fix-b-thing-5b5cd7fac427'), follows: [{ thread: 'github:12', own: true }] })
    expect(await sweepWorkspaces([foreign, openPr], settings(7), stateDir, now, remove)).toEqual([])
    expect(remove).not.toHaveBeenCalled()
  })
  it('does nothing while retention is disabled', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const due = ticket({ ended: ended('2026-11-01T00:00:00Z'), execution: execution('fix-a-thing-5b5cd7fac427') })
    expect(await sweepWorkspaces([due], settings(0), stateDir, now, remove)).toEqual([])
    expect(remove).not.toHaveBeenCalled()
  })
  it('swallows removal failures so the rest of the sweep still runs', async () => {
    const remove = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(undefined)
    const first = ticket({ id: 'one', ended: ended('2026-11-01T00:00:00Z'), execution: execution('fix-a-thing-5b5cd7fac427') })
    const second = ticket({ id: 'two', ended: ended('2026-11-01T00:00:00Z'), execution: execution('fix-b-thing-5b5cd7fac427') })
    const removed = await sweepWorkspaces([first, second], settings(7), stateDir, now, remove)
    expect(removed).toEqual([join(stateDir, 'work', 'fix-b-thing-5b5cd7fac427')])
  })
})
