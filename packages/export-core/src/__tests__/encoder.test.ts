import { describe, expect, it } from 'vitest';
import {
  buildEncoderArgs,
  buildDecodeArgs,
  buildLoudnessArgs,
  chooseVideoEncoder,
  containerFor,
  audioArgs,
  metadataArgs,
  videoQualityArgs,
  sourceFilterChain,
  hardwareQualityValue,
  parseIntegratedLoudness,
  loudnessGainDb,
  HARDWARE_ENCODERS,
  SOFTWARE_H264,
  SOFTWARE_VP9,
  COLOUR_ARGS,
  cfrArgs,
  detectCapabilities,
  DEFAULT_CAPABILITIES,
} from '../encoder.js';
import { buildExportPlan } from '../planner.js';
import type { ExportPlan, ExportSettings } from '../planner.js';

function makeSettings(overrides: Partial<ExportSettings> = {}): ExportSettings {
  return {
    compositionId: 'comp-1',
    projectId: 'proj-1',
    preset: '1080p',
    aspect: '9:16',
    fps: 30,
    format: 'mp4',
    quality: 'standard',
    rateControl: 'vbr',
    audioBitrate: 192,
    includeAudio: true,
    burnCaptions: true,
    saveSubtitles: false,
    subtitleFormats: [],
    embedProjectName: true,
    normaliseLoudness: false,
    targetLufs: -16,
    isDraft: false,
    rangeUs: [0, 10_000_000],
    compositionFps: 30,
    compositionDurationUs: 10_000_000,
    items: [],
    ...overrides,
  };
}

function makePlan(overrides: Partial<ExportSettings> = {}): ExportPlan {
  return buildExportPlan(makeSettings(overrides));
}

function encodeArgsFor(plan: ExportPlan, extra: { audioInput?: string } = {}) {
  return buildEncoderArgs({
    plan,
    videoInput: 'pipe:0',
    outputPath: '/tmp/out.partial.mp4',
    encoder: chooseVideoEncoder(plan),
    title: 'My clip',
    ...extra,
  });
}

describe('chooseVideoEncoder', () => {
  it('uses libx264 for MP4 by default', () => {
    expect(chooseVideoEncoder(makePlan()).codec).toBe('libx264');
  });

  it('uses libvpx-vp9 for WebM', () => {
    expect(chooseVideoEncoder(makePlan({ format: 'webm' })).codec).toBe('libvpx-vp9');
  });

  it('ignores hardware for WebM, which has no hardware path here', () => {
    const plan = makePlan({ format: 'webm' });
    expect(chooseVideoEncoder(plan, { validatedHardware: 'nvenc' })).toEqual(SOFTWARE_VP9);
  });

  it('prefers validated hardware for MP4', () => {
    const choice = chooseVideoEncoder(makePlan(), { validatedHardware: 'nvenc' });
    expect(choice).toEqual(HARDWARE_ENCODERS.nvenc);
    expect(choice.label).toBe('H.264 · NVIDIA NVENC');
  });

  it('falls back to libx264 when hardware validation failed', () => {
    expect(chooseVideoEncoder(makePlan(), { validatedHardware: null })).toEqual(SOFTWARE_H264);
  });

  it('forceCpu overrides detected hardware', () => {
    const choice = chooseVideoEncoder(makePlan(), { validatedHardware: 'qsv', forceCpu: true });
    expect(choice).toEqual(SOFTWARE_H264);
  });
});

describe('containerFor', () => {
  it('gives mp4 + faststart', () => {
    expect(containerFor(makePlan())).toEqual({ extension: 'mp4', movFlags: '+faststart' });
  });

  it('gives webm without movflags', () => {
    expect(containerFor(makePlan({ format: 'webm' }))).toEqual({ extension: 'webm' });
  });
});

