import { describe, expect, it } from 'vitest';
import {
  computeResolution,
  resolutionForPreset,
  roundEven,
  parseAspect,
  EXPORT_PRESETS,
  QUALITY_PRESETS,
  OUTPUT_FORMATS,
  ASPECT_RATIOS,
  aspectFromCanvas,
  presetForShortSide,
} from '../presets.js';

describe('roundEven', () => {
  it('rounds to nearest even', () => {
    expect(roundEven(1080)).toBe(1080);
    expect(roundEven(1081)).toBe(1082);
    expect(roundEven(1083)).toBe(1084);
    expect(roundEven(1)).toBe(2);
    expect(roundEven(0)).toBe(0);
  });
});

describe('parseAspect', () => {
  it('parses 16:9', () => {
    expect(parseAspect('16:9')).toBeCloseTo(16 / 9);
  });
  it('parses 9:16', () => {
    expect(parseAspect('9:16')).toBeCloseTo(9 / 16);
  });
  it('parses 1:1', () => {
    expect(parseAspect('1:1')).toBe(1);
  });
  it('returns default for invalid input', () => {
    expect(parseAspect('invalid')).toBeCloseTo(16 / 9);
  });
});

describe('computeResolution', () => {
  it('computes 16:9 at 1080p short side', () => {
    const { width, height } = computeResolution(1080, '16:9');
    expect(width).toBe(1920);
    expect(height).toBe(1080);
  });

  it('computes 9:16 at 1080p short side (portrait)', () => {
    const { width, height } = computeResolution(1080, '9:16');
    expect(width).toBe(1080);
    expect(height).toBe(1920);
  });

  it('computes 1:1 at 720p short side', () => {
    const { width, height } = computeResolution(720, '1:1');
    expect(width).toBe(720);
    expect(height).toBe(720);
  });

  it('computes 4:5 at 720p short side', () => {
    const { width, height } = computeResolution(720, '4:5');
    expect(width).toBe(720);
    expect(height).toBe(900);
  });

  it('computes 21:9 at 720p short side', () => {
    const { width, height } = computeResolution(720, '21:9');
    expect(width).toBe(1680);
    expect(height).toBe(720);
  });

  it('computes 4K UHD 16:9', () => {
    const { width, height } = computeResolution(2160, '16:9');
    expect(width).toBe(3840);
    expect(height).toBe(2160);
  });

  it('computes 4K UHD 9:16 (portrait)', () => {
    const { width, height } = computeResolution(2160, '9:16');
    expect(width).toBe(2160);
    expect(height).toBe(3840);
  });

  it('computes DCI 2K 16:9', () => {
    const { width, height } = computeResolution(1152, '16:9');
    expect(width).toBe(2048);
    expect(height).toBe(1152);
  });

  it('computes QHD 1440p 4:3', () => {
    const { width, height } = computeResolution(1440, '4:3');
    expect(width).toBe(1920);
    expect(height).toBe(1440);
  });

  it('computes 16:9 at 720p short side', () => {
    const { width, height } = computeResolution(720, '16:9');
    expect(width).toBe(1280);
    expect(height).toBe(720);
  });
});

describe('resolutionForPreset', () => {
  it('returns correct resolution for 1080p preset', () => {
    const { width, height } = resolutionForPreset('1080p', '9:16');
    expect(width).toBe(1080);
    expect(height).toBe(1920);
  });

  it('returns correct resolution for 720p preset', () => {
    const { width, height } = resolutionForPreset('720p', '16:9');
    expect(width).toBe(1280);
    expect(height).toBe(720);
  });

  it('returns correct resolution for 4K UHD preset', () => {
    const { width, height } = resolutionForPreset('4k-uhd', '16:9');
    expect(width).toBe(3840);
    expect(height).toBe(2160);
  });

  it('returns correct resolution for DCI 2K preset', () => {
    const { width, height } = resolutionForPreset('dci-2k', '16:9');
    expect(width).toBe(2048);
    expect(height).toBe(1152);
  });

  it('returns correct resolution for QHD 1440p preset', () => {
    const { width, height } = resolutionForPreset('qhd-1440p', '16:9');
    expect(width).toBe(2560);
    expect(height).toBe(1440);
  });
});

