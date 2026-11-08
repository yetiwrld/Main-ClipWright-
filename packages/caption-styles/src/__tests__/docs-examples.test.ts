import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStyle } from '../schema.js';

/** The two examples in docs/formats.md must be real, valid styles. */
const doc = readFileSync(join(process.cwd(), 'docs', 'formats.md'), 'utf8');

function jsonBlocksAfter(heading: string): unknown[] {
  const start = doc.indexOf(heading);
  expect(start, `docs/formats.md has no "${heading}" section`).toBeGreaterThan(-1);
  const after = doc.slice(start);
  const next = after.indexOf('\n### ', 1);
  const section = next === -1 ? after : after.slice(0, next);
  return [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]!));
}

describe('the worked examples in docs/formats.md', () => {
  it('parses example 1 as a valid style', () => {
    const blocks = jsonBlocksAfter('### Worked example 1');
    expect(blocks).toHaveLength(1);
    expect(() => parseStyle(blocks[0])).not.toThrow();
  });

  it('parses example 2 as a valid style', () => {
    const blocks = jsonBlocksAfter('### Worked example 2');
    expect(blocks).toHaveLength(1);
    expect(() => parseStyle(blocks[0])).not.toThrow();
  });

  it('names the preset directory the shipped styles live in', () => {
    // A reader needs to find the real files from the schema description.
    expect(doc).toContain('assets/caption-presets/');
  });
});
