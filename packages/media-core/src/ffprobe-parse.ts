/**
 * Pure parsers: ffprobe JSON -> MediaInfo. No binary required, unit-tested
 * against real captured ffprobe output shapes.
 */
import { z } from 'zod';
import type { MediaInfo } from '@clipwright/project-schema';

const FractionSchema = z.string().regex(/^\d+\/\d+$/);

const fractionToFloat = (f: string | undefined): number => {
  if (!f) return 0;
  const m = FractionSchema.safeParse(f);
  if (!m.success) {
    const n = Number(f);
    return Number.isFinite(n) ? n : 0;
  }
  const [num, den] = f.split('/').map(Number);
  if (!den) return 0;
  return num! / den!;
};

const parseRate = (avg?: string, real?: string): number => {
  const a = fractionToFloat(avg);
  const r = fractionToFloat(real);
  // ffprobe sometimes emits "0/0" for stills; fall back to r_frame_rate.
  if (a > 0) return a;
  if (r > 0) return r;
  return 30;
};

const rotationFromSideData = (sideData: unknown): 0 | 90 | 180 | 270 => {
  if (!Array.isArray(sideData)) return 0;
  for (const sd of sideData) {
    const rot = (sd as Record<string, unknown>)?.rotation;
    if (typeof rot === 'number') {
      const r = ((Math.round(rot) % 360) + 360) % 360;
      if (r === 90 || r === 270 || r === 180) return r as 90 | 180 | 270;
      if (r !== 0) return (Math.abs(r - 90) < 45 ? 90 : Math.abs(r - 270) < 45 ? 270 : r % 180 === 0 ? 180 : 0) as 0 | 90 | 180 | 270;
      return 0;
    }
    if (typeof rot === 'string') {
      const n = Math.abs(Math.round(Number(rot)));
      if (n === 90 || n === 180 || n === 270) return n as 90 | 180 | 270;
    }
  }
  return 0;
};

export interface ParsedStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  display_aspect_ratio?: string;
  sample_aspect_ratio?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  pix_fmt?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  bits_per_raw_sample?: string;
  bit_rate?: string;
  duration?: string;
  channels?: number;
  sample_rate?: string;
  tags?: Record<string, string>;
  side_data_list?: unknown;
  disposition?: Record<string, unknown>;
  index?: number;
}
export interface ParsedProbe {
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string; tags?: Record<string, string> };
  streams?: ParsedStream[];
}

export const parseFfprobeJson = (raw: unknown, mediaId: string): MediaInfo => {
  const probe = raw as ParsedProbe;
  const format = probe.format ?? {};
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audios = streams.filter((s) => s.codec_type === 'audio');

  const durationSec = Number(format.duration ?? video?.duration ?? audios[0]?.duration ?? 0);
  const durationUs = Number.isFinite(durationSec) ? Math.round(durationSec * 1_000_000) : 0;
  const sizeBytes = Number(format.size ?? 0) || 0;
  const kind: MediaInfo['kind'] = video ? 'video' : audios.length > 0 ? 'audio' : 'video';

  // rotation: displaymatrix side data, else rotate tag
  let rotation = rotationFromSideData(video?.side_data_list);
  if (rotation === 0 && video?.tags?.rotate) {
    const n = Math.abs(Math.round(Number(video.tags.rotate))) % 360;
    if (n === 90 || n === 180 || n === 270) rotation = n as 90 | 180 | 270;
  }
  const w = video?.width ?? 1;
  const h = video?.height ?? 1;
  const rotated = rotation === 90 || rotation === 270;

  // VFR detection: avg vs r frame rate differing > 1%
  const avg = fractionToFloat(video?.avg_frame_rate);
  const real = fractionToFloat(video?.r_frame_rate);
  let fpsMode: 'constant' | 'variable' | 'unknown' = 'unknown';
  if (avg > 0 && real > 0) {
    fpsMode = Math.abs(avg - real) / Math.max(avg, real) > 0.01 ? 'variable' : 'constant';
  }

  const transfer = video?.color_transfer ?? '';
  const primaries = video?.color_primaries ?? '';
  const hdr = /smpte2084|arib-std-b67/.test(transfer) || primaries === 'bt2020';

  const audio = audios.map((a, i) => ({
    index: a.index ?? i,
    codec: a.codec_name ?? 'unknown',
    channels: a.channels ?? 2,
    sampleRate: Number(a.sample_rate ?? 48000),
    language: a.tags?.language,
    title: a.tags?.title,
    default: a.disposition?.default === 1 || i === 0,
  }));
  // exactly one default flagged (first if none flagged)
  if (audio.length > 0 && !audio.some((a) => a.default)) audio[0]!.default = true;

  return {
    mediaId,
    kind,
    container: (format.format_name ?? 'unknown').split(',')[0] ?? 'unknown',
    durationUs,
    sizeBytes,
    bitrate: format.bit_rate ? Number(format.bit_rate) : undefined,
    video: video ? {
      codec: video.codec_name ?? 'unknown',
      profile: video.profile,
      width: w,
      height: h,
      displayWidth: rotated ? h : w,
      displayHeight: rotated ? w : h,
      rotation,
      sar: video.sample_aspect_ratio ?? '1:1',
      dar: video.display_aspect_ratio ?? '1:1',
      fps: parseRate(video.avg_frame_rate, video.r_frame_rate),
      fpsMode,
      pixFmt: video.pix_fmt ?? 'unknown',
      colorSpace: video.color_space,
      hdr,
      bitDepth: video.bits_per_raw_sample ? Number(video.bits_per_raw_sample) : undefined,
      hasAlpha: video.pix_fmt?.includes('a') ?? false,
    } : undefined,
    audio,
    metadata: format.tags ?? {},
    creationTime: format.tags?.creation_time,
    hasSpeechAudio: audio.length > 0,
  };
};
