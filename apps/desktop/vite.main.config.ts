/**
 * SPEC 15 §6 — builds the main process and the preload script.
 *
 * The renderer is built by `vite.config.ts`. The main process needs its own pass
 * because it targets Node, not the browser: it imports `electron`, uses
 * `node:*` builtins, and must resolve the workspace packages to source while
 * leaving native modules (`better-sqlite3`) external so their `.node` binaries
 * keep working inside the asar.
 *
 * Output is CommonJS (`index.cjs`) because Electron loads `main` from
 * package.json and the app runs with `"type": "module"`: a `.cjs` extension is
 * the only unambiguous way to ship a main script there.
 */
import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

const root = __dirname;

/** Everything Electron supplies at runtime, plus native modules we cannot bundle. */
const external = [
  'electron',
  'electron-updater',
  'better-sqlite3',
  'onnxruntime-node',
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
];

export default defineConfig({
  build: {
    outDir: resolve(root, 'dist/main'),
    emptyOutDir: true,
    target: 'node20',
    // Sourcemaps ship for crash reports; the renderer's are stripped from the
    // package by electron-builder's `!**/*.map` filter.
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        index: resolve(root, 'src/main/main.ts'),
        preload: resolve(root, 'src/preload/index.cjs'),
      },
      formats: ['cjs'],
      fileName: (_format, entryName) => `${entryName}.cjs`,
    },
    rollupOptions: {
      external,
      output: {
        // Deterministic names: `main` in package.json points at dist/main/index.cjs,
        // and a hashed entry file would make the packaged app's launch script
        // differ from build to build for no benefit.
        entryFileNames: '[name].cjs',
        // Chunk names come from the module that spawned them, which is stable for
        // a given source layout; the default content hash is what we avoid.
        chunkFileNames: 'chunk-[name].cjs',
      },
    },
  },
  resolve: {
    // Workspace packages point at TypeScript source; vite compiles them inline,
    // so the packaged app does not need a separate package build.
    preserveSymlinks: false,
  },
});
