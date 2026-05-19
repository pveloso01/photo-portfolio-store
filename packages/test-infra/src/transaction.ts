// Per-test transaction isolation. Wrap a test body in withTransaction so
// every write the SUT performs lands inside a tx that the helper rolls back
// after the callback resolves. This gives us per-test isolation without the
// cost of truncating tables or re-running migrations between tests.
//
// We intentionally don't commit even on success: the test's job is to assert
// behavior, not persist state. A test that needs to read its own writes can
// still do so freely inside the callback because Postgres transactions are
// session-isolated.

import type { DbClient } from '@pkg/db';

interface RollbackSignal {
  readonly __rollback: true;
}
const ROLLBACK: RollbackSignal = { __rollback: true } as const;

export const withTransaction = async <T>(
  db: DbClient,
  fn: (tx: DbClient) => Promise<T>,
): Promise<T> => {
  let captured: T | undefined;
  let captureSet = false;
  try {
    await db.transaction(async (tx) => {
      captured = await fn(tx as unknown as DbClient);
      captureSet = true;
      // Force drizzle to roll back by throwing a sentinel after we've
      // captured the result. drizzle propagates the throw to abort the tx.
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  if (!captureSet) {
    throw new Error('withTransaction: callback did not complete');
  }
  return captured as T;
};
