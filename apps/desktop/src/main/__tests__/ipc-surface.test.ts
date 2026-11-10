/**
 * Every channel the preload bridge can invoke must have a handler in main.
 *
 * This test exists because that was false for **36 channels** and nothing noticed. Commit
 * `8418bfe` ("one model catalogue for setup, settings and the manager") intended to replace three
 * `models:*` handlers; it removed 160 lines from `registerIPC` and added 21, and the range it
 * deleted took every `ai:*` handler, all six `moments:*` handlers and the two progress sinks with
 * it. The services kept being constructed and the `require*()` helpers kept compiling, so the build
 * was clean.
 *
 * An `ipcMain` channel with no handler is not a type error and not a boot error: `ipcRenderer
 * .invoke` returns a promise that rejects at the moment of use, so the failure lands in whichever
 * page the user opened — the providers panel, the model manager, the privacy section, the entire
 * moments screen — as `Error: No handler registered for 'ai:providers:list'`.
 *
 * The check reads the two source files rather than importing them, because `main.ts` calls
 * `app.whenReady()` at import time and cannot be loaded in a test process. Reading the source is a
 * weaker claim than calling the channel, and it is the claim that matters: a channel the bridge
 * offers and main does not handle cannot work, whatever the handler would have done.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '../../..');
const preloadSource = fs.readFileSync(path.join(desktopRoot, 'src/preload/index.cjs'), 'utf8');
const mainSource = fs.readFileSync(path.join(desktopRoot, 'src/main/main.ts'), 'utf8');

/** Channels the bridge hands to `ipcRenderer.invoke`. */
function invokedChannels(source: string): string[] {
  return [...source.matchAll(/invoke\(\s*'([^']+)'/g)].map((match) => match[1]!);
}

/** Channels `registerIPC` answers. */
function handledChannels(source: string): string[] {
  return [...source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((match) => match[1]!);
}

/** Channels main pushes to the window, through either `webContents.send` or the `push` helper. */
function pushedChannels(source: string): string[] {
  const direct = [...source.matchAll(/\.send\(\s*'([^']+)'/g)].map((match) => match[1]!);
  const viaHelper = [...source.matchAll(/\bpush\(\s*'([^']+)'/g)].map((match) => match[1]!);
  return [...direct, ...viaHelper];
}

/** Channels the bridge subscribes to with `ipcRenderer.on`. */
function listenedChannels(source: string): string[] {
  return [...source.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)].map((match) => match[1]!);
}

describe('the bridge and main agree about the channel list', () => {
  it('finds the channels at all, so a refactor cannot make this file pass by finding nothing', () => {
    /*
      The guard against the guard. Every assertion below is of the form "this set is a subset of
      that one", and an empty set is a subset of everything — rename `ipcRenderer.invoke` or move
      the preload file and this test would go green while checking nothing.
    */
    expect(invokedChannels(preloadSource).length).toBeGreaterThan(100);
    expect(handledChannels(mainSource).length).toBeGreaterThan(100);
  });

  it('handles every channel the bridge invokes', () => {
    const invoked = new Set(invokedChannels(preloadSource));
    const handled = new Set(handledChannels(mainSource));
    const missing = [...invoked].filter((channel) => !handled.has(channel)).sort();

    /*
      Named rather than counted: a failure should say which channel was dropped, because the
      interesting content is *which* feature went dark. The whole AI surface was missing when this
      test was written and the failure would have named thirty-six channels.
    */
    expect(missing).toEqual([]);
  });

  it('pushes every channel the bridge listens to', () => {
    /*
      The same failure in the other direction. A sink that is registered on a channel nothing sends
      to is a progress bar that never moves — the download manager and the moments analysis both
      report through pushes, and the deletion that motivated this file took both sinks with it.
    */
    const listened = new Set(listenedChannels(preloadSource));
    const pushed = new Set(pushedChannels(mainSource));
    const orphaned = [...listened].filter((channel) => !pushed.has(channel)).sort();
    expect(orphaned).toEqual([]);
  });

  it('has no handler the bridge cannot reach', () => {
    /*
      The reverse direction, which is not a bug on its own — main may handle a channel for a future
      feature — but is how a typo shows up: a handler registered as `moments:analyse` would answer
      nobody, and the misspelling looks like work.
    */
    const invoked = new Set(invokedChannels(preloadSource));
    const handled = handledChannels(mainSource);
    const unreachable = [...new Set(handled)].filter((channel) => !invoked.has(channel)).sort();
    expect(unreachable).toEqual([]);
  });
});
