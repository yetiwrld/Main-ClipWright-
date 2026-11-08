#!/usr/bin/env node
/**
 * Turn a gitleaks JSON report into check annotations.
 *
 * The scan runs on the Windows CI runner, where the console output is not
 * reachable from a local session (`gh run view --log` returns EOF). Without this
 * the only signal is "gitleaks exited 1", which is equally consistent with one
 * real leaked credential and with forty test fixtures that contain strings the
 * rules are supposed to match.
 *
 * Prints the file, line and rule for each finding — never the secret itself.
 *
 * Usage: node scripts/ci-annotate-leaks.mjs [report.json]
 */
import { existsSync, readFileSync } from 'node:fs';

const reportPath = process.argv[2] ?? 'gitleaks-report.json';

const escape = (text) =>
  String(text).replaceAll('%', '%25').replaceAll('\r', '').replaceAll('\n', ' ');

if (!existsSync(reportPath)) {
  console.log(`::error title=no gitleaks report::${escape(`No report at ${reportPath}.`)}`);
  process.exit(0);
}

let findings;
try {
  findings = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (!Array.isArray(findings)) findings = [];
} catch (error) {
  console.log(`::error title=unreadable gitleaks report::${escape(error)}`);
  process.exit(0);
}

// Count by rule: one annotation per rule says more than forty identical ones.
const byRule = new Map();
for (const finding of findings) {
  const rule = finding.RuleID ?? 'unknown-rule';
  const where = `${finding.File ?? '?'}:${finding.StartLine ?? '?'}`;
  byRule.set(rule, [...(byRule.get(rule) ?? []), where]);
}

for (const [rule, places] of byRule) {
  console.log(
    `::error title=${escape(rule)} (${places.length})::${escape(places.slice(0, 15).join(', '))}` +
      (places.length > 15 ? escape(` …and ${places.length - 15} more`) : ''),
  );
}

console.log(
  `::error title=gitleaks summary::${escape(`${findings.length} finding(s) across ${byRule.size} rule(s).`)}`,
);
