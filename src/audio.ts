import { durationSeconds, type MusicProject } from './score.js';

const RATE = 44100;
export const BUILTIN_RENDERER_VERSION = '2';
function noise(seed: number): number { let x = seed | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 2147483648 - 1; }
function wave(kind: string, phase: number, seed: number, dutyCycle = 0.5): number {
  const x = phase - Math.floor(phase);
  switch (kind) { case 'sine': return Math.sin(2 * Math.PI * x); case 'triangle': return 1 - 4 * Math.abs(x - 0.5); case 'saw': return 2 * x - 1; case 'square': return (x < dutyCycle ? 1 - dutyCycle : -dutyCycle) / Math.max(dutyCycle, 1 - dutyCycle); default: return noise(seed); }
}
function heldLevel(t: number, a: number, d: number, s: number): number {
  return t < a ? t / Math.max(a, 1 / RATE) : s + (1 - s) * Math.exp(-(t - a) / Math.max(d, 1 / RATE));
}
export function renderWav(p: MusicProject, seconds = durationSeconds(p), abortSignal?: AbortSignal): Uint8Array {
  const frames = Math.round(seconds * RATE);
  if (frames <= 0 || frames > RATE * 600) throw new Error('WAV duration outside built-in renderer limits');
  const left = new Float32Array(frames), right = new Float32Array(frames);
  const beatSeconds = 60 / p.bpm;
  let voiceSeconds = 0;
  for (const track of p.tracks) for (const note of track.notes) voiceSeconds += note.duration * beatSeconds + Math.min(track.patch?.envelope.release ?? 0, 8) * 2;
  if (voiceSeconds > 5000) throw new Error('score exceeds built-in renderer voice budget');
  for (const [ti, track] of p.tracks.entries()) {
    const patch = track.patch;
    if (!patch) throw new Error(`missing patch: ${track.name}`);
    const panL = Math.sqrt((1 - patch.pan) / 2), panR = Math.sqrt((1 + patch.pan) / 2);
    const cutoff = 1 - Math.exp(-2 * Math.PI * patch.lowpassHz / RATE);
    for (const [ni, note] of track.notes.entries()) {
      if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('aborted');
      const start = Math.round(note.start * beatSeconds * RATE);
      const held = note.duration * beatSeconds;
      const stop = Math.min(frames, start + Math.ceil((held + Math.min(patch.envelope.release * 2, 10)) * RATE));
      const hz = 440 * 2 ** ((note.pitch - 69) / 12);
      const oscillators = patch.oscillators.map(osc => ({ wave: osc.wave, level: osc.level, dutyCycle: osc.dutyCycle, frequency: hz * 2 ** (osc.octave + osc.detuneCents / 1200) }));
      const { attack, decay, sustain, release } = patch.envelope;
      const endLevel = heldLevel(held, attack, decay, sustain);
      const noteGain = patch.gain * note.velocity / 127;
      let filtered = 0;
      for (let i = Math.max(0, start); i < stop; i++) {
        const t = (i - start) / RATE;
        let sample = 0;
        for (const [oi, osc] of oscillators.entries()) {
          sample += osc.level * wave(osc.wave, osc.frequency * t, ((ti + 1) * 73856093) ^ ((ni + 1) * 19349663) ^ (i * 83492791) ^ oi, osc.dutyCycle);
        }
        filtered += cutoff * (sample - filtered);
        const envelope = t < held ? heldLevel(t, attack, decay, sustain) : endLevel * Math.exp(-(t - held) * 5 / release);
        const v = filtered * envelope * noteGain;
        left[i] += v * panL; right[i] += v * panR;
      }
    }
    // A short deterministic cross-channel echo adds space without an impulse-response asset.
    if (patch.reverb > 0) {
      const delay = Math.round((0.13 + ti % 3 * 0.041) * RATE);
      for (let i = delay; i < frames; i++) { left[i] += right[i - delay] * patch.reverb * 0.2; right[i] += left[i - delay] * patch.reverb * 0.2; }
    }
  }
  let peak = 0;
  for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const scale = peak > 0.95 ? 0.95 / peak : 1;
  const bytes = new Uint8Array(44 + frames * 4); const view = new DataView(bytes.buffer);
  const str = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  str(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); str(8, 'WAVE'); str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, RATE, true); view.setUint32(28, RATE * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) { view.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, left[i] * scale)) * 32767), true); view.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, right[i] * scale)) * 32767), true); }
  if (view.getUint32(40, true) !== frames * 4) throw new Error('WAV sample count mismatch');
  return bytes;
}
