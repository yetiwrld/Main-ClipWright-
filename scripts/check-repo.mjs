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
import { dirname, join, relative, resolve } from 'node:path';

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
 * 4. The renderer must not import main-process code.
 *
 * This is an Electron boundary, not a style preference: main-process modules
 * import `electron`, `node:fs` and friends, so a renderer module that pulls one
 * in either fails to bundle or bundles something that cannot work in a
 * sandboxed renderer. Two modules had drifted across it — a privacy string and
 * a string-search function — which is why this is checked rather than trusted.
 * ------------------------------------------------------------------ */
const rendererDir = join(ROOT, 'apps', 'desktop', 'src', 'renderer');
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
    // `.d.ts` files are ambient declarations: nothing imports them, and the
    // compiler picks them up by presence. They are not orphan candidates.
    if (/\.d\.ts$/.test(entry.name)) return [];
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

for (const file of walk(rendererDir)) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
    const specifier = match[1];
    if (/^(\.\.\/)+(main)\//.test(specifier) || specifier.includes('/src/main/')) {
      fail(
        `${relative(ROOT, file)} imports ${specifier}. The renderer must not depend on ` +
          `main-process code; move the shared piece to a package or beside the renderer.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * 5. Documentation that quotes test counts must quote the real ones.
 *
 * docs/verification.md is the document a sceptical reader checks the project
 * against. It quoted "39 files / 909 tests" for four committed revisions while
 * the suite grew to 44 and 993 — not a lie anyone told, just a number nobody
 * re-ran. Rather than let that drift again, the figures are compared here.
 *
 * Skipped when vitest has not run: this check must stay fast enough to sit in
 * `pnpm lint`, and the count comes from the JSON report rather than a fresh run.
 * ------------------------------------------------------------------ */
const REPORT = join(ROOT, '.vitest-report.json');
if (existsSync(REPORT)) {
  try {
    const report = JSON.parse(readFileSync(REPORT, 'utf8'));
    const tests = report.numTotalTests;
    // `numTotalTestSuites` counts describe-blocks, not files; the per-file
    // results array is what the "Test Files" line reports.
    const files = report.testResults?.length;
    const doc = readFileSync(join(ROOT, 'docs', 'verification.md'), 'utf8');
    const claimedTests = /Tests\s+(\d+) passed/.exec(doc)?.[1];
    const claimedFiles = /Test Files\s+(\d+) passed/.exec(doc)?.[1];

    if (claimedTests && Number(claimedTests) !== tests) {
      fail(`docs/verification.md claims ${claimedTests} tests; the report has ${tests}.`);
    }
    if (claimedFiles && Number(claimedFiles) !== files) {
      fail(`docs/verification.md claims ${claimedFiles} test files; the report has ${files}.`);
    }
  } catch {
    // An unreadable report is not a repository problem.
  }
}

/* ------------------------------------------------------------------ *
 * 6. No module may exist only for its tests.
 *
 * `main/ipc.ts` was reachable only from a test file. It exported six shortcuts
 * with empty handlers, so the test could assert the keys were listed while
 * nothing in the app ever pressed them. A module with no production importer is
 * either dead code or a feature nobody wired up, and both are worth knowing
 * about before a user finds out.
 *
 * Tests are excluded from the importer search on purpose — importing it from a
 * test is exactly the situation this catches.
 * ------------------------------------------------------------------ */
const sourceDirs = [
  join(ROOT, 'apps', 'desktop', 'src', 'main'),
  join(ROOT, 'apps', 'desktop', 'src', 'renderer'),
];

/**
 * The final segment of a path, whichever separator it uses.
 *
 * `path.basename` follows the host platform, which made a Windows-only bug
 * untestable on the machine that fixed it. Splitting on both separators gives the
 * same answer everywhere, so the Linux run proves what Windows will do.
 */
function lastSegment(file) {
  const index = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return index === -1 ? file : file.slice(index + 1);
}

function listSources(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : listSources(full);
    // `.d.ts` files are ambient declarations: nothing imports them, and the
    // compiler picks them up by presence. They are not orphan candidates.
    if (/\.d\.ts$/.test(entry.name)) return [];
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const allSources = sourceDirs.flatMap(listSources);
const productionSources = allSources.filter((file) => !file.includes('__tests__'));
const ENTRY_POINTS = new Set(['main.ts', 'main.tsx', 'index.ts', 'index.tsx']);

for (const file of productionSources) {
  // NOT `split('/')`: on Windows these are `C:\...` paths, where splitting on
  // '/' returns the whole path and every entry-point exemption silently stops
  // matching. That is not cosmetic — it made this check flag main.tsx and 22
  // other files as orphans on CI while passing on Linux.
  //
  // NOT `path.basename` either: it is platform-specific, so the fix could not be
  // tested on the platform where it was written. `lastSegment` splits on both
  // separators and behaves identically everywhere.
  const name = lastSegment(file);
  if (ENTRY_POINTS.has(name)) continue;
  const base = name.replace(/\.tsx?$/, '');
  /*
    Static imports, *and* dynamic ones. `main.ts` reaches for `await import('./audio-enhance.js')`
    deliberately — the ffmpeg module is a heavy dependency that only a noise-reduction job needs,
    and a static import would load it at start-up for everyone. The check used to look only for
    `from '…'`, so a module wired exclusively through a dynamic import was reported as an orphan
    while being genuinely reachable: the rule's own words are "a module only a test can reach", and
    this one was reachable from the app.
  */
  const imported = productionSources.some(
    (other) =>
      other !== file &&
      new RegExp(`(from |import\\()\\s*'[^']*/${base}\\.js'`).test(readFileSync(other, 'utf8')),
  );
  if (!imported) {
    fail(
      `${relative(ROOT, file)} is not imported by any non-test file. ` +
        `Either wire it up or delete it — a module only a test can reach proves nothing.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 7. No renderer dependency may reach a node: builtin.
 *
 * The renderer is bundled for a sandboxed context where `node:crypto` and
 * friends do not exist. When `UPDATE_PRIVACY_NOTE` moved into update-core, the
 * renderer started importing the package root, which also pulls in the Ed25519
 * signing module and therefore `node:crypto`. `tsc --noEmit` passed and 1063
 * tests passed; only `pnpm build` failed, with
 *   "createPublicKey" is not exported by "__vite-browser-external"
 *
 * Checking the *transitive* import graph is what would have caught it, so that
 * is what this does: walk the renderer's local imports (including workspace
 * packages) and fail on any node: builtin or `electron` in the closure.
 *
 * `@clipwright/update-core/browser` is the sanctioned way to reach the pure
 * parts of that package; the root entry includes signing on purpose.
 * ------------------------------------------------------------------ */
const NODE_BUILTIN = /^node:/;
const RENDERER_ROOT = join(ROOT, 'apps', 'desktop', 'src', 'renderer');
const WORKSPACE_PACKAGES = join(ROOT, 'packages');

function resolveLocal(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const packageEntries = new Map();
for (const name of readdirSync(WORKSPACE_PACKAGES)) {
  const manifestPath = join(WORKSPACE_PACKAGES, name, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const exportsMap = manifest.exports ?? { '.': { default: manifest.main } };
  for (const [subpath, target] of Object.entries(exportsMap)) {
    const file = typeof target === 'string' ? target : (target.default ?? target.import);
    if (file) packageEntries.set(`${manifest.name}${subpath === '.' ? '' : subpath}`, join(WORKSPACE_PACKAGES, name, file));
  }
}

function* importClosure(entry, seen = new Set()) {
  if (seen.has(entry) || !existsSync(entry)) return;
  seen.add(entry);
  yield { file: entry };
  const text = readFileSync(entry, 'utf8');
  // `import type` is erased by the compiler and never reaches the bundle, so a
  // type-only import of a Node-using module is fine — and the renderer relies on
  // that for every payload shape it shares with the main process.
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)) {
    if (/^\s*(?:import|export)\s+type\b/m.test(match[0])) continue;
    const specifier = match[1];
    if (NODE_BUILTIN.test(specifier) || specifier === 'electron') {
      yield { file: entry, forbidden: specifier };
      continue;
    }
    const local = resolveLocal(entry, specifier);
    const pkg = packageEntries.get(specifier);
    const next = local ?? pkg ?? null;
    if (next) yield* importClosure(next, seen);
  }
}

const rendererEntries = allSources.filter((file) => file.startsWith(RENDERER_ROOT));
for (const entry of rendererEntries) {
  for (const hit of importClosure(entry)) {
    if (!hit.forbidden) continue;
    fail(
      `${relative(ROOT, hit.file)} reaches "${hit.forbidden}" from renderer code (` +
        `${relative(ROOT, entry)}). The renderer is bundled for a context without Node ` +
        `builtins; import '@clipwright/update-core/browser' rather than the package root.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 8. The unsigned notice appears everywhere §6.4 and acceptance item 10 say.
 *
 * The spec calls for an automated string check, and the reason is that this is
 * the one thing in the project nobody may quietly drop: an unsigned installer
 * that does not say so is a trust failure, and SmartScreen would be the first
 * thing to mention it.
 *
 * The release-notes requirement is checked on the *generator* rather than on
 * RELEASE_NOTES.md, because that file only exists once a release has been built.
 * ------------------------------------------------------------------ */
const UNSIGNED_SURFACES = [
  { file: 'README.md', what: 'the README' },
  { file: 'apps/desktop/src/renderer/features/updates/UpdateDialog.tsx', what: 'the update dialog' },
  { file: 'scripts/release/extract-notes.mjs', what: 'the release-notes generator' },
  { file: 'docs/release.md', what: 'the release documentation' },
];

for (const surface of UNSIGNED_SURFACES) {
  const path = join(ROOT, surface.file);
  if (!existsSync(path)) {
    fail(`${surface.file} is missing; ${surface.what} carries the unsigned notice.`);
    continue;
  }
  if (!/unsigned/i.test(readFileSync(path, 'utf8'))) {
    fail(
      `${surface.what} (${surface.file}) does not mention that the build is unsigned. ` +
        `SPEC 15 §6.4 requires it on every surface the user can reach.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 9. The packaging config must agree with package.json.
 *
 * `electron` was declared only at the workspace root, so electron-builder —
 * which runs in apps/desktop — could not resolve a version at all:
 *   "Cannot compute electron version from installed node modules"
 * The release job would have failed at the last step, after the version was
 * bumped and pushed. Packaging is the one thing that cannot be exercised on
 * every commit, so it gets checked statically instead.
 * ------------------------------------------------------------------ */
const builderConfigPath = join(ROOT, 'apps', 'desktop', 'electron-builder.yml');
if (existsSync(builderConfigPath)) {
  const yaml = readFileSync(builderConfigPath, 'utf8');
  const desktopManifest = JSON.parse(
    readFileSync(join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8'),
  );

  const declaredElectron =
    desktopManifest.devDependencies?.electron ?? desktopManifest.dependencies?.electron ?? null;
  if (!declaredElectron) {
    fail(
      'apps/desktop/package.json does not declare "electron". electron-builder runs in that ' +
        'directory and cannot resolve a version from the workspace root alone.',
    );
  }

  const pinned = /^electronVersion:\s*([\w.]+)/m.exec(yaml)?.[1];
  if (!pinned) {
    fail('apps/desktop/electron-builder.yml does not pin electronVersion.');
  } else if (declaredElectron && !declaredElectron.includes(pinned)) {
    fail(
      `electron-builder.yml pins electron ${pinned} but package.json asks for ${declaredElectron}. ` +
        `The release would ship a different Electron than the one that was tested.`,
    );
  }

  // `files` must include what the main process actually loads. Matched by
  // directory rather than by exact path, because the config globs a tree
  // (`dist/main/**/*`) and demanding the literal filename would be a false alarm.
  const mainEntry = (desktopManifest.main ?? './dist/main/index.cjs').replace(/^\.\//, '');
  const mainDir = mainEntry.includes('/') ? mainEntry.slice(0, mainEntry.lastIndexOf('/')) : '.';
  if (!yaml.includes(mainDir)) {
    fail(`electron-builder.yml does not package ${mainDir}/, which holds package.json's "main" (${mainEntry}).`);
  }
}

/* ------------------------------------------------------------------ *
 * 10. File-name references in the package config must match package.json.
 * ------------------------------------------------------------------ */
const desktopPkg = JSON.parse(readFileSync(join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8'));
const mainEntry = desktopPkg.main ?? 'dist/main/index.cjs';
const mainOnDisk = join(ROOT, 'apps', 'desktop', mainEntry);
if (!existsSync(mainOnDisk) && existsSync(join(ROOT, 'apps', 'desktop', 'dist'))) {
  // Only meaningful when a build exists; the release job asserts it after building.
  fail(`apps/desktop/package.json "main" is ${mainEntry}, which the build did not produce.`);
}

/* ------------------------------------------------------------------ *
 * 11. Every `uses:` in a workflow must name an action that exists.
 * ------------------------------------------------------------------ */
// A pinned action that does not resolve kills the job at "Set up job", before a
// single step runs — and it does so only in CI, on a branch push, which is the
// slowest possible feedback loop. That is exactly what happened: two of the four
// pinned actions in this repository bore SHAs from no commit in their own repo,
// so `ci.yml` had never once executed and `release.yml` would have failed at its
// upload step. Nothing local could catch it.
//
// This cannot verify a SHA without network access, and check-repo must run
// offline. What it can check is that each pin is a full 40-character SHA with a
// version comment — a real SHA is the only thing GitHub will accept, and the
// comment is what makes the pin reviewable.
const SHA_PIN = /^[0-9a-f]{40}$/;
const USES_LINE = /^\s*(?:-\s*)?uses:\s*(\S+)\s*(?:#\s*(\S+))?\s*$/;
for (const file of workflowFiles) {
  const lines = readFileSync(join(workflowDir, file), 'utf8').split('\n');
  lines.forEach((line, index) => {
    const match = USES_LINE.exec(line);
    if (match === null) return;
    const [, ref, comment] = match;
    // Local composite actions use `./path` and are not pinned.
    if (ref.startsWith('./')) return;
    if (!ref.includes('@')) {
      problems.push(`${file}:${index + 1} uses "${ref}" with no @ref.`);
      return;
    }
    const [action, sha] = ref.split('@');
    if (!SHA_PIN.test(sha)) {
      problems.push(
        `${file}:${index + 1} pins ${action} to "${sha}", which is not a full 40-character commit SHA.`,
      );
    }
    if (comment === undefined) {
      problems.push(
        `${file}:${index + 1} pins ${action} without a version comment; write "# v4.2.2" so the pin can be reviewed.`,
      );
    }
  });
}

/* ------------------------------------------------------------------ *
 * An ungated test must not reach a binary.
 *
 * CI has no ffmpeg; this checkout bundles one in `resources/bin`. A test that starts a render
 * therefore passes locally and fails in CI, and it fails in the *worst* way: the spawn rejection
 * arrives after the assertion, as an unhandled error, so the report says "0 failed" and the build
 * says exit 1. That cost two red runs to diagnose (`docs/decisions.md` §64–65).
 *
 * The static rule is narrow on purpose: a test file that never mentions the ffmpeg gate must not
 * start an export or invoke a binary. It cannot prove a call is safe — `start()` is the interesting
 * one and it is spelled plainly — so it checks the two things that are reliably visible:
 *
 *  - a file that calls `service.start(` / `startExport(` must carry a gate; and
 *  - a file that spawns or execs a binary must carry one too.
 *
 * A gate is `skipIf(!HAS_FFMPEG)`, `describe.skipIf`, or an explicit `usableBinary(...)` guard —
 * anything that makes the file honest about needing the binary.
 * ------------------------------------------------------------------ */
/*
  Every shape of gate this repo actually uses: vitest's `skipIf`/`runIf`, the shared
  `usableBinary` helper, the per-file `HAS_FFMPEG` constant, and a local `hasFfmpeg`-style probe.
  Matching the *idioms* rather than one name is what keeps the check from flagging files that are
  already correct — two of the first three hits were, and a lint that cries wolf gets disabled.
*/
const GATE = /skipIf\(|\brunIf\(|usableBinary\(|HAS_FFMPEG|hasFfmpeg|hasBinary/i;
/*
  Only the *media* binaries, not every child process: `release-roundtrip` runs `process.execPath`
  (node itself), which exists wherever the test runs. Flagging it would be the false positive that
  gets this check deleted.
*/
const STARTS_WORK = /\b(?:service|runner|queue)\.start\(|\bstartExport\(|\bffmpegPath\(|\bffprobePath\(|\bFFMPEG\b|\bFFPROBE\b/;
for (const file of tracked) {
  if (!file.endsWith('.test.ts') && !file.endsWith('.test.tsx')) continue;
  const source = readFileSync(join(ROOT, file), 'utf8');
  if (!STARTS_WORK.test(source)) continue;
  if (GATE.test(source)) continue;
  problems.push(
    `${file} starts an export or a binary but has no gate. CI has no ffmpeg, so this passes locally ` +
      `and fails there as an unhandled "spawn ffmpeg ENOENT" after the assertions (see ` +
      `docs/decisions.md §65). Gate it, or call the pure decision function instead.`,
  );
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
