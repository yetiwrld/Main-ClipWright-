/**
 * The `.cwbrand` archive (SPEC 13 §8.2: "Export/Import (`.cwbrand` zip with assets)").
 *
 * A `.cwbrand` file is a zip holding `kit.json` at its root and the kit's assets beside it —
 * `<assetId>.<ext>` — so a kit carries the logo it names. The JSON inside is byte-for-byte
 * what `exportBrandKit` writes, which means the file format has one definition: the archive is
 * a container, not a second schema.
 *
 * **Why the zip is written by hand.** A `.cwbrand` is three deflated files and one central
 * directory; the format is a documented, stable one and the subset needed here is small. The
 * alternatives were a dependency (this repository vendors deliberately and adds no runtime
 * dependency for a container format), or shelling out to `zip` (not present on a user's
 * Windows machine). Writing it also makes the *reader* honest: it is implemented against the
 * format rather than against one library's idea of it, and the tests check both directions
 * against a real `unzip`, so a file this build writes can be opened by anything.
 *
 * Everything here is pure: bytes in, bytes out, no filesystem, no Electron. The caller reads
 * and writes the file.
 */
import { crc32 } from './crc32.js';
import { exportBrandKit, importBrandKit, type BrandKit } from './schema.js';

/** The name `kit.json` must have at the archive root. */
export const KIT_ENTRY_NAME = 'kit.json';

/** One file inside the archive. `data` is the raw bytes. */
export interface ArchiveEntry {
  /** Forward-slashed path inside the archive. Assets sit at the root: `<assetId>.<ext>`. */
  name: string;
  data: Uint8Array;
}

/** What a parsed archive contains. */
export interface ParsedArchive {
  /** The `kit.json` bytes, untouched. */
  kitJson: Uint8Array;
  /** Everything else, keyed by entry name. */
  assets: Map<string, Uint8Array>;
}

/** An archive that cannot be read, with a reason a user can be shown. */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/* ------------------------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------------------------ */

/** A DOS timestamp, which is what the zip format stores. */
function dosDateTime(date: Date): { time: number; date: number } {
  /*
    Zip's date fields start at 1980 and cannot describe anything earlier. A clock set before
    then (or a caller passing epoch zero) would underflow into a huge year, so the value is
    clamped rather than trusted — a file dated 2107 is a worse answer than one dated 1980.
  */
  const year = Math.max(1980, date.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { time: dosTime, date: dosDate };
}

/**
 * Build a `.cwbrand` archive.
 *
 * Entries are written **stored**, not deflated. The payload is a JSON kit and a logo — a few
 * kilobytes to a few megabytes — and a stored entry has one property that matters more than
 * the size: it can be read by anything, including the most minimal unzip implementation, and
 * it cannot fail a deflate round trip. PNG logos are already compressed, so the gain would be
 * small; the cost would be a second code path in the reader.
 */
export function writeArchive(entries: readonly ArchiveEntry[], now: Date = new Date()): Uint8Array {
  if (entries.length === 0) throw new ArchiveError('An archive needs at least one file.');
  if (entries.length > 0xffff) throw new ArchiveError('An archive cannot hold more than 65535 files.');
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.name.startsWith('/') || entry.name.includes('..')) {
      throw new ArchiveError(`Unsafe path in the archive: ${entry.name}`);
    }
    if (seen.has(entry.name)) throw new ArchiveError(`Duplicate entry in the archive: ${entry.name}`);
    seen.add(entry.name);
  }

  const { time, date } = dosDateTime(now);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const checksum = crc32(entry.data);
    if (entry.data.length > 0xffffffff) throw new ArchiveError(`Entry too large: ${entry.name}`);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); // local file header
    localView.setUint16(4, 20, true); // version needed: 2.0 (deflate, not used — stored is 1.0)
    localView.setUint16(6, 0x0800, true); // UTF-8 names
    localView.setUint16(8, 0, true); // stored
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true); // no extra field
    local.set(nameBytes, 30);

    chunks.push(local, entry.data);

    const header = new Uint8Array(46 + nameBytes.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x02014b50, true); // central directory header
    headerView.setUint16(4, 20, true); // version made by
    headerView.setUint16(6, 20, true); // version needed
    headerView.setUint16(8, 0x0800, true);
    headerView.setUint16(10, 0, true);
    headerView.setUint16(12, time, true);
    headerView.setUint16(14, date, true);
    headerView.setUint32(16, checksum, true);
    headerView.setUint32(20, entry.data.length, true);
    headerView.setUint32(24, entry.data.length, true);
    headerView.setUint16(28, nameBytes.length, true);
    /* extra, comment, disk number, internal attrs — all zero for a file this writer makes. */
    headerView.setUint32(38, 0, true);
    headerView.setUint32(42, offset, true);
    header.set(nameBytes, 46);
    central.push(header);

    offset += local.length + entry.data.length;
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); // end of central directory
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...chunks, ...central, end]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/* ------------------------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------------------------ */

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  /*
    The end record sits at the very end of the file, optionally followed by a comment of up to
    64 KiB. It is searched backwards because that is the only way to find it in a file that may
    have a comment — and a file with no end record is not a zip at all.
  */
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= lowest; at -= 1) {
    if (
      bytes[at] === 0x50 &&
      bytes[at + 1] === 0x4b &&
      bytes[at + 2] === 0x05 &&
      bytes[at + 3] === 0x06
    ) {
      return at;
    }
  }
  throw new ArchiveError('That file is not a brand kit archive.');
}

