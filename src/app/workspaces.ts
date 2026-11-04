/** Safe removal of ended Tickets' workspace directories, which the Executor leaves on disk after a Ticket ends. */
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Ticket } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import { pullsOf } from '../sources/github-pull.ts'
import { executionRoot } from './execution-environment.ts'

const DAY_MS = 86_400_000
/** How long an ended Ticket's directory is kept, in milliseconds; `0` disables automatic removal. */
export const workspaceRetentionMs = (settings: Settings): number => settings.executor.workspaceRetentionDays * DAY_MS

/**
 * Whether a Ticket's workspace directory may be removed: the Ticket ended, its retention has elapsed, and it has no
 * pull request still open (a not-yet-merged PR keeps its directory, as the Operator asked).
 */
export function workspaceDue(ticket: Ticket, settings: Settings, now = Date.now()): boolean {
  if (!ticket.ended || !ticket.execution?.directory || !ticket.execution.name) return false
  const retention = workspaceRetentionMs(settings)
  if (retention <= 0) return false
  if (pullsOf(ticket, true).length > 0) return false
  return now - Date.parse(ticket.ended.at) >= retention
}

/** The directory the Executor built for `ticket` under `root`, which its stored `directory` must still equal. */
const expectedWorkspace = (ticket: Ticket, root: string): string => resolve(join(root, ticket.execution!.name))

/** Removes a workspace directory recursively, tolerating one that is already gone. */
export const removeWorkspace = (directory: string): Promise<void> => rm(directory, { recursive: true, force: true })

/**
 * Removes the workspace directories of `tickets` that are due, and returns the directories actually removed. A Ticket's
 * stored directory is removed only while it still equals the Executor's expected path under `root`, so a stale or foreign
 * path is never touched. Failures are swallowed: a directory already gone counts as cleaned, and one that cannot be removed
 * is left for the next sweep.
 */
export async function sweepWorkspaces(tickets: readonly Ticket[], settings: Settings, stateDir: string,
  now = Date.now(), remove: (directory: string) => Promise<void> = removeWorkspace): Promise<string[]> {
  if (workspaceRetentionMs(settings) <= 0) return []
  const root = resolve(executionRoot(settings, stateDir))
  const removed: string[] = []
  for (const ticket of tickets) {
    if (!workspaceDue(ticket, settings, now)) continue
    const directory = resolve(ticket.execution!.directory)
    if (directory !== expectedWorkspace(ticket, root)) continue
    try { await remove(directory); removed.push(directory) } catch { /* Absent, or not removable now; retried next sweep. */ }
  }
  return removed
}
