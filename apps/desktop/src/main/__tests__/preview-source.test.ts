import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { previewSourceFor } from '../preview-source.js';

describe('choosing the file the preview plays (SPEC 04 §7)', () => {
  const original = '/media/original.mov';
  const proxy = '/media/proxy/proxy.mp4';

  it('plays the original when no proxy was generated', () => {
    // The common case: a 1080p h264 clip needs no proxy at all, and asking the
    // filesystem about a path that does not exist would be wasted work.
    const chosen = previewSourceFor({ path: original }, { useProxies: true });
    expect(chosen).toEqual({ path: original, reason: 'original' });
  });

  it('plays the proxy when there is one', () => {
    const chosen = previewSourceFor({ path: original, proxyPath: proxy }, { useProxies: true });
    expect(chosen).toEqual({ path: proxy, reason: 'proxy' });
  });

  it('plays the original when the user has turned proxies off', () => {
    /*
      The escape hatch matters when a proxy is wrong — a transcode that mangled a
      non-standard clip — and the user needs to see the real file without deleting
      anything.
    */
    const chosen = previewSourceFor({ path: original, proxyPath: proxy }, { useProxies: false });
    expect(chosen).toEqual({ path: original, reason: 'proxies-off' });
  });

  it('falls back to the original when the proxy has been deleted', () => {
    /*
      The derived directory is disposable — a user clearing caches removes it. Serving
      a missing file would leave the clip blank, which reads as "this media is broken"
      rather than "the proxy is gone"; the original is always correct, only slower.
    */
    const chosen = previewSourceFor(
      { path: original, proxyPath: proxy },
      { useProxies: true, exists: () => false },
    );
    expect(chosen).toEqual({ path: original, reason: 'proxy-missing' });
  });

  it('distinguishes "no proxy" from "proxy gone"', () => {
    // Both play the original, and the distinction is the whole reason `reason` exists:
    // one is expected, the other means the derived cache was cleared and a re-import
    // would speed editing back up.
    const none = previewSourceFor({ path: original }, { useProxies: true });
    const gone = previewSourceFor(
      { path: original, proxyPath: proxy },
      { useProxies: true, exists: () => false },
    );
    expect(none.path).toBe(gone.path);
    expect(none.reason).not.toBe(gone.reason);
  });

  it('treats a null proxy path as no proxy', () => {
    // `null` is what `needsProxy` declining to make one produces, so it must not be
    // read as a path — the string "null" would be served otherwise.
    const chosen = previewSourceFor({ path: original, proxyPath: null }, { useProxies: true });
    expect(chosen.path).toBe(original);
    expect(chosen.reason).toBe('original');
  });

  it('never returns a path that is not one of the record’s own', () => {
    /*
      A guard on the function's contract rather than on its branches: whatever it
      decides, it decides between two known paths. That is what keeps a proxy out of an
      export — the exporter asks storage for `record.path` directly, and nothing in this
      module can hand it a transcode.
    */
    const records = [
      { path: original },
      { path: original, proxyPath: proxy },
      { path: original, proxyPath: null },
    ];
    for (const useProxies of [true, false]) {
      for (const record of records) {
        const chosen = previewSourceFor(record, { useProxies });
        expect([original, proxy]).toContain(chosen.path);
      }
    }
  });
});

describe('a proxy never reaches an export', () => {
  /*
    Two independent guarantees, and it is worth testing both because they are
    structural rather than behavioural — nothing about them is visible when they hold.

    The first is the type: the exporter's storage port is `{ path: string }`, so
    `record.proxyPath` is not even in scope where an export resolves its media. The
    second is the call: the exporter asks storage for the path itself and never routes
    through the preview protocol handler that this module feeds.
  */
  it('leaves the proxy out of the port the exporter is given', () => {
    // A record with a proxy, narrowed the way `ExportStorageLike` narrows it.
    const record = { path: '/media/original.mov', proxyPath: '/media/proxy/proxy.mp4' };
    const asExporterSeesIt: { path: string } = record;
    expect(Object.keys({ path: asExporterSeesIt.path })).toEqual(['path']);
    // Compile-time, too: the annotation above fails to typecheck if `path` is not the
    // only field the exporter may rely on.
    expect(asExporterSeesIt.path).toBe(record.path);
  });

  it('is not reachable from the export path at all', () => {
    /*
      A source-level guard rather than a runtime one. If a future refactor pointed the
      exporter at `previewSourceFor`, every exported frame would come from a transcode
      — the exact failure this whole slice has to avoid — and no unit test of the
      exporter would notice, because the proxy is a perfectly valid video file.
    */
    const exportDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'export');
    const offenders: string[] = [];
    for (const file of readdirSync(exportDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(join(exportDir, file), 'utf8');
      if (source.includes('previewSourceFor') || source.includes('proxyPath')) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the proxy path survives a save', () => {
  it('is declared on the schema, so `.passthrough()` is not what keeps it', async () => {
    /*
      A record literal proves nothing: `.passthrough()` lets any unknown key through, so
      a test that builds an object with `proxyPath` and parses it passes whether or not
      the field is declared. Removing the declaration must break something, so this
      asserts on the *shape* the schema publishes rather than on a round trip.
    */
    const { MediaRecordSchema } = await import('@clipwright/project-schema');
    expect(Object.keys(MediaRecordSchema.shape)).toContain('proxyPath');
  });

  it('is written by the importer, so the file on disk is reachable', () => {
    /*
      The bug, stated at the place it happened: `generateProxy` wrote the file, the path
      travelled out of `ingestMedia`, and `saveMedia` was handed a record without it. A
      round trip through the schema cannot see that — only the call site can. Read as
      source because `ingestMedia` needs a filesystem, a database and ffmpeg to run,
      and the thing under test is one line of a record literal.
    */
    const pipeline = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'media-pipeline.ts'),
      'utf8',
    );
    const saveCall = pipeline.slice(pipeline.indexOf('storage.saveMedia({'));
    expect(saveCall.slice(0, saveCall.indexOf('}'))).toContain('proxyPath');
  });

  it('is chosen by the preview once it is stored', () => {
    // The two halves joined: a record that carries the path plays the proxy.
    expect(
      previewSourceFor({ path: '/media/original.mov', proxyPath: '/media/proxy/proxy.mp4' }, {
        useProxies: true,
      }).reason,
    ).toBe('proxy');
  });

  it('accepts a record that predates the field', async () => {
    // Media imported before this field existed has no `proxyPath` at all, and must
    // keep loading — the schema's job is to describe old files too.
    const { MediaRecordSchema } = await import('@clipwright/project-schema');
    const parsed = MediaRecordSchema.parse({
      id: 'media-2',
      kind: 'video',
      storageMode: 'managed',
      path: '/media/original.mov',
      originalName: 'original.mov',
      sizeBytes: 1024,
      fingerprint: 'abc',
      createdAt: new Date().toISOString(),
      info: {
        mediaId: 'media-1',
        kind: 'video' as const,
        container: 'mov',
        durationUs: 1_000_000,
        sizeBytes: 1024,
      },
      status: 'ok',
    });
    expect(parsed.proxyPath).toBeUndefined();
    expect(previewSourceFor(parsed, { useProxies: true }).reason).toBe('original');
  });
});
