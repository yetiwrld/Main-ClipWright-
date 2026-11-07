/**
 * SPEC 00 §6 Phase 1 & SPEC 15 §6.1 / §12.12 — Electron Security Configuration
 */

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: file:",
  "media-src 'self' data: blob: file:",
  "font-src 'self' data:",
  "connect-src 'self' http://localhost:11434 http://127.0.0.1:11434",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
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

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
