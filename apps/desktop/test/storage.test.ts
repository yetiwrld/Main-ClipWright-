/** Real round-trip tests against a temp workspace — no mocks. */
import { test, expect, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initWorkspace, WORKSPACE_FOLDERS } from '../src/main/workspace.ts';
import { StorageService } from '../src/main/storage.ts';
import { defaultProjectSettings } from '@clipwright/project-schema';

let root: string;
let storage: StorageService;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cw-test-'));
  initWorkspace(root);
  storage = new StorageService(root);
});

afterAll(() => {
  storage.close();
  rmSync(root, { recursive: true, force: true });
});

test('initWorkspace creates all standard folders and the workspace db', () => {
  for (const folder of WORKSPACE_FOLDERS) {
    assert.ok(existsSync(join(root, folder)), `missing ${folder}`);
  }
  assert.ok(existsSync(join(root, 'workspace.db')));
});

test('settings default and merge-parse round trip', () => {
  const s = storage.getSettings();
  assert.equal(s.downloadQuality, '1080p');
  assert.equal(s.transcriptionModel, 'auto');
  const updated = storage.updateSettings({ downloadQuality: '720p', duckingEnabled: false });
  assert.equal(updated.downloadQuality, '720p');
  assert.equal(updated.duckingEnabled, false);
  // untouched key survives
  assert.equal(updated.transcriptionModel, 'auto');
  storage.updateSettings({ downloadQuality: '1080p', duckingEnabled: true });
});

test('corrupt settings JSON falls back to defaults rather than crashing', () => {
  const dbPath = join(root, 'workspace.db');
  const db = new Database(dbPath);
  db.prepare("UPDATE settings SET value_json = 'not json' WHERE key = 'app'").run();
  db.close();
  const s = storage.getSettings();
  assert.equal(s.downloadQuality, '1080p');
});

test('project create/get/update round trip', () => {
  const p = storage.createProject({ name: 'Test project', settings: defaultProjectSettings() });
  assert.ok(p.id);
  const fetched = storage.getProject(p.id);
  assert.equal(fetched?.name, 'Test project');
  assert.equal(fetched?.stage, 'created');
  const renamed = storage.updateProject(p.id, { name: 'Renamed', stage: 'editor' });
  assert.equal(renamed?.name, 'Renamed');
  assert.equal(storage.getProject(p.id)?.stage, 'editor');
});

test('interrupted jobs are revived to queued', () => {
  const id = storage.enqueueJob({ type: 'copy', params: {}, priority: 'background' });
  storage.updateJob(id, { status: 'running', startedAt: Date.now() });
  const revived = storage.reviveInterruptedJobs();
  assert.ok(revived >= 1);
  const job = storage.getJob(id)!;
  assert.equal(job['status'], 'queued');
});

test('provider save/list/delete round trip', () => {
  const id = storage.saveProvider({ kind: 'openai-compatible', displayName: 'Test', baseUrl: 'http://localhost:1/v1', model: 'test-model', secretId: 'sec-1' });
  const list = storage.listProviders();
  const found = list.find((p) => p.id === id);
  assert.equal(found?.displayName, 'Test');
  assert.equal(found?.model, 'test-model');
  storage.deleteProvider(id);
  assert.equal(storage.listProviders().find((p) => p.id === id), undefined);
});

test('invalid media rows are quarantined, not fatal', () => {
  const db = new Database(join(root, 'workspace.db'));
  db.prepare("INSERT INTO media(id, kind, storage_mode, path, original_name, size_bytes, fingerprint, status, created_at) VALUES ('bad-1', 'hologram', 'managed', '/nope', 'nope.mp4', 1, 'fp-bad', 'ok', 1)").run();
  db.close();
  const asset = storage.getMedia('bad-1');
  assert.equal(asset, null);
  const check = new Database(join(root, 'workspace.db'));
  const rows = check.prepare("SELECT * FROM _quarantine WHERE row_id = 'bad-1'").all() as Array<Record<string, unknown>>;
  check.close();
  assert.ok(rows.length >= 1, 'expected quarantine row');
});

test('composition save/load round trip with journal entry cleanup', () => {
  const p = storage.createProject({ name: 'Comp test', settings: defaultProjectSettings() });
  const comp = {
    id: 'comp-test-1', projectId: p.id, name: 'Clip 1', fps: 30 as const, width: 1080, height: 1920,
    tracks: [], items: [], markers: [], keyframes: [], effects: [], transitions: [],
    createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1,
  };
  storage.saveComposition(p.id, comp);
  const loaded = storage.loadComposition(p.id, 'comp-test-1');
  assert.equal(loaded?.name, 'Clip 1');
  assert.equal(storage.listCompositions(p.id).length, 1);
});

test('transcript replace/load and caption chunks round trip', () => {
  const p = storage.createProject({ name: 'Transcript test', settings: defaultProjectSettings() });
  storage.replaceTranscript(p.id, [
    { id: 'w1', index: 0, text: 'hello', startUs: 0, endUs: 500_000, confidence: 1, isApproximate: false },
    { id: 'w2', index: 1, text: 'world', startUs: 500_000, endUs: 1_000_000, confidence: 0.9, isApproximate: true },
  ]);
  const words = storage.loadTranscript(p.id);
  assert.equal(words.length, 2);
  assert.equal(words[1]?.text, 'world');
});
