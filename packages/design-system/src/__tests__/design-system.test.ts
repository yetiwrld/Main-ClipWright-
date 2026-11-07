import { describe, it, expect } from 'vitest';
import {
  TOKENS,
  getContrastRatio,
  verifyAllTokenContrasts,
  computeLayoutTier,
} from '../index.js';

describe('Spec 01 — Design System Tokens & Accessibility Contrast', () => {
  it('passes WCAG contrast thresholds for all text/surface pairs (Spec 01 §3.4 & §12.3)', () => {
    const audit = verifyAllTokenContrasts();
    expect(audit.length).toBeGreaterThanOrEqual(13);
    for (const row of audit) {
      expect(row.passed, `${row.pair} ratio ${row.ratio}:1 < ${row.minRequired}:1`).toBe(true);
    }
  });

  it('keeps track colours distinct from brand orange (#FF7A00)', () => {
    for (const [role, hex] of Object.entries(TOKENS.tracks)) {
      expect(hex.toUpperCase()).not.toBe(TOKENS.brand.default);
      expect(hex.toUpperCase()).not.toBe(TOKENS.brand.strong);
      const contrastWithSurface = getContrastRatio(hex, TOKENS.surface.panel);
      expect(contrastWithSurface, `track ${role} contrast`).toBeGreaterThan(2.0);
    }
  });

  it('computes responsive layout tiers accurately (Spec 01 §9)', () => {
    expect(computeLayoutTier(1100)).toBe('compact');
    expect(computeLayoutTier(1280)).toBe('compact');
    expect(computeLayoutTier(1365)).toBe('compact');
    expect(computeLayoutTier(1366)).toBe('standard');
    expect(computeLayoutTier(1600)).toBe('standard');
    expect(computeLayoutTier(1919)).toBe('standard');
    expect(computeLayoutTier(1920)).toBe('large');
    expect(computeLayoutTier(2560)).toBe('large');
  });

  it('enforces minimum font size >= 12px across the typography scale (Spec 01 §4)', () => {
    for (const [, scale] of Object.entries(TOKENS.fontSize)) {
      expect(scale.px).toBeGreaterThanOrEqual(12);
    }
  });
});
