/**
 * Per-session turn serialization — in-memory mutex (architecture-v2.md §5.1).
 *
 * One turn per session runs at a time. This mutex handles the common case
 * (double-submit, two tabs on the same instance). Cross-instance races
 * fall back to the optimistic `sessions.version` check in the store —
 * a conflicting save throws VersionConflictError and the route reports it.
 *
 * In-memory by design (same caveat as the rate limiter): a production
 * deployment would use a shared lock (e.g. a Postgres advisory lock).
 */

const chains = new Map<string, Promise<void>>();

/** Run `fn` exclusively for `sessionId`, chained after any in-flight turn. */
export async function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The chain the NEXT waiter joins waits for the previous turn AND this one.
  const next = previous.then(() => current);
  chains.set(sessionId, next);
  // `previous` only ever resolves (release() runs in a finally below), so
  // a failed turn never rejects the chain.
  await previous;
  try {
    return await fn();
  } finally {
    release();
    // Clean up only if no newer chain replaced ours while we ran.
    if (chains.get(sessionId) === next) chains.delete(sessionId);
  }
}