/** Inflate a raw deflate stream using the platform's DecompressionStream. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  /*
    Copied into a plain `ArrayBuffer`-backed view: a subarray of a larger archive is typed as
    possibly backed by a `SharedArrayBuffer`, which `DecompressionStream` does not accept. The
    copy is of one compressed asset, not the whole file.
  */
  void writer.write(new Uint8Array(data));
  void writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Read a `.cwbrand` archive.
 *
 * Both stored and deflated entries are accepted, because a kit exported from this build is
 * stored but one from another tool — or a future one that decides to compress — may not be.
 * The kit must contain `kit.json` at the root; anything else is an asset, and a path with a
 * directory in it is refused rather than flattened, so two assets cannot collide by name.
 *
 * `DecompressionStream` is used rather than a bundled inflater: it is in every runtime this app
 * runs on (Chromium, Node 18+) and a hand-written inflater would be the largest and least
 * testable thing in the package. Writing a deflate stream is not needed — see `writeArchive`.
 */
export async function readArchive(bytes: Uint8Array): Promise<ParsedArchive> {
  const endAt = findEndOfCentralDirectory(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(endAt + 10, true);
  const centralSize = view.getUint32(endAt + 12, true);
  const centralOffset = view.getUint32(endAt + 16, true);
  if (centralOffset + centralSize > bytes.length) {
    throw new ArchiveError('That brand kit archive is truncated.');
  }

  let cursor = centralOffset;
  let kitJson: Uint8Array | undefined;
  const assets = new Map<string, Uint8Array>();

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new ArchiveError('That brand kit archive is damaged.');
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.startsWith('/') || name.includes('..')) {
      throw new ArchiveError(`Unsafe path in the archive: ${name}`);
    }
    if (name.includes('/')) {
      throw new ArchiveError(`A kit archive cannot contain folders: ${name}`);
    }

    /*
      The size lives in the local header too, but a streaming writer can leave it zero there
      and put the real value in the central directory — so the compressed size is read from
      the central record, where it is always correct, and only the data offset comes from the
      local one.
    */
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new ArchiveError('That brand kit archive is damaged.');
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > bytes.length) {
      throw new ArchiveError('That brand kit archive is truncated.');
    }
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      data = await inflateRaw(raw);
    } else {
      throw new ArchiveError(`Unsupported compression in the archive (method ${method}).`);
    }

    if (name === KIT_ENTRY_NAME) {
      kitJson = data;
    } else {
      assets.set(name, data);
    }
  }

  if (!kitJson) throw new ArchiveError('That brand kit archive has no kit.json.');
  return { kitJson, assets };
}

/* ------------------------------------------------------------------------------------ *
 * A kit as an archive
 * ------------------------------------------------------------------------------------ */

/** An asset's bytes, keyed by media id, as the caller's library provides them. */
export type KitAssetFetcher = (assetId: string) => Promise<Uint8Array | undefined>;

/** What to write, and what could not be found. */
export interface KitArchiveResult {
  bytes: Uint8Array;
  /**
   * Assets the kit names that the caller could not supply. The archive is still written — a
   * kit whose logo went missing is more useful than no file — but the caller is told, because
   * a `.cwbrand` that silently lost its logo is a file the recipient will find broken.
   */
  missingAssets: string[];
}

/** Every asset id a kit names, in a stable order and without duplicates. */
export function kitAssetIds(kit: BrandKit): string[] {
  const ids = new Set<string>();
  // Intro and outro may name a template instead, which is not an asset.
  for (const ref of [kit.logo, kit.watermark, kit.intro, kit.outro]) {
    if (ref && 'assetId' in ref && typeof ref.assetId === 'string' && ref.assetId.length > 0) {
      ids.add(ref.assetId);
    }
  }
  if (kit.audio?.musicAssetId) ids.add(kit.audio.musicAssetId);
  return [...ids];
}

