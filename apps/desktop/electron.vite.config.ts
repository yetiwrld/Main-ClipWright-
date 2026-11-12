import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * First-party workspace packages MUST be bundled, never externalized:
 * their package.json `exports` point at TypeScript source, so a runtime
 * `require('@clipwright/...')` would crash the packaged app.
 * Only true external (node_modules) deps stay external.
 */
const WORKSPACE_PACKAGES = [
  '@clipwright/ai-core',
  '@clipwright/audio-core',
  '@clipwright/caption-styles',
  '@clipwright/design-system',
  '@clipwright/export-core',
  '@clipwright/media-core',
  '@clipwright/project-schema',
  '@clipwright/timeline-engine',
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      chunkSizeWarningLimit: 2500,
    },
  },
});
