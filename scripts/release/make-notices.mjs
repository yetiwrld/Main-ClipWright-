#!/usr/bin/env node
/**
 * SPEC 15 §6.2 — generate `THIRD-PARTY-NOTICES.txt`.
 *
 * The document that ships inside the installer. It lists what the app actually
 * contains, read from the real installed packages rather than from a list someone
 * typed and forgot to update.
 *
 * CI fails on a dependency with no recognisable licence, because "we're not sure
 * what this is licensed under" is not something you can ship.
 *
 * Usage:
 *   node scripts/release/make-notices.mjs                  # write the file
 *   node scripts/release/make-notices.mjs --check          # verify, exit 1 if stale
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'THIRD-PARTY-NOTICES.txt');
const check = process.argv.includes('--check');

/** Runtimes that are documented by hand because their licence text is large. */
const HANDWRITTEN = [
  {
    name: 'FFmpeg / ffprobe',
    licence: 'GPL v2+ (this build includes libx264, libvpx, libopus, native AAC)',
    note:
      'Distributed as separate executables in resources/bin and invoked as child processes; never linked into the application.\n' +
      'Source: https://ffmpeg.org/download.html and https://git.videolan.org/?p=ffmpeg.git\n' +
      'Users may obtain the corresponding source from those addresses, free of charge.',
  },
  {
    name: 'whisper.cpp',
    licence: 'MIT',
    note: 'Separate CLI executable (whisper-cli). Copyright (c) Georgi Gerganov. https://github.com/ggml-org/whisper.cpp',
  },
  {
    name: 'yt-dlp',
    licence: 'The Unlicense',
    note: 'Separate executable. https://github.com/yt-dlp/yt-dlp',
  },
  {
    name: 'Electron / Chromium',
    licence: 'MIT (Electron) and the Chromium BSD licences',
    note: 'The full Chromium notices ship alongside the app as LICENSES.chromium.html.',
  },
];

/** A licence field is sometimes a string, sometimes an object or an array. */
function licenceOf(pkg) {
  const licence = pkg.license;
  if (typeof licence === 'string' && licence.trim()) return licence.trim();
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((entry) => entry?.type).filter(Boolean).join(' OR ');
  }
  if (typeof pkg.licenses === 'object' && pkg.licenses?.type) return pkg.licenses.type;
  return null;
}

/**
 * Walk the runtime dependencies that actually ship, one level deep.
 *
 * Only `apps/desktop/node_modules` is read, because that is the only place a
 * *shipped* dependency lives: the root `package.json` declares no dependencies at
 * all — every entry is a devDependency — yet pnpm links the whole toolchain into
 * the root `node_modules`. Scanning it listed vitest, jsdom, playwright and
 * electron-builder as third-party components of a shipping app.
 *
 * `apps/desktop/package.json` names the entry point, and electron-builder packs
 * from that directory, so its production dependencies are the shipping set.
 */
async function collect() {
  const roots = [join(ROOT, 'apps', 'desktop', 'node_modules')];
  const seen = new Map();

  for (const nodeModules of roots) {
    if (!existsSync(nodeModules)) continue;
    const scoped = await readdir(nodeModules, { withFileTypes: true }).catch(() => []);

    for (const entry of scoped) {
      const candidates = entry.name.startsWith('@')
        ? (await readdir(join(nodeModules, entry.name), { withFileTypes: true }).catch(() => [])).map(
            (child) => join(entry.name, child.name),
          )
        : [entry.name];

      for (const relative of candidates) {
        if (relative.startsWith('.') || relative.startsWith('@clipwright')) continue;
        const packagePath = join(nodeModules, relative, 'package.json');
        if (!existsSync(packagePath)) continue;
        try {
          const pkg = JSON.parse(await readFile(packagePath, 'utf8'));

          // Skip anything platform-conditional. These are native helper
          // packages — `@ffmpeg-installer/linux-x64` and its win32 twin — that
          // exist as dev dependencies so the encoder suites have a binary to run.
          // Whatever machine generates this file installs exactly one variant, so
          // including them makes the output depend on the host: a list committed
          // from Linux can never match one generated on the Windows CI runner.
          // They do not ship, and they are documented by hand above.
          if (pkg.os || pkg.cpu) continue;

          // Only runtime dependencies ship; dev tooling does not.
          if (pkg.devDependencies && !pkg.dependencies && relative === 'typescript') continue;
          seen.set(pkg.name, {
            name: pkg.name,
            version: pkg.version ?? 'unknown',
            licence: licenceOf(pkg),
            repository:
              typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '',
          });
        } catch {
          // A malformed package.json is the package manager's problem, not ours.
        }
      }
    }
  }
  return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name));
}

const packages = await collect();
const unlicensed = packages.filter((pkg) => !pkg.licence);

if (unlicensed.length > 0 && !check) {
  console.error('\nmake-notices: these packages declare no licence:\n');
  for (const pkg of unlicensed) console.error(`  - ${pkg.name}@${pkg.version}`);
  console.error('\nSPEC 15 §6.2 requires failing on an unknown licence. Fix the pins or add');
  console.error('an entry to HANDWRITTEN with a reviewed licence.\n');
  process.exit(1);
}

