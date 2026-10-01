import { BUILTIN_RENDERER_VERSION, renderWav } from './audio.js';
import { durationSeconds as scoreDurationSeconds, validateProject, type MusicProject } from './score.js';

/** A renderer owns its instrument assets, licenses, and audio processing. */
export interface MusicRenderer {
  readonly id: string;
  readonly version: string;
  render(project: MusicProject, options: { durationSeconds: number; abortSignal?: AbortSignal }): Uint8Array | Promise<Uint8Array>;
}

export function validateRenderer(renderer: MusicRenderer): void {
  if (!renderer || typeof renderer.id !== 'string' || !renderer.id.trim() || typeof renderer.version !== 'string' || !renderer.version.trim() || typeof renderer.render !== 'function') throw new TypeError('renderer requires an id, version, and render function');
}

export const builtinRenderer: MusicRenderer = {
  id: 'builtin', version: BUILTIN_RENDERER_VERSION,
  render: (project, options) => renderWav(project, options.durationSeconds, options.abortSignal),
};

export interface WavInfo { sampleRate: number; channels: number; bitDepth: number; frames: number; durationSeconds: number }

export interface RenderMusicOptions { renderer?: MusicRenderer; durationSeconds?: number; abortSignal?: AbortSignal }

/** Render an existing score again without making another model call. */
export async function renderMusic(project: MusicProject, options: RenderMusicOptions = {}): Promise<{ bytes: Uint8Array; info: WavInfo }> {
  const renderer = options.renderer ?? builtinRenderer;
  validateRenderer(renderer);
  const durationSeconds = options.durationSeconds ?? scoreDurationSeconds(project);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new RangeError('render duration must be positive and finite');
  const validated = validateProject(project, renderer === builtinRenderer);
  if (options.abortSignal?.aborted) throw options.abortSignal.reason ?? new Error('aborted');
  const bytes = await renderer.render(validated, { durationSeconds, abortSignal: options.abortSignal });
  if (options.abortSignal?.aborted) throw options.abortSignal.reason ?? new Error('aborted');
  const info = inspectWav(bytes);
  if (info.frames !== Math.round(durationSeconds * info.sampleRate)) throw new Error('WAV duration verification failed');
  return { bytes, info };
}

/** Read the encoded file, rather than trusting renderer-reported metadata. */
export function inspectWav(bytes: Uint8Array): WavInfo {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44) throw new Error('renderer must return WAV bytes');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const label = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (label(0) !== 'RIFF' || label(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.byteLength) throw new Error('invalid RIFF WAV');
  let format: { encoding: number; channels: number; sampleRate: number; blockAlign: number; bitDepth: number } | undefined;
  let dataSize: number | undefined;
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const size = view.getUint32(at + 4, true);
    const start = at + 8;
    if (start + size > bytes.byteLength) throw new Error('truncated WAV chunk');
    if (label(at) === 'fmt ') {
      if (size < 16) throw new Error('invalid WAV format chunk');
      format = { encoding: view.getUint16(start, true), channels: view.getUint16(start + 2, true), sampleRate: view.getUint32(start + 4, true), blockAlign: view.getUint16(start + 12, true), bitDepth: view.getUint16(start + 14, true) };
    } else if (label(at) === 'data') {
      if (dataSize !== undefined) throw new Error('multiple WAV data chunks are unsupported');
      dataSize = size;
    }
    at = start + size + (size % 2);
  }
  if (!format || dataSize === undefined || !format.sampleRate || !format.channels || !format.bitDepth) throw new Error('WAV is missing format or data');
  if (!((format.encoding === 1 && [16, 24, 32].includes(format.bitDepth)) || (format.encoding === 3 && format.bitDepth === 32))) throw new Error('renderer must return PCM or 32-bit float WAV');
  if (format.blockAlign !== format.channels * format.bitDepth / 8 || dataSize % format.blockAlign) throw new Error('invalid WAV sample alignment');
  const frames = dataSize / format.blockAlign;
  return { sampleRate: format.sampleRate, channels: format.channels, bitDepth: format.bitDepth, frames, durationSeconds: frames / format.sampleRate };
}
