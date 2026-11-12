/**
 * DEV-ONLY mock bridge for browser previews of the design showcase (/__design).
 * Installed only when import.meta.env.DEV is true and no preload bridge exists
 * (i.e. the renderer is served outside Electron). Never active in production
 * builds and never claims to be real data — the UI chrome renders, but every
 * call returns obviously-mock values.
 */
import type { AppSettings } from '@clipwright/project-schema';

export const installDevMockBridge = (): void => {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV) return; // hard-disabled in production builds
  const w = window as unknown as { clipwright?: unknown };
  if (w.clipwright) return; // real preload bridge present — never override

  const settings = {
    workspaceFolder: '/mock-workspace (dev preview — not real)',
    theme: 'dark',
    defaultQuality: 'high',
    defaultAspectRatio: '9:16',
    defaultExportPreset: '1080p',
    autosaveEnabled: true,
    autosaveIntervalSeconds: 30,
    updateCheckEnabled: false,
    updateChannel: 'stable',
    transcribeLanguage: 'auto',
    defaultWhisperModel: 'small',
    keychainAvailable: false,
    reducedMotion: false,
    debug: false,
  } as unknown as AppSettings;

  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
  const noopUnsub = () => () => undefined;

  w.clipwright = {
    getBoot: () => ok({ version: '0.1.0-dev-mock', workspaceFolder: settings.workspaceFolder, settings, firstRun: false, secretsMemoryOnly: true }),
    updateSettings: () => ok(settings),
    pickWorkspaceFolder: () => ok(null),
    revealPath: () => ok(false),
    openExternal: () => ok(false),
    logRendererError: () => ok(true),
    window: { minimize: () => undefined, toggleMaximize: () => undefined, close: () => undefined, isMaximized: () => Promise.resolve(false) },
    projects: { list: () => ok([]), get: () => ok(null), create: () => ok(null), update: () => ok(null), delete: () => ok(false), duplicate: () => ok(null) },
    media: { pickVideoFile: () => ok(null), probePath: () => ok(null), get: () => ok(null), importFile: () => ok({ mediaId: 'mock' }) },
    jobs: { list: () => ok({ active: [], recent: [] }), cancel: () => ok(false), onProgress: noopUnsub, onDone: noopUnsub, onFailed: noopUnsub },
    transcript: { load: () => ok([]), updateWord: () => ok(null), deleteWord: () => ok(false) },
    captions: { load: () => ok([]), save: () => ok(true) },
    moments: { load: () => ok([]), setStatus: () => ok(false), run: () => ok('mock-job'), createClips: () => ok({ created: [], errors: [] }) },
    composition: { list: () => ok([]), load: () => ok(null), save: () => ok({ savedAt: 0 }), delete: () => ok(false) },
    export: { plan: () => ok(null), start: () => ok('mock-export'), history: () => ok([]) },
    whisper: { listModels: () => ok({ binaryFound: false, modelsDir: '', models: [], defaultModel: 'small' }) },
    providers: { list: () => ok([]), saveOpenAiCompatible: () => ok({ id: 'mock', maskedSuffix: null }), delete: () => ok(false), test: () => ok({ reply: 'mock' }) },
    ollama: { status: () => ok({ available: false, version: null, models: [] }) },
    invoke: () => Promise.reject(new Error('dev mock bridge: “invoke” is not implemented')),
  };
  // Loud, honest banner for anyone who opens the preview.
  console.info('[clipwright dev-mock] Mock bridge installed — UI preview only, no real backend.');
};
