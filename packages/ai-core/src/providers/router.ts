/**
 * SPEC 06 §6 — Task router.
 *
 * A pure function: given the user's processing mode, their provider records and
 * what is actually available right now, decide which provider+model runs a task
 * — or explain why it cannot and what to do next.
 *
 * Pipelines call this; they never read provider configuration themselves.
 */

import type { Capability, Locality, ProviderKind } from './types.js';

export type ProcessingMode = 'offline' | 'online' | 'automatic';

export type AiTask = 'transcription' | 'moment_analysis' | 'titles' | 'editor_ai';

export interface RouterProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  capabilities: Capability[];
  locality: Locality;
  status: 'connected' | 'not_tested' | 'error' | 'key_missing';
  models: { transcription?: string; text?: string };
  /** Consent already granted for the data category this task sends. */
  consentGranted: boolean;
}

export interface RouterEnvironment {
  /** A verified whisper.cpp model is installed on this machine. */
  whisperModelInstalled: boolean;
  whisperModelName?: string;
  /** Ollama answered a version probe and has at least one model. */
  ollamaAvailable: boolean;
  ollamaModel?: string;
}

export interface RouterSettings {
  mode: ProcessingMode;
  /** Per-task chosen provider ids; unset means Automatic. */
  defaultProviders: Partial<Record<AiTask, string>>;
}

export type Reason =
  | 'no_provider'
  | 'no_model'
  | 'provider_not_connected'
  | 'missing_capability'
  | 'needs_consent'
  | 'no_local_model'
  | 'task_needs_llm';

export interface FixAction {
  kind: 'add_provider' | 'set_up_provider' | 'download_model' | 'install_ollama' | 'grant_consent' | 'open_settings' | 'pick_model';
  label: string;
}

export type Route =
  | {
      ok: true;
      route: 'ollama' | 'whisper' | 'provider' | 'heuristic';
      providerId?: string;
      providerName?: string;
      model?: string;
      locality: Locality | 'local-machine';
      /** True when this route leaves this computer. */
      sendsDataOffDevice: boolean;
    }
  | {
      ok: false;
      reason: Reason;
      fix: FixAction[];
      message: string;
      /** Present when the refusal names a specific provider (consent, capability). */
      providerId?: string;
      providerName?: string;
    };

/** Every task except transcription sends transcript text only (SPEC 06 §8). */
export function taskSendsTextOffDevice(route: { sendsDataOffDevice: boolean }): boolean {
  return route.sendsDataOffDevice;
}

const TEXT_TASKS: AiTask[] = ['moment_analysis', 'titles', 'editor_ai'];

function isUsable(provider: RouterProvider): boolean {
  return provider.status === 'connected';
}

function needsConsentFor(provider: RouterProvider): boolean {
  return provider.locality !== 'local' && !provider.consentGranted;
}

function capable(provider: RouterProvider, capability: Capability): boolean {
  return provider.capabilities.includes(capability);
}

function modelFor(provider: RouterProvider, capability: Capability): string | undefined {
  return capability === 'transcription' ? provider.models.transcription : provider.models.text;
}

function providerRoute(provider: RouterProvider, capability: Capability, needsConsent: boolean): Route {
  return {
    ok: true,
    route: 'provider',
    providerId: provider.id,
    providerName: provider.name,
    model: modelFor(provider, capability),
    locality: provider.locality,
    sendsDataOffDevice: provider.locality !== 'local' && needsConsent === false ? true : provider.locality !== 'local',
  };
}

function consentRefusal(provider: RouterProvider): Route {
  const where = provider.locality === 'network' ? 'another computer on your network' : 'the internet';
  return {
    ok: false,
    reason: 'needs_consent',
    message: `Clipwright needs your permission before sending data to ${provider.name} over ${where}.`,
    fix: [{ kind: 'grant_consent', label: `Allow ${provider.name}` }],
    providerId: provider.id,
    providerName: provider.name,
  };
}

