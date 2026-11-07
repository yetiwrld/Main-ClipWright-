import React, { useCallback, useEffect, useState } from 'react';
import { Chip, SegmentedControl } from '@clipwright/design-system';
import { api, describeError, isDesktop } from '../../api.js';
import type { AiTask, AppSettings, RoutePayload } from '../../global.js';

const TASKS: Array<{ id: AiTask; label: string }> = [
  { id: 'transcription', label: 'Transcription' },
  { id: 'moment_analysis', label: 'Moment analysis' },
  { id: 'titles', label: 'Titles' },
  { id: 'editor_ai', label: 'Editor AI' },
];

export type ProcessingMode = AppSettings['processingMode'];

/**
 * SPEC 06 §6.2 — the mode panel.
 *
 * Mode is a real setting; each chip underneath says what would actually run
 * right now, resolved by the router rather than guessed by the UI.
 */
export function ModePanel({
  mode,
  onChange,
  compact = false,
}: {
  mode: ProcessingMode;
  onChange: (mode: ProcessingMode) => void;
  compact?: boolean;
}) {
  const [routes, setRoutes] = useState<Record<string, RoutePayload | null>>({});
  const [offline, setOffline] = useState<boolean | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      const state = await api.connectivity();
      setOffline(!state.online);
      const entries = await Promise.all(
        TASKS.map(async (task) => [task.id, await api.routeFor(task.id)] as const)
      );
      setRoutes(Object.fromEntries(entries));
      setError('');
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, mode]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 8 : 12 }}>
      <SegmentedControl<ProcessingMode>
        ariaLabel="Processing mode"
        value={mode}
        onChange={(next) => {
          onChange(next);
          setTimeout(() => void load(), 50);
        }}
        options={[
          { value: 'offline', label: 'Offline' },
          { value: 'online', label: 'Online' },
          { value: 'automatic', label: 'Automatic' },
        ]}
      />
      <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
        {mode === 'offline'
          ? 'Nothing leaves this computer. AI that needs the internet is switched off.'
          : mode === 'online'
            ? 'Uses the providers you added. Local models are used only when you pick them per task.'
            : 'Prefers local models, and only uses a provider you have allowed when it must.'}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {TASKS.map((task) => (
          <TaskChip key={task.id} label={task.label} route={routes[task.id] ?? undefined} onRefresh={load} />
        ))}
      </div>
      {offline && (
        <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--warning)' }}>
          No internet connection is reachable right now, so online routes will fail until it returns.
        </p>
      )}
      {error && <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--danger)' }}>{error}</p>}
    </div>
  );
}

function TaskChip({
  label,
  route,
  onRefresh,
}: {
  label: string;
  route?: RoutePayload;
  onRefresh: () => void;
}) {
  const detail = route ? describeRoute(route) : 'Checking…';
  const tone: 'success' | 'warning' | 'error' | 'neutral' = !route
    ? 'neutral'
    : route.ok
      ? route.sendsDataOffDevice
        ? 'warning'
        : 'success'
      : 'error';

  return (
    <Chip
      variant={tone}
      onClick={() => {
        onRefresh();
      }}
    >
      {label}: {detail}
    </Chip>
  );
}

/** Mirrors `describeRoute` in ai-core so the chip text is stable across screens. */
export function describeRoute(route: RoutePayload): string {
  if (!route.ok) return 'Not available';
  switch (route.route) {
    case 'whisper':
      return `Whisper ${route.model ?? ''} on this computer`.trim();
    case 'ollama':
      return `${route.model ?? 'Ollama'} on this computer`;
    case 'heuristic':
      return 'Basic scoring (no model)';
    case 'provider':
      return `${route.providerName ?? 'Provider'}${route.sendsDataOffDevice ? ' · sends transcript text' : ''}`;
    default:
      return 'Available';
  }
}
