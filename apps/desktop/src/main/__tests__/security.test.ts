import { describe, it, expect } from 'vitest';
import {
  CONTENT_SECURITY_POLICY,
  buildSecureWindowConfig,
  isAllowedExternalUrl,
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
