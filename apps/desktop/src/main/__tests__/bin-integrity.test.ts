// @vitest-environment node
/**
 * SPEC 15 §6.1 — a binary whose checksum does not match must be disabled, not run.
 *
 * These tests matter out of proportion to their size: `ffmpeg` is spawned with
 * paths inside the user's workspace, so a swapped binary is code execution. The
 * behaviours below are the difference between noticing and not noticing.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isToolEnabled,
  sha256OfFile,
  summariseIntegrity,
  verifyBundledTools,
} from '../bin-integrity.js';

const TMP = join(process.cwd(), '.tmp-bin-integrity');
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** Write a fake tool plus a checksums.json that describes it. */
function makeBinDir(files: Record<string, string>, checksums?: Record<string, string>) {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(TMP, name), content);
  }
  const manifest =
    checksums ?? Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha256(content)]));
  writeFileSync(join(TMP, 'checksums.json'), JSON.stringify(manifest, null, 2));
}

describe('verifyBundledTools', () => {
  it('accepts tools that match their recorded checksums', async () => {
    makeBinDir({ ffmpeg: 'real ffmpeg', ffprobe: 'real ffprobe' });
    // Only the two tools that exist here: the default list also covers yt-dlp and
    // whisper-cli, and reporting those as missing would be correct, not a pass.
    const report = await verifyBundledTools({ binDir: TMP, tools: ['ffmpeg', 'ffprobe'] });

    expect(report.tools.ffmpeg).toMatchObject({ state: 'ok' });
    expect(report.tools.ffprobe).toMatchObject({ state: 'ok' });
    expect(report.enabled).toContain('ffmpeg');
    expect(report.problems).toEqual([]);
    expect(summariseIntegrity(report)).toBeNull();
  });

  it('accepts the .exe names Windows ships', async () => {
    makeBinDir({ 'ffmpeg.exe': 'windows ffmpeg' });
    const report = await verifyBundledTools({ binDir: TMP, tools: ['ffmpeg'] });
    expect(report.tools.ffmpeg.state).toBe('ok');
  });

  it('disables a binary whose bytes changed', async () => {
    // The attack this exists for: something replaced ffmpeg after installation.
    makeBinDir({ ffmpeg: 'the real one' }, { ffmpeg: sha256('a different binary') });
    const report = await verifyBundledTools({ binDir: TMP, tools: ['ffmpeg'] });

    const status = report.tools.ffmpeg;
    expect(status.state).toBe('mismatch');
    if (status.state === 'mismatch') {
      expect(status.expected).toBe(sha256('a different binary'));
      expect(status.actual).toBe(sha256('the real one'));
    }
    expect(isToolEnabled(report, 'ffmpeg')).toBe(false);
    expect(report.problems[0]).toContain('disabled');
    expect(report.problems[0]).toContain('Reinstall');
  });

  it('reports a missing tool rather than ignoring it', async () => {
    makeBinDir({ ffmpeg: 'real ffmpeg' });
    const report = await verifyBundledTools({ binDir: TMP, tools: ['ffmpeg', 'whisper-cli'] });

    expect(report.tools['whisper-cli'].state).toBe('missing');
    expect(report.problems.some((p) => p.includes('whisper-cli is missing'))).toBe(true);
    expect(report.enabled).toEqual(['ffmpeg']);
  });

  it('treats a missing checksums.json as unverified, never as fine', async () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    writeFileSync(join(TMP, 'ffmpeg'), 'bytes');

    const report = await verifyBundledTools({ binDir: TMP, tools: ['ffmpeg'] });
    expect(report.manifestPresent).toBe(false);
    expect(report.tools.ffmpeg.state).toBe('unverified');
    expect(report.enabled).toEqual([]);
    expect(summariseIntegrity(report)).toContain('could not be verified');
  });

  it('treats a corrupt checksums.json as unverified', async () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(join(TMP, 'ffmpeg'), 'bytes');
    writeFileSync(join(TMP, 'checksums.json'), '{not json');

    const report = await verifyBundledTools({ binDir: TMP, tools: ['ffmpeg'] });
    expect(report.tools.ffmpeg.state).toBe('unverified');
  });

  it('reports a tool with no recorded checksum as unverified, not ok', async () => {
    // Silently passing an unlisted binary would make the manifest meaningless.
    makeBinDir({ ffmpeg: 'bytes', extra: 'unlisted' }, { ffmpeg: sha256('bytes') });
    const report = await verifyBundledTools({ binDir: TMP, tools: ['extra'] });
    expect(report.tools.extra.state).toBe('unverified');
  });

  it('ignores a malformed recorded checksum instead of matching against it', async () => {
    makeBinDir({ ffmpeg: 'bytes' }, { ffmpeg: 'not-a-sha256' });
    const report = await verifyBundledTools({ binDir: TMP, tools: ['ffmpeg'] });
    expect(report.tools.ffmpeg.state).toBe('unverified');
  });

  it('never throws, even when hashing fails', async () => {
    makeBinDir({ ffmpeg: 'bytes' });
    const report = await verifyBundledTools({
      binDir: TMP,
      tools: ['ffmpeg'],
      hashFile: async () => {
        throw new Error('EPERM');
      },
    });
    expect(report.tools.ffmpeg.state).toBe('unverified');
  });

  it('summarises several problems as one sentence', async () => {
    makeBinDir({}, {});
    const report = await verifyBundledTools({ binDir: TMP, tools: ['ffmpeg', 'ffprobe', 'yt-dlp'] });
    expect(summariseIntegrity(report)).toBe('3 bundled tools could not be verified. Reinstall Clipwright Studio.');
  });

  it('hashes a real file correctly', async () => {
    mkdirSync(TMP, { recursive: true });
    const path = join(TMP, 'thing');
    writeFileSync(path, 'hello world');
    expect(await sha256OfFile(path)).toBe(sha256('hello world'));
  });
});
