/** The panel's read-only view of recent shadow records: what routing would have decided, newest first. */
import { KV } from '../../kv.ts'
import { configFingerprint, loadConfig, readShadow } from '../assignees.ts'
import type { Store } from '../store.ts'

/** How many shadow records the panel shows at once; the record is an audit aid, not a history. */
export const SHADOW_SHOWN = 20

/**
 * The newest shadow records, with `stale` marking one computed against a configuration that has changed since.
 * Records are written by this build, but a stored value is untrusted input: a record that cannot be read as one is skipped.
 */
export function shadowList(store: Pick<Store, 'get' | 'keys'>) {
  const current = configFingerprint(loadConfig(store).config)
  const prefix = KV.assignees.shadow.prefix
  const records = store.keys(KV.assignees.shadow).flatMap(key => {
    const record = readShadow(store, key.slice(prefix.length))
    return record && typeof record.at === 'string' && typeof record.decisionId === 'string'
      && typeof record.suggestion?.assignee === 'string' ? [record] : []
  })
  return { items: records.sort((left, right) => right.at.localeCompare(left.at)).slice(0, SHADOW_SHOWN).map(record => ({
    at: record.at,
    decisionId: record.decisionId,
    ...(record.ticketId ? { ticketId: record.ticketId } : {}),
    workType: record.workType ?? null,
    assignee: record.suggestion.assignee,
    ...(record.suggestion.fallback ? { fallback: record.suggestion.fallback } : {}),
    // The record only explains today's routing while its fingerprint equals the current configuration's.
    stale: record.configFingerprint !== current,
  })) }
}
export type ShadowListView = ReturnType<typeof shadowList>
