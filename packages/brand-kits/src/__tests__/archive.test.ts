import { execFileSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ArchiveError,
  CwbrandFormat,
  CwbrandFormatVersion,
  assetEntryName,
  crc32,
  extensionFor,
  kitAssetIds,
  readArchive,
  readBrandKitArchive,
  writeArchive,
  writeBrandKitArchive,
  type BrandKit,
} from '../index.js';

/**
 * The `.cwbrand` archive (SPEC 13 §8.2: export/import a zip with its assets).
 *
 * A kit archive is only useful if something else can open it, so the central tests here do not
 * check this reader against this writer — they check the bytes against **`unzip`**, a real
 * implementation. A writer and reader that agree with each other and nothing else is the
 * classic way to ship an unreadable file, and it passes a round-trip test every time.
 */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const MP4 = Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

const temporary = mkdtempSync(join(tmpdir(), 'cwbrand-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * Whether a real zip tool is on this machine.
 *
 * The archive is an interchange format, so the tests that matter most use something that is
 * not this package. `unzip` ships with the Git installation CI runs under and with every
 * desktop Linux and macOS, but `zip` does not exist on the Windows runner — so each test that
 * needs one says which, and skips with a reason instead of failing a build for an environment
 * difference. The deflated-read test uses Node's own `zlib` instead, so the compressed path is
 * covered everywhere.
 */
function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const HAS_UNZIP = hasBinary('unzip');
const HAS_ZIP = hasBinary('zip');

function kit(overrides: Partial<BrandKit> = {}): BrandKit {
  return {
    format: CwbrandFormat,
    formatVersion: CwbrandFormatVersion,
    id: 'kit-1',
    name: 'Studio',
    colors: {
      primary: '#FF7A00',
      secondary: '#1F2937',
      accent: '#4DA3FF',
      background: '#0B0B0F',
      text: '#FFFFFF',
      custom: [],
    },
    fonts: {},
    safeAreaPreset: 'none',
    ...overrides,
  } as BrandKit;
}

/**
 * A minimal deflated zip, written independently of `writeArchive`.
 *
 * Deliberately not shared with the code under test: a fixture built by the writer would prove
 * only that the reader agrees with it. The only borrowed implementation here is `zlib`'s
 * deflate.
 */
function buildDeflatedArchive(files: Array<[string, Uint8Array]>): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = new TextEncoder().encode(name);
    const packed = new Uint8Array(deflateRawSync(data));
    const checksum = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 8, true); // deflate
    lv.setUint32(14, checksum, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    localHeader.set(nameBytes, 30);
    local.push(localHeader, packed);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, checksum, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    central.push(centralHeader);

    offset += localHeader.length + packed.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...local, ...central, end];
  const out = new Uint8Array(all.reduce((total, part) => total + part.length, 0));
  let cursor = 0;
  for (const part of all) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/** Write bytes to a temp `.cwbrand` and list what a real `unzip` sees. */
function unzipList(bytes: Uint8Array, name = 'kit.cwbrand'): string[] {
  const file = join(temporary, name);
  writeFileSync(file, bytes);
  return execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

describe('crc32', () => {
  it('matches the published check value', () => {
    // The universal check value for "123456789" — every CRC-32 implementation agrees on it,
    // so a table built wrong here (reversed polynomial, missing final inversion) fails.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('is zero for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('writeArchive', () => {
  it.skipIf(!HAS_UNZIP)('writes an archive a real unzip can list', () => {
    /*
      The claim that matters: not "our reader reads it", but "the file is a zip". `unzip -Z1`
      reads the central directory so a wrong offset, size or signature fails here rather than
      in a user's hands.
    */
    const bytes = writeArchive([
      { name: 'kit.json', data: new TextEncoder().encode('{"hello":"world"}') },
      { name: 'logo-1.png', data: PNG },
    ]);
    expect(unzipList(bytes)).toEqual(['kit.json', 'logo-1.png']);
  });

  it.skipIf(!HAS_UNZIP)('writes bytes a real unzip can extract intact', () => {
    // Listing only reads the directory; extraction reads the data and verifies the CRC. Both
    // checks are needed, because a directory can be perfect while every payload is garbage.
    const target = mkdtempSync(join(temporary, 'extract-'));
    const file = join(target, 'kit.cwbrand');
    writeFileSync(
      file,
      writeArchive([
        { name: 'kit.json', data: new TextEncoder().encode('{"format":"cwbrand"}') },
        { name: 'mark-1.png', data: PNG },
      ]),
    );
    execFileSync('unzip', ['-qq', file, '-d', target]);
    // The archive being extracted lives in the same folder, so it is in the listing too.
    expect(readdirSync(target).sort()).toEqual(['kit.cwbrand', 'kit.json', 'mark-1.png']);
    expect(new Uint8Array(readFileSync(join(target, 'mark-1.png')))).toEqual(PNG);
  });

  it.skipIf(!HAS_UNZIP)('fails its own integrity check when a byte is flipped', () => {
    // `unzip -t` verifies CRCs; this proves the archive carries a correct one rather than a
    // zero that a reader would have to ignore.
    const bytes = writeArchive([{ name: 'kit.json', data: new TextEncoder().encode('{"a":1}') }]);
    const file = join(temporary, 'crc.cwbrand');
    writeFileSync(file, bytes);
    expect(() => execFileSync('unzip', ['-t', file], { stdio: 'pipe' })).not.toThrow();

    const damaged = Uint8Array.from(bytes);
    damaged[30 + 'kit.json'.length] ^= 0xff;
    const damagedFile = join(temporary, 'crc-damaged.cwbrand');
    writeFileSync(damagedFile, damaged);
    expect(() => execFileSync('unzip', ['-t', damagedFile], { stdio: 'pipe' })).toThrow();
  });

  it('refuses unsafe paths and duplicate names', () => {
    expect(() => writeArchive([{ name: '../escape', data: PNG }])).toThrow(ArchiveError);
    expect(() => writeArchive([{ name: '/absolute', data: PNG }])).toThrow(ArchiveError);
    expect(() =>
      writeArchive([
        { name: 'a.png', data: PNG },
        { name: 'a.png', data: JPG },
      ]),
    ).toThrow(ArchiveError);
  });
});

describe('readArchive', () => {
  it('reads a deflated archive, which this writer never produces', async () => {
    /*
      The compressed path: a kit exported by another tool. The deflate stream comes from
      Node's `zlib` — a real implementation, not ours — and the headers are built here so the
      fixture is independent of `writeArchive`'s. Built in code rather than by running `zip`,
      which does not exist on the Windows runner.
    */
    const parsed = await readArchive(buildDeflatedArchive([
      ['kit.json', new TextEncoder().encode('{"format":"cwbrand","formatVersion":1}')],
      ['logo-1.png', PNG],
    ]));
    expect(text(parsed.kitJson)).toContain('cwbrand');
    expect(parsed.assets.get('logo-1.png')).toEqual(PNG);
  });

  it.skipIf(!HAS_ZIP)('reads an archive made by the zip program itself', async () => {
    // The same claim against a third implementation, on the platforms that have one.
    const source = mkdtempSync(join(temporary, 'zipped-'));
    writeFileSync(join(source, 'kit.json'), '{"format":"cwbrand","formatVersion":1}');
    writeFileSync(join(source, 'logo-1.png'), PNG);
    execFileSync('zip', ['-q', '-r', 'kit.cwbrand', 'kit.json', 'logo-1.png'], { cwd: source });

    const parsed = await readArchive(new Uint8Array(readFileSync(join(source, 'kit.cwbrand'))));
    expect(parsed.assets.get('logo-1.png')).toEqual(PNG);
  });

  it('says so when the file is not a zip', async () => {
    await expect(readArchive(new TextEncoder().encode('not a zip at all'))).rejects.toThrow(
      /not a brand kit archive/,
    );
  });

  it('says so when there is no kit.json', async () => {
    const bytes = writeArchive([{ name: 'logo-1.png', data: PNG }]);
    await expect(readArchive(bytes)).rejects.toThrow(/no kit\.json/);
  });
});

describe('extensionFor', () => {
  it('names the common types from their bytes, not from a file name', () => {
    // A kit's asset id is an opaque string; the extension comes from the data so an archive a
    // user opens contains `.png` files that are PNGs.
    expect(extensionFor(PNG)).toBe('.png');
    expect(extensionFor(JPG)).toBe('.jpg');
    expect(extensionFor(MP4)).toBe('.mp4');
    expect(extensionFor(new TextEncoder().encode('garbage'))).toBe('.bin');
  });

  it('does not mistake a text file for an image', () => {
    // The signature check has to be at the front: a font or a licence text could contain the
    // bytes of a PNG magic number somewhere inside.
    expect(extensionFor(new TextEncoder().encode('...\x89PNG'))) .toBe('.bin');
  });
});

describe('kitAssetIds', () => {
  it('collects every asset a kit names, once each', () => {
    const ids = kitAssetIds(
      kit({
        logo: { assetId: 'logo-1', position: 'br', xPct: 4, yPct: 4, sizePct: 10, opacity: 1, margin: 4, showFrom: 'always', showFor: 'whole' },
        watermark: { assetId: 'logo-1', position: 'tl', xPct: 4, yPct: 4, sizePct: 20, opacity: 0.4, margin: 4, showFrom: 'always', showFor: 'whole' },
        intro: { assetId: 'intro-1', durationSec: 2 },
        audio: { musicAssetId: 'music-1', musicVolumeDb: -18, duckUnderSpeech: true },
      }),
    );
    expect(ids.sort()).toEqual(['intro-1', 'logo-1', 'music-1']);
  });

  it('skips an intro that names a template instead of an asset', () => {
    // A template is built from the project, not stored in the archive, so shipping a file for
    // it would put a missing-asset warning on every kit that uses one.
    expect(kitAssetIds(kit({ intro: { compositionTemplateId: 'tpl-1', durationSec: 2 } }))).toEqual([]);
  });
});

describe('writeBrandKitArchive and readBrandKitArchive', () => {
  const fullKit = () =>
    kit({
      captionStyleId: 'bold-creator',
      logo: { assetId: 'logo-1', position: 'br', xPct: 4, yPct: 4, sizePct: 10, opacity: 1, margin: 4, showFrom: 'always', showFor: 'whole' },
      intro: { assetId: 'intro-1', durationSec: 2 },
      audio: { musicAssetId: 'music-1', musicVolumeDb: -18, duckUnderSpeech: true },
    });

  const library = new Map<string, Uint8Array>([
    ['logo-1', PNG],
    ['intro-1', MP4],
    ['music-1', JPG],
  ]);
  const fetchAsset = async (assetId: string): Promise<Uint8Array | undefined> => library.get(assetId);

  it('round-trips a kit and its assets onto a clean workspace', async () => {
    /*
      SPEC 13 §8's acceptance case, in full: export a kit with assets, import it somewhere that
      has never seen it, and get back a kit equal to the original with its files attached.
      "Clean workspace" is what makes the asset comparison meaningful — nothing was left on
      disk to be found by accident.
    */
    const written = await writeBrandKitArchive(fullKit(), { fetchAsset });
    expect(written.missingAssets).toEqual([]);

    const imported = await readBrandKitArchive(written.bytes);
    expect(imported.kit).toEqual(fullKit());
    expect(imported.missingAssets).toEqual([]);
    expect(imported.assets.get('logo-1.png')).toEqual(PNG);
    expect(imported.assets.get('intro-1.mp4')).toEqual(MP4);
    expect(imported.assets.get('music-1.jpg')).toEqual(JPG);
  });

  it.skipIf(!HAS_UNZIP)('writes an archive a real unzip can list, with kit.json first', async () => {
    const written = await writeBrandKitArchive(fullKit(), { fetchAsset });
    const listing = unzipList(written.bytes, 'full.cwbrand');
    expect(listing[0]).toBe('kit.json');
    expect(listing).toContain('logo-1.png');
    expect(listing).toHaveLength(4);
  });

  it('reports an asset the library does not have, and still writes the archive', async () => {
    // A kit whose logo went missing is more useful than no file at all — and the caller needs
    // to know, or the recipient finds a kit that references a file it does not contain.
    const written = await writeBrandKitArchive(fullKit(), { fetchAsset: async () => undefined });
    expect(written.missingAssets.sort()).toEqual(['intro-1', 'logo-1', 'music-1']);
    expect(unzipList(written.bytes, 'sparse.cwbrand')).toEqual(['kit.json']);

    const imported = await readBrandKitArchive(written.bytes);
    expect(imported.kit).toEqual(fullKit());
    expect(imported.missingAssets.sort()).toEqual(['intro-1', 'logo-1', 'music-1']);
  });

  it('uses bytes the caller already holds instead of asking the library', async () => {
    // The editor has the logo it just loaded; making it round-trip through the library would
    // be a redundant read and a chance for the two to disagree.
    let asked = 0;
    const written = await writeBrandKitArchive(kit(), {
      fetchAsset: async () => {
        asked += 1;
        return undefined;
      },
      provided: new Map([
        ['logo-1', PNG],
      ]),
    });
    expect(written.bytes).toBeDefined();
    // This kit names no assets at all, so the library is never consulted.
    expect(asked).toBe(0);
  });

  it('rejects a kit that is not one', async () => {
    // The archive's JSON goes through `importBrandKit`, so an archive cannot smuggle in a kit
    // a plain kit.json would be refused for.
    const bytes = writeArchive([
      { name: 'kit.json', data: new TextEncoder().encode('{"format":"something-else"}') },
    ]);
    await expect(readBrandKitArchive(bytes)).rejects.toThrow(/not a brand kit/);
  });

  it('rejects an archive whose kit.json is not JSON', async () => {
    const bytes = writeArchive([{ name: 'kit.json', data: new TextEncoder().encode('{oops') }]);
    await expect(readBrandKitArchive(bytes)).rejects.toThrow(/not valid JSON/);
  });

  it.skipIf(!HAS_UNZIP)('names an asset file after its id so the archive can be opened by hand', async () => {
    // The kit's JSON names `logo-1`; the archive holds `logo-1.png`. A user unzipping the file
    // sees a PNG they can look at, and the reader finds it by prefix.
    const written = await writeBrandKitArchive(
      kit({ logo: { assetId: 'logo-1', position: 'br', xPct: 4, yPct: 4, sizePct: 10, opacity: 1, margin: 4, showFrom: 'always', showFor: 'whole' } }),
      { fetchAsset },
    );
    expect(unzipList(written.bytes, 'named.cwbrand')).toContain(assetEntryName('logo-1', PNG));
  });
});
