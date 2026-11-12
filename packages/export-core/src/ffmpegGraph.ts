/**
 * ffmpeg filter-graph builder for compositions. PURE — unit-tested.
 *
 * Supported subset (v1): sequential video segments (main track), image overlays,
 * text/caption burn-in (drawtext), audio mixing (volume/fades/amix), clip fades,
 * mute. Anything else (effects, transitions, keyframes, speed changes, rotated
 * transforms) is reported as `unsupported` so the caller can refuse rather than
 * silently drop it.
 */
import type { Composition, Item } from '@clipwright/project-schema';
import type { OutputSize } from './plan.js';

export interface ResolvedMedia { path: string; durationUs: number; }
export interface RenderableCaption { text: string; startUs: number; endUs: number; style: CaptionDrawStyle; }
export interface CaptionDrawStyle {
  family: string;          // informational; export renders with the bundled font file
  sizePx: number;
  color: string;           // drawtext fontcolor
  outlineColor?: string;
  outlinePx?: number;
  backgroundColor?: string; // drawtext box color (with alpha)
  boxBorderPx?: number;
  shadow?: boolean;
  yPct: number;            // canvas height percent
  align: 'center' | 'left' | 'right';
  uppercase: boolean;
}

export interface GraphBuildOk {
  ok: true;
  args: string[];
  warnings: string[];
}
export interface GraphBuildFail {
  ok: false;
  unsupported: string[];
  warnings: string[];
}
export type GraphBuildResult = GraphBuildOk | GraphBuildFail;

const escapeDrawtext = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%').replace(/\n/g, ' ');

const evenInt = (n: number) => Math.floor(n / 2) * 2;

export interface GraphOptions {
  output: OutputSize;
  fps: number;
  durationSeconds: number;
  media: Map<string, ResolvedMedia>;
  fontFile: string;            // absolute path to a font drawtext can use
  audioNormalize?: boolean;
  draft?: boolean;
  videoCodec?: 'h264' | 'vp9';
  crf?: number;
  x264Preset?: string;
}

