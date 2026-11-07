#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/**
 * SPEC 01 §12.2 — Lint rule enforcing that no UI screen outside packages/design-system
 * hard-codes hex colours, px border-radius values, or ms transition durations.
 */
const ROOT = process.cwd();
const SCAN_DIRS = [path.join(ROOT, 'apps/desktop/src/renderer')];

const HEX_REGEX = /#[0-9A-Fa-f]{3,8}\b/g;
const RADIUS_PX_REGEX = /borderRadius\s*:\s*['"`]\d+px['"`]|border-radius\s*:\s*\d+px/g;
const DURATION_MS_REGEX = /transition\s*:\s*['"`][^'"`]*\b\d+ms\b/g;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(tsx|ts|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

let violations = [];
for (const scanDir of SCAN_DIRS) {
  for (const file of walk(scanDir)) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);

    const hexMatches = content.match(HEX_REGEX);
    if (hexMatches) {
      violations.push(`${rel}: Hard-coded hex colour(s): ${hexMatches.join(', ')}`);
    }
    const radMatches = content.match(RADIUS_PX_REGEX);
    if (radMatches) {
      violations.push(`${rel}: Hard-coded px border-radius: ${radMatches.join(', ')}`);
    }
    const durMatches = content.match(DURATION_MS_REGEX);
    if (durMatches) {
      violations.push(`${rel}: Hard-coded ms duration: ${durMatches.join(', ')}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Design system token lint failed (Spec 01 §12.2):');
  for (const v of violations) console.error('  -', v);
  process.exit(1);
}
console.log('✓ Design system token lint passed (0 hard-coded hex colours, px radii, or ms durations in renderer UI).');