describe('videoQualityArgs', () => {
  it('uses CRF and preset for libx264', () => {
    const plan = makePlan({ quality: 'high' });
    expect(videoQualityArgs(plan, SOFTWARE_H264)).toEqual(['-crf', '19', '-preset', 'medium']);
  });

  it('maps every quality preset to the documented CRF ladder', () => {
    const expected: Array<[ExportSettings['quality'], string, string]> = [
      ['draft', '26', 'veryfast'],
      ['standard', '22', 'fast'],
      ['high', '19', 'medium'],
      ['maximum', '16', 'slow'],
    ];
    for (const [quality, crf, preset] of expected) {
      const plan = makePlan({ quality });
      expect(videoQualityArgs(plan, SOFTWARE_H264)).toEqual(['-crf', crf, '-preset', preset]);
    }
  });

  it('uses CRF and zero bitrate for VP9, with row multithreading', () => {
    const plan = makePlan({ format: 'webm', quality: 'standard' });
    expect(videoQualityArgs(plan, SOFTWARE_VP9)).toEqual(['-crf', '33', '-b:v', '0', '-row-mt', '1']);
  });

  it('honours a custom bitrate over the quality preset', () => {
    const plan = makePlan({ videoBitrate: 8 });
    const args = videoQualityArgs(plan, SOFTWARE_H264);
    expect(args[0]).toBe('-b:v');
    expect(args[1]).toBe('8000k');
    expect(args).not.toContain('-crf');
  });

  it('adds minrate for CBR custom bitrate', () => {
    const plan = makePlan({ videoBitrate: 8, rateControl: 'cbr' });
    const args = videoQualityArgs(plan, SOFTWARE_H264);
    expect(args).toContain('-minrate');
    expect(args[args.indexOf('-minrate') + 1]).toBe('8000k');
  });

  it('uses zero CRF with a bitrate for VP9 custom bitrate', () => {
    const plan = makePlan({ format: 'webm', videoBitrate: 5 });
    const args = videoQualityArgs(plan, SOFTWARE_VP9);
    expect(args).toContain('-b:v');
    expect(args[args.indexOf('-crf') + 1]).toBe('0');
  });

  it('uses constant QP for NVENC rather than CRF', () => {
    const plan = makePlan({ quality: 'high' });
    const args = videoQualityArgs(plan, HARDWARE_ENCODERS.nvenc);
    expect(args).not.toContain('-crf');
    expect(args[args.indexOf('-qp') + 1]).toBe('19');
  });
});

describe('hardwareQualityValue', () => {
  it('passes CRF through for NVENC/QSV/AMF scales', () => {
    expect(hardwareQualityValue(22, 'nvenc')).toBe(22);
    expect(hardwareQualityValue(22, 'qsv')).toBe(22);
    expect(hardwareQualityValue(22, 'amf')).toBe(22);
  });

  it('inverts the ladder for VideoToolbox (higher is better)', () => {
    const better = hardwareQualityValue(16, 'videotoolbox');
    const worse = hardwareQualityValue(26, 'videotoolbox');
    expect(better).toBeGreaterThan(worse);
  });
});

describe('audioArgs', () => {
  it('encodes AAC-LC 48 kHz stereo for MP4', () => {
    const args = audioArgs(makePlan());
    expect(args).toContain('aac');
    expect(args).toContain('aac_low');
    expect(args[args.indexOf('-b:a') + 1]).toBe('192k');
    expect(args[args.indexOf('-ar') + 1]).toBe('48000');
    expect(args[args.indexOf('-ac') + 1]).toBe('2');
  });

  it('encodes Opus for WebM', () => {
    expect(audioArgs(makePlan({ format: 'webm' }))).toContain('libopus');
  });

  it('disables audio when audio is excluded', () => {
    expect(audioArgs(makePlan({ includeAudio: false }))).toEqual(['-an']);
  });

  it('respects the chosen audio bitrate', () => {
    const args = audioArgs(makePlan({ audioBitrate: 320 }));
    expect(args[args.indexOf('-b:a') + 1]).toBe('320k');
  });
});

