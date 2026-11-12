/**
 * faster-whisper backend. Honest by construction: if Python, the faster-whisper
 * package, or a matching model is not available, the job fails with a clear,
 * actionable message — the app never invents a transcript.
 *
 * Why this exists: the whisper.cpp engine reads only ggml-*.bin models. Many
 * PCs already carry OpenAI Whisper downloads in CTranslate2 format inside the
 * Hugging Face hub cache (e.g. Systran/faster-whisper-*, or
 * mobiuslabsgmbh/faster-whisper-large-v3-turbo). Those files are structurally
 * incompatible with whisper.cpp, so this backend runs them with the user's own
 * Python + faster-whisper instead.
 */
import { existsSync, readdirSync, statSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { parseFasterWhisperJson, type ParsedTranscript } from '@clipwright/ai-core';
import { newId, type TranscriptWord } from '@clipwright/project-schema';
import { WhisperError } from './whisper.js';

export interface DetectedFasterWhisperModel {
  /** HF repo id, e.g. 'Systran/faster-whisper-medium'. */
  repoId: string;
  /** Absolute path of the snapshot directory containing model.bin + config.json. */
  snapshotPath: string;
  sizeBytes: number;
}

export interface FasterWhisperStatus {
  /** Resolved executable (as invoked), null if no working Python + faster-whisper found. */
  pythonPath: string | null;
  /** Human-readable label for how Python was found (e.g. 'py -3.12' or 'CLIPWRIGHT_PYTHON'). */
  pythonLabel: string | null;
  /** Extra args that must precede the script (e.g. ['-3.12'] for the py launcher). */
  pythonArgs: string[];
  /** faster-whisper version reported by the interpreter, null if not detected. */
  version: string | null;
  /** Resolved HF hub cache root that models were scanned in. */
  hubCache: string;
  /** CT2 models found in the hub cache (complete snapshots only). */
  models: DetectedFasterWhisperModel[];
}

/** Prefix used in AppSettings.transcriptionModel / project settings to select this backend. */
export const FASTER_WHISPER_PREFIX = 'faster-whisper:';

/** HF hub cache root: HF_HUB_CACHE wins, then HF_HOME/hub, then the default. */
export const resolveHfHubCache = (env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string => {
  const direct = env['HF_HUB_CACHE'];
  if (direct && direct.trim()) return direct;
  const hfHome = env['HF_HOME'];
  if (hfHome && hfHome.trim()) return join(hfHome, 'hub');
  return join(home, '.cache', 'huggingface', 'hub');
};

/** 'models--Systran--faster-whisper-medium' -> 'Systran/faster-whisper-medium'. */
export const parseHfCacheDirName = (dir: string): string | null => {
  const m = /^models--(.+)$/.exec(dir);
  if (!m) return null;
  const rest = m[1]!;
  const idx = rest.indexOf('--');
  if (idx <= 0) return null;
  const org = rest.slice(0, idx).trim();
  const repo = rest.slice(idx + 2).trim();
  if (!org || !repo) return null;
  return `${org}/${repo}`;
};

interface SnapshotCandidate extends DetectedFasterWhisperModel { mtimeMs: number }

/**
 * Scan a HF hub cache for faster-whisper (CT2) models. A snapshot counts as usable
 * when it contains a model.bin of at least 1 MB and a config.json. The newest such
 * snapshot wins. This is a metadata-level check only — it cannot prove the weights
 * are uncorrupted; the first transcription will reveal that.
 */
export const scanFasterWhisperModels = (hubDir: string, minModelBinBytes = 1_000_000): DetectedFasterWhisperModel[] => {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try { entries = readdirSync(hubDir, { withFileTypes: true }) as never; } catch { return []; }
  const out: DetectedFasterWhisperModel[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const repoId = parseHfCacheDirName(e.name);
    if (!repoId) continue;
    const snapRoot = join(hubDir, e.name, 'snapshots');
    let snaps: Array<{ name: string; isDirectory(): boolean }>;
    try { snaps = readdirSync(snapRoot, { withFileTypes: true }) as never; } catch { continue; }
    let best: SnapshotCandidate | null = null;
    for (const s of snaps) {
      if (!s.isDirectory()) continue;
      const snapshotPath = join(snapRoot, s.name);
      const modelBin = join(snapshotPath, 'model.bin');
      const config = join(snapshotPath, 'config.json');
      try {
        const binStat = statSync(modelBin);
        if (!binStat.isFile() || binStat.size < minModelBinBytes) continue;
        if (!statSync(config).isFile()) continue;
        const mtimeMs = binStat.mtimeMs ?? 0;
        const candidate: SnapshotCandidate = { repoId, snapshotPath, sizeBytes: binStat.size, mtimeMs };
        if (!best || mtimeMs > best.mtimeMs) best = candidate;
      } catch { /* incomplete snapshot */ }
    }
    if (best) {
      const { mtimeMs: _mtimeMs, ...model } = best;
      void _mtimeMs;
      out.push(model);
    }
  }
  return out.sort((a, b) => a.repoId.localeCompare(b.repoId));
};

export interface PythonCandidate { command: string; args: string[]; label: string }

/**
 * Probe order: explicit override wins, then the py launcher (newest first, since a
 * newer default interpreter may lack the package), then unversioned interpreters,
 * then well-known Windows install locations. Every candidate is verified by actually
 * importing faster_whisper — nothing is assumed.
 */
export const pythonCandidates = (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): PythonCandidate[] => {
  const out: PythonCandidate[] = [];
  const explicit = env['CLIPWRIGHT_PYTHON'];
  if (explicit && explicit.trim()) {
    out.push({ command: explicit.trim(), args: [], label: 'CLIPWRIGHT_PYTHON' });
  }
  if (platform === 'win32') {
    const launcherArgs: string[][] = [['-3.12'], ['-3.13'], ['-3.11'], ['-3.10'], ['-3'], []];
    for (const args of launcherArgs) out.push({ command: 'py', args, label: ['py', ...args].join(' ').trim() });
    const localApp = env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local');
    for (const v of ['Python312', 'Python313', 'Python311', 'Python310']) {
      out.push({ command: join(localApp, 'Programs', 'Python', v, 'python.exe'), args: [], label: `%LOCALAPPDATA%\\Programs\\Python\\${v}\\python.exe` });
    }
    const programFiles = env['ProgramFiles'] || 'C:\\Program Files';
    for (const v of ['Python312', 'Python313', 'Python311', 'Python310']) {
      out.push({ command: join(programFiles, v, 'python.exe'), args: [], label: `%ProgramFiles%\\${v}\\python.exe` });
    }
    const userProfile = env['USERPROFILE'];
    if (userProfile) {
      for (const v of ['Python312', 'Python313', 'Python311', 'Python310']) {
        out.push({ command: join(userProfile, 'AppData', 'Local', 'Programs', 'Python', v, 'python.exe'), args: [], label: `%USERPROFILE%\\AppData\\Local\\Programs\\Python\\${v}\\python.exe` });
      }
    }
  }
  out.push({ command: platform === 'win32' ? 'python' : 'python3', args: [], label: 'python' });
  out.push({ command: 'python', args: [], label: 'python' });
  return out;
};

const PROBE = 'import faster_whisper; print(faster_whisper.__version__)';

const probePython = (candidate: PythonCandidate, env: NodeJS.ProcessEnv = process.env): Promise<string | null> =>
  new Promise<string | null>((resolve) => {
    // An explicit override path that doesn't exist is skipped cheaply.
    if (candidate.label === 'CLIPWRIGHT_PYTHON' && !existsSync(candidate.command)) return resolve(null);
    execFile(
      candidate.command,
      [...candidate.args, '-c', PROBE],
      { timeout: 30_000, windowsHide: true, env: { ...env } },
      (err, stdout) => {
        if (err) return resolve(null);
        const version = String(stdout).trim().split(/\r?\n/)[0]?.trim() ?? '';
        resolve(/^\d+\.\d+/.test(version) ? version : null);
      },
    );
  });

let detectCache: Promise<FasterWhisperStatus> | null = null;

/** Detect (and cache per session unless `refresh` is true) Python + faster-whisper + cached models. */
export const detectFasterWhisper = (refresh = false, env: NodeJS.ProcessEnv = process.env): Promise<FasterWhisperStatus> => {
  if (detectCache && !refresh) return detectCache;
  detectCache = (async () => {
    const hubCache = resolveHfHubCache(env);
    const models = scanFasterWhisperModels(hubCache);
    for (const candidate of pythonCandidates(env)) {
      const version = await probePython(candidate, env);
      if (version) {
        return { pythonPath: candidate.command, pythonLabel: candidate.label, pythonArgs: candidate.args, version, hubCache, models };
      }
    }
    return { pythonPath: null, pythonLabel: null, pythonArgs: [], version: null, hubCache, models };
  })();
  return detectCache;
};

/** Test seam: reset the detection cache. */
export const resetFasterWhisperDetectionCache = (): void => { detectCache = null; };

/** The Python helper. Arguments arrive via argv only; no paths are interpolated into source. */
const HELPER_PY = `
import argparse, json, sys

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--model', required=True)
    p.add_argument('--audio', required=True)
    p.add_argument('--language', default=None)
    p.add_argument('--out', required=True)
    a = p.parse_args()

    from faster_whisper import WhisperModel
    model = WhisperModel(a.model, device='auto', compute_type='default')
    lang = a.language if (a.language and a.language != 'auto') else None
    segments, info = model.transcribe(a.audio, word_timestamps=True, language=lang)

    items = []
    for seg in segments:
        words = []
        for w in (seg.words or []):
            words.append({
                'word': w.word,
                'start': float(w.start),
                'end': float(w.end),
                'probability': float(getattr(w, 'probability', 0.0) or 0.0),
            })
        items.append({'start': float(seg.start), 'end': float(seg.end), 'text': seg.text, 'words': words})
        print('SEGMENT %.3f' % seg.end, flush=True)

    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump({'language': getattr(info, 'language', None), 'segments': items}, f, ensure_ascii=False)

if __name__ == '__main__':
    main()
`;

export interface FasterWhisperTranscribeOptions {
  status: FasterWhisperStatus;
  modelSnapshotPath: string;
  /** 16 kHz mono pcm_s16le WAV (same as the whisper.cpp path). */
  audioWav: string;
  language?: string;
  /** Approximate audio duration in seconds, used only for the progress bar. */
  durationSec?: number;
  onProgress?: (fraction: number, phase: string) => void;
  signal?: AbortSignal;
}

export const transcribeFasterWhisper = async (
  opts: FasterWhisperTranscribeOptions,
): Promise<ParsedTranscript & { words: TranscriptWord[] }> => {
  const { status } = opts;
  if (!status.pythonPath) {
    throw new WhisperError(
      'No Python with faster-whisper was found. Install it (pip install faster-whisper) or point CLIPWRIGHT_PYTHON at one, e.g. C:\\Path\\To\\python.exe.',
      'no-binary',
    );
  }
  if (!existsSync(opts.modelSnapshotPath)) {
    throw new WhisperError('The selected faster-whisper model is missing from the Hugging Face cache. Re-download it and try again.', 'no-model');
  }

  const work = mkdtempSync(join(tmpdir(), 'clipwright-fw-'));
  const helper = join(work, 'faster_whisper_transcribe.py');
  const outJson = join(work, 'result.json');
  writeFileSync(helper, HELPER_PY, 'utf8');

  const args = [...status.pythonArgs, helper, '--model', opts.modelSnapshotPath, '--audio', opts.audioWav, '--out', outJson];
  if (opts.language && opts.language !== 'auto') args.push('--language', opts.language);

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(status.pythonPath as string, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new WhisperError('Transcription timed out.', 'failed')); }, 3 * 60 * 60 * 1000);
      opts.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
      let stdoutBuf = '';
      let stderrTail = '';
      child.stdout.on('data', (d: Buffer) => {
        stdoutBuf += d.toString('utf8');
        const matches = stdoutBuf.match(/SEGMENT\s+(\d+(?:\.\d+)?)/g) ?? [];
        for (const m of matches) {
          const endSec = Number(m.replace(/SEGMENT\s+/, ''));
          if (opts.durationSec && opts.durationSec > 0) {
            opts.onProgress?.(Math.min(0.92, 0.05 + 0.85 * (endSec / opts.durationSec)), 'transcribing');
          } else {
            opts.onProgress?.(0.5, 'transcribing');
          }
        }
        if (stdoutBuf.length > 8192) stdoutBuf = stdoutBuf.slice(-4096);
      });
      child.stderr.on('data', (d: Buffer) => {
        stderrTail = (stderrTail + d.toString('utf8')).slice(-2000);
      });
      child.on('error', (err) => { clearTimeout(timer); reject(new WhisperError(`Could not start Python (${err.message}).`, 'failed')); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new WhisperError(`faster-whisper exited with code ${code}. ${stderrTail.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 500) || 'Check that the model files are complete.'}`.trim(), 'failed'));
      });
    });

    let raw: unknown;
    try { raw = JSON.parse(readFileSync(outJson, 'utf8')); }
    catch { throw new WhisperError('faster-whisper finished but its output could not be read.', 'failed'); }
    const parsed = parseFasterWhisperJson(raw, newId);
    if (parsed.words.length === 0) {
      throw new WhisperError('No speech was detected in this video.', 'empty');
    }
    return parsed;
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* tmp dir is disposable */ }
  }
};
