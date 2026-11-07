#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/**
 * SPEC 16 §6.8 — Automated No-Fakes & Honesty Audit
 * Checks for banned marketing/virality claims and forbidden patterns in production code.
 */
const ROOT = process.cwd();
const PROD_DIRS = [
  path.join(ROOT, 'apps/desktop/src'),
  path.join(ROOT, 'packages/design-system/src'),
  path.join(ROOT, 'packages/project-schema/src'),
  path.join(ROOT, 'packages/timeline-engine/src'),
  path.join(ROOT, 'packages/compositor/src'),
  path.join(ROOT, 'packages/caption-styles/src'),
  path.join(ROOT, 'packages/audio-core/src'),
  path.join(ROOT, 'packages/media-core/src'),
  path.join(ROOT, 'packages/ai-core/src'),
  path.join(ROOT, 'packages/export-core/src'),
];

const DETERMINISTIC_DIRS = [
  path.join(ROOT, 'packages/compositor/src'),
  path.join(ROOT, 'packages/export-core/src'),
  path.join(ROOT, 'packages/timeline-engine/src'),
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(tsx|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];

for (const dir of PROD_DIRS) {
  for (const file of walk(dir)) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);

    if (/TODO:\s*mock|FIXME:\s*mock/i.test(content)) {
      violations.push(`${rel}: Contains forbidden 'TODO: mock' marker`);
    }

  }
}

for (const dir of DETERMINISTIC_DIRS) {
  for (const file of walk(dir)) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    if (/Math\.random\s*\(/.test(content)) {
      violations.push(`${rel}: Contains forbidden Math.random() in deterministic engine/compositor/export code`);
    }
  }
}

/**
 * SPEC 07 §13.10 — no "viral"/"guaranteed" hype in any string the user can read.
 * Only renderer copy is scanned: matcher keywords inside engines are data, not claims.
 */
const RENDERER_DIR = path.join(ROOT, 'apps/desktop/src/renderer');
for (const file of walk(RENDERER_DIR)) {
  const content = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  // Look only inside quoted strings, so regexes and identifiers are ignored.
  const strings = content.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? [];
  for (const literal of strings) {
    const hype = /\b(viral|guaranteed|go viral|blow up)\b/i.exec(literal);
    if (hype) {
      violations.push(`${rel}: UI string contains hype wording "${hype[0]}" (SPEC 07 §13.10)`);
    }
  }
}

if (violations.length > 0) {
  console.error('No-fakes audit failed (Spec 16 §6.8):');
  for (const v of violations) console.error('  -', v);
  process.exit(1);
}
console.log('✓ No-fakes & determinism code audit passed.');
