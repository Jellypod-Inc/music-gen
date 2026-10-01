import { beatsPerBar, type MusicProject } from './score.js';

const PPQ = 960;
function vlq(n: number): number[] { if (!Number.isInteger(n) || n < 0 || n > 0x0fffffff) throw new Error('MIDI delta out of range'); const a = [n & 127]; while ((n >>= 7)) a.unshift((n & 127) | 128); return a; }
function chunk(id: string, bytes: number[]): number[] { const n = bytes.length; return [...new TextEncoder().encode(id), (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, ...bytes]; }
type Event = { tick: number; order: number; data: number[] };
function encode(events: Event[], endpoint: number): number[] {
  events.push({ tick: endpoint, order: 99, data: [0xff, 0x2f, 0] });
  events.sort((a,b) => a.tick - b.tick || a.order - b.order);
  let last = 0; const result: number[] = [];
  for (const event of events) { if (event.tick > endpoint) throw new Error('event exceeds MIDI endpoint'); result.push(...vlq(event.tick - last), ...event.data); last = event.tick; }
  return chunk('MTrk', result);
}
function metaText(type: number, value: string): number[] { const b = [...new TextEncoder().encode(value)]; return [0xff, type, ...vlq(b.length), ...b]; }
export function writeMidi(p: MusicProject, intendedSeconds?: number): { bytes: Uint8Array; encodedSeconds: number } {
  const endpoint = Math.round(p.bars * beatsPerBar(p) * PPQ);
  const micros = Math.round(60_000_000 / p.bpm);
  const encodedSeconds = endpoint * micros / (PPQ * 1_000_000);
  if (intendedSeconds !== undefined && Math.abs(encodedSeconds - intendedSeconds) > Math.max(0.0005, 60 / p.bpm / PPQ)) throw new Error('MIDI endpoint differs from requested duration');
  const meterPower = Math.log2(p.timeSignature.denominator);
  const conductor: Event[] = [
    { tick: 0, order: 0, data: metaText(3, p.title) },
    { tick: 0, order: 1, data: [0xff, 0x51, 3, (micros >> 16) & 255, (micros >> 8) & 255, micros & 255] },
    { tick: 0, order: 2, data: [0xff, 0x58, 4, p.timeSignature.numerator, meterPower, 24, 8] },
  ];
  const tracks = [encode(conductor, endpoint)]; let channel = 0;
  for (const track of p.tracks) {
    if (!track.percussion) { while (channel === 9) channel++; if (channel > 15) throw new Error('too many pitched tracks for MIDI channels'); }
    const ch = track.percussion ? 9 : channel++;
    const events: Event[] = [
      { tick: 0, order: 0, data: metaText(3, track.name) },
      { tick: 0, order: 1, data: [0xc0 | ch, track.program] },
    ];
    for (const note of track.notes) {
      const start = Math.round(note.start * PPQ), end = Math.round((note.start + note.duration) * PPQ);
      if (end <= start || end > endpoint) throw new Error('note cannot be represented at MIDI tick resolution');
      events.push({ tick: start, order: 3, data: [0x90 | ch, note.pitch, note.velocity] }, { tick: end, order: 2, data: [0x80 | ch, note.pitch, 0] });
    }
    tracks.push(encode(events, endpoint));
  }
  const header = chunk('MThd', [0,1, (tracks.length >> 8) & 255, tracks.length & 255, (PPQ >> 8) & 255, PPQ & 255]);
  return { bytes: Uint8Array.from([...header, ...tracks.flat()]), encodedSeconds };
}
