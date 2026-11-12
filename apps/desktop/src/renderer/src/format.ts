import type { Job } from '@clipwright/project-schema';

export const fmtDuration = (us: number): string => {
  const s = Math.max(0, Math.floor(us / 1_000_000));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
};

export const fmtBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

export const fmtRelativeTime = (ts: number): string => {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};

export const jobPhaseLabel = (job: Job): string => {
  switch (job.type) {
    case 'copy': return 'Copying file';
    case 'probe': return 'Reading video details';
    case 'extract_audio': return 'Extracting audio';
    case 'thumbnails': return 'Making thumbnail';
    case 'proxy': return 'Preparing preview';
    case 'transcribe': return 'Transcribing';
    case 'moments': return 'Finding moments';
    case 'export': return 'Exporting';
    case 'download': return 'Downloading';
    case 'peaks': return 'Building waveform';
    default: return job.type;
  }
};

export const stageLabel = (stage: string): string => ({
  'created': 'Imported',
  'importing': 'Importing',
  'import-failed': 'Import failed',
  'transcribing': 'Transcribing',
  'transcribe-failed': 'Transcription failed',
  'transcribed': 'Transcribed',
  'moments': 'Analysing',
  'moments-failed': 'Analysis failed',
  'moments-ready': 'Moments ready',
  'editor': 'Editing',
  'exported': 'Exported',
} as Record<string, string>)[stage] ?? stage;