/**
 * The file name an asset is stored under, inside the archive.
 *
 * The id alone, plus an extension guessed from the bytes. The id is what the kit's JSON names,
 * so the reader can find it without a manifest; the extension is for the *user*, who may open
 * the archive and expects a `.png` to be a PNG. Guessing from the bytes rather than from the
 * id means an id containing dots cannot produce a misleading extension.
 */
export function assetEntryName(assetId: string, data: Uint8Array): string {
  return `${assetId}${extensionFor(data)}`;
}

/** A file extension for the most common asset types, from the bytes alone. */
export function extensionFor(data: Uint8Array): string {
  const starts = (...signature: number[]): boolean =>
    signature.every((byte, index) => data[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return '.png';
  if (starts(0xff, 0xd8, 0xff)) return '.jpg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return '.gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45) return '.webp';
  if (starts(0x00, 0x00, 0x00) && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) {
    return '.mp4';
  }
  /*
    An unknown type keeps its bytes and gets `.bin`: refusing to export a font or a video
    because the signature is not in this list would make the archive less useful than a folder
    of files. The extension is a convenience, and `kit.json` is what the reader trusts.
  */
  return '.bin';
}

/**
 * Write a kit and its assets as a `.cwbrand` archive.
 *
 * `kit.json` is `exportBrandKit(kit)` — the same function a caller would write to a bare file —
 * so the archive cannot drift from the format. Assets are fetched only for ids that are not
 * found in `provided`, which lets a caller that already holds the bytes (the editor, exporting
 * the logo it just loaded) skip the library round trip.
 */
export async function writeBrandKitArchive(
  kit: BrandKit,
  options: {
    fetchAsset: KitAssetFetcher;
    provided?: ReadonlyMap<string, Uint8Array>;
    now?: Date;
  },
): Promise<KitArchiveResult> {
  const json = new TextEncoder().encode(JSON.stringify(exportBrandKit(kit), null, 2));
  const entries: ArchiveEntry[] = [{ name: KIT_ENTRY_NAME, data: json }];
  const missingAssets: string[] = [];
  const used = new Set<string>();

  for (const assetId of kitAssetIds(kit)) {
    const data = options.provided?.get(assetId) ?? (await options.fetchAsset(assetId));
    if (!data) {
      missingAssets.push(assetId);
      continue;
    }
    /*
      Two asset ids cannot collide here — they are distinct strings — but an id ending in the
      same text as another id plus its extension could, so a taken name gets a numeric suffix
      rather than overwriting a file that is already in the archive.
    */
    let name = assetEntryName(assetId, data);
    let suffix = 2;
    while (used.has(name) || name === KIT_ENTRY_NAME) {
      name = `${assetId}-${suffix}${extensionFor(data)}`;
      suffix += 1;
    }
    used.add(name);
    entries.push({ name, data });
  }

  return { bytes: writeArchive(entries, options.now), missingAssets };
}

/** What a parsed kit archive contains once the JSON has been validated. */
export interface ImportedKitArchive {
  kit: BrandKit;
  /** The assets found, keyed by the file name they were stored under. */
  assets: Map<string, Uint8Array>;
  /**
   * Assets the kit *names* that the archive does not contain. Reported rather than treated as
   * a failure: a kit with a missing logo can still be imported, edited and applied, and
   * refusing it would make a file nobody can open from a file that mostly works.
   */
  missingAssets: string[];
}

/**
 * Read a `.cwbrand` archive back into a kit.
 *
 * The JSON is parsed and validated by `importBrandKit` — the same function that reads a bare
 * `kit.json` — so an archive cannot accept a kit that a plain file would reject, and unknown
 * fields are preserved exactly as they are for a file.
 */
export async function readBrandKitArchive(bytes: Uint8Array): Promise<ImportedKitArchive> {
  const parsed = await readArchive(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(parsed.kitJson));
  } catch {
    throw new ArchiveError('This brand kit’s kit.json is not valid JSON.');
  }
  const result = importBrandKit(raw);
  if (!result.ok) throw new ArchiveError(result.message);

  /*
    A missing asset is matched by the id the kit names, which the writer used as the file name
    prefix. Matching on the prefix rather than reconstructing the exact name means an archive
    whose extension was changed by hand still imports.
  */
  const missingAssets = kitAssetIds(result.kit).filter(
    (assetId) =>
      ![...parsed.assets.keys()].some(
        (name) => name === assetId || name.startsWith(`${assetId}.`) || name.startsWith(`${assetId}-`),
      ),
  );
  return { kit: result.kit, assets: parsed.assets, missingAssets };
}
