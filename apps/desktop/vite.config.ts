import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, relative, join } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';

const ASSETS_DIR = resolve(__dirname, '../../assets');

function contentTypeFor(file: string): string {
  if (file.endsWith('.woff2')) return 'font/woff2';
  if (file.endsWith('.woff')) return 'font/woff';
  if (file.endsWith('.ttf')) return 'font/ttf';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * The repo ships fonts and other static media in /assets at the repository root.
 * Vite serves that folder directly in dev; this plugin emits the same files into
 * the production bundle so the CSS `url(/assets/...)` references keep working.
 */
function copyRootAssets(): Plugin {
  return {
    name: 'clipwright-copy-root-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/assets/')) return next();
        const target = resolve(ASSETS_DIR, url.replace(/^\/assets\//, '').split('?')[0]);
        if (!target.startsWith(ASSETS_DIR)) return next();
        try {
          if (!statSync(target).isFile()) return next();
        } catch {
          return next();
        }
        res.setHeader('Content-Type', contentTypeFor(target));
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.end(readFileSync(target));
      });
    },
    generateBundle() {
      let files: string[] = [];
      try {
        files = walk(ASSETS_DIR);
      } catch {
        return;
      }
      for (const file of files) {
        const rel = relative(ASSETS_DIR, file).split('\\').join('/');
        this.emitFile({
          type: 'asset',
          fileName: `assets/${rel}`,
          source: readFileSync(file),
        });
      }
    },
  };
}

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: file: clipwright-media:",
  "media-src 'self' data: blob: file: clipwright-media:",
  "font-src 'self' data:",
  "connect-src 'self' http://localhost:11434 http://127.0.0.1:11434",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Dev needs inline scripts for React Refresh and a websocket for HMR. */
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: file: clipwright-media:",
  "media-src 'self' data: blob: file: clipwright-media:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'clipwright-csp',
    transformIndexHtml(_html, ctx) {
      const policy = ctx.server ? DEV_CSP : PROD_CSP;
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react(), copyRootAssets(), cspPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    fs: {
      allow: [resolve(__dirname, '../..')],
    },
    // Serve the repository-level /assets folder so font URLs resolve in dev.
    proxy: {},
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    allowedHosts: true,
  },
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: true,
  },
});
