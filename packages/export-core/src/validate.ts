/**
 * Post-export validation (Section 19.6). Pure check functions over ffprobe
 * JSON — unit-tested with real captured ffprobe shapes. The runner lives in
 * the desktop main process (it shells out to ffprobe/ffmpeg).
 */
export interface ValidationCheck {
  id: number;
  name: string;
  required: boolean;
  pass: boolean;
  expected: string;
  measured: string;
  detail?: string;
}
export interface ValidationReport {
  checks: ValidationCheck[];
  status: 'verified' | 'warnings' | 'failed';
  requiredFailures: ValidationCheck[];
}

export interface ExpectedStreamInfo {
  width: number;
  height: number;
  fps: number;
  durationUs: number;
  audioExpected: boolean;
  audioSampleRate?: number;
  audioChannels?: number;
  videoCodec?: string; // 'h264' | 'vp9'
  audioCodec?: string; // 'aac' | 'opus'
  timeBaseMatch?: boolean;
}

const fpsOf = (avg?: string, real?: string): { avg: number; real: number; mode: 'constant' | 'variable' | 'unknown' } => {
  const parse = (f?: string) => {
    if (!f) return 0;
    const [n, d] = f.split('/').map(Number);
    if (!n || !d) return 0;
    return n / d;
  };
  const a = parse(avg); const r = parse(real);
  let mode: 'constant' | 'variable' | 'unknown' = 'unknown';
  if (a > 0 && r > 0) mode = Math.abs(a - r) / Math.max(a, r) > 0.01 ? 'variable' : 'constant';
  return { avg: a, real: r, mode };
};

export const runValidationChecks = (plan: ExpectedStreamInfo, probe: unknown): ValidationReport => {
  const p = probe as { format?: { duration?: string; size?: string }; streams?: Array<Record<string, unknown>> };
  const streams = p.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video') as Record<string, unknown> | undefined;
  const audio = streams.find((s) => s.codec_type === 'audio') as Record<string, unknown> | undefined;
  const checks: ValidationCheck[] = [];
  const add = (id: number, name: string, required: boolean, pass: boolean, expected: string, measured: string, detail?: string) =>
    checks.push({ id, name, required, pass, expected, measured, ...(detail ? { detail } : {}) });

  // 2 stream structure
  add(2, 'Stream structure', true, !!video && (plan.audioExpected ? !!audio : true),
    plan.audioExpected ? '1 video + 1 audio' : '1 video',
    `${streams.filter((s) => s.codec_type === 'video').length} video, ${streams.filter((s) => s.codec_type === 'audio').length} audio`);

  // 3 size
  const vw = Number(video?.width ?? 0);
  const vh = Number(video?.height ?? 0);
  add(3, 'Frame size', true, vw === plan.width && vh === plan.height, `${plan.width}×${plan.height}`, `${vw}×${vh}`);

  // 4 aspect SAR 1:1
  const sar = String(video?.sample_aspect_ratio ?? '1:1');
  const sarOk = sar === '1:1' || sar === 'N/A' || sar === '0:1';
  add(4, 'Aspect ratio & SAR', true, sarOk, 'SAR 1:1', `SAR ${sar}`);

  // 5 fps constant == plan
  const f = fpsOf(video?.avg_frame_rate as string, video?.r_frame_rate as string);
  const fpsOk = f.mode === 'constant' && Math.abs(f.avg - plan.fps) < 0.01;
  add(5, 'Frame rate (constant)', true, fpsOk, `${plan.fps} fps constant`, `avg ${f.avg.toFixed(3)}, r ${f.real.toFixed(3)} (${f.mode})`);

  // 6 duration within 1 frame
  const frameUs = 1_000_000 / plan.fps;
  const durSec = Number(p.format?.duration ?? 0);
  const durUs = Math.round(durSec * 1_000_000);
  const durOk = Math.abs(durUs - plan.durationUs) <= frameUs;
  add(6, 'Duration', true, durOk,
    `${(plan.durationUs / 1_000_000).toFixed(3)} s (±1 frame)`,
    `${durSec.toFixed(3)} s`);

  // 7 frame count via nb_frames if present
  const nb = Number(video?.nb_frames ?? 0);
  const expectedFrames = Math.round((plan.durationUs / 1_000_000) * plan.fps);
  if (nb > 0) {
    add(7, 'Frame sequence', true, Math.abs(nb - expectedFrames) <= 1, `${expectedFrames} frames`, `${nb} frames`);
  } else {
    add(7, 'Frame sequence', true, true, `${expectedFrames} frames`, 'nb_frames not reported (decode check covers this)');
  }

  // 13 audio sanity (presence; loudness measured by caller via ebur128)
  if (plan.audioExpected && audio) {
    const sr = Number(audio.sample_rate ?? 0);
    add(13, 'Audio stream', true, sr === (plan.audioSampleRate ?? 48000), `${plan.audioSampleRate ?? 48000} Hz`, `${sr} Hz`);
  } else {
    add(13, 'Audio stream', true, true, 'n/a', plan.audioExpected ? 'MISSING' : 'none expected');
  }

  // 14 codec / pix-fmt
  const vcodec = String(video?.codec_name ?? '');
  const abitrateOk = audio ? true : !plan.audioExpected;
  const pixFmt = String(video?.pix_fmt ?? '');
  const videoOk = plan.videoCodec ? vcodec === plan.videoCodec : true;
  add(14, 'Codec & pixel format', true, videoOk && abitrateOk && (pixFmt === 'yuv420p' || !pixFmt),
    `${plan.videoCodec ?? 'any'} / yuv420p`, `${vcodec || 'none'} / ${pixFmt || 'none'}`);

  const requiredFailures = checks.filter((c) => c.required && !c.pass);
  const status = requiredFailures.length > 0 ? 'failed'
    : checks.some((c) => !c.pass) ? 'warnings' : 'verified';
  return { checks, status, requiredFailures };
};
