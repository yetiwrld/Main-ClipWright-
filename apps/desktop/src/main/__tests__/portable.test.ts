// @vitest-environment node
/**
 * SPEC 15 §6.3 — the portable build.
 *
 * The rule worth protecting: with no `portable.flag`, a portable copy behaves
 * like an installed one. Storing data next to the exe by default would mean a
 * user who moves or deletes the exe loses their workspace.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectPortableMode, portableExeName, portableUpdateFolder } from '../portable.js';

const TMP = join(process.cwd(), '.tmp-portable');

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('detectPortableMode', () => {
  it('is not portable for an installed build', () => {
    expect(detectPortableMode('/opt/clipwright', {})).toEqual({
      isPortable: false,
      usesLocalData: false,
      dataDir: null,
    });
  });

  it('uses %APPDATA% for a portable build with no flag (the default)', () => {
    mkdirSync(TMP, { recursive: true });
    const info = detectPortableMode(TMP, { PORTABLE_EXECUTABLE_DIR: TMP });
    expect(info.isPortable).toBe(true);
    expect(info.usesLocalData).toBe(false);
    expect(info.dataDir).toBeNull();
  });

  it('uses ClipwrightData next to the exe when the flag exists', () => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(join(TMP, 'portable.flag'), '');
    const info = detectPortableMode(TMP, { PORTABLE_EXECUTABLE_DIR: TMP });
    expect(info.usesLocalData).toBe(true);
    expect(info.dataDir).toBe(join(TMP, 'ClipwrightData'));
  });

  it('ignores the flag for an installed build', () => {
    // A stray portable.flag in a program folder must not redirect user data.
    mkdirSync(TMP, { recursive: true });
    writeFileSync(join(TMP, 'portable.flag'), '');
    expect(detectPortableMode(TMP, {}).usesLocalData).toBe(false);
  });

  it('treats an empty env var as not portable', () => {
    expect(detectPortableMode(TMP, { PORTABLE_EXECUTABLE_DIR: '   ' }).isPortable).toBe(false);
  });
});

describe('portable update helpers', () => {
  it('points downloads at an Updates folder beside the exe', () => {
    expect(portableUpdateFolder('C:\\Apps')).toBe(join('C:\\Apps', 'Updates'));
  });

  it('names the portable artefact the user must replace', () => {
    expect(portableExeName('1.3.0')).toBe('Clipwright-Studio-1.3.0-x64-portable.exe');
  });
});
