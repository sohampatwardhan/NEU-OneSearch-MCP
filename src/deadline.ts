export interface Deadline {
  remainingMs(): number;
  expired(): boolean;
}

/** A countdown from now. `clock` is injectable so tests need no real waiting. */
export function createDeadline(totalMs: number, clock: () => number = Date.now): Deadline {
  const end = clock() + totalMs;
  const remainingMs = (): number => Math.max(0, end - clock());
  return { remainingMs, expired: () => remainingMs() <= 0 };
}
