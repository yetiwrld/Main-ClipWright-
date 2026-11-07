import { expect } from 'vitest';
import { checkInvariants } from '../invariants';
import type { TimelineState } from '../selectors';

/** Invariant check that fails with a readable list instead of a bare diff. */
export function checkInvariantsMB(state: TimelineState, fps: 30 | 60 = 30): string[] {
  const problems = checkInvariants(state, fps);
  if (problems.length) expect(problems, problems.join('\n')).toEqual([]);
  return problems;
}
