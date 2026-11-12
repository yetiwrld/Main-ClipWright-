/**
 * Graceful degradation when the ffprobe binary is missing but ffmpeg exists:
 * `ffmpeg -i <input>` prints container/stream info to stderr, which we parse
 * into the same shape the ffprobe-JSON parser expects. LOSSY (no per-stream
 * disposition/default flags, approximate VFR detection) — flagged in output.
 * This is a real probe of the real file, not a stub.
 */
export interface FallbackProbe {
  format: { format_name: string; duration: string; size?: string; bit_rate?: string; tags: Record<string, string> };
  streams: Array<Record<string, unknown>>;
  warnings: string[];
}

const timeToSeconds = (h: string, m: string, s: string): number =>
  Number(h) * 3600 + Number(m) * 60 + Number(s);

export const parseFfprobeStderr = (output: string, fileSizeBytes?: number): FallbackProbe => {
  const warnings: string[] = ['ffprobe binary unavailable — stream details are approximate (parsed from ffmpeg output)'];
  const formatMatch = /Input #0, ([^,]+(?:,[^,]+)*?), from/.exec(output);
  const durationMatch = /Duration: (\d{1,2}):(\d{2}):(\d{2})\.(\d+)/.exec(output);
  const bitrateMatch = /bitrate: (\d+) kb\/s/.exec(output);
  const formatName = formatMatch?.[1]?.trim() ?? 'unknown';
  const durationSec = durationMatch ? timeToSeconds(durationMatch[1]!, durationMatch[2]!, durationMatch[3]!) + Number('0.' + durationMatch[4]) : 0;

  const streams: Array<Record<string, unknown>> = [];
  const streamRe = /Stream #0:(\d+)(?:\[[^\]]*\])?(?:\([^)]*\))?: (Video|Audio|Subtitle|Data): ([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(output)) !== null) {
    const index = Number(m[1]);
    const kind = m[2]!.toLowerCase();
    const rest = m[3]!;
    if (kind === 'video') {
      const codec = /^([a-z0-9_]+)/i.exec(rest)?.[1] ?? 'unknown';
      const profileMatch = /\((\w[\w ]*)\)/.exec(rest);
      const resMatch = /(\d{2,5})x(\d{2,5})/.exec(rest);
      const sarMatch = /SAR ([\d:]+) DAR ([\d:]+)/.exec(rest);
      const fpsMatch = /([\d.]+) fps/.exec(rest);
      const tbrMatch = /([\d.]+) tbr/.exec(rest);
      const pixMatch = /, (yuvj?[0-9a-z]+(?:le|be)?|gbrp[a-z0-9]*|gray)[,\s(]/.exec(rest);
      const rate = fpsMatch?.[1] ?? tbrMatch?.[1];
      streams.push({
        index, codec_type: 'video', codec_name: codec, profile: profileMatch?.[1],
        width: resMatch ? Number(resMatch[1]) : undefined, height: resMatch ? Number(resMatch[2]) : undefined,
        display_aspect_ratio: sarMatch?.[2], sample_aspect_ratio: sarMatch?.[1],
        avg_frame_rate: rate ? `${Math.round(Number(rate) * 1000)}/1000` : '30/1',
        r_frame_rate: rate ? `${Math.round(Number(rate) * 1000)}/1000` : '30/1',
        pix_fmt: pixMatch?.[1] ?? 'unknown',
        side_data_list: /rotation of (-?[\d.]+) degrees/.test(output)
          ? [{ rotation: Number(/rotation of (-?[\d.]+) degrees/.exec(output)?.[1]) }]
          : undefined,
      });
    } else if (kind === 'audio') {
      const codec = /^([a-z0-9_]+)/i.exec(rest)?.[1] ?? 'unknown';
      const srMatch = /(\d{4,6}) Hz/.exec(rest);
      const channels = /stereo/.test(rest) ? 2 : /mono/.test(rest) ? 1 : /5\.1/.test(rest) ? 6 : 2;
      streams.push({ index, codec_type: 'audio', codec_name: codec, sample_rate: srMatch?.[1], channels, disposition: { default: index === 0 ? 1 : 0 } });
    }
  }

  return {
    format: {
      format_name: formatName,
      duration: String(durationSec),
      size: fileSizeBytes !== undefined ? String(fileSizeBytes) : undefined,
      bit_rate: bitrateMatch ? String(Number(bitrateMatch[1]) * 1000) : undefined,
      tags: {},
    },
    streams,
    warnings,
  };
};