describe('metadataArgs', () => {
  it('strips source metadata and sets a title', () => {
    const args = metadataArgs(makePlan(), 'My clip');
    expect(args.slice(0, 2)).toEqual(['-map_metadata', '-1']);
    expect(args).toContain('title=My clip');
  });

  it('embeds the project name when enabled', () => {
    const args = metadataArgs(makePlan({ embedProjectName: true }), 'My clip');
    expect(args.some((a) => a.startsWith('comment='))).toBe(true);
  });

  it('omits the comment when disabled', () => {
    const args = metadataArgs(makePlan({ embedProjectName: false }), 'My clip');
    expect(args.some((a) => a.startsWith('comment='))).toBe(false);
  });
});

describe('buildEncoderArgs', () => {
  it('starts with rawvideo on stdin at the plan resolution and rate', () => {
    const plan = makePlan();
    const args = encodeArgsFor(plan);
    expect(args[args.indexOf('-f') + 1]).toBe('rawvideo');
    expect(args[args.indexOf('-s') + 1]).toBe('1080x1920');
    expect(args[args.indexOf('-framerate') + 1]).toBe('30');
    expect(args[args.indexOf('-i') + 1]).toBe('pipe:0');
  });

  it('maps video and audio streams explicitly', () => {
    const args = encodeArgsFor(makePlan(), { audioInput: '/tmp/mix.wav' });
    expect(args.filter((a) => a === '-map')).toHaveLength(2);
    expect(args).toContain('0:v:0');
    expect(args).toContain('1:a:0');
  });

  it('maps only video when there is no audio input', () => {
    const args = encodeArgsFor(makePlan());
    expect(args.filter((a) => a === '-map')).toHaveLength(1);
  });

  it('writes constant frame rate', () => {
    const args = encodeArgsFor(makePlan({ fps: 60 }));
    // Default build spelling is the legacy one; either way CFR is requested.
    expect(args[args.indexOf('-vsync') + 1]).toBe('cfr');
    expect(args[args.indexOf('-r') + 1]).toBe('60');
  });

  it('writes -fps_mode when the build supports it', () => {
    const plan = makePlan({ fps: 60 });
    const args = buildEncoderArgs({
      plan,
      videoInput: 'pipe:0',
      outputPath: '/tmp/out.partial.mp4',
      encoder: chooseVideoEncoder(plan),
      title: 'Clip',
      capabilities: { fpsMode: true },
    });
    expect(args[args.indexOf('-fps_mode') + 1]).toBe('cfr');
    expect(args).not.toContain('-vsync');
  });

  it('always tags BT.709 limited range', () => {
    const args = encodeArgsFor(makePlan());
    for (const flag of COLOUR_ARGS) expect(args).toContain(flag);
    expect(args[args.indexOf('-color_range') + 1]).toBe('tv');
  });

  it('bounds the encode to the planned duration', () => {
    const plan = makePlan({ rangeUs: [0, 10_000_000] });
    const args = encodeArgsFor(plan);
    expect(args[args.indexOf('-t') + 1]).toBe('10.000000');
  });

  it('writes faststart for MP4', () => {
    expect(encodeArgsFor(makePlan())[encodeArgsFor(makePlan()).indexOf('-movflags') + 1]).toBe('+faststart');
  });

  it('omits faststart for WebM', () => {
    expect(encodeArgsFor(makePlan({ format: 'webm' }))).not.toContain('+faststart');
  });

  it('ends with the output path and overwrite flag', () => {
    const args = encodeArgsFor(makePlan());
    expect(args[args.length - 1]).toBe('/tmp/out.partial.mp4');
    expect(args[args.length - 2]).toBe('-y');
  });

  it('targets the VP9 encoder arguments for WebM', () => {
    const plan = makePlan({ format: 'webm' });
    const args = encodeArgsFor(plan);
    expect(args[args.indexOf('-c:v') + 1]).toBe('libvpx-vp9');
    expect(args).toContain('-row-mt');
  });
});