function noProvider(reason: Reason, message: string, fix: FixAction[], mode: ProcessingMode): Route {
  if (mode !== 'offline') {
    return { ok: false, reason, message, fix };
  }
  return { ok: false, reason, message, fix };
}

export function resolveProvider(
  task: AiTask,
  settings: RouterSettings,
  providers: RouterProvider[],
  env: RouterEnvironment
): Route {
  const mode = settings.mode ?? 'automatic';
  const capability: Capability = task === 'transcription' ? 'transcription' : 'text';
  const chosenId = settings.defaultProviders?.[task];
  const chosen = chosenId ? providers.find((p) => p.id === chosenId) : undefined;

  if (mode === 'offline') {
    return resolveOffline(task, capability, chosen, env);
  }

  if (mode === 'online') {
    return resolveOnline(task, capability, chosen, providers);
  }

  return resolveAutomatic(task, capability, chosen, providers, env);
}

function resolveOffline(
  task: AiTask,
  capability: Capability,
  chosen: RouterProvider | undefined,
  env: RouterEnvironment
): Route {
  if (capability === 'transcription') {
    if (chosen && chosen.locality === 'local' && isUsable(chosen)) {
      return providerRoute(chosen, 'transcription', false);
    }
    if (env.whisperModelInstalled) {
      return {
        ok: true,
        route: 'whisper',
        model: env.whisperModelName,
        locality: 'local-machine',
        sendsDataOffDevice: false,
      };
    }
    return {
      ok: false,
      reason: 'no_model',
      message: 'No Whisper model is installed, and Offline mode never sends audio anywhere.',
      fix: [{ kind: 'download_model', label: 'Download a Whisper model' }],
    };
  }

  // Text tasks: a local provider, otherwise a local model, otherwise no LLM.
  const localProvider = chosen && chosen.locality === 'local' ? chosen : undefined;
  if (localProvider && isUsable(localProvider) && capable(localProvider, 'text')) {
    return providerRoute(localProvider, 'text', false);
  }

  if (env.ollamaAvailable) {
    return {
      ok: true,
      route: 'ollama',
      model: env.ollamaModel,
      locality: 'local',
      sendsDataOffDevice: false,
    };
  }

  if (task === 'moment_analysis') {
    return {
      ok: true,
      route: 'heuristic',
      locality: 'local-machine',
      sendsDataOffDevice: false,
    };
  }

  if (task === 'titles') {
    return { ok: true, route: 'heuristic', locality: 'local-machine', sendsDataOffDevice: false };
  }

  return {
    ok: false,
    reason: 'task_needs_llm',
    message: 'This tool needs a language model, and Offline mode never sends data anywhere.',
    fix: [
      { kind: 'install_ollama', label: 'Get a local model (Ollama)' },
      { kind: 'open_settings', label: 'Switch processing mode' },
    ],
  };
}

function resolveOnline(
  task: AiTask,
  capability: Capability,
  chosen: RouterProvider | undefined,
  providers: RouterProvider[]
): Route {
  const candidates = chosen ? [chosen] : providers.filter((p) => capable(p, capability) && p.locality !== 'local');

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'no_provider',
      message: 'Online AI mode needs a provider that can handle this task.',
      fix: [{ kind: 'add_provider', label: 'Add a provider' }],
    };
  }

  const provider = candidates[0];
  if (!capable(provider, capability)) {
    return {
      ok: false,
      reason: 'missing_capability',
      message: `${provider.name} can't handle this task.`,
      fix: [{ kind: 'pick_model', label: 'Choose another provider' }],
    };
  }
  if (provider.status === 'key_missing') {
    return {
      ok: false,
      reason: 'provider_not_connected',
      message: `${provider.name} has no key saved yet.`,
      fix: [{ kind: 'set_up_provider', label: 'Add the key' }],
    };
  }
  if (!isUsable(provider)) {
    return {
      ok: false,
      reason: 'provider_not_connected',
      message: `${provider.name} hasn't connected yet. Test it in Settings.`,
      fix: [{ kind: 'set_up_provider', label: 'Test connection' }],
    };
  }
  if (!modelFor(provider, capability)) {
    return {
      ok: false,
      reason: 'no_model',
      message: `Pick a model for ${provider.name} first.`,
      fix: [{ kind: 'pick_model', label: 'Choose a model' }],
    };
  }
  if (needsConsentFor(provider)) {
    return consentRefusal(provider);
  }
  return providerRoute(provider, capability, true);
}

