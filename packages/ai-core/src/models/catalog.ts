/// <reference types="node" />
/**
 * SPEC 06 §7.2/§7.4 — the model catalogue, read from data files, plus the
 * pure functions that turn "what is in the catalogue" and "what is on disk"
 * into the cards the Local Model Manager renders.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import whisperData from '../../../../assets/whisper-models.json';
import onnxData from '../../../../assets/onnx-models.json';
import checksumData from '../../../../assets/model-checksums.json';
import type {
  AccuracyTier,
  Compatibility,
  MachineProfile,
  ModelCard,
  ModelStatus,
  OnnxCatalogEntry,
  WhisperCatalogEntry,
} from './types.js';

const GB = 1024 ** 3;

const ACCURACY_ORDER: Record<AccuracyTier, number> = {
  fastest: 0,
  fast: 1,
  balanced: 2,
  accurate: 3,
  most_accurate: 4,
};

export const WHISPER_CATALOG: WhisperCatalogEntry[] = whisperData.models.map((m) => ({
  ...m,
  accuracy: m.accuracy as AccuracyTier,
}));

export const ONNX_CATALOG: OnnxCatalogEntry[] = onnxData.models;

export interface ChecksumFile {
  version: number;
  whisper: Record<string, string>;
  onnx: Record<string, string>;
}

export function whisperChecksums(): Record<string, string> {
  return { ...(checksumData as ChecksumFile).whisper };
}

export function onnxChecksums(): Record<string, string> {
  return { ...(checksumData as ChecksumFile).onnx };
}

export function findWhisperModel(id: string): WhisperCatalogEntry | undefined {
  return WHISPER_CATALOG.find((m) => m.id === id);
}

export function findOnnxModel(id: string): OnnxCatalogEntry | undefined {
  return ONNX_CATALOG.find((m) => m.id === id);
}

/** Sorts a catalogue fastest → most accurate, as the UI lists it. */
export function byAccuracy<T extends { accuracy: AccuracyTier }>(models: T[]): T[] {
  return [...models].sort((a, b) => ACCURACY_ORDER[a.accuracy] - ACCURACY_ORDER[b.accuracy]);
}

export function accuracyLabel(tier: AccuracyTier): string {
  switch (tier) {
    case 'fastest':
      return 'Fastest';
    case 'fast':
      return 'Fast';
    case 'balanced':
      return 'Balanced';
    case 'accurate':
      return 'Accurate';
    case 'most_accurate':
      return 'Most accurate';
  }
}

/**
 * SPEC 06 §7.2 — "Compatibility" from *this* machine's RAM.
 * We compare against free RAM with headroom for the app itself, and never claim
 * a model is fine when the numbers say otherwise.
 */
export function compatibilityFor(ramGb: number, machine: MachineProfile): Compatibility {
  if (!machine.totalRamGb || machine.totalRamGb <= 0) return 'unknown';
  const usable = Math.min(machine.freeRamGb || machine.totalRamGb, machine.totalRamGb);
  if (ramGb <= usable * 0.6) return 'good_fit';
  if (ramGb <= usable * 0.9) return 'slow';
  return 'may_run_out';
}

export function describeCompatibility(compatibility: Compatibility): string {
  switch (compatibility) {
    case 'good_fit':
      return 'Good fit';
    case 'slow':
      return 'Slow on this computer';
    case 'may_run_out':
      return 'May run out of memory';
    case 'unknown':
      return 'Memory unknown';
  }
}

export interface DiscoveredFile {
  fileName: string;
  bytes: number;
  modifiedMs: number;
}

/** Reads the model folder once and returns what is actually there. */
export function scanModelDir(dir: string): Map<string, DiscoveredFile> {
  const found = new Map<string, DiscoveredFile>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(full);
      found.set(entry.name, { fileName: entry.name, bytes: stat.size, modifiedMs: stat.mtimeMs });
    } catch {
      // A file that vanished between readdir and stat is simply absent.
    }
  }
  return found;
}

export function machineProfile(modelsDir?: string): MachineProfile {
  const totalRamGb = os.totalmem() / GB;
  const freeRamGb = os.freemem() / GB;
  let freeDiskGb = 0;
  try {
    const stat = fs.statfsSync(modelsDir ?? os.homedir());
    freeDiskGb = (stat.bavail * stat.bsize) / GB;
  } catch {
    freeDiskGb = 0;
  }
  return {
    totalRamGb: Math.round(totalRamGb * 10) / 10,
    freeRamGb: Math.round(freeRamGb * 10) / 10,
    freeDiskGb: Math.round(freeDiskGb * 10) / 10,
  };
}

