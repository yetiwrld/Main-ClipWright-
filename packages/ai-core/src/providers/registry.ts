/**
 * SPEC 06 §2.2 — Adding a provider means adding one adapter and registering it.
 */

import { anthropicAdapter } from './anthropic.js';
import { geminiAdapter } from './gemini.js';
import { ollamaAdapter } from './ollama.js';
import { openAiCompatibleAdapter } from './openai-compatible.js';
import type { ProviderAdapter, ProviderKind } from './types.js';

const adapters: Record<ProviderKind, ProviderAdapter> = {
  'openai-compatible': openAiCompatibleAdapter,
  ollama: ollamaAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
};

export function getAdapter(kind: ProviderKind): ProviderAdapter {
  const adapter = adapters[kind];
  if (!adapter) throw new Error(`No adapter registered for provider kind "${kind}".`);
  return adapter;
}

export function listAdapterKinds(): ProviderKind[] {
  return Object.keys(adapters) as ProviderKind[];
}

export function registerAdapter(adapter: ProviderAdapter): void {
  adapters[adapter.kind] = adapter;
}
