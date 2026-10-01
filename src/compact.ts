import { z } from 'zod';
import { beatsPerBar, noteSchema, validateProject, type MusicProject, type SynthPatch } from './score.js';

const soundNames = ['soft-piano', 'warm-pad', 'glass-lead', 'round-bass', 'pluck', 'kick', 'snare', 'hat', 'pulse-lead', 'pulse-bass', 'chip-arp', 'custom'] as const;
type Sound = typeof soundNames[number];
const waveNames = ['sine', 'triangle', 'saw', 'square', 'noise'] as const;
const patch = (wave: SynthPatch['oscillators'][number]['wave'], gain: number, attack: number, decay: number, sustain: number, release: number, lowpassHz: number, reverb = 0, dutyCycle?: number): SynthPatch => ({
  oscillators: [{ wave, level: 1, octave: 0, detuneCents: 0, ...(dutyCycle === undefined ? {} : { dutyCycle }) }],
  envelope: { attack, decay, sustain, release }, lowpassHz, gain, pan: 0, reverb,
});
const sounds: Record<Sound, { role: string; program: number; percussion: boolean; patch: SynthPatch }> = {
  'soft-piano': { role: 'keys', program: 0, percussion: false, patch: patch('triangle', 0.24, 0.01, 0.3, 0.28, 0.35, 5500, 0.1) },
  'warm-pad': { role: 'pad', program: 89, percussion: false, patch: patch('sine', 0.18, 0.35, 0.5, 0.75, 1.2, 4200, 0.2) },
  'glass-lead': { role: 'lead', program: 10, percussion: false, patch: patch('sine', 0.19, 0.01, 0.2, 0.5, 0.4, 8000, 0.12) },
  'round-bass': { role: 'bass', program: 33, percussion: false, patch: patch('triangle', 0.28, 0.01, 0.2, 0.68, 0.3, 1800) },
  pluck: { role: 'pluck', program: 24, percussion: false, patch: patch('triangle', 0.2, 0.005, 0.15, 0.12, 0.2, 7000, 0.08) },
  kick: { role: 'kick', program: 0, percussion: true, patch: patch('sine', 0.34, 0.005, 0.09, 0, 0.08, 1500) },
  snare: { role: 'snare', program: 0, percussion: true, patch: patch('noise', 0.19, 0.005, 0.08, 0, 0.06, 9000) },
  hat: { role: 'hat', program: 0, percussion: true, patch: patch('noise', 0.1, 0.005, 0.025, 0, 0.02, 12000) },
  'pulse-lead': { role: 'lead', program: 80, percussion: false, patch: patch('square', 0.18, 0.005, 0.08, 0.65, 0.08, 9000, 0, 0.25) },
  'pulse-bass': { role: 'bass', program: 80, percussion: false, patch: patch('square', 0.2, 0.005, 0.1, 0.6, 0.12, 4000, 0, 0.5) },
  'chip-arp': { role: 'arpeggio', program: 80, percussion: false, patch: patch('square', 0.13, 0.005, 0.06, 0.3, 0.06, 9000, 0, 0.125) },
  custom: { role: 'synth', program: 80, percussion: false, patch: patch('square', 0.18, 0.01, 0.15, 0.55, 0.15, 8000) },
};

const voiceGenerationSchema = z.object({
  wave: z.enum(waveNames), dutyCycle: z.number().optional(), gain: z.number().optional(),
  attack: z.number().optional(), release: z.number().optional(), lowpassHz: z.number().optional(),
  pan: z.number().optional(), program: z.number().int().optional(), percussion: z.boolean().optional(),
});
const voiceSchema = voiceGenerationSchema.extend({
  dutyCycle: z.number().finite().min(0.05).max(0.95).optional(),
  gain: z.number().finite().min(0).max(1).optional(),
  attack: z.number().finite().min(0).max(5).optional(),
  release: z.number().finite().min(0.005).max(8).optional(),
  lowpassHz: z.number().finite().min(80).max(20000).optional(),
  pan: z.number().finite().min(-1).max(1).optional(),
  program: z.number().int().min(0).max(127).optional(),
});

// Keep provider-facing JSON Schema to widely supported shape constraints;
// compactScoreSchema below enforces all limits after generation.
export const compactGenerationSchema = z.object({
  title: z.string(), bpm: z.number(), meter: z.string(), bars: z.number().int(),
  tracks: z.array(z.object({
    id: z.string(), sound: z.enum(soundNames), role: z.string().optional(), voice: voiceGenerationSchema.optional(),
    patterns: z.array(z.object({ id: z.string(), notes: z.array(z.string()) })),
    play: z.array(z.string()),
  })),
});

export const compactScoreSchema = z.object({
  title: z.string().min(1).max(120),
  bpm: z.number().finite().min(20).max(300),
  meter: z.string().min(3).max(5),
  bars: z.number().int().min(1).max(512),
  tracks: z.array(z.object({
    id: z.string().min(1).max(60),
    sound: z.enum(soundNames), role: z.string().min(1).max(80).optional(), voice: voiceSchema.optional(),
    patterns: z.array(z.object({ id: z.string().min(1).max(32), notes: z.array(z.string().min(7).max(60)).min(1).max(256) })).min(1).max(16),
    play: z.array(z.string().min(5).max(80)).min(1).max(256),
  })).min(1).max(32),
});
export type CompactScore = z.infer<typeof compactScoreSchema>;