export interface ModelCardInputs {
  dir: string;
  machine: MachineProfile;
  checksums?: Record<string, string>;
  /** Downloads currently in flight, keyed by model id. */
  active?: Map<string, { progress: number; bytesPerSecond: number | null; etaSeconds: number | null; status: ModelStatus }>;
  /** Speed factors measured on this machine (`05 §4.1`). */
  speedFactors?: Record<string, number>;
  /** Model ids whose file hash we have checked against the pinned digest. */
  verifiedIds?: Set<string>;
}

/**
 * Builds the Whisper cards.
 *
 * A file that exists with the wrong size is `corrupt`, not `installed`: the
 * whisper.cpp loader would fail on it and the user would get a confusing error
 * in the middle of a transcription instead of here.
 */
export function whisperCards(inputs: ModelCardInputs): ModelCard[] {
  const files = scanModelDir(inputs.dir);
  const checksums = inputs.checksums ?? whisperChecksums();

  return byAccuracy(WHISPER_CATALOG).map((model) => {
    const active = inputs.active?.get(model.id);
    const file = files.get(model.fileName);
    const part = files.get(`${model.fileName}.part`);
    const digest = checksums[model.id];

    let status: ModelStatus = 'not_installed';
    if (active) {
      status = active.status;
    } else if (file) {
      status = file.bytes === model.bytes ? 'installed' : 'corrupt';
    } else if (part) {
      status = 'paused';
    }

    const installedBytes = file?.bytes ?? part?.bytes ?? 0;
    const progress = active
      ? active.progress
      : status === 'installed'
        ? 100
        : installedBytes > 0
          ? Math.min(99, Math.round((installedBytes / model.bytes) * 100))
          : 0;

    return {
      id: model.id,
      category: 'whisper',
      label: model.label,
      fileName: model.fileName,
      expectedBytes: model.bytes,
      installedBytes,
      status,
      progress,
      bytesPerSecond: active?.bytesPerSecond ?? null,
      etaSeconds: active?.etaSeconds ?? null,
      // A file we have never hashed is "unknown", never "verified".
      verified:
        status === 'installed'
          ? digest
            ? (inputs.verifiedIds?.has(model.id) ?? false)
              ? true
              : null
            : false
          : null,
      checksumMissing: !digest,
      compatibility: compatibilityFor(model.ramGb, inputs.machine),
      speedFactor: inputs.speedFactors?.[model.id] ?? null,
      ramGb: model.ramGb,
      accuracy: model.accuracy,
      languages: model.languages,
      notes: model.notes,
    };
  });
}

export function onnxCards(inputs: ModelCardInputs): ModelCard[] {
  const files = scanModelDir(inputs.dir);
  const checksums = inputs.checksums ?? onnxChecksums();

  return ONNX_CATALOG.map((model) => {
    const active = inputs.active?.get(model.id);
    const file = files.get(model.fileName);
    const digest = checksums[model.id];

    let status: ModelStatus = 'not_installed';
    if (active) status = active.status;
    else if (file) status = file.bytes === model.bytes ? 'installed' : 'corrupt';

    return {
      id: model.id,
      category: 'onnx',
      label: model.label,
      fileName: model.fileName,
      expectedBytes: model.bytes,
      installedBytes: file?.bytes ?? 0,
      status,
      progress: status === 'installed' ? 100 : (active?.progress ?? 0),
      bytesPerSecond: active?.bytesPerSecond ?? null,
      etaSeconds: active?.etaSeconds ?? null,
      verified:
        status === 'installed'
          ? digest
            ? (inputs.verifiedIds?.has(model.id) ?? false)
              ? true
              : null
            : false
          : null,
      checksumMissing: !digest,
      compatibility: 'good_fit',
      speedFactor: null,
      notes: model.notes,
      bundled: model.bundled,
    };
  });
}

/** Free-space check required before a download starts (`06 §7.2`). */
export function hasRoomForDownload(bytes: number, machine: MachineProfile): boolean {
  if (!machine.freeDiskGb) return true; // unknown → do not block the user
  return machine.freeDiskGb * GB >= bytes * 1.2;
}
