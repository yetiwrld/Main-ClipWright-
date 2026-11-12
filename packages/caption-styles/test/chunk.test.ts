import { describe, expect, it } from 'vitest';
import { buildCaptions } from '../src/chunk.js';
import type { TranscriptWord } from '@clipwright/project-schema';

const words = (texts: string[], start = 0, stepUs = 300_000): TranscriptWord[] =>
  texts.map((text, i) => ({ id: `w${i}`, index: i, text, startUs: start + i * stepUs, endUs: start + i * stepUs + 250_000 }));

describe('buildCaptions', () => {
  it('chunks a transcript respecting maxChars', () => {
    const w = words('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa'.split(' '));
    const chunks = buildCaptions(w, { maxChars: 24, id: (() => { let n = 0; return () => `c${n++}`; })() });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(30);
  });

  it('breaks on long pauses', () => {
    const w = [
      ...words(['hello', 'there'], 0),
      ...words(['world'], 5_000_000), // > 500ms pause
    ];
    const chunks = buildCaptions(w);
    expect(chunks).toHaveLength(2);
  });

  it('shifts times by timeOffsetUs', () => {
    const w = words(['one', 'two'], 10_000_000);
    const chunks = buildCaptions(w, { timeOffsetUs: -10_000_000 });
    expect(chunks[0]!.startUs).toBe(0);
  });

  it('is deterministic for the same input and id source', () => {
    const w = words(['a', 'b', 'c']);
    const mk = () => { let n = 0; return () => `id${n++}`; };
    expect(buildCaptions(w, { id: mk() })).toEqual(buildCaptions(w, { id: mk() }));
  });
});