function parseNote(value: string) {
  if (!/^\d+(?:\.\d+)?,\d+,\d+(?:\.\d+)?,\d+$/.test(value)) throw new Error(`invalid note tuple: ${value}`);
  const [start, pitch, duration, velocity] = value.split(',').map(Number);
  return noteSchema.parse({ start, pitch, duration, velocity });
}

function parsePlacement(value: string): [string, number, number] {
  const match = /^([A-Za-z0-9_-]+),(\d+),(-?\d+)$/.exec(value);
  if (!match) throw new Error(`invalid placement tuple: ${value}`);
  const startBar = Number(match[2]), transpose = Number(match[3]);
  if (startBar > 511 || transpose < -24 || transpose > 24) throw new Error(`placement out of range: ${value}`);
  return [match[1], startBar, transpose];
}

export function expandCompactScoreWithStats(value: unknown, audio: boolean): { project: MusicProject; truncatedNotes: number; droppedNotes: number } {
  const compact = compactScoreSchema.parse(value);
  const meter = /^(\d{1,2})\/(2|4|8|16)$/.exec(compact.meter);
  if (!meter || Number(meter[1]) < 1 || Number(meter[1]) > 12) throw new Error(`invalid meter: ${compact.meter}`);
  const project: MusicProject = {
    version: 1, title: compact.title, bpm: compact.bpm,
    timeSignature: { numerator: Number(meter[1]), denominator: Number(meter[2]) as 2 | 4 | 8 | 16 }, bars: compact.bars,
    tracks: [],
  };
  const barBeats = beatsPerBar(project);
  const endBeat = compact.bars * barBeats;
  let truncatedNotes = 0, droppedNotes = 0;
  for (const track of compact.tracks) {
    const sound = sounds[track.sound];
    if (track.sound === 'custom' && !track.voice) throw new Error(`custom sound requires voice: ${track.id}`);
    const voice = track.voice;
    const percussion = voice?.percussion ?? sound.percussion;
    const renderPatch: SynthPatch = voice ? {
      ...sound.patch,
      oscillators: [{ ...sound.patch.oscillators[0], wave: voice.wave, ...(voice.dutyCycle === undefined ? {} : { dutyCycle: voice.dutyCycle }) }],
      envelope: { ...sound.patch.envelope, attack: voice.attack ?? sound.patch.envelope.attack, release: voice.release ?? sound.patch.envelope.release },
      gain: voice.gain ?? sound.patch.gain,
      lowpassHz: voice.lowpassHz ?? sound.patch.lowpassHz,
      pan: voice.pan ?? sound.patch.pan,
    } : sound.patch;
    const patterns = new Map(track.patterns.map(pattern => [pattern.id, pattern.notes]));
    if (patterns.size !== track.patterns.length) throw new Error(`duplicate pattern id: ${track.id}`);
    if ([...patterns.keys()].some(id => !/^[A-Za-z0-9_-]+$/.test(id))) throw new Error(`invalid pattern id: ${track.id}`);
    const lowerIds = new Map<string, string>();
    for (const id of patterns.keys()) if (!lowerIds.has(id.toLowerCase())) lowerIds.set(id.toLowerCase(), id);
    const parsed = new Map<string, ReturnType<typeof parseNote>[]>();
    const notes: MusicProject['tracks'][number]['notes'] = [];
    for (const entry of track.play) {
      const [patternId, startBar, transpose] = parsePlacement(entry);
      const resolved = patterns.has(patternId) ? patternId : lowerIds.get(patternId.toLowerCase()) ?? (patterns.size === 1 ? patterns.keys().next().value! : patternId);
      const pattern = patterns.get(resolved);
      if (!pattern) throw new Error(`unknown pattern ${patternId} in ${track.id}`);
      if (percussion && transpose !== 0) throw new Error(`percussion cannot transpose: ${track.id}`);
      if (!parsed.has(resolved)) parsed.set(resolved, pattern.map(parseNote));
      for (const note of parsed.get(resolved)!) {
        const start = startBar * barBeats + note.start;
        if (start >= endBeat) { droppedNotes++; continue; }
        const duration = Math.min(note.duration, endBeat - start);
        if (duration < note.duration) truncatedNotes++;
        notes.push({ start, pitch: note.pitch + transpose, duration, velocity: note.velocity });
        if (notes.length > 4000) throw new Error(`track exceeds 4000 notes: ${track.id}`);
      }
    }
    project.tracks.push({ id: track.id, name: track.id, role: track.role ?? sound.role, program: voice?.program ?? (percussion ? 0 : sound.program), percussion, notes, ...(audio ? { patch: renderPatch } : {}) });
  }
  return { project: validateProject(project, audio), truncatedNotes, droppedNotes };
}

export function expandCompactScore(value: unknown, audio: boolean): MusicProject {
  return expandCompactScoreWithStats(value, audio).project;
}
