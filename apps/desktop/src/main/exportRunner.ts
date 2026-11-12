/**
 * Export job: plan → render (ffmpeg filter graph) → atomic publish → validate.
 * Rendering never records the screen; frames come from a proper ffmpeg graph.
 */
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { createRequire } from 'node:module';
import {
  buildExportGraph, buildExportPlan, runValidationChecks, type CaptionDrawStyle, type RenderableCaption,
  type ExportPlanSettings,
} from '@clipwright/export-core';
import { compositionDurationUs, type Item, type Composition } from '@clipwright/project-schema';
import { getBuiltinPreset } from '@clipwright/caption-styles';
import { resolveBinaries, runProcess, probeInput, parseProgressLine, MissingBinaryError, parseFfprobeJson } from '@clipwright/media-core';
import type { JobContext } from './jobs.js';

const require_ = createRequire(import.meta.url);

const resolveExportFont = (): string => {
  const override = process.env['CLIPWRIGHT_EXPORT_FONT'];
  if (override && existsSync(override)) return override;
  try {
    const pkgJson = require_.resolve('@fontsource/manrope/package.json');
    return join(pkgJson, '..', 'files', 'manrope-latin-800-normal.woff2');
  } catch {
    // last resort: a widely available system font on Linux
    const linuxFallback = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    if (existsSync(linuxFallback)) return linuxFallback;
    const winFallback = 'C:\\Windows\\Fonts\\segoeuib.ttf';
    if (existsSync(winFallback)) return winFallback;
    throw new Error('No usable font was found for burned-in captions.');
  }
};

