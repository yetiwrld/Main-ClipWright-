/**
 * SPEC 06 §3 — provider presets and Ollama suggestions, read from `/assets`.
 *
 * These files are data on purpose: a base URL or a capability flag can be
 * corrected without touching logic, and nothing here claims what a model costs
 * or how good it is — models are always discovered with `listModels` or typed by
 * the user.
 */

import presetData from '../../../../assets/provider-presets.json';
import suggestionData from '../../../../assets/ollama-suggestions.json';
import type { Capability, Locality, ProviderKind } from './types.js';

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  locality: Locality;
  capabilities: Capability[];
  needsKey: boolean;
  notes: string;
}

export interface OllamaSuggestion {
  name: string;
  approxSizeGb: number;
  ramGuidanceGb: number;
  notes: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = presetData.presets as ProviderPreset[];

export const OLLAMA_SUGGESTIONS: OllamaSuggestion[] = (
  suggestionData as { suggestions: OllamaSuggestion[] }
).suggestions;

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function presetsForKind(kind: ProviderKind): ProviderPreset[] {
  return PROVIDER_PRESETS.filter((preset) => preset.kind === kind);
}

/** Presets whose endpoint genuinely offers the capability, for "add provider" flows. */
export function presetsWithCapability(capability: Capability): ProviderPreset[] {
  return PROVIDER_PRESETS.filter((preset) => preset.capabilities.includes(capability));
}