describe('sourceFilterChain', () => {
  it('resamples to the target fps on a nearest-time grid', () => {
    const chain = sourceFilterChain({ targetFps: 30, outputWidth: 1080, outputHeight: 1920 });
    expect(chain).toContain('fps=30:round=near');
  });

  it('never decodes above the source size', () => {
    const chain = sourceFilterChain({
      targetFps: 30,
      sourceWidth: 640,
      sourceHeight: 360,
      outputWidth: 1080,
      outputHeight: 1920,
    });
    expect(chain).toContain('scale=640:360');
  });

  it('never decodes above the output size', () => {
    const chain = sourceFilterChain({
      targetFps: 30,
      sourceWidth: 3840,
      sourceHeight: 2160,
      outputWidth: 1080,
      outputHeight: 1920,
    });
    expect(chain).toContain('scale=1080:1920');
  });

  it('rounds to even dimensions', () => {
    const chain = sourceFilterChain({ targetFps: 30, sourceWidth: 641, sourceHeight: 361, outputWidth: 1080, outputHeight: 1920 });
    expect(chain).toContain('scale=642:362');
  });

  it('adds setpts for speed changes', () => {
    const chain = sourceFilterChain({ targetFps: 30, outputWidth: 1080, outputHeight: 1920, speed: 2 });
    expect(chain).toContain('setpts=0.500000*PTS');
  });

  it('leaves normal speed alone', () => {
    expect(sourceFilterChain({ targetFps: 30, outputWidth: 1080, outputHeight: 1920, speed: 1 })).not.toContain('setpts');
  });

  it('ends in yuv420p', () => {
    expect(sourceFilterChain({ targetFps: 30, outputWidth: 1080, outputHeight: 1920 }).endsWith('format=yuv420p')).toBe(true);
  });
});

describe('buildDecodeArgs', () => {
  it('seeks on the input side and bounds the read', () => {
    const args = buildDecodeArgs({
      sourcePath: '/media/a.mp4',
      inUs: 2_500_000,
      durationUs: 5_000_000,
      filterChain: 'fps=30:round=near',
    });
    expect(args[args.indexOf('-ss') + 1]).toBe('2.500000');
    expect(args[args.indexOf('-t') + 1]).toBe('5.000000');
    expect(args[args.indexOf('-i') + 1]).toBe('/media/a.mp4');
    // Input-side seek: -ss must come before -i or the seek is not fast.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-f') + 1]).toBe('rawvideo');
    expect(args[args.length - 1]).toBe('-');
  });
});

