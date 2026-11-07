import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_QUICK_PRESETS,
  applyQuickPreset,
  findQuickPreset,
  validateQuickPresets,
} from '../quick-presets.js';

const ASSET_PATH = join(process.cwd(), 'assets', 'export-presets.json');

function readAsset(): unknown {
  return JSON.parse(readFileSync(ASSET_PATH, 'utf8'));
}

describe('assets/export-presets.json', () => {
  it('exists and parses', () => {
    expect(readAsset()).toBeTruthy();
  });

  it('contains no validation issues', () => {
    const { issues } = validateQuickPresets(readAsset());
    expect(issues).toEqual([]);
  });

  it('matches the built-in presets in code', () => {
    // The asset is the editable copy; the constant is the fallback. They must
    // not drift, or the app would offer one preset and validate another.
    const { presets } = validateQuickPresets(readAsset());
    expect(presets).toEqual(BUILT_IN_QUICK_PRESETS);
  });

  it('provides exactly the five presets named in SPEC 14 §3.5', () => {
    const { presets } = validateQuickPresets(readAsset());
    expect(presets.map((preset) => preset.id)).toEqual([
      'short-form-vertical',
      'landscape-1080p',
      'high-quality-4k',
      'small-file',
      'square-1080',
    ]);
  });
});

describe('validateQuickPresets', () => {
  it('rejects a file without a presets array', () => {
    const { presets, issues } = validateQuickPresets({});
    expect(presets).toEqual([]);
    expect(issues[0].field).toBe('presets');
  });

  it('rejects null', () => {
    expect(validateQuickPresets(null).issues.length).toBeGreaterThan(0);
  });

  it('names the offending field for an unknown resolution preset', () => {
    const { presets, issues } = validateQuickPresets({
      presets: [
        {
          id: 'bad',
          label: 'Bad',
          description: '',
          settings: {
            preset: '8k',
            aspect: '16:9',
            fps: 30,
            format: 'mp4',
            quality: 'standard',
            audioBitrate: 192,
            includeAudio: true,
            burnCaptions: true,
            saveSubtitles: false,
            normaliseLoudness: false,
            targetLufs: -16,
          },
        },
      ],
    });
    expect(presets).toEqual([]);
    expect(issues.some((issue) => issue.field === 'settings.preset')).toBe(true);
  });

  it('rejects an unsupported frame rate rather than coercing it', () => {
    const { issues } = validateQuickPresets({
      presets: [
        {
          id: 'fps-24',
          label: '24 fps',
          description: '',
          settings: {
            preset: '1080p',
            aspect: '16:9',
            fps: 24,
            format: 'mp4',
            quality: 'standard',
            audioBitrate: 192,
            includeAudio: true,
            burnCaptions: true,
            saveSubtitles: false,
            normaliseLoudness: false,
            targetLufs: -16,
          },
        },
      ],
    });
    expect(issues.some((issue) => issue.field === 'settings.fps')).toBe(true);
  });

  it('rejects an unknown aspect ratio', () => {
    const { issues } = validateQuickPresets({
      presets: [
        {
          id: 'weird',
          label: 'Weird',
          description: '',
          settings: {
            preset: '1080p',
            aspect: '2:1',
            fps: 30,
            format: 'mp4',
            quality: 'standard',
            audioBitrate: 192,
            includeAudio: true,
            burnCaptions: true,
            saveSubtitles: false,
            normaliseLoudness: false,
            targetLufs: -16,
          },
        },
      ],
    });
    expect(issues.some((issue) => issue.field === 'settings.aspect')).toBe(true);
  });

  it('rejects an unsupported audio bitrate', () => {
    const { issues } = validateQuickPresets({
      presets: [
        {
          id: 'bit',
          label: 'Bit',
          description: '',
          settings: {
            preset: '1080p',
            aspect: '16:9',
            fps: 30,
            format: 'mp4',
            quality: 'standard',
            audioBitrate: 200,
            includeAudio: true,
            burnCaptions: true,
            saveSubtitles: false,
            normaliseLoudness: false,
            targetLufs: -16,
          },
        },
      ],
    });
    expect(issues.some((issue) => issue.field === 'settings.audioBitrate')).toBe(true);
  });

  it('rejects non-boolean toggles', () => {
    const { issues } = validateQuickPresets({
      presets: [
        {
          id: 'flags',
          label: 'Flags',
          description: '',
          settings: {
            preset: '1080p',
            aspect: '16:9',
            fps: 30,
            format: 'mp4',
            quality: 'standard',
            audioBitrate: 192,
            includeAudio: 'yes',
            burnCaptions: true,
            saveSubtitles: false,
            normaliseLoudness: false,
            targetLufs: -16,
          },
        },
      ],
    });
    expect(issues.some((issue) => issue.field === 'settings.includeAudio')).toBe(true);
  });

  it('keeps the good presets when one is bad', () => {
    const asset = readAsset() as { presets: unknown[] };
    const broken = {
      ...asset,
      presets: [...asset.presets, { id: 'broken', label: 'Broken', settings: {} }],
    };
    const { presets, issues } = validateQuickPresets(broken);
    expect(presets).toHaveLength(5);
    expect(issues.some((issue) => issue.presetId === 'broken')).toBe(true);
  });
});

describe('findQuickPreset', () => {
  it('finds a preset by id', () => {
    expect(findQuickPreset('short-form-vertical')?.label).toBe('Short-form vertical');
  });

  it('returns undefined for an unknown id', () => {
    expect(findQuickPreset('nope')).toBeUndefined();
  });
});

describe('applyQuickPreset', () => {
  it('overrides only the fields the preset owns', () => {
    const preset = findQuickPreset('landscape-1080p')!;
    const current = {
      preset: '720p' as const,
      aspect: '9:16' as const,
      fps: 60 as const,
      quality: 'draft' as const,
      // Fields a preset does not describe must survive.
      isDraft: true,
      rangeChoice: 'work-area',
    };
    const applied = applyQuickPreset(current, preset);
    expect(applied.preset).toBe('1080p');
    expect(applied.aspect).toBe('16:9');
    expect(applied.fps).toBe(30);
    expect(applied.quality).toBe('standard');
    expect(applied.isDraft).toBe(true);
    expect(applied.rangeChoice).toBe('work-area');
  });

  it('gives each preset a distinct vertical/landscape/square shape', () => {
    const vertical = findQuickPreset('short-form-vertical')!.settings;
    const landscape = findQuickPreset('landscape-1080p')!.settings;
    const square = findQuickPreset('square-1080')!.settings;
    expect(vertical.aspect).toBe('9:16');
    expect(landscape.aspect).toBe('16:9');
    expect(square.aspect).toBe('1:1');
  });

  it('makes the sharing preset the smallest and the 4K preset the largest', () => {
    const small = findQuickPreset('small-file')!.settings;
    const large = findQuickPreset('high-quality-4k')!.settings;
    expect(small.preset).toBe('720p');
    expect(small.quality).toBe('draft');
    expect(large.preset).toBe('4k-uhd');
    expect(large.quality).toBe('maximum');
  });
});
