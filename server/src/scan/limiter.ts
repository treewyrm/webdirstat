/** Caps how many filesystem operations are in flight at once, regardless of tree shape. */
export function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
