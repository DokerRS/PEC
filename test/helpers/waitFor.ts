/**
 * Deterministic event-driven wait for test assertions (AUDIT-QA-P3):
 * polls a predicate until the observable effect of an async chain is present,
 * instead of sleeping a fixed number of milliseconds and hoping the chain
 * finished. Fails loudly on timeout so a broken async path cannot silently
 * pass through a stale predicate.
 */
export async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; stepMs?: number; label?: string } = {}
): Promise<void> {
  const { timeoutMs = 2000, stepMs = 5, label = "condition" } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor: timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