function resolveAutomatic(
  task: AiTask,
  capability: Capability,
  chosen: RouterProvider | undefined,
  providers: RouterProvider[],
  env: RouterEnvironment
): Route {
  // 1. The user's explicit choice, when it is connected and capable.
  if (chosen && capable(chosen, capability) && isUsable(chosen) && modelFor(chosen, capability)) {
    if (chosen.locality === 'local') return providerRoute(chosen, 'text', false);
    if (chosen.consentGranted) return providerRoute(chosen, capability, true);
    // Automatic never silently sends data: stop and ask.
    return consentRefusal(chosen);
  }

  // 2. Local machine.
  if (capability === 'transcription' && env.whisperModelInstalled) {
    return {
      ok: true,
      route: 'whisper',
      model: env.whisperModelName,
      locality: 'local-machine',
      sendsDataOffDevice: false,
    };
  }

  if (TEXT_TASKS.includes(task) && env.ollamaAvailable) {
    return { ok: true, route: 'ollama', model: env.ollamaModel, locality: 'local', sendsDataOffDevice: false };
  }

  // 3. A connected online provider, but only with consent already granted.
  const online = providers.filter((p) => p.locality !== 'local' && capable(p, capability) && isUsable(p));
  const consented = online.find((p) => p.consentGranted && modelFor(p, capability));
  if (consented) return providerRoute(consented, capability, true);

  const needsConsent = online.find((p) => modelFor(p, capability));
  if (needsConsent) return consentRefusal(needsConsent);

  // 4. Local fallbacks that need no model at all.
  if (task === 'moment_analysis' || task === 'titles') {
    return { ok: true, route: 'heuristic', locality: 'local-machine', sendsDataOffDevice: false };
  }

  if (capability === 'transcription') {
    return noProvider(
      'no_model',
      'No transcription engine is available. Install a Whisper model or add a provider.',
      [
        { kind: 'download_model', label: 'Download a Whisper model' },
        { kind: 'add_provider', label: 'Add a provider' },
      ],
      'automatic'
    );
  }

  return {
    ok: false,
    reason: 'task_needs_llm',
    message: 'This tool needs a language model. Add a provider, or run one locally with Ollama.',
    fix: [
      { kind: 'add_provider', label: 'Add a provider' },
      { kind: 'install_ollama', label: 'Get a local model' },
    ],
  };
}

/** Human-readable one-liner for the mode summary panel and per-task chips. */
export function describeRoute(task: AiTask, route: Route): string {
  const label = TASK_LABELS[task];
  if (!route.ok) {
    return `${label} → not available (${route.message})`;
  }
  switch (route.route) {
    case 'whisper':
      return `${label} → Whisper ${route.model ?? ''} (on this computer)`.replace('  ', ' ');
    case 'ollama':
      return `${label} → ${route.model ?? 'Ollama model'} via Ollama (on this computer)`;
    case 'heuristic':
      return `${label} → Basic scoring (no AI model)`;
    case 'provider':
      return `${label} → ${route.providerName}${route.model ? ` · ${route.model}` : ''} (${
        route.locality === 'local' ? 'on this computer' : route.locality === 'network' ? 'on your network' : 'online'
      })`;
  }
}

const TASK_LABELS: Record<AiTask, string> = {
  transcription: 'Transcription',
  moment_analysis: 'Moments',
  titles: 'Titles',
  editor_ai: 'Editor AI',
};
