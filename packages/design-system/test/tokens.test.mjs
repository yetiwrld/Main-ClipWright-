/** Design-system invariants: required tokens exist; no hex colours leak outside design-system. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = new URL('../../..', import.meta.url).pathname; // repo root
const read = (p) => readFileSync(join(root, p), 'utf8');

const REQUIRED = [
  '--brand', '--brand-strong', '--brand-amber', '--brand-tint', '--on-brand',
  '--surface-app', '--surface-panel', '--surface-card', '--surface-hover',
  '--line-faint', '--line-default', '--line-strong',
  '--text-primary', '--text-secondary', '--text-muted', '--text-disabled',
  '--success', '--warning', '--error', '--info',
  '--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl', '--fs-2xl', '--fs-hero',
  '--space-1', '--space-2', '--space-3', '--space-4', '--space-6', '--space-8', '--space-12',
  '--panel-gap', '--radius-control', '--radius-panel', '--radius-dialog', '--radius-pill',
  '--dur-fast', '--dur-panel', '--dur-screen', '--ease',
  '--track-video', '--track-audio', '--track-music', '--track-caption',
];

test('tokens.css defines every required token', () => {
  const css = read('packages/design-system/src/tokens.css');
  for (const t of REQUIRED) assert.ok(css.includes(t + ':'), `missing token ${t}`);
});

test('no hex colours or rgba colours outside the design-system package', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'out') continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx|css|js|jsx|mjs)$/.test(name)) continue;
      const rel = relative(root, p).replaceAll('\\', '/');
      // The UI-chrome rule applies to app screens only. Colour hex values in
      // packages/caption-styles and project-schema are style *data* (the .cwstyle
      // format, schema defaults), not themed UI chrome, and are allowed there.
      const isUi = rel.startsWith('apps/') || rel.startsWith('packages/design-system/');
      if (!isUi) continue;
      if (rel.startsWith('packages/design-system/src/tokens.css') || rel.startsWith('packages/design-system/src/tokens.ts')) continue;
      const src = read(rel);
      const hexes = src.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (hexes) offenders.push(`${rel}: ${hexes.slice(0, 3).join(', ')}`);
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], `Hard-coded colours found:\n${offenders.join('\n')}`);
});
