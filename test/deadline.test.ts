import { describe, it, expect } from 'vitest';
import { createDeadline } from '../src/deadline.js';

describe('createDeadline', () => {
  it('counts down against the injected clock and never goes negative', () => {
    let now = 1000;
    const d = createDeadline(500, () => now);
    expect(d.remainingMs()).toBe(500);
    expect(d.expired()).toBe(false);
    now = 1400;
    expect(d.remainingMs()).toBe(100);
    now = 1500;
    expect(d.remainingMs()).toBe(0);
    expect(d.expired()).toBe(true);
    now = 9000;
    expect(d.remainingMs()).toBe(0);
  });
});
