// Browser preview of the renderer (dev server) for the /__design showcase.
// DEV serving => the dev-mock bridge (src/renderer/src/devMock.ts) installs,
// so the shell renders outside Electron with obviously-mock data.
// Production packaging never uses this file.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // allow the Arena preview host
    allowedHosts: true,
    fs: { strict: false },
  },
  build: { outDir: '../../out/renderer-dev' },
});
