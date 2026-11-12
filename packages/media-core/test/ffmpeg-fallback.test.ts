import { describe, expect, it } from 'vitest';
import { parseFfprobeStderr } from '../src/ffmpeg-fallback.js';
import { parseFfprobeJson } from '../src/ffprobe-parse.js';

// Real capture from ffmpeg n9.0.2 -i (testsrc2 fixture generated in this repo's test setup)
const FIXTURE_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/fftest/fixture.mp4':
  Metadata:
    major_brand     : isom
  Duration: 00:00:01.00, start: 0.000000, bitrate: 396 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 320x240 [SAR 1:1 DAR 4:3], 304 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 70 kb/s (default)
  Stream #0:2[0x3](und): Video: mjpeg, yuvj420p, 320x240, 90k tbr, 90k tbn
At least one output file must be specified`;

describe('parseFfprobeStderr', () => {
  it('parses format and streams into ffprobe-shaped JSON', () => {
    const parsed = parseFfprobeStderr(FIXTURE_STDERR, 49575);
    expect(parsed.format.format_name).toContain('mov');
    expect(Number(parsed.format.duration)).toBeCloseTo(1.0, 2);
    expect(parsed.streams).toHaveLength(3);
    const video = parsed.streams[0]!;
    expect(video.codec_name).toBe('h264');
    expect(video.width).toBe(320);
    expect(video.height).toBe(240);
    expect(video.sample_aspect_ratio).toBe('1:1');
    const audio = parsed.streams[1]!;
    expect(audio.sample_rate).toBe('44100');
    expect(audio.channels).toBe(1);
  });

  it('round-trips through parseFfprobeJson', () => {
    const parsed = parseFfprobeStderr(FIXTURE_STDERR, 49575);
    const info = parseFfprobeJson({ format: parsed.format, streams: parsed.streams }, 'm1');
    expect(info.kind).toBe('video');
    expect(info.durationUs).toBe(1_000_000);
    expect(info.video?.width).toBe(320);
    expect(info.audio[0]?.sampleRate).toBe(44100);
  });
});
