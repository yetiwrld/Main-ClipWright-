#!/usr/bin/env node
/**
 * Print one GitHub `::error` annotation per failing test, from vitest's JSON
 * report.
 *
 * Written because reading a failed CI run from here is otherwise impossible:
 * `gh run view --log` returns EOF, and annotations built by grepping the console
 * output are at the mercy of colour codes, wrapping and truncation — the first
 * attempt produced an empty list and reported nothing at all.
 *
 * The JSON report is machine-written and unambiguous, so this is the one path
 * that reliably names every failure.
 *
 * Usage: node scripts/ci-annotate-failures.mjs [path-to-report]
 */
import { existsSync, readFileSync } from 'node:fs';

const reportPath = process.argv[2] ?? '.vitest-report.json';

/** GitHub command syntax treats `%` and newlines specially. */
function escape(text) {
  return text.replaceAll('%', '%25').replaceAll('\r', '').replaceAll('\n', ' ');
}

if (!existsSync(reportPath)) {
  console.log(`::error title=no report::${escape(`No vitest report at ${reportPath}.`)}`);
  process.exit(0);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.log(`::error title=unreadable report::${escape(String(error))}`);
  process.exit(0);
}

const failures = [];
for (const file of report.testResults ?? []) {
  for (const assertion of file.assertionResults ?? []) {
    if (assertion.status !== 'failed') continue;
    const firstLine = (assertion.failureMessages?.[0] ?? '').split('\n').find((line) => line.trim()) ?? '';
    failures.push({ file: file.name ?? '', name: assertion.fullName ?? assertion.title ?? '', firstLine });
  }
}

console.log(
  `::error title=summary::${escape(
    `${report.numFailedTests ?? failures.length} failed, ${report.numPassedTests ?? 0} passed, ` +
      `${report.numPendingTests ?? 0} skipped of ${report.numTotalTests ?? 0} tests.`,
  )}`,
);

for (const failure of failures.slice(0, 20)) {
  // Strip the absolute path so the annotation names the file, not the runner's
  // checkout directory.
  // Forward slashes only: GitHub resolves the `file=` attribute against the
  // repository tree, where paths are POSIX even when the runner is Windows.
  const normalised = failure.file.replaceAll('\\', '/');
  const marker = normalised.search(/(?:^|\/)(?:apps|packages)\//);
  const short = marker === -1 ? normalised : normalised.slice(marker + 1);
  console.log(
    `::error file=${short},title=${escape(failure.name).slice(0, 180)}::${escape(failure.firstLine).slice(0, 800)}`,
  );
}
