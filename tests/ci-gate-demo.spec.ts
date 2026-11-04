import { expect, it } from 'vitest'

// Temporary: exists only to watch the Source turn a red check into a task.
it('fails on purpose so the CI gate has something to report', () => {
  expect(1 + 1).toBe(3)
})
