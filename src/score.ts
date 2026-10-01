import { z } from 'zod';

export const noteSchema = z.object({ start: z.number().finite().nonnegative(), duration: z.number().finite().positive(), pitch: z.number().int().min(0).max(127), velocity: z.number().int().min(1).max(127) });
export const patchSchema = z.object({
  oscillators: z.array(z.object({ wave: z.enum(['sine', 'triangle', 'saw', 'square', 'noise']), level: z.number().finite().min(0).max(1), octave: z.number().int().min(-2).max(2), detuneCents: z.number().finite().min(-50).max(50), dutyCycle: z.number().finite().min(0.05).max(0.95).optional() })).min(1).max(3),
  envelope: z.object({ attack: z.number().finite().min(0).max(5), decay: z.number().finite().min(0).max(5), sustain: z.number().finite().min(0).max(1), release: z.number().finite().min(0.005).max(8) }),
  lowpassHz: z.number().finite().min(80).max(20000), gain: z.number().finite().min(0).max(1), pan: z.number().finite().min(-1).max(1), reverb: z.number().finite().min(0).max(0.5),
});
export const trackSchema = z.object({ id: z.string().min(1).max(60), name: z.string().min(1).max(80), role: z.string().min(1).max(80), program: z.number().int().min(0).max(127), percussion: z.boolean(), notes: z.array(noteSchema).max(4000), patch: patchSchema.optional() });
export const projectSchema = z.object({ version: z.literal(1), title: z.string().min(1).max(120), bpm: z.number().finite().min(20).max(300), timeSignature: z.object({ numerator: z.number().int().min(1).max(12), denominator: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]) }), bars: z.number().int().min(1).max(512), tracks: z.array(trackSchema).min(1).max(32) });
export type MusicProject = z.infer<typeof projectSchema>;
export type SynthPatch = z.infer<typeof patchSchema>;

export function beatsPerBar(p: MusicProject): number { return p.timeSignature.numerator * 4 / p.timeSignature.denominator; }
export function durationSeconds(p: MusicProject): number { return p.bars * beatsPerBar(p) * 60 / p.bpm; }
export function validateProject(value: unknown, audio: boolean): MusicProject {
  const p = projectSchema.parse(value);
  const ids = new Set<string>();
  let count = 0;
  for (const t of p.tracks) {
    if (ids.has(t.id)) throw new Error(`duplicate track id: ${t.id}`);
    ids.add(t.id);
    if (audio && !t.patch) throw new Error(`missing synth patch for ${t.name}`);
    for (const n of t.notes) {
      count++;
      if (n.start + n.duration > p.bars * beatsPerBar(p) + 1e-7) throw new Error(`note outside score: ${t.name}`);
    }
  }
  if (!count) throw new Error('score has no notes');
  if (count > 10000) throw new Error('score exceeds 10000-note safety limit');
  return p;
}
