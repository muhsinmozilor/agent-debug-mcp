/**
 * Poll for a page global (default every 250 ms, up to `maxMs`) and notify on presence changes.
 * Shared by the TanStack Query/Router packages, which only differ in how they find their instance.
 * Returns a stop function.
 */
export function watchGlobal(
  find: () => boolean,
  onChange: (present: boolean) => void,
  opts: { intervalMs?: number; maxMs?: number } = {},
): () => void {
  const interval = opts.intervalMs ?? 250;
  const max = opts.maxMs ?? 30_000;
  let present = find();
  onChange(present);
  const start = Date.now();
  const timer = setInterval(() => {
    const now = find();
    if (now !== present) {
      present = now;
      onChange(now);
    }
    if (Date.now() - start > max) clearInterval(timer);
  }, interval);
  return () => clearInterval(timer);
}
