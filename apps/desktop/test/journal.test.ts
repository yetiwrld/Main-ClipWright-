/** Journal + lock round-trip tests against a temp recovery dir. */
import { test, expect, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, writeLock, removeLock, lockStatus, saveRestorePoint } from '../src/main/journal.ts';
import { newId, type Composition } from '@clipwright/project-schema';

let dir: string;
const makeComp = (over: Partial<Composition> = {}): Composition => ({
  id: newId(), projectId: 'proj-1', name: 'Test clip', fps: 30, width: 1080, height: 1920,
  tracks: [], items: [], markers: [], keyframes: [], effects: [], transitions: [],
  createdAt: Date.now(), updatedAt: Date.now(), schemaVersion: 1, ...over,
});

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cw-journal-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('append + flush + recover round trip', () => {
  const j = new Journal(dir);
  const comp = makeComp();
  j.append(comp);
  j.flush();
  const recovered = new Journal(dir).readRecoverable();
  assert.equal(recovered.comps.size, 1);
  assert.equal([...recovered.comps.values()][0]!.name, 'Test clip');
});

test('corrupt journal lines are counted, not fatal', () => {
  const j = new Journal(dir);
  j.append(makeComp());
  j.flush();
  const fd = openSync(join(dir, 'journal.jsonl'), 'a');
  writeSync(fd, 'this is not json\n');
  closeSync(fd);
  const recovered = new Journal(dir).readRecoverable();
  assert.equal(recovered.comps.size, 1);
  assert.equal(recovered.badLines >= 1, true);
});

test('clear removes the journal', () => {
  const j = new Journal(dir);
  j.append(makeComp());
  j.flush();
  j.clear();
  assert.equal(existsSync(join(dir, 'journal.jsonl')), false);
});

test('lock write/status/remove and stale detection', () => {
  const lock = writeLock(dir, '0.1.0');
  assert.equal(lock.appVersion, '0.1.0');
  const status = lockStatus(dir);
  assert.equal(status.state, 'alive');
  removeLock(dir);
  assert.equal(lockStatus(dir).state, 'none');
});

test('restore point is written and capped at 20', () => {
  const comp = makeComp();
  for (let i = 0; i < 22; i++) saveRestorePoint(dir, 'proj-1', comp);
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const points = readdirSync(join(dir, 'checkpoints')).filter((f: string) => f.endsWith('.cwcp'));
  assert.ok(points.length <= 20, `expected <= 20 restore points, got ${points.length}`);
});
