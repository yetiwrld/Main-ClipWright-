#!/usr/bin/env node
/**
 * Pull the release notes for one version out of CHANGELOG.md.
 *
 * SPEC 15 §8.1: release notes are generated from the matching CHANGELOG section,
 * so the notes a user reads are the ones that were reviewed in the pull request —
 * not something typed into the release page after the fact.
 *
 * Usage: node scripts/release/extract-notes.mjs --version 1.3.0 --out notes.md
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const args = process.argv.slice(2);
const version = argValue('--version');
const out = argValue('--out');

if (!version) fail('--version is required');
if (!out) fail('--out is required');

const root = resolve(import.meta.dirname, '..', '..');
const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8').catch(() => null);

if (changelog === null) {
  fail('CHANGELOG.md is missing. §8.1 requires it; see docs/release.md.');
}

const section = extractSection(changelog, version);
if (!section.trim()) {
  fail(`CHANGELOG.md has no section for ${version}. Add one before tagging this release.`);
}

await mkdir(dirname(resolve(out)), { recursive: true });
await writeFile(resolve(out), `${section.trim()}\n`);
console.log(`Wrote ${out} (${section.trim().split('\n').length} lines) from CHANGELOG ${version}`);

/**
 * Find `## [1.3.0] …` (Keep a Changelog) or `## 1.3.0`, and take everything up
 * to the next level-2 heading.
 */
export function extractSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?`, 'm');
  const match = heading.exec(changelog);
  if (!match) return '';

  const after = changelog.slice(match.index + match[0].length);
  const nextHeading = /\n##\s+/.exec(after);
  const body = nextHeading ? after.slice(0, nextHeading.index) : after;
  // Link-reference definitions at the bottom of the file (`[1.0.0]: https://…`)
  // belong to the document, not to these notes.
  return body
    .split('\n')
    .filter((line) => !/^\[[^\]]+\]:\s+\S+/.test(line))
    .join('\n')
    .trim();
}

function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function fail(message) {
  console.error(`\nextract-notes: ${message}\n`);
  process.exit(1);
}
