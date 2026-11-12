import { describe, expect, it } from 'vitest';
import { parseFfprobeJson } from '../src/ffprobe-parse.js';
import { parseProgressLine, progressFromOutTime } from '../src/ffmpeg.js';

const sample = {
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '754.25', size: '482113024', bit_rate: '5115462', tags: { creation_time: '2024-05-01T10:00:00.000000Z', encoder: 'Lavf' } },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', profile: 'High', width: 1920, height: 1080,
      display_aspect_ratio: '16:9', sample_aspect_ratio: '1:1', avg_frame_rate: '30000/1001', r_frame_rate: '30000/1001',
      pix_fmt: 'yuv420p', color_space: 'bt709', bits_per_raw_sample: '8', disposition: { default: 0 } },
    { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', disposition: { default: 1 }, tags: { language: 'eng' } },
  ],
};

describe('parseFfprobeJson', () => {
  it('parses a 1080p H.264 MP4', () => {
    const info = parseFfprobeJson(sample, 'm1');
    expect(info.kind).toBe('video');
    expect(info.durationUs).toBe(754_250_000);
    expect(info.video?.fps).toBeCloseTo(29.97, 1);
    expect(info.video?.fpsMode).toBe('constant');
    expect(info.video?.displayWidth).toBe(1920);
    expect(info.audio[0]?.language).toBe('eng');
    expect(info.container).toBe('mov');
  });

  it('handles rotation via rotate tag (portrait phone video)', () => {
    const rotated = JSON.parse(JSON.stringify(sample));
    rotated.streams[0].tags = { rotate: '90' };
    const info = parseFfprobeJson(rotated, 'm2');
    expect(info.video?.rotation).toBe(90);
    expect(info.video?.displayWidth).toBe(1080);
    expect(info.video?.displayHeight).toBe(1920);
  });

  it('flags VFR when avg and real frame rates differ', () => {
    const vfr = JSON.parse(JSON.stringify(sample));
    vfr.streams[0].avg_frame_rate = '24000/1001';
    vfr.streams[0].r_frame_rate = '30000/1001';
    expect(parseFfprobeJson(vfr, 'm3').video?.fpsMode).toBe('variable');
  });

  it('detects HDR from transfer characteristics', () => {
    const hdr = JSON.parse(JSON.stringify(sample));
    hdr.streams[0].color_transfer = 'smpte2084';
    hdr.streams[0].color_primaries = 'bt2020';
    expect(parseFfprobeJson(hdr, 'm4').video?.hdr).toBe(true);
  });

  it('marks hasSpeechAudio=false for audio-less files', () => {
    const noAudio = { format: sample.format, streams: [sample.streams[0]] };
    const info = parseFfprobeJson(noAudio, 'm5');
    expect(info.hasSpeechAudio).toBe(false);
    expect(info.audio).toEqual([]);
  });
});

describe('progress parsing', () => {
  it('parses -progress lines', () => {
    expect(parseProgressLine('out_time_us=123456')).toEqual({ out_time_us: '123456' });
    expect(parseProgressLine('frame=  42')).toEqual({ frame: '  42' });
    expect(parseProgressLine('garbage line here')).toBeNull();
  });

  it('computes fractions with clamping', () => {
    expect(progressFromOutTime(50, 100)).toBe(0.5);
    expect(progressFromOutTime(150, 100)).toBe(1);
    expect(progressFromOutTime(50, 0)).toBe(0);
  });
});
