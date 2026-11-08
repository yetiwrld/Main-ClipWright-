import { describe, it, expect } from 'vitest';
import {
  CONTENT_SECURITY_POLICY,
  DEV_CONTENT_SECURITY_POLICY,
  DEV_SERVER_ORIGIN,
  buildSecureWindowConfig,
  isAllowedExternalUrl,
  resolveNavigation,
} from '../security.js';

describe('Spec 00 Phase 1 & Spec 15 §12.12 — Electron Security Configuration', () => {
  it('enforces contextIsolation, disables nodeIntegration, enables sandbox, and enforces min 1100x680 window', () => {
    const cfg = buildSecureWindowConfig('/path/to/preload.cjs', [], true);
    expect(cfg.minWidth).toBe(1100);
    expect(cfg.minHeight).toBe(680);
    expect(cfg.webPreferences.contextIsolation).toBe(true);
    expect(cfg.webPreferences.nodeIntegration).toBe(false);
    expect(cfg.webPreferences.sandbox).toBe(true);
    expect(cfg.webPreferences.webSecurity).toBe(true);
    expect(cfg.webPreferences.devTools).toBe(false);
  });

  it('enables devTools in production only when --devtools flag is passed', () => {
    const cfg = buildSecureWindowConfig('/path/to/preload.cjs', ['--devtools'], true);
    expect(cfg.webPreferences.devTools).toBe(true);
  });

  it('provides a strict Content-Security-Policy with no unsafe-eval or remote scripts', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
  });

  it('allows only https:// URLs for shell.openExternal', () => {
    expect(isAllowedExternalUrl('https://ollama.com')).toBe(true);
    expect(isAllowedExternalUrl('https://github.com/yetiwrld/Main-ClipWright-')).toBe(true);
    expect(isAllowedExternalUrl('http://insecure.example.com')).toBe(false);
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('the navigation guard (SPEC 15 §12.12)', () => {
  const guard = (url: string, isDev = false) => resolveNavigation(url, { isDev });

  it('loads packaged app content in-window', () => {
    expect(guard('file:///C:/Program%20Files/Clipwright/resources/app.asar/renderer/index.html')).toBe('allow');
  });

  it('loads the vite dev server in-window during development', () => {
    expect(guard(DEV_SERVER_ORIGIN, true)).toBe('allow');
    expect(guard(`${DEV_SERVER_ORIGIN}/index.html?x=1`, true)).toBe('allow');
  });

  it('refuses to load the dev server in a packaged build', () => {
    // A packaged app has no dev server; accepting one would let anyone who can
    // reach that port push content into a window that owns an IPC bridge.
    expect(guard(DEV_SERVER_ORIGIN, false)).toBe('block');
  });

  it('is not fooled by a userinfo prefix that merely looks like the dev server', () => {
    // `localhost:5173` is the username here; the host is evil.example. A
    // startsWith() check accepts this and loads remote content in-window.
    expect(new URL('http://localhost:5173@evil.example/steal').host).toBe('evil.example');
    expect(guard('http://localhost:5173@evil.example/steal', true)).toBe('block');
    expect(guard('http://localhost:5173@evil.example/steal', false)).toBe('block');
  });

  it('is not fooled by a longer port or a look-alike host', () => {
    expect(guard('http://localhost:51730/', true)).toBe('block');
    expect(guard('http://localhost.evil.example/', true)).toBe('block');
    expect(guard('http://127.0.0.1:5173/', true)).toBe('block');
  });

  it('sends public https links to the browser rather than the window', () => {
    expect(guard('https://github.com/yetiwrld/Main-ClipWright-/releases')).toBe('external');
    expect(guard('https://github.com/yetiwrld/Main-ClipWright-/releases', true)).toBe('external');
  });

  it('blocks everything else', () => {
    expect(guard('http://evil.example/')).toBe('block');
    expect(guard('javascript:alert(1)')).toBe('block');
    expect(guard('data:text/html,<script>alert(1)</script>')).toBe('block');
    expect(guard('app://etc/passwd')).toBe('block');
    expect(guard('not a url')).toBe('block');
  });

  it('keeps the two policies distinct so production never gains unsafe-inline scripts', () => {
    // The dev policy relaxes script-src and connect-src for HMR. If someone ever
    // collapses the two, this fails rather than shipping the looser one.
    expect(DEV_CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'unsafe-inline'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self' http://localhost:11434");
    expect(CONTENT_SECURITY_POLICY).not.toContain('ws:');
  });
});
