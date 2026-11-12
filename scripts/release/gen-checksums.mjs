#!/usr/bin/env node
/**
 * Write sha256 checksums for the binaries staged in resources/bin/ into
 * checksums.json. Run by the release workflow after fetching binaries.
 * Fails loudly if the directory is empty of binaries — an installer without
 * binaries must never be produced silently.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const binDir = join(dirname(fileURLToPath(import.meta.url)), '../../apps/desktop/resources/bin');
const tracked = ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe', 'whisper-cli.exe', 'whisper-cli-avx2.exe'];
const found = readdirSync(binDir).filter((f) => tracked.includes(f));

if (found.length === 0) {
  console.error('resources/bin contains none of the expected binaries:', tracked.join(', '));
  console.error('Refusing to write checksums.json for an empty payload.');
  process.exit(1);
}

const sums = {};
for (const f of found.sort()) {
  const hash = createHash('sha256').update(readFileSync(join(binDir, f))).digest('hex');
  sums[f] = hash;
  console.log(`${hash}  ${f}  (${statSync(join(binDir, f)).size} bytes)`);
}
writeFileSync(join(binDir, 'checksums.json'), JSON.stringify(sums, null, 2) + '\n');
console.log('checksums.json updated:', Object.keys(sums).join(', '));
