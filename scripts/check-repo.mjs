#!/usr/bin/env node
/**
 * Repository consistency checks that a compiler cannot make.
 *
 * Written after `.gitignore` turned out to have an unanchored `release/` pattern
 * that silently excluded every release script from the repository. `git status`
 * reported a clean tree, so nothing looked wrong, and CI would have failed on the
 * first tag with "Cannot find module" — after the version had been bumped and
 * pushed.
 *
 * The lesson generalises: anything referenced by *string* rather than by import
 * can go missing without a single test noticing. This script checks those
 * references directly.
 *
 * Usage: node scripts/check-repo.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const problems = [];

function fail(message) {
  problems.push(message);
}

/* ------------------------------------------------------------------ *
 * 1. Every path a workflow names must be tracked in git, not just on disk.
 * ------------------------------------------------------------------ */
const workflowDir = join(ROOT, '.github', 'workflows');
const workflowFiles = existsSync(workflowDir)
  ? readdirSync(workflowDir).filter((name) => name.endsWith('.yml'))
  : [];

const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean),
);

for (const workflow of workflowFiles) {
  const text = readFileSync(join(workflowDir, workflow), 'utf8');
  // Paths in `run:` blocks that look like repo files.
  const referenced = [...text.matchAll(/(?:node|pnpm tsx)\s+([\w./-]+\.mjs)/g)].map((m) => m[1]);
  for (const path of referenced) {
    if (!tracked.has(path)) {
      fail(
        `.github/workflows/${workflow} runs ${path}, which is not tracked by git. ` +
          `CI will fail with "Cannot find module".`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. Ignore rules must not exclude source.
 * ------------------------------------------------------------------ */
const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
const SOURCE_PATHS = [
  'scripts/release/assert-package.mjs',
  'scripts/release/make-manifest.mjs',
  'scripts/binaries.lock.json',
  'packages/update-core/src/index.ts',
  'apps/desktop/src/main/updater/update-service.ts',
  'apps/desktop/electron-builder.yml',
  'apps/desktop/vite.main.config.ts',
];

for (const path of SOURCE_PATHS) {
  if (!tracked.has(path)) {
    fail(`${path} exists in the project layout but is not tracked by git.`);
  }
}

// A bare directory pattern with no leading slash matches at any depth.
for (const line of gitignore.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
  if (!trimmed.includes('/')) continue; // file patterns like `*.exe` are fine
  if (trimmed.startsWith('/')) continue; // anchored: intentional
  // Unanchored `name/` would match `any/depth/name/`.
  if (/^[\w.-]+\/$/.test(trimmed)) {
    const offenders = [...tracked].filter((path) => path.includes(`/${trimmed.replace(/\/$/, '')}/`));
    if (offenders.length > 0) {
      fail(
        `.gitignore has the unanchored directory pattern "${trimmed}", which also matches ` +
          `${offenders.length} tracked path(s) such as ${offenders[0]}. Anchor it with a leading "/".`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * 3. Documentation links must resolve.
 * ------------------------------------------------------------------ */
const docFiles = [
  ...readdirSync(join(ROOT, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => join('docs', name)),
  ...['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md'].filter((name) =>
    existsSync(join(ROOT, name)),
  ),
];

for (const doc of docFiles) {
  const text = readFileSync(join(ROOT, doc), 'utf8');
  for (const match of text.matchAll(/\]\(([^)#\s]+\.md)/g)) {
    const link = match[1];
    if (/^https?:/.test(link)) continue;
    const target = resolve(ROOT, join(doc, '..', link));
    if (!existsSync(target)) fail(`${doc} links to ${link}, which does not exist.`);
  }
}

/* ------------------------------------------------------------------ *
 * 4. File-name references in the package config must match package.json.
 * ------------------------------------------------------------------ */
const desktopPkg = JSON.parse(readFileSync(join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8'));
const mainEntry = desktopPkg.main ?? 'dist/main/index.cjs';
const mainOnDisk = join(ROOT, 'apps', 'desktop', mainEntry);
if (!existsSync(mainOnDisk) && existsSync(join(ROOT, 'apps', 'desktop', 'dist'))) {
  // Only meaningful when a build exists; the release job asserts it after building.
  fail(`apps/desktop/package.json "main" is ${mainEntry}, which the build did not produce.`);
}

/* ------------------------------------------------------------------ */

if (problems.length > 0) {
  console.error('\ncheck-repo: problems found:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(
  `check-repo: OK — ${workflowFiles.length} workflows, ${docFiles.length} docs, ${tracked.size} tracked files.`,
);

void relative;
