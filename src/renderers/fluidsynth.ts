import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { writeMidi } from '../midi.js';
import { inspectWav, type MusicRenderer } from '../renderer.js';

const run = promisify(execFile);

export interface FluidSynthRendererOptions {
  soundFontPath: string;
  fluidSynthPath?: string;
  soundFontVersion?: string;
  fluidSynthVersion?: string;
  gain?: number;
}

function trimFluidSynthWav(bytes: Uint8Array, durationSeconds: number): Uint8Array {
  const info = inspectWav(bytes);
  const frames = Math.round(durationSeconds * info.sampleRate);
  if (info.channels !== 2 || info.bitDepth !== 16 || String.fromCharCode(...bytes.subarray(36, 40)) !== 'data' || info.frames < frames) {
    throw new Error('unexpected FluidSynth WAV layout or duration');
  }
  const trimmed = bytes.slice(0, 44 + frames * 4);
  const header = new DataView(trimmed.buffer);
  header.setUint32(4, trimmed.byteLength - 8, true);
  header.setUint32(40, frames * 4, true);
  return trimmed;
}

/** Optional CLI adapter. The application installs FluidSynth and supplies its own SoundFont. */
export function createFluidSynthRenderer({ soundFontPath, fluidSynthPath = 'fluidsynth', soundFontVersion = 'user-supplied', fluidSynthVersion = 'system', gain = 0.8 }: FluidSynthRendererOptions): MusicRenderer {
  if (!soundFontPath) throw new TypeError('soundFontPath is required');
  if (!Number.isFinite(gain) || gain <= 0 || gain > 1) throw new RangeError('gain must be in (0, 1]');
  return {
    id: `fluidsynth:${soundFontVersion}`,
    version: `adapter-1;engine=${fluidSynthVersion};gain=${gain}`,
    async render(project, { durationSeconds, abortSignal }) {
      const directory = await mkdtemp(join(tmpdir(), 'music-fluidsynth-'));
      try {
        const midiPath = join(directory, 'score.mid');
        const wavPath = join(directory, 'score.wav');
        await writeFile(midiPath, writeMidi(project).bytes);
        await run(fluidSynthPath, ['-ni', '-q', '-r', '44100', '-g', String(gain), '-T', 'wav', '-O', 's16', '-F', wavPath, soundFontPath, midiPath], { signal: abortSignal });
        return trimFluidSynthWav(await readFile(wavPath), durationSeconds);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
