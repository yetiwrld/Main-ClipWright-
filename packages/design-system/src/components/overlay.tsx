import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

/* -------------------------------------------------------------- dialog */
export function Dialog({ open, onClose, title, children, actions, labelledBy }: {
  open: boolean; onClose: () => void; title: string; children: React.ReactNode;
  actions?: React.ReactNode; labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = labelledBy ?? 'cw-dialog-title';
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    // focus trap: focus the dialog on open
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusables = el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusables.length === 0) return;
      const first = focusables[0]!; const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    el.addEventListener('keydown', onTab);
    return () => el.removeEventListener('keydown', onTab);
  }, [open]);
  if (!open) return null;
  return (
    <div className="cw-dialog-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cw-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref}>
        <h2 id={titleId}>{title}</h2>
        <div>{children}</div>
        {actions && <div className="cw-dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- tooltip */
export function Tooltip({ text, shortcut, children }: { text: string; shortcut?: string; children: React.ReactElement }) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const timer = useRef<number | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const show = () => {
    timer.current = window.setTimeout(() => {
      const rect = ref.current?.getBoundingClientRect();
      if (rect) setPos({ top: rect.bottom + 6, left: rect.left + rect.width / 2 });
      setVisible(true);
    }, 500);
  };
  const hide = () => { if (timer.current) window.clearTimeout(timer.current); setVisible(false); };
  return (
    <span ref={ref} style={{ display: 'inline-flex' }} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {visible && (
        <span className="cw-tooltip" role="tooltip" style={{ top: pos.top, left: pos.left, transform: 'translateX(-50%)' }}>
          {text}{shortcut && <> · <span className="cw-kbd">{shortcut}</span></>}
        </span>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- menu */
export interface MenuItem { id: string; label: string; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect?: () => void; }
export function Menu({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" className="cw-menu" style={{
      background: 'var(--surface-card)', border: '1px solid var(--line-default)', borderRadius: 'var(--radius-panel)',
      boxShadow: 'var(--shadow-menu)', minWidth: 200, padding: 4, zIndex: 100,
    }}>
      {items.map((item) => (
        <button key={item.id} role="menuitem" disabled={item.disabled}
          onClick={() => { item.onSelect?.(); onClose(); }}
          style={{
            display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between',
            height: 32, padding: '0 var(--space-3)', border: 'none', background: 'transparent',
            color: item.danger ? 'var(--error)' : 'var(--text-primary)', borderRadius: 'var(--radius-control)',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--fs-sm)', cursor: item.disabled ? 'not-allowed' : 'pointer',
          }}
          onMouseEnter={(e) => { if (!item.disabled) (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-hover)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
        >
          <span>{item.label}</span>
          {item.shortcut && <span className="cw-kbd">{item.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- toast */
export interface ToastItem { id: string; message: string; tone?: 'default' | 'error'; }
export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timers = toasts.filter((t) => t.tone !== 'error').map((t) =>
      window.setTimeout(() => onDismiss(t.id), 4000));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [toasts, onDismiss]);
  return (
    <div className="cw-toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={clsx('cw-toast', t.tone === 'error' && 'cw-toast--error')} role={t.tone === 'error' ? 'alert' : 'status'}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
            <span>{t.message}</span>
            <button aria-label="Dismiss" onClick={() => onDismiss(t.id)}
              style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>×</button>
          </div>
        </div>
      ))}
    </div>
  );
}
