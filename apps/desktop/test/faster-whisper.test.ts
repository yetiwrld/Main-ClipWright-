/**
 * Unit tests for the faster-whisper helper logic — pure filesystem/parse logic only.
 * No Python, no models, no network. The end-to-end transcription path is NOT
 * covered here (and is documented as unverified).
 */
import { test, expect, describe, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseHfCacheDirName,
  resolveHfHubCache,
  scanFasterWhisperModels,
  pythonCandidates,
  FASTER_WHISPER_PREFIX,
} from '../src/main/fasterWhisper.ts';

describe('parseHfCacheDirName', () => {
  test('splits org and repo at the first double dash', () => {
    assert.equal(parseHfCacheDirName('models--Systran--faster-whisper-medium'), 'Systran/faster-whisper-medium');
    assert.equal(parseHfCacheDirName('models--mobiuslabsgmbh--faster-whisper-large-v3-turbo'), 'mobiuslabsgmbh/faster-whisper-large-v3-turbo');
  });
  test('rejects non-model dirs and malformed names', () => {
    assert.equal(parseHfCacheDirName('not-a-model'), null);
    assert.equal(parseHfCacheDirName('models--noseparator'), null);
    assert.equal(parseHfCacheDirName('models----repo'), null);
    assert.equal(parseHfCacheDirName(''), null);
  });
});

describe('resolveHfHubCache', () => {
  test('HF_HUB_CACHE wins over everything', () => {
    assert.equal(resolveHfHubCache({ HF_HUB_CACHE: 'D:\\hf\\hub', HF_HOME: 'D:\\hf' }, 'C:\\Users\\x'), 'D:\\hf\\hub');
  });
  test('HF_HOME appends hub', () => {
    assert.equal(resolveHfHubCache({ HF_HOME: 'D:\\hf' }, 'C:\\Users\\x'), join('D:\\hf', 'hub'));
  });
  test('defaults to ~/.cache/huggingface/hub', () => {
    const p = resolveHfHubCache({}, '/home/yeti');
    assert.match(p.replace(/\\/g, '/'), /\/home\/yeti\/\.cache\/huggingface\/hub$/);
  });
});

describe('scanFasterWhisperModels', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cw-hfhub-'));
    const mk = (orgRepo: string, sha: string, binBytes: number, withConfig = true) => {
      const dir = join(root, `models--${orgRepo.replace('/', '--')}`, 'snapshots', sha);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'model.bin'), Buffer.alloc(binBytes));
      if (withConfig) writeFileSync(join(dir, 'config.json'), '{}');
    };
    // complete model
    mk('Systran/faster-whisper-small', 'aaa111', 1_500_000);
    // complete model with two snapshots — newest mtime should win (both valid here)
    mk('Systran/faster-whisper-medium', 'bbb222', 2_000_000);
    // incomplete: bin too small
    mk('Systran/faster-whisper-tiny', 'ccc333', 500_000);
    // missing config.json
    mk('Systran/faster-whisper-base', 'ddd444', 2_000_000, false);
    // repo name with dashes in the repo part
    mk('mobiuslabsgmbh/faster-whisper-large-v3-turbo', 'eee555', 1_700_000);
    // junk dir that must be ignored
    mkdirSync(join(root, 'datasets--some--junk'), { recursive: true });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('finds complete CT2 snapshots and ignores incomplete ones', () => {
    const found = scanFasterWhisperModels(root).map((m) => m.repoId).sort();
    assert.deepEqual(found, [
      'Systran/faster-whisper-medium',
      'Systran/faster-whisper-small',
      'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
    ]);
  });

  test('snapshot path points at the snapshot containing model.bin', () => {
    const small = scanFasterWhisperModels(root).find((m) => m.repoId === 'Systran/faster-whisper-small');
    assert.ok(small);
    assert.match(small!.snapshotPath.replace(/\\/g, '/'), /models--Systran--faster-whisper-small\/snapshots\/aaa111$/);
    assert.ok(small!.sizeBytes >= 1_500_000);
  });

  test('a missing hub cache returns an empty list, not an error', () => {
    assert.deepEqual(scanFasterWhisperModels(join(root, 'does-not-exist')), []);
  });
});

describe('pythonCandidates', () => {
  const env = {
    CLIPWRIGHT_PYTHON: 'D:\\Python\\python.exe',
    LOCALAPPDATA: 'C:\\Users\\Yeti\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    USERPROFILE: 'C:\\Users\\Yeti',
  };
  test('explicit CLIPWRIGHT_PYTHON is tried first', () => {
    const c = pythonCandidates(env, 'win32');
    assert.equal(c[0]!.command, 'D:\\Python\\python.exe');
    assert.equal(c[0]!.label, 'CLIPWRIGHT_PYTHON');
  });
  test('py launcher 3.12 comes before the unversioned launcher', () => {
    const c = pythonCandidates(env, 'win32').filter((x) => x.command === 'py');
    assert.equal(c[0]!.args.join(' '), '-3.12');
    assert.equal(c[c.length - 1]!.args.length, 0, 'bare py fallback last');
  });
  test('without an override, py candidates come first and CLIPWRIGHT_PYTHON adds none', () => {
    const c = pythonCandidates({}, 'win32');
    assert.equal(c[0]!.command, 'py');
    assert.ok(!c.some((x) => x.label === 'CLIPWRIGHT_PYTHON'));
  });
  test('prefix for settings selection is stable', () => {
    assert.equal(FASTER_WHISPER_PREFIX, 'faster-whisper:');
  });
});