const lines = [
  'Clipwright Studio — Third-Party Notices',
  '=======================================',
  '',
  'This file lists the third-party components distributed with Clipwright Studio.',
  'It is generated by scripts/release/make-notices.mjs from the packages actually',
  'installed, so it cannot silently drift from what the app contains.',
  '',
  'The full licence texts, source offers and reasoning for each component are in',
  'docs/licences.md, which also ships with the source.',
  '',
  '',
  'Standalone executables',
  '----------------------',
  '',
];

for (const entry of HANDWRITTEN) {
  lines.push(`${entry.name}`);
  lines.push(`  Licence: ${entry.licence}`);
  for (const noteLine of entry.note.split('\n')) lines.push(`  ${noteLine}`);
  lines.push('');
}

lines.push('', 'Bundled fonts', '-------------', '');
lines.push('All bundled fonts are licensed under the SIL Open Font License 1.1 (OFL-1.1).');
lines.push('Manrope, Inter, Montserrat, Poppins, Anton, Playfair Display, Bangers,');
lines.push('JetBrains Mono. Each retains its own copyright; see docs/licences.md.');
lines.push('');

lines.push('', `JavaScript packages (${packages.length})`, '-'.repeat(30), '');
for (const pkg of packages) {
  const suffix = pkg.repository ? `  ${pkg.repository}` : '';
  lines.push(`${pkg.name}@${pkg.version}  —  ${pkg.licence ?? 'licence unknown'}${suffix}`);
}

lines.push('');
lines.push('');
lines.push('If you believe a component is listed incorrectly or is missing, please open');
lines.push('an issue: https://github.com/yetiwrld/Main-ClipWright-/issues');
lines.push('');

const text = lines.join('\n');

if (check) {
  // Compare with line endings normalised.
  //
  // There is no `.gitattributes` in this repository, so Git's `core.autocrlf`
  // applies: on the Windows CI runner the file is checked out with `CRLF`, while
  // this generator writes `LF`. Comparing raw text made every single line differ
  // on Windows and none on Linux — a failure that looked like nine wrong versions
  // and was really one wrong assumption about the checkout.
  const current = (await readFile(OUT, 'utf8').catch(() => '')).replaceAll('\r\n', '\n');
  if (current !== text) {
    // Name what differs. "The file is out of date" is unactionable when the
    // difference is one platform-specific package, which is exactly what happens
    // between a Linux checkout and the Windows runner: 80 entries in the lockfile
    // are conditional on `os`/`cpu`, so the installed set genuinely differs.
    // The JavaScript section lists `name@version  —  licence  repository`, one per
    // line. Parse from that heading onward only: the prose above it explains the
    // bundled runtimes, and a looser pattern reads "Licence:" and "Distributed"
    // as package names.
    const listed = new Set();
    const body = current.slice(current.indexOf('JavaScript packages'));
    for (const line of body.split('\n')) {
      const match = /^(\S+?)@[^\s]+\s+—/.exec(line);
      if (match) listed.add(match[1]);
    }
    const expected = new Set(packages.map((pkg) => pkg.name));
    const added = [...expected].filter((name) => !listed.has(name));
    const removed = [...listed].filter((name) => !expected.has(name));
    console.error('\nmake-notices: THIRD-PARTY-NOTICES.txt is out of date.');
    if (added.length > 0) console.error(`  installed but not listed: ${added.join(', ')}`);
    if (removed.length > 0) console.error(`  listed but not installed: ${removed.join(', ')}`);
    if (added.length === 0 && removed.length === 0) {
      // Diff the package lines directly. "A version or URL changed" names a class
      // of problem, not the problem, and this check runs on two platforms whose
      // installs can legitimately differ in version resolution.
      const currentLines = new Set(
        current.slice(current.indexOf('JavaScript packages')).split('\n'),
      );
      const changes = text
        .slice(text.indexOf('JavaScript packages'))
        .split('\n')
        .filter((line) => /@/.test(line) && /—/.test(line) && !currentLines.has(line));
      if (changes.length > 0) {
        console.error(`  ${changes.length} package line(s) differ, expected:`);
        for (const line of changes.slice(0, 10)) console.error(`    ${line}`);
      } else {
        console.error('  The package lines match; the difference is in the prose above them.');
      }
    }
    console.error('Run `node scripts/release/make-notices.mjs` and commit the result.\n');
    // Also emit a check annotation: this step fails on the Windows CI runner while
    // passing on a Linux checkout, and the console output of that step is not
    // reachable from here. `%` and newlines are escaped per GitHub's command syntax.
    const announce = (message) =>
      console.log(`::error title=notices out of date::${message.replaceAll('%', '%25').replaceAll('\n', ' ')}`);
    if (added.length > 0) announce(`installed but not listed: ${added.join(', ')}`);
    if (removed.length > 0) announce(`listed but not installed: ${removed.join(', ')}`);
    if (added.length === 0 && removed.length === 0) {
      const currentLines = new Set(current.slice(current.indexOf('JavaScript packages')).split('\n'));
      const changes = text
        .slice(text.indexOf('JavaScript packages'))
        .split('\n')
        .filter((line) => /@/.test(line) && /—/.test(line) && !currentLines.has(line));
      announce(
        changes.length > 0
          ? `expected: ${changes.slice(0, 6).join(' | ')}`
          : 'Same packages and lines; the prose differs.',
      );
    }
    process.exit(1);
  }
  console.log(`make-notices: OK — ${packages.length} packages, file is current.`);
  process.exit(0);
}

await writeFile(OUT, text);
console.log(`Wrote THIRD-PARTY-NOTICES.txt (${packages.length} packages).`);
