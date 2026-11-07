/**
 * SPEC 06 §7 — Local model manager types.
 *
 * Everything in this folder is data-driven: the catalogue lives in
 * `/assets/whisper-models.json` and `/assets/onnx-models.json`, the digests in
 * `/assets/model-checksums.json`. No sizes, RAM figures or "recommended" claims
 * are invented in code, and no model is ever called "best".
 */

export type AccuracyTier = 'fastest' | 'fast' | 'balanced' | 'accurate' | 'most_accurate';

export type ModelCategory = 'whisper' | 'onnx' | 'ollama';

export type Compatibility = 'good_fit' | 'slow' | 'may_run_out' | 'unknown';

export type ModelStatus =
  | 'not_installed'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'installed'
  | 'corrupt';

export interface WhisperCatalogEntry {
  id: string;
  label: string;
  fileName: string;
  bytes: number;
  /** Memory the model needs to run comfortably, in GB. */
  ramGb: number;
  accuracy: AccuracyTier;
  multilingual: boolean;
  languages: string;
  notes: string;
}

export interface OnnxCatalogEntry {
  id: string;
  label: string;
  fileName: string;
  bytes: number;
  bundled: boolean;
  purpose: string;
  notes: string;
}

export interface ModelCard {
  id: string;
  category: ModelCategory;
  label: string;
  fileName: string;
  expectedBytes: number;
  installedBytes: number;
  status: ModelStatus;
  /** Percentage 0–100 while downloading. */
  progress: number;
  /** Bytes per second, measured during this download; null when unknown. */
  bytesPerSecond: number | null;
  /** Seconds remaining, computed from the measured rate; null when unknown. */
  etaSeconds: number | null;
  /** `null` when no digest is pinned for this file — never assume "verified". */
  verified: boolean | null;
  checksumMissing: boolean;
  compatibility: Compatibility;
  /** Measured on this machine after a first run; null until we have data. */
  speedFactor: number | null;
  ramGb?: number;
  accuracy?: AccuracyTier;
  languages?: string;
  notes?: string;
  bundled?: boolean;
  error?: string;
}

export interface MachineProfile {
  totalRamGb: number;
  freeRamGb: number;
  /** Free space on the volume that holds the models folder, in GB. */
  freeDiskGb: number;
}

export interface DownloadRequest {
  id: string;
  /** Absolute URL of the file. */
  url: string;
  destDir: string;
  fileName: string;
  expectedBytes?: number;
  /** SHA-256 hex digest; omitted means "download but mark unverified". */
  expectedSha256?: string;
  signal?: AbortSignal;
}

export interface DownloadProgressEvent {
  id: string;
  bytesReceived: number;
  totalBytes: number | null;
  percent: number | null;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  status: ModelStatus;
  resumed: boolean;
  verified: boolean | null;
  error?: string;
}

export interface DownloadOutcome {
  id: string;
  filePath: string;
  bytes: number;
  verified: boolean | null;
  resumed: boolean;
  cancelled: boolean;
}