const hexToDrawtextColor = (color: string): string => color.replace(/^#/, '0x');

const bgToBoxColor = (color: string, opacity: number): string => {
  const hex = color.replace(/^#/, '');
  return `0x${hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex}@${opacity}`;
};

const wrapText = (text: string, maxChars: number): string => {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars && line) { lines.push(line.trim()); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n');
};

const captionStyleForItem = (item: Item, canvasShort: number): CaptionDrawStyle => {
  const style = getBuiltinPreset(item.captionStyleId ?? 'bold-creator') ?? getBuiltinPreset('bold-creator')!;
  const sizePx = Math.max(12, Math.round((style.font.sizePctOfShortSide / 100) * canvasShort));
  const outlinePx = style.outline.enabled ? (style.outline.widthPctOfFont / 100) * sizePx : 0;
  const upper = style.text.case === 'upper';
  return {
    family: style.font.family,
    sizePx,
    color: hexToDrawtextColor(style.fill.color),
    outlineColor: style.outline.enabled ? hexToDrawtextColor(style.outline.color) : undefined,
    outlinePx,
    backgroundColor: style.background.enabled ? bgToBoxColor(style.background.color, style.background.opacity) : undefined,
    boxBorderPx: style.background.enabled ? style.background.paddingY : undefined,
    shadow: style.shadow.enabled,
    yPct: style.position.yPct,
    align: style.text.align,
    uppercase: upper,
  };
};

export interface ExportResult {
  outputPath: string;
  sizeBytes: number;
  validationStatus: 'verified' | 'warnings' | 'failed';
  validationJson: string;
  subtitlePath?: string;
}

export const runExportJob = async (
  ctx: JobContext,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const workspaceRoot = String(params['workspaceRoot'] ?? '');
  const projectId = String(params['projectId'] ?? '');
  const compId = String(params['compId'] ?? '');
  const outputDir = String(params['outputDir'] ?? join(workspaceRoot, 'Exports', projectId));
  const settings = params['settings'] as ExportPlanSettings;
  const fileNameTemplate = String(params['fileName'] ?? '{project}-{clip}-{preset}');

  const comp = ctx.storage.loadComposition(projectId, compId);
  if (!comp) throw new Error('The composition could not be loaded.');
  const project = ctx.storage.getProject(projectId);

  // --- resolve media, refuse missing
  const missing: string[] = [];
  const mediaMap = new Map<string, { path: string; durationUs: number }>();
  for (const item of comp.items) {
    if (!item.mediaId) continue;
    const asset = ctx.storage.getMedia(item.mediaId);
    if (!asset || !existsSync(asset.path)) { missing.push(asset?.originalName ?? item.mediaId); continue; }
    mediaMap.set(item.mediaId, { path: asset.path, durationUs: asset.info?.durationUs ?? 0 });
  }
  if (missing.length > 0) {
    throw new Error(`${missing.length} file${missing.length > 1 ? 's' : ''} used in this clip can't be found: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}. Relink them and try again.`);
  }

  const canvasShort = Math.min(comp.width, comp.height);
  const plan = buildExportPlan({ fps: comp.fps, durationUs: compositionDurationUs(comp) }, settings);

  // --- captions
  const captionItems = comp.items.filter((i) => i.kind === 'caption' && i.text);
  const captions: RenderableCaption[] = captionItems.map((item) => {
    const style = captionStyleForItem(item, canvasShort);
    const maxChars = getBuiltinPreset(item.captionStyleId ?? 'bold-creator')?.text.maxCharsPerLineHint ?? 20;
    return { text: wrapText(item.text!, maxChars), startUs: item.startUs, endUs: item.startUs + item.durationUs, style };
  });

  // --- output path with auto-numbering
  mkdirSync(outputDir, { recursive: true });
  const tokens: Record<string, string> = {
    project: sanitizeFileName(project?.name ?? 'project'),
    clip: sanitizeFileName(comp.name),
    preset: settings.preset === 'custom' ? 'custom' : settings.preset,
    date: new Date().toISOString().slice(0, 10),
    time: new Date().toISOString().slice(11, 19).replace(/:/g, '-'),
    res: `${plan.output.width}x${plan.output.height}`,
    fps: String(plan.fps),
    aspect: settings.aspect,
  };
  const baseName = fileNameTemplate.replace(/\{(\w+)\}/g, (_, k) => tokens[k] ?? k);
  const ext = settings.format === 'webm' ? '.webm' : '.mp4';
  let finalPath = join(outputDir, `${baseName}${ext}`);
  for (let n = 2; existsSync(finalPath); n++) finalPath = join(outputDir, `${baseName}-${n}${ext}`);
  const partialPath = join(outputDir, `${basename(finalPath, ext)}.partial${ext}`);

  // --- build the graph
  ctx.report(0.02, 'Preparing export');
  let fontFile: string;
  try { fontFile = resolveExportFont(); } catch (e) { throw new Error(e instanceof Error ? e.message : String(e)); }
  const crf = settings.format === 'mp4'
    ? { draft: 26, standard: 22, high: 19, maximum: 16 }[settings.quality]
    : { draft: 38, standard: 33, high: 30, maximum: 27 }[settings.quality];
  const x264Preset = { draft: 'veryfast', standard: 'fast', high: 'medium', maximum: 'slow' }[settings.quality];
  const graph = buildExportGraph(comp, captions, {
    output: plan.output,
    fps: plan.fps,
    durationSeconds: plan.durationSeconds,
    media: mediaMap,
    fontFile,
    videoCodec: settings.format === 'webm' ? 'vp9' : 'h264',
    crf,
    x264Preset,
  });
  if (!graph.ok) {
    throw new Error(`This clip uses features this build can't export yet: ${graph.unsupported.join(', ')}. Remove them or wait for a future update.`);
  }
  for (const w of graph.warnings) ctx.logger.warn('Export warning', { warning: w });

  const graphArgs = graph.args.map((a) => (a === 'OUTFILE' ? partialPath : a));
  // insert -progress before the output path
  const ffmpegArgs = [...graphArgs.slice(0, -1), '-progress', 'pipe:1', graphArgs[graphArgs.length - 1]!];
  const bins = resolveBinaries();
  if (!bins.ffmpeg) throw new MissingBinaryError('ffmpeg');

  // --- render
  const totalUs = Math.round(plan.durationSeconds * 1_000_000);
  ctx.report(0.05, 'Rendering');
  const renderRes = await runProcess(bins.ffmpeg, ffmpegArgs, {
    timeoutMs: 12 * 60 * 60 * 1000,
    signal: ctx.signal,
    onProgressLine: (line) => {
      const kv = parseProgressLine(line);
      if (kv && kv['out_time_us'] && totalUs > 0) {
        const t = Number(kv['out_time_us']);
        if (Number.isFinite(t)) ctx.report(0.05 + 0.8 * Math.min(0.99, t / totalUs), 'Rendering');
      }
    },
  });
  if (renderRes.code !== 0) {
    try { unlinkSync(partialPath); } catch { /* keep */ }
    const tail = renderRes.stderrTail.split('\n').slice(-4).join(' | ');
    ctx.logger.error('Export encode failed', { stderrTail: tail });
    throw new Error(`The video encoder stopped unexpectedly. ${tail ? 'Details: ' + tail.slice(0, 240) : 'See the log for details.'}`);
  }

  // --- validate before publishing
  ctx.report(0.9, 'Verifying');
  const { probe, warnings: probeWarnings } = await probeInput(bins, partialPath, safeSize(partialPath), 60_000);
  const info = parseFfprobeJson(probe, 'export-check');
  for (const w of probeWarnings) ctx.logger.warn('Export validation probe warning', { detail: w });
  const validation = runValidationChecks(
    {
      width: plan.output.width, height: plan.output.height, fps: plan.fps,
      durationUs: totalUs, audioExpected: true, audioSampleRate: 48000,
      videoCodec: settings.format === 'webm' ? 'vp9' : 'h264',
    },
    probe,
  );

  if (validation.status === 'failed') {
    try { unlinkSync(partialPath); } catch { /* keep */ }
    const failed = validation.requiredFailures.map((c) => c.name).join(', ');
    throw new Error(`The exported file didn't pass verification: ${failed}. The partial file was removed.`);
  }

  // --- publish
  renameSync(partialPath, finalPath);
  const sizeBytes = safeSize(finalPath);

  // --- subtitle sidecar
  let subtitlePath: string | undefined;
  if (settings.subtitleSidecar && captionItems.length > 0) {
    subtitlePath = finalPath.replace(new RegExp(`${ext.replace('.', '\\.')}$`), '.en.srt');
    writeSrt(subtitlePath, captionItems);
  }

  // --- record
  ctx.storage.recordExport({
    projectId, compId, settings, outputPath: finalPath,
    sizeBytes, durationUs: totalUs,
    validation: { status: validation.status, checks: validation.checks, measuredCodec: info.video?.codec, measuredFps: info.video?.fps },
  });
  ctx.storage.setProjectStage(projectId, 'exported');
  ctx.report(1, 'Done');
  return { outputPath: finalPath, sizeBytes, validationStatus: validation.status, validationJson: JSON.stringify(validation), ...(subtitlePath ? { subtitlePath } : {}) } satisfies ExportResult & Record<string, unknown> as unknown as Record<string, unknown>;
};

const sanitizeFileName = (s: string): string =>
  s.replace(/[<>:\"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';

const safeSize = (p: string): number => { try { return statSync(p).size; } catch { return 0; } };

const fmtSrtTime = (us: number): string => {
  const totalMs = Math.floor(us / 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60_000) % 60;
  const h = Math.floor(totalMs / 3_600_000);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
};

const writeSrt = (path: string, items: Item[]): void => {
  const lines: string[] = [];
  items.sort((a, b) => a.startUs - b.startUs).forEach((item, i) => {
    lines.push(String(i + 1));
    lines.push(`${fmtSrtTime(item.startUs)} --> ${fmtSrtTime(item.startUs + item.durationUs)}`);
    lines.push(item.text ?? '');
    lines.push('');
  });
  writeFileSync(path, lines.join('\n'), 'utf8');
};