describe('presets', () => {
  it('has 5 export presets', () => {
    expect(EXPORT_PRESETS.length).toBe(5);
  });

  it('has 4 quality presets', () => {
    expect(QUALITY_PRESETS.length).toBe(4);
  });

  it('has 2 output formats', () => {
    expect(OUTPUT_FORMATS.length).toBe(2);
  });

  it('quality presets have correct CRF values', () => {
    const draft = QUALITY_PRESETS.find((p) => p.id === 'draft')!;
    const maximum = QUALITY_PRESETS.find((p) => p.id === 'maximum')!;
    expect(draft.x264Crf).toBe(26);
    expect(maximum.x264Crf).toBe(16);
  });

  it('output formats have correct codecs', () => {
    const mp4 = OUTPUT_FORMATS.find((f) => f.id === 'mp4')!;
    const webm = OUTPUT_FORMATS.find((f) => f.id === 'webm')!;
    expect(mp4.videoCodec).toBe('h264');
    expect(mp4.audioCodec).toBe('aac');
    expect(webm.videoCodec).toBe('vp9');
    expect(webm.audioCodec).toBe('opus');
  });
});

describe('aspectFromCanvas', () => {
  /*
    The export dialog's aspect decides the output frame. It used to start from a constant 9:16
    whatever the composition was, so a 16:9 project exported a portrait file unless the user noticed
    the control — the composition they built and the file they got disagreed, and neither side
    complained.
  */
  it('reads a landscape canvas as 16:9 and a portrait one as 9:16', () => {
    expect(aspectFromCanvas(1920, 1080)).toBe('16:9');
    expect(aspectFromCanvas(1080, 1920)).toBe('9:16');
  });

  it('does not confuse square, 4:5, 4:3 and 21:9', () => {
    /* Every ratio in the list must round-trip; a classifier that only knows portrait from
       landscape would put 4:3 into 16:9 and 1:1 into 4:5. */
    expect(aspectFromCanvas(1080, 1080)).toBe('1:1');
    expect(aspectFromCanvas(1080, 1350)).toBe('4:5');
    expect(aspectFromCanvas(1440, 1080)).toBe('4:3');
    expect(aspectFromCanvas(2560, 1080)).toBe('21:9');
  });

  it('round-trips every ratio in ASPECT_RATIOS at 1080 on the short side', () => {
    for (const ratio of ASPECT_RATIOS) {
      const { width, height } = resolutionForPreset('1080p', ratio);
      expect(aspectFromCanvas(width, height)).toBe(ratio);
    }
  });

  it('snaps a custom canvas to the nearest ratio rather than failing', () => {
    /* A 2:1 canvas is nearest 16:9 (1.78 against 2.0) — closer than 21:9 at 2.33. */
    expect(aspectFromCanvas(2000, 1000)).toBe('16:9');
  });

  it('falls back for a degenerate canvas instead of dividing by zero', () => {
    expect(aspectFromCanvas(0, 1080)).toBe('9:16');
    expect(aspectFromCanvas(1920, 0)).toBe('9:16');
  });
});

describe('presetForShortSide', () => {
  /*
    A resolution preset names its *short* side, so a 1080×1920 portrait canvas and a 1920×1080 one
    are both 1080p. Reading the width instead would call every portrait composition 1080p and every
    landscape one 1080p too — and a 1080-wide portrait canvas 720p.
  */
  it('names the preset by the short side, not the width', () => {
    expect(presetForShortSide(1080)).toBe('1080p');
    expect(presetForShortSide(720)).toBe('720p');
    expect(presetForShortSide(2160)).toBe('4k-uhd');
  });

  it('snaps an in-between canvas to the nearest preset', () => {
    expect(presetForShortSide(1000)).toBe('1080p');
    expect(presetForShortSide(800)).toBe('720p');
  });

  it('falls back rather than throwing on a degenerate canvas', () => {
    expect(presetForShortSide(0)).toBe('1080p');
    expect(presetForShortSide(Number.NaN)).toBe('1080p');
  });
});
