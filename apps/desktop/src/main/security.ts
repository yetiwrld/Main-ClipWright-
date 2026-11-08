/**
 * SPEC 00 §6 Phase 1 & SPEC 15 §6.1 / §12.12 — Electron Security Configuration
 */

export const CONTENT_SECURITY_POLICY = [
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

/**
 * Development-only policy: Vite serves an inline React Refresh preamble and uses
 * a websocket for HMR, and Electron loads the renderer from the dev server
 * origin. Production always uses CONTENT_SECURITY_POLICY above.
 */
export const DEV_CONTENT_SECURITY_POLICY = [
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

export interface SecureWindowConfig {
  minWidth: number;
  minHeight: number;
  defaultWidth: number;
  defaultHeight: number;
  titleBarStyle: 'hidden';
  titleBarOverlay: {
    color: string;
    symbolColor: string;
    height: number;
  };
  webPreferences: {
    contextIsolation: true;
    nodeIntegration: false;
    sandbox: true;
    webSecurity: true;
    allowRunningInsecureContent: false;
    devTools: boolean;
    preload: string;
  };
}

export function buildSecureWindowConfig(
  preloadPath: string,
  argv: string[] = process.argv,
  isProduction = process.env.NODE_ENV === 'production'
): SecureWindowConfig {
  const enableDevTools = !isProduction || argv.includes('--devtools');
  return {
    minWidth: 1100,
    minHeight: 680,
    defaultWidth: 1360,
    defaultHeight: 820,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0E0E0F',
      symbolColor: '#F2F2F3',
      height: 40,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: enableDevTools,
      preload: preloadPath,
    },
  };
}

export const DEV_SERVER_ORIGIN = 'http://localhost:5173';

/**
 * Decides what happens to an in-window navigation (SPEC 15 §12.12).
 *
 * `allow` loads the URL in the window; `external` opens it in the system
 * browser; `block` drops it silently. Everything here runs against a window that
 * has a preload bridge into the main process, so the default is `block`.
 *
 * The dev-server origin is compared by `origin`, never by prefix. A prefix test
 * accepts `http://localhost:5173@evil.example/`, where everything before the `@`
 * is userinfo and the actual host is `evil.example` — the URL loads in-window and
 * the renderer's IPC bridge is then reachable from remote content. The same
 * comparison is why the dev origin is only honoured in a development build: a
 * packaged app has no dev server to talk to, so nothing legitimate is lost.
 */
export function resolveNavigation(
  rawUrl: string,
  { isDev }: { isDev: boolean }
): 'allow' | 'external' | 'block' {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'block';
  }

  if (parsed.protocol === 'file:') return 'allow';
  if (isDev && parsed.origin === DEV_SERVER_ORIGIN) return 'allow';
  if (parsed.protocol === 'https:') return 'external';
  return 'block';
}

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
