/**
 * SPEC 01 — DESIGN SYSTEM TOKENS (TypeScript mirror for canvas & programmatic checks)
 */

export const TOKENS = {
  brand: {
    default: '#FF7A00',
    strong: '#FF5A00',
    amber: '#FFB000',
    tint: 'rgba(255, 122, 0, 0.14)',
    tintStrong: 'rgba(255, 122, 0, 0.24)',
    onBrand: '#121212',
  },
  surface: {
    app: '#0E0E0F',
    panel: '#161617',
    card: '#1F1F21',
    hover: '#28282B',
    pressed: '#303034',
    overlay: 'rgba(0, 0, 0, 0.6)',
  },
  line: {
    faint: 'rgba(255, 255, 255, 0.06)',
    default: '#2E2E32',
  },
  text: {
    primary: '#F2F2F3',
    secondary: '#A8A8AE',
    muted: '#80808A',
    disabled: '#5C5C64',
    brand: '#FF8A1F',
  },
  status: {
    success: '#3DD68C',
    successTint: 'rgba(61, 214, 140, 0.14)',
    warning: '#F5C542',
    warningTint: 'rgba(245, 197, 66, 0.14)',
    error: '#F0524F',
    errorTint: 'rgba(240, 82, 79, 0.14)',
    info: '#4DA3FF',
    infoTint: 'rgba(77, 163, 255, 0.14)',
  },
  tracks: {
    main: '#3F7F93',
    overlay: '#5C6FB5',
    graphic: '#8A6FB0',
    voice: '#3E8F8A',
    audio: '#4E9A6F',
    music: '#6FA05A',
    sfx: '#A0679A',
    caption: '#C28AA0',
    text: '#7E8FA6',
    fx: '#8C8F5C',
  },
  font: {
    sans: '"Manrope", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
    mono: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
  },
  fontSize: {
    xs: { rem: '0.75rem', px: 12, lineHeight: 16 },
    sm: { rem: '0.8125rem', px: 13, lineHeight: 20 },
    md: { rem: '0.875rem', px: 14, lineHeight: 21 },
    lg: { rem: '1rem', px: 16, lineHeight: 22 },
    xl: { rem: '1.25rem', px: 20, lineHeight: 26 },
    '2xl': { rem: '1.75rem', px: 28, lineHeight: 34 },
    hero: { rem: '3.5rem', px: 56, lineHeight: 60 },
  },
  spacing: {
    1: 4,
    2: 8,
    3: 12,
    4: 16,
    6: 24,
    8: 32,
    12: 48,
    editorGutter: 6,
  },
  radius: {
    xs: 4,
    clip: 5,
    sm: 8,
    md: 12,
    lg: 16,
    pill: 999,
  },
  motion: {
    fastMs: 120,
    baseMs: 200,
    slowMs: 320,
    easeStandard: 'cubic-bezier(0.2, 0, 0, 1)',
    easeExit: 'cubic-bezier(0.4, 0, 1, 1)',
  },
} as const;

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  const num = parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function getContrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

export interface ContrastAuditItem {
  pair: string;
  foreground: string;
  background: string;
  ratio: number;
  minRequired: number;
  passed: boolean;
}

/**
 * Verifies all contrast pairs required in Spec 01 §3.4 & §10
 */
export function verifyAllTokenContrasts(): ContrastAuditItem[] {
  const pairs: Array<{ pair: string; fg: string; bg: string; min: number }> = [
    { pair: 'text-primary on surface-app', fg: TOKENS.text.primary, bg: TOKENS.surface.app, min: 13.0 },
    { pair: 'text-primary on surface-panel', fg: TOKENS.text.primary, bg: TOKENS.surface.panel, min: 13.0 },
    { pair: 'text-primary on surface-card', fg: TOKENS.text.primary, bg: TOKENS.surface.card, min: 13.0 },
    { pair: 'text-secondary on surface-panel', fg: TOKENS.text.secondary, bg: TOKENS.surface.panel, min: 7.0 },
    { pair: 'text-secondary on surface-card', fg: TOKENS.text.secondary, bg: TOKENS.surface.card, min: 4.5 },
    { pair: 'text-muted on surface-panel', fg: TOKENS.text.muted, bg: TOKENS.surface.panel, min: 4.5 },
    { pair: 'text-brand on surface-panel', fg: TOKENS.text.brand, bg: TOKENS.surface.panel, min: 6.0 },
    { pair: 'on-brand on brand', fg: TOKENS.brand.onBrand, bg: TOKENS.brand.default, min: 4.5 },
    { pair: 'on-brand on brand-amber', fg: TOKENS.brand.onBrand, bg: TOKENS.brand.amber, min: 4.5 },
    { pair: 'status-success on surface-panel', fg: TOKENS.status.success, bg: TOKENS.surface.panel, min: 4.5 },
    { pair: 'status-warning on surface-panel', fg: TOKENS.status.warning, bg: TOKENS.surface.panel, min: 4.5 },
    { pair: 'status-error on surface-panel', fg: TOKENS.status.error, bg: TOKENS.surface.panel, min: 4.5 },
    { pair: 'status-info on surface-panel', fg: TOKENS.status.info, bg: TOKENS.surface.panel, min: 4.5 },
  ];

  return pairs.map((p) => {
    const ratio = getContrastRatio(p.fg, p.bg);
    return {
      pair: p.pair,
      foreground: p.fg,
      background: p.bg,
      ratio,
      minRequired: p.min,
      passed: ratio >= p.min,
    };
  });
}