describe('buildLoudnessArgs', () => {
  it('runs ebur128 with true peak', () => {
    expect(buildLoudnessArgs('/tmp/mix.wav')).toEqual(
      ['-hide_banner', '-nostdin', '-i', '/tmp/mix.wav', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    );
  });
});

describe('parseIntegratedLoudness', () => {
  const SAMPLE = `
[Parsed_ebur128_0 @ 0x1] t: 9.9 TARGET:-16 LUFS M: -18.2 S:-120.7 I: -18.2 LUFS LRA: 1.2 LU
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -18.2 LUFS
    Threshold: -28.4 LUFS

  Loudness range:
    LRA:         1.2 LU
    Threshold: -38.7 LUFS

  True peak:
    Peak:       -3.4 dBFS
`;

  it('reads integrated loudness and true peak', () => {
    expect(parseIntegratedLoudness(SAMPLE)).toEqual({ integratedLufs: -18.2, truePeakDb: -3.4 });
  });

  it('returns null when there is no summary block', () => {
    expect(parseIntegratedLoudness('t: 1.0 M: -20.0 S: -120.0')).toBeNull();
  });

  it('returns null when the summary has no integrated line', () => {
    expect(parseIntegratedLoudness('Summary:\n  Integrated loudness:\n')).toBeNull();
  });
});

describe('loudnessGainDb', () => {
  it('raises quiet mixes toward the target', () => {
    expect(loudnessGainDb(-18.2, -16)).toBeCloseTo(2.2);
  });

  it('lowers loud mixes toward the target', () => {
    expect(loudnessGainDb(-12, -16)).toBeCloseTo(-4);
  });

  it('clamps the correction to a sane range', () => {
    expect(loudnessGainDb(-60, -16)).toBe(24);
    expect(loudnessGainDb(-2, -16)).toBe(-14);
  });

  it('leaves silence alone', () => {
    expect(loudnessGainDb(-91, -16)).toBe(0);
  });

  it('leaves non-finite measurements alone', () => {
    expect(loudnessGainDb(Number.NEGATIVE_INFINITY, -16)).toBe(0);
  });
});

describe('cfrArgs / detectCapabilities', () => {
  it('uses -fps_mode on builds that know it', () => {
    expect(cfrArgs(30, { fpsMode: true })).toEqual(['-r', '30', '-fps_mode', 'cfr']);
  });

  it('falls back to -vsync on older builds', () => {
    expect(cfrArgs(30, { fpsMode: false })).toEqual(['-r', '30', '-vsync', 'cfr']);
  });

  it('detects -fps_mode from help output', () => {
    expect(detectCapabilities('-fps_mode <int> E..V.... Set timestamps mode')).toEqual({ fpsMode: true });
  });

  it('reports the legacy build when the option is absent', () => {
    expect(detectCapabilities('-vsync <int> E..V.... Video sync method')).toEqual({ fpsMode: false });
  });

  it('defaults to the option that exists everywhere', () => {
    expect(DEFAULT_CAPABILITIES.fpsMode).toBe(false);
  });
});

describe('sourceFilterChain fit mode', () => {
  it('letterboxes into the canvas instead of stretching', () => {
    const chain = sourceFilterChain({
      targetFps: 30,
      outputWidth: 1080,
      outputHeight: 1920,
      fit: 'fit',
    });
    expect(chain).toContain('scale=1080:1920:force_original_aspect_ratio=decrease');
    expect(chain).toContain('pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black');
    expect(chain).toContain('setsar=1');
  });

  it('keeps even canvas dimensions in fit mode', () => {
    const chain = sourceFilterChain({ targetFps: 30, outputWidth: 1081, outputHeight: 1921, fit: 'fit' });
    expect(chain).toContain('pad=1082:1922');
  });

  it('defaults to fill mode', () => {
    const chain = sourceFilterChain({ targetFps: 30, outputWidth: 1080, outputHeight: 1920 });
    expect(chain).not.toContain('pad=');
  });
});

/**
 * SPEC 10 §8.4–8.6 — the export has to draw what the preview drew.
 *
 * The interesting property is not "a filter appears" but that the chain stays
 * valid: every stage has to emit even dimensions (yuv420p cannot hold an odd width)
 * and the final stage has to land back on the exact output size, or the encoder
 * rejects the stream halfway through a long export.
 */
describe('sourceFilterChain geometry', () => {
  const base = { targetFps: 30, outputWidth: 1080, outputHeight: 1920, fit: 'fit' as const };

  it('leaves an untouched item exactly as it was', () => {
    expect(sourceFilterChain({ ...base, geometry: {} })).toBe(sourceFilterChain(base));
    expect(sourceFilterChain({ ...base, geometry: { crop: {}, transform: {} } })).toBe(
      sourceFilterChain(base),
    );
  });

  it('crops in source-fraction maths so any source size works', () => {
    const chain = sourceFilterChain({ ...base, geometry: { crop: { left: 0.1, right: 0.1 } } });
    // iw/ih are the source's own dimensions, so the crop survives a 4K or a 480p
    // source without a second lookup of its size.
    expect(chain).toContain('crop=floor(iw*0.8/2)*2:floor(ih*1/2)*2:floor(iw*0.1/2)*2:floor(ih*0/2)*2');
  });

  it('ignores a crop that would leave no picture', () => {
    // The same guard as the preview: a degenerate crop must not reach ffmpeg,
    // where it becomes an error mid-export rather than a slightly wrong frame.
    const chain = sourceFilterChain({ ...base, geometry: { crop: { left: 0.9, right: 0.9 } } });
    // No source-fraction crop stage; the canvas cap below is a different filter and
    // must still be there.
    expect(chain).not.toContain('crop=floor(');
    expect(chain).toContain("crop=w='min(iw,1080)'");
  });

  it('scales the fitted picture without changing the canvas', () => {
    const chain = sourceFilterChain({ ...base, geometry: { transform: { scaleX: 1.5, scaleY: 1.5 } } });
    expect(chain).toContain('scale=w=trunc(iw*1.5/2)*2:h=trunc(ih*1.5/2)*2:flags=lanczos');
    // Growing past the canvas is trimmed back rather than padded: `pad` cannot
    // shrink a picture, and a zoom means "keep the middle".
    expect(chain).toContain("crop=w='min(iw,1080)':h='min(ih,1920)':x=(iw-ow)/2:y=(ih-oh)/2");
    expect(chain).toContain('pad=1080:1920');
  });

  it('handles a zoom out, where the picture ends up smaller than the canvas', () => {
    // The mirror case of the one above. `crop` must be a no-op rather than an
    // error, which is why the expression is `min(iw, W)` and not a bare width.
    const chain = sourceFilterChain({ ...base, geometry: { transform: { scaleX: 0.5, scaleY: 0.5 } } });
    // `min(iw, W)` is `iw` here, so the crop keeps the whole (smaller) picture and
    // the pad letterboxes it. A bare `crop=1080:1920` would fail outright.
    expect(chain).toContain("crop=w='min(iw,1080)':h='min(ih,1920)'");
    expect(chain).toContain('pad=1080:1920');
  });

  it('honours the legacy framing scale', () => {
    const chain = sourceFilterChain({ ...base, geometry: { transform: { scale: 1.4 } } });
    expect(chain).toContain('trunc(iw*1.4/2)*2');
  });

  it('rotates, then fits the canvas, then pads', () => {
    // `rotate` produces a canvas large enough for the rotated bounding box, which
    // is wider than the output for any angle in between — so a fit has to follow it
    // before the pad, or ffmpeg refuses the pad as a shrink.
    const chain = sourceFilterChain({
      ...base,
      outputWidth: 1920,
      outputHeight: 1080,
      geometry: { transform: { rotation: 90 } },
    });
    const stages = chain.split(',');
    const rotateAt = stages.findIndex((stage) => stage.startsWith('rotate='));
    // The fit *after* the rotate — the first one is the pre-existing letterbox.
    const fitAt = stages.findIndex(
      (stage, index) => index > rotateAt && stage.includes('force_original_aspect_ratio'),
    );
    const padAt = stages.findIndex((stage) => stage.startsWith('pad=1920:1080'));
    expect(rotateAt).toBeGreaterThan(-1);
    expect(fitAt).toBeGreaterThan(rotateAt);
    expect(padAt).toBeGreaterThan(fitAt);
  });

  it('moves the picture by a fraction of the canvas', () => {
    const chain = sourceFilterChain({ ...base, geometry: { transform: { x: 0.25, y: -0.1 } } });
    // 25% of 1080 = 270, −10% of 1920 = −192, both added to the centring term.
    expect(chain).toContain('(ow-iw)/2+270:(oh-ih)/2+-192');
  });

  it('flips with hflip/vflip rather than a negative scale', () => {
    // A negative `scale` reverses the picture but can leave dimensions odd, and it
    // makes every later expression that reads `iw` untrustworthy.
    const chain = sourceFilterChain({ ...base, geometry: { transform: { flipH: true, flipV: true } } });
    expect(chain).toContain('hflip');
    expect(chain).toContain('vflip');
    expect(chain).not.toContain('iw*-1');
  });

  it('rounds a rotation onto even dimensions', () => {
    // `rotate` computes its own output size from a float; an odd result fails at
    // yuv420p after the first frame has already been encoded.
    const chain = sourceFilterChain({ ...base, geometry: { transform: { rotation: 17 } } });
    const pads = chain.match(/pad=\d+:\d+/g) ?? [];
    for (const pad of pads) {
      const [, w, h] = pad.match(/pad=(\d+):(\d+)/)!;
      expect(Number(w) % 2, pad).toBe(0);
      expect(Number(h) % 2, pad).toBe(0);
    }
  });
});
