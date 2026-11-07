import React, { useState, useEffect, useRef } from 'react';
import type { Route } from '../App.js';
import { fuzzySearch, type CommandPaletteItem } from './command-palette-search.js';

interface Props {
  onClose: () => void;
  onNavigate: (r: Route) => void;
}

export function CommandPalette({ onClose, onNavigate }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items: CommandPaletteItem[] = [
    { id: 'open-project', label: 'Open project', category: 'Project', action: () => onNavigate({ name: 'projects' }) },
    { id: 'new-project', label: 'New project', shortcut: 'Ctrl+N', category: 'Project', action: () => onNavigate({ name: 'home' }) },
    { id: 'settings-general', label: 'Settings — General', category: 'Settings', action: () => onNavigate({ name: 'settings', section: 'general' }) },
    { id: 'settings-models', label: 'Settings — Models', category: 'Settings', action: () => onNavigate({ name: 'settings', section: 'models' }) },
    { id: 'settings-performance', label: 'Settings — Performance', category: 'Settings', action: () => onNavigate({ name: 'settings', section: 'performance' }) },
    { id: 'models', label: 'Model manager', category: 'Models', action: () => onNavigate({ name: 'models' }) },
    { id: 'projects', label: 'All projects', category: 'Project', action: () => onNavigate({ name: 'projects' }) },
    { id: 'home', label: 'Home', category: 'Navigation', action: () => onNavigate({ name: 'home' }) },
  ];

  const results = fuzzySearch(query, items);

  useEffect(() => {
    inputRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex((i) => Math.min(i + 1, results.length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex((i) => Math.max(i - 1, 0)); }
      if (e.key === 'Enter') { e.preventDefault(); const item = results[selectedIndex]; if (item) { item.action(); onClose(); } }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [results, selectedIndex, onClose]);

  useEffect(() => { setSelectedIndex(0); }, [query]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--surface-overlay)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface-raised)',
          border: '1px solid var(--line-default)',
          borderRadius: 'var(--radius-lg)',
          width: 520,
          maxWidth: '90vw',
          maxHeight: '50vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search commands…"
          style={{
            border: 'none',
            borderRadius: 0,
            padding: '16px 20px',
            fontSize: 'var(--fs-md)',
            background: 'transparent',
            color: 'var(--text-primary)',
            outline: 'none',
          }}
        />
        <div style={{ overflow: 'auto', flex: 1 }}>
          {results.map((item, i) => (
            <button
              key={item.id}
              onMouseEnter={() => setSelectedIndex(i)}
              onClick={() => { item.action(); onClose(); }}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '10px 20px',
                border: 'none',
                background: i === selectedIndex ? 'var(--surface-hover)' : 'transparent',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 'var(--fs-sm)',
              }}
            >
              <span>{item.label}</span>
              <span style={{ display: 'flex', gap: 8 }}>
                {item.shortcut && <kbd style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{item.shortcut}</kbd>}
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{item.category}</span>
              </span>
            </button>
          ))}
          {results.length === 0 && (
            <div style={{ padding: '16px 20px', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
              No commands found
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
