/**
 * §19 export verification matrix.
 *
 * Builds a one-clip composition (video + captions) for every (preset, quality)
 * short-side tier, renders it with the same code path as the app's export
 * engine, probes the result and runs the §19.6 validation checks.
 *
 * Honest contract:
 *   - If no ffmpeg binary is available (CLIPWRIGHT_FFMPEG or PATH), it prints
 *     "BLOCKED" for runtime checks and exits 2 — it never reports success
 *     without producing and probing real files.
 *   - Plan-level (static) checks always run.
 *
 * Usage:
 *   CLIPWRIGHT_FFMPEG=/path/to/ffmpeg pnpm verify:export-matrix
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildExportGraph, buildExportPlan, runValidationChecks, PRESET_SHORT_SIDE, H264_CRF,
  type ExportFormat, type QualityId,
} from '../../packages/export-core/src/index.js';
import { probeInput, parseFfprobeJson } from '../../packages/media-core/src/index.js';
import { newId, type Composition } from '../../packages/project-schema/src/index.js';
import { getBuiltinPreset } from '../../packages/caption-styles/src/index.js';

const QUALITIES: QualityId[] = ['draft', 'standard', 'high', 'maximum'];

const findFfmpeg = (): string | null => {
  if (process.env['CLIPWRIGHT_FFMPEG'] && existsSync(process.env['CLIPWRIGHT_FFMPEG'])) return process.env['CLIPWRIGHT_FFMPEG'];
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    const p = join(dir, 'ffmpeg');
    if (existsSync(p)) return p;
  }
  return null;
};

const findFont = (): string | null => {
  const candidates = [
    process.env['CLIPWRIGHT_EXPORT_FONT'],
    join(process.cwd(), 'node_modules/@fontsource/manrope/files/manrope-latin-800-normal.woff2'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    'C:\\Windows\\Fonts\\arialbd.ttf',
  ].filter((v): v is string => !!v);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
};

const main = async (): Promise<void> => {
  const ffmpeg = findFfmpeg();
  const font = findFont();
  console.log('Clipwright export matrix\n=======================\n');

  /* ---- static (plan) checks: every preset × quality builds a valid plan */
  console.log('Plan checks');
  let planFailures = 0;
  for (const [preset, shortSide] of Object.entries(PRESET_SHORT_SIDE)) {
    for (const quality of QUALITIES) {
      const plan = buildExportPlan(
        { fps: 30, durationUs: 5_000_000 },
        {
          preset: preset as keyof typeof PRESET_SHORT_SIDE, aspect: '9:16', fps: 30,
          format: 'mp4', quality, audioBitrateKbps: 192, loudnessTargetLufs: -16,
          burnCaptions: true, subtitleSidecar: false, draft: quality === 'draft',
        },
      );
      const ok =
        plan.output.width % 2 === 0 && plan.output.height % 2 === 0 &&
        Math.min(plan.output.width, plan.output.height) === shortSide &&
        plan.durationFrames === 150 &&
        H264_CRF[quality] > 0;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${preset.padEnd(10)} ${quality.padEnd(9)} → ${plan.output.width}×${plan.output.height} · ${plan.summary}`);
      if (!ok) planFailures++;
    }
  }
  if (planFailures > 0) {
    console.error(`\n${planFailures} plan check(s) failed.`);
    process.exit(1);
  }
  console.log('  All plan checks passed.\n');

  /* ---- runtime checks: render + probe + §19.6 validation */
  if (!ffmpeg) {
    console.error('BLOCKED  No ffmpeg binary found (set CLIPWRIGHT_FFMPEG or install ffmpeg on PATH).');
    console.error('         Plan checks above are valid; runtime render/validation did NOT run.');
    process.exit(2);
  }
  if (!font) {
    console.error('BLOCKED  No font file found for drawtext (set CLIPWRIGHT_EXPORT_FONT).');
    process.exit(2);
  }
  console.log(`Runtime render checks (ffmpeg: ${ffmpeg}, font: ${font})`);
  const root = mkdtempSync(join(tmpdir(), 'cw-matrix-'));
  try {
    const fixture = join(root, 'fixture.mp4');
    execFileSync(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', fixture], { stdio: 'pipe' });

    let runtimeFailures = 0;
    for (const quality of QUALITIES) {
      const plan = buildExportPlan(
        { fps: 30, durationUs: 2_000_000 },
        { preset: '1080p', aspect: '9:16', fps: 30, format: 'mp4' as ExportFormat, quality, audioBitrateKbps: 192, loudnessTargetLufs: -16, burnCaptions: true, subtitleSidecar: false, draft: quality === 'draft' },
      );
      const trackId = newId(); const videoTrackId = newId(); const captionTrackId = newId();
      const now = Date.now();
      const comp: Composition = {
        id: newId(), projectId: 'matrix', name: `matrix-${quality}`, fps: 30, width: plan.output.width, height: plan.output.height,
        tracks: [
          { id: videoTrackId, type: 'video', name: 'Video 1', order: 0, locked: false, hidden: false, height: 64 },
          { id: captionTrackId, type: 'caption', name: 'Captions', order: 1, locked: false, hidden: false, height: 48 },
        ],
        items: [{
          id: newId(), trackId: videoTrackId, kind: 'video', name: 'fixture', startUs: 0, durationUs: 2_000_000, inUs: 0,
          mediaId: 'fixture',
          transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false },
          volume: 1, fadeInUs: 0, fadeOutUs: 0, muted: false, effects: [],
        }].map((it) => ({ ...it, trackId: videoTrackId })),
        markers: [], keyframes: [], effects: [], transitions: [],
        createdAt: now, updatedAt: now, schemaVersion: 1,
      };
      void trackId;
      const media = new Map([['fixture', { path: fixture, durationUs: 2_000_000 }]]);
      const preset = getBuiltinPreset('bold-creator')!;
      const short = Math.min(plan.output.width, plan.output.height);
      const sizePx = Math.max(12, Math.round((preset.font.sizePctOfShortSide / 100) * short));
      const outlinePx = preset.outline.enabled ? (preset.outline.widthPctOfFont / 100) * sizePx : 0;
      const graph = buildExportGraph(comp, [
        { text: 'HELLO WORLD', startUs: 0, endUs: 2_000_000, style: {
          family: preset.font.family, sizePx,
          color: preset.fill.color.replace(/^#/, '0x'),
          ...(preset.outline.enabled ? { outlineColor: preset.outline.color.replace(/^#/, '0x'), outlinePx } : {}),
          shadow: preset.shadow.enabled,
          yPct: preset.position.yPct, align: preset.text.align, uppercase: preset.text.case === 'upper',
        } },
      ], { output: plan.output, fps: 30, durationSeconds: 2, media, fontFile: font, crf: H264_CRF[quality] });
      if (!graph.ok) {
        console.error(`  FAIL  ${quality.padEnd(9)} graph: ${graph.unsupported.join(', ')}`);
        runtimeFailures++;
        continue;
      }
      const outPath = join(root, `out-${quality}.mp4`);
      try {
        const args = graph.args.map((a) => (a === 'OUTFILE' ? outPath : a));
        execFileSync(ffmpeg, args, { stdio: 'pipe', timeout: 300_000 });
        const { probe } = await probeInput({ ffmpeg, ffprobe: null }, outPath, statSync(outPath).size, 30_000);
        const info = parseFfprobeJson(probe as never, 'matrix');
        const report = runValidationChecks(
          { width: plan.output.width, height: plan.output.height, fps: 30, durationUs: 2_000_000, audioExpected: true, audioSampleRate: 48_000, videoCodec: 'h264', audioCodec: 'aac' },
          probe,
        );
        const status = report.status === 'failed' ? 'FAIL' : 'PASS';
        const vw = info.video?.width ?? 0; const vh = info.video?.height ?? 0;
        console.log(`  ${status}  ${quality.padEnd(9)} → ${vw}×${vh} · validation: ${report.status}`);
        if (report.status === 'failed') {
          for (const f of report.requiredFailures) console.error(`        check ${f.id} failed: ${f.name} — expected ${f.expected}, measured ${f.measured}`);
          runtimeFailures++;
        }
      } catch (err) {
        console.error(`  FAIL  ${quality.padEnd(9)} render/validate: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
        runtimeFailures++;
      }
    }
    if (runtimeFailures > 0) {
      console.error(`\n${runtimeFailures} runtime check(s) failed.`);
      process.exit(1);
    }
    console.log('\nAll runtime checks passed. Files were produced and probed for real.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

void main();
