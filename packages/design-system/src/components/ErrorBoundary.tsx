import React from 'react';
import { Button } from './Button.js';

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    try {
      const w = window as unknown as { clipwright?: { logRendererError?: (m: string) => void } };
      w.clipwright?.logRendererError?.(`render-crash: ${error.message}\n${info.componentStack ?? ''}`);
    } catch { /* logging is best-effort */ }
  }
  override render() {
    if (this.state.error) {
      return (
        <div role="alert" style={{
          minHeight: '100vh', display: 'grid', placeItems: 'center',
          background: 'var(--surface-app)', color: 'var(--text-primary)', fontFamily: 'var(--font-sans)',
        }}>
          <div style={{ maxWidth: 460, textAlign: 'center' }}>
            <h1 style={{ fontSize: 'var(--fs-xl)', fontWeight: 'var(--weight-title)' }}>Something went wrong</h1>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              The interface hit an unexpected error. Your project is saved — reopening the page brings you back to where you were.
            </p>
            <pre style={{
              textAlign: 'left', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', background: 'var(--surface-panel)',
              borderRadius: 'var(--radius-control)', padding: 'var(--space-3)', maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap',
            }}>{this.state.error.message}</pre>
            <Button variant="primary" size="36" onClick={() => window.location.reload()}>Reload</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