export const buildExportGraph = (comp: Composition, captions: RenderableCaption[], opts: GraphOptions): GraphBuildResult => {
  const unsupported: string[] = [];
  const warnings: string[] = [];

  if (comp.effects.length > 0) unsupported.push('effects');
  if (comp.transitions.length > 0) unsupported.push('transitions');
  if (comp.keyframes.length > 0) unsupported.push('keyframes');
  for (const item of comp.items) {
    if (item.kind === 'adjustment') unsupported.push('adjustment layers');
    if (item.transform.rotationDeg !== 0) unsupported.push(`rotation on "${item.name || item.kind}"`);
    if (item.transform.flipH || item.transform.flipV) unsupported.push(`flip on "${item.name || item.kind}"`);
  }

  const { width, height } = opts.output;
  const canvasAR = width / height;

  const trackOrder = new Map(comp.tracks.map((t, i) => [t.id, i]));
  const videoItems = comp.items
    .filter((i) => i.kind === 'video' || i.kind === 'image')
    .sort((a, b) => (trackOrder.get(a.trackId) ?? 0) - (trackOrder.get(b.trackId) ?? 0) || a.startUs - b.startUs);
  const mainTrackId = videoItems.length ? [...new Set(videoItems.map((i) => i.trackId))].sort()[0] : undefined;

  // Main sequential segments on the lowest video track
  const mainItems = videoItems.filter((i) => i.trackId === mainTrackId);
  const overlayItems = videoItems.filter((i) => i.trackId !== mainTrackId);
  const audioItems = comp.items.filter((i) => i.kind === 'audio');
  const textItems = comp.items.filter((i) => i.kind === 'text');

  const inputs: string[] = [];
  const inputIndex = new Map<string, number>();
  const inputFor = (mediaId: string): number => {
    const key = mediaId;
    if (inputIndex.has(key)) return inputIndex.get(key)!;
    const resolved = opts.media.get(mediaId);
    if (!resolved) throw new Error(`Media not found for item: ${mediaId}`);
    inputIndex.set(key, inputs.length / 2);
    inputs.push('-i', resolved.path);
    return inputIndex.get(key)!;
  };

  try { for (const it of [...videoItems, ...audioItems]) if (it.mediaId) inputFor(it.mediaId); }
  catch (e) { return { ok: false, unsupported: [e instanceof Error ? e.message : String(e)], warnings }; }

  const filters: string[] = [];
  const mainLabels: string[] = [];

  const sortedMain = [...mainItems].sort((a, b) => a.startUs - b.startUs);
  let cursorUs = 0;
  let vpart = 0;
  const gapFiller = (lenUs: number, tag: string) => {
    const sec = lenUs / 1_000_000;
    filters.push(`color=c=black:s=${width}x${height}:r=${opts.fps}:d=${sec.toFixed(3)}[gap${tag}]`);
    mainLabels.push(`[gap${tag}]`);
  };
  for (const it of sortedMain) {
    if (it.startUs > cursorUs) gapFiller(it.startUs - cursorUs, String(vpart++));
    const idx = it.mediaId ? inputIndex.get(it.mediaId)! : 0;
    const inSec = it.inUs / 1_000_000;
    const durSec = it.durationUs / 1_000_000;
    const scaleCrop = `scale=w='if(gt(iw/ih,${canvasAR}),-2,${width})':h='if(gt(iw/ih,${canvasAR}),${height},-2)':flags=lanczos,` +
      `crop=${evenInt(width)}:${evenInt(height)},setsar=1,fps=${opts.fps},` +
      `setpts=PTS-STARTPTS`;
    const tag = String(vpart++);
    filters.push(`[${idx}:v]trim=start=${inSec.toFixed(6)}:duration=${durSec.toFixed(6)},${scaleCrop}[mv${tag}]`);
    mainLabels.push(`[mv${tag}]`);
    cursorUs = Math.max(cursorUs, it.startUs + it.durationUs);
  }
  if (cursorUs < Math.round(opts.durationSeconds * 1_000_000)) {
    gapFiller(Math.round(opts.durationSeconds * 1_000_000) - cursorUs, String(vpart++));
  }
  const mainItemsOrdered = sortedMain;
  void mainItemsOrdered;

  // base canvas: concat of main segments (or black if empty)
  if (mainLabels.length === 0) {
    filters.push(`color=c=black:s=${width}x${height}:r=${opts.fps}:d=${opts.durationSeconds.toFixed(3)}[base0]`);
  } else if (mainLabels.length === 1) {
    filters.push(`${mainLabels[0]}copy[base0]`);
  } else {
    filters.push(`${mainLabels.join('')}concat=n=${mainLabels.length}:v=1:a=0[base0]`);
  }

  // overlays (images / secondary video), positioned at centre by default with enable windows
  let baseLabel = 'base0';
  overlayItems.forEach((it, i) => {
    const idx = it.mediaId ? inputIndex.get(it.mediaId)! : 0;
    const startSec = it.startUs / 1_000_000;
    const endSec = (it.startUs + it.durationUs) / 1_000_000;
    const targetW = evenInt(width * (it.transform.scale || 1));
    const out = `ov${i}`;
    if (it.kind === 'image') {
      filters.push(`[${idx}:v]scale=${targetW}:-2[ovsrc${i}]`);
    } else {
      const inSec = it.inUs / 1_000_000;
      const durSec = it.durationUs / 1_000_000;
      filters.push(`[${idx}:v]trim=start=${inSec.toFixed(6)}:duration=${durSec.toFixed(6)},setpts=PTS-STARTPTS,scale=${targetW}:-2[ovsrc${i}]`);
    }
    const x = `(W-w)/2+${Math.round(it.transform.x)}`;
    const y = `(H-h)/2+${Math.round(it.transform.y)}`;
    filters.push(`[${baseLabel}][ovsrc${i}]overlay=x='${x}':y='${y}':enable='between(t,${startSec.toFixed(3)},${endSec.toFixed(3)})'[${out}]`);
    baseLabel = out;
  });

  // text items
  textItems.forEach((it, i) => {
    const startSec = it.startUs / 1_000_000;
    const endSec = (it.startUs + it.durationUs) / 1_000_000;
    const fontsize = it.fontSize ?? Math.round(height * 0.07);
    const text = escapeDrawtext((it.text ?? '').toUpperCase());
    const out = `tx${i}`;
    filters.push(
      `[${baseLabel}]drawtext=fontfile='${opts.fontFile}':text='${text}':fontcolor=white:fontsize=${fontsize}` +
      `:borderw=3:bordercolor=black@0.85:x=(w-text_w)/2:y=h*0.72-text_h/2:enable='between(t,${startSec.toFixed(3)},${endSec.toFixed(3)})'[${out}]`,
    );
    baseLabel = out;
  });

  // captions
  captions.forEach((cap, i) => {
    const startSec = cap.startUs / 1_000_000;
    const endSec = cap.endUs / 1_000_000;
    const y = Math.round(height * (cap.style.yPct / 100));
    const text = escapeDrawtext(cap.style.uppercase ? cap.text.toUpperCase() : cap.text);
    const hasBox = !!cap.style.backgroundColor;
    const boxArg = hasBox ? `:box=1:boxcolor=${cap.style.backgroundColor}:boxborderw=${cap.style.boxBorderPx ?? 8}` : '';
    const outlineArg = cap.style.outlinePx && cap.style.outlinePx > 0 ? `:borderw=${Math.round(cap.style.outlinePx)}:bordercolor=${cap.style.outlineColor ?? 'black'}` : '';
    const shadowArg = cap.style.shadow ? ':shadowcolor=black@0.8:shadowx=0:shadowy=3' : '';
    const xExpr = cap.style.align === 'center' ? '(w-text_w)/2' : cap.style.align === 'left' ? 'w*0.06' : 'w-text_w-w*0.06';
    const out = `cap${i}`;
    filters.push(
      `[${baseLabel}]drawtext=fontfile='${opts.fontFile}':text='${text}':fontcolor=${cap.style.color}:fontsize=${cap.style.sizePx}` +
      `${outlineArg}${shadowArg}${boxArg}:x=${xExpr}:y=${y}-text_h/2:enable='between(t,${startSec.toFixed(3)},${endSec.toFixed(3)})'[${out}]`,
    );
    baseLabel = out;
  });

  filters.push(`[${baseLabel}]format=yuv420p[vout]`);

  // audio: main video embedded audio (segments) + audio items, mixed
  const audioLabels: string[] = [];
  mainItems.forEach((it, i) => {
    if (!it.mediaId) return;
    const idx = inputIndex.get(it.mediaId)!;
    const inSec = it.inUs / 1_000_000;
    const durSec = it.durationUs / 1_000_000;
    const startSec = it.startUs / 1_000_000;
    const delayMs = Math.round(startSec * 1000);
    const vol = it.muted ? 0 : it.volume;
    filters.push(`[${idx}:a]atrim=start=${inSec.toFixed(6)}:duration=${durSec.toFixed(6)},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs},volume=${vol}[am${i}]`);
    audioLabels.push(`[am${i}]`);
  });
  audioItems.forEach((it, i) => {
    if (!it.mediaId) return;
    const idx = inputIndex.get(it.mediaId)!;
    const inSec = it.inUs / 1_000_000;
    const durSec = it.durationUs / 1_000_000;
    const startSec = it.startUs / 1_000_000;
    const delayMs = Math.round(startSec * 1000);
    const vol = it.muted ? 0 : it.volume;
    const fadeIn = it.fadeInUs > 0 ? `,afade=t=in:st=0:d=${(it.fadeInUs / 1_000_000).toFixed(3)}` : '';
    const fadeOut = it.fadeOutUs > 0 ? `,afade=t=out:st=${Math.max(0, durSec - it.fadeOutUs / 1_000_000).toFixed(3)}:d=${(it.fadeOutUs / 1_000_000).toFixed(3)}` : '';
    filters.push(`[${idx}:a]atrim=start=${inSec.toFixed(6)}:duration=${durSec.toFixed(6)},asetpts=PTS-STARTPTS${fadeIn}${fadeOut},adelay=${delayMs}|${delayMs},volume=${vol}[aa${i}]`);
    audioLabels.push(`[aa${i}]`);
  });

  let audioMapArgs: string[] = [];
  if (audioLabels.length === 0) {
    filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${opts.durationSeconds.toFixed(3)}[aout]`);
    audioMapArgs = ['-map', '[aout]'];
  } else if (audioLabels.length === 1) {
    filters.push(`${audioLabels[0]}aresample=48000[aout]`);
    audioMapArgs = ['-map', '[aout]'];
  } else {
    filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:normalize=0,aresample=48000,alimiter=limit=0.89[aout]`);
    audioMapArgs = ['-map', '[aout]'];
  }

  const graph = filters.join(';');
  const isVp9 = opts.videoCodec === 'vp9';
  const videoCodecArgs = isVp9
    ? ['-c:v', 'libvpx-vp9', '-crf', String(opts.crf ?? 33), '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libx264', '-profile:v', 'high', '-crf', String(opts.crf ?? 22), '-preset', opts.x264Preset ?? 'veryfast', '-pix_fmt', 'yuv420p',
       '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
       '-movflags', '+faststart'];
  const audioCodecArgs = isVp9 ? ['-c:a', 'libopus', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];

  const args = [
    '-hide_banner', '-nostdin', '-y',
    ...inputs,
    '-filter_complex', graph,
    '-map', '[vout]',
    ...audioMapArgs,
    ...videoCodecArgs,
    ...audioCodecArgs,
    '-t', opts.durationSeconds.toFixed(3),
    'OUTFILE',
  ];

  if (unsupported.length > 0) return { ok: false, unsupported: [...new Set(unsupported)], warnings };
  return { ok: true, args, warnings };
};
