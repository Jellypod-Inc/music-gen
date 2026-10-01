import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { parseMidi } from 'midi-file';
import { z } from 'zod';
import { expandCompactScore, expandCompactScoreWithStats, generateMusic, inspectWav, renderMusic, renderWav, validateProject, writeMidi, type MusicRenderer } from '../src/index.js';
import { compactGenerationSchema, compactScoreSchema } from '../src/compact.js';

const patch = { oscillators: [{ wave: 'triangle', level: 0.8, octave: 0, detuneCents: 0 }], envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.4 }, lowpassHz: 4500, gain: 0.2, pan: 0, reverb: 0.1 } as const;
const score = { version: 1, title: 'Test piece', bpm: 120, timeSignature: { numerator: 4, denominator: 4 }, bars: 15, tracks: [
  { id: 'melody', name: 'Melody', role: 'lead', program: 0, percussion: false, notes: [{ start: 0, duration: 1, pitch: 60, velocity: 100 }, { start: 30, duration: 2, pitch: 64, velocity: 95 }], patch },
  { id: 'bass', name: 'Bass', role: 'bass', program: 33, percussion: false, notes: [{ start: 0, duration: 2, pitch: 36, velocity: 90 }], patch: { ...patch, pan: -0.4 } },
] };
const compact = { title: 'Compact piece', bpm: 120, meter: '4/4', bars: 4, tracks: [
  { id: 'lead', sound: 'soft-piano', patterns: [{ id: 'A', notes: ['0,60,1,90', '2,64,1,80'] }], play: ['A,0,0', 'A,2,2'] },
  { id: 'bass', sound: 'round-bass', patterns: [{ id: 'B', notes: ['0,36,2,90'] }], play: ['B,0,0', 'B,2,0'] },
] };

test('provider-facing compact schema keeps shape while local validation retains limits', () => {
  const schema = z.toJSONSchema(compactGenerationSchema) as { properties: { title: { minLength?: number }; tracks: { maxItems?: number } } };
  assert.equal(schema.properties.title.minLength, undefined);
  assert.equal(schema.properties.tracks.maxItems, undefined);
  assert.equal(compactGenerationSchema.safeParse({ ...compact, title: '' }).success, true);
  assert.equal(compactScoreSchema.safeParse({ ...compact, title: '' }).success, false);
});

test('compact score lets the model choose many tracks and a custom pulse voice', () => {
  const tracks = Array.from({ length: 6 }, (_, index) => ({
    id: `voice-${index}`, sound: index === 0 ? 'custom' : 'pulse-lead', role: index === 0 ? 'lead' : 'harmony',
    ...(index === 0 ? { voice: { wave: 'square', dutyCycle: 0.125, gain: 0.2, attack: 0.005, release: 0.1, program: 80 } } : {}),
    patterns: [{ id: 'A', notes: [`0,${60 + index},1,90`] }], play: ['A,0,0'],
  }));
  const project = expandCompactScore({ title: 'Chip ensemble', bpm: 120, meter: '4/4', bars: 1, tracks }, true);
  assert.equal(project.tracks.length, 6);
  assert.equal(project.tracks[0].role, 'lead');
  assert.equal(project.tracks[0].patch?.oscillators[0].dutyCycle, 0.125);
  assert.equal(project.tracks[1].patch?.oscillators[0].dutyCycle, 0.25);
  assert.equal(parseMidi(Buffer.from(writeMidi(project).bytes)).tracks.length, 7);
  const wide = { ...project, tracks: project.tracks.map((track, index) => index ? track : { ...track, patch: { ...track.patch!, oscillators: [{ ...track.patch!.oscillators[0], dutyCycle: 0.5 }] } }) };
  assert.notDeepEqual(renderWav(project), renderWav(wide));
  assert.throws(() => expandCompactScore({ title: 'Missing voice', bpm: 120, meter: '4/4', bars: 1, tracks: [{ ...tracks[0], voice: undefined }] }, true), /custom sound requires voice/);
});
function mockResult(value: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: { inputTokens: { total: 10, noCache: 7, cacheRead: 3, cacheWrite: 0 }, outputTokens: { total: 20, text: 18, reasoning: 2 } }, warnings: [] }; }
function mock(value: unknown) { return new MockLanguageModelV4({ doGenerate: mockResult(value) }); }

function monoWav(frames: number, sampleRate = 48000): Uint8Array {
  const bytes = new Uint8Array(44 + frames * 2); const view = new DataView(bytes.buffer);
  for (const [at, label] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) for (let i = 0; i < label.length; i++) bytes[at + i] = label.charCodeAt(i);
  view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, frames * 2, true);
  return bytes;
}

test('custom renderer receives the score and reports its actual WAV format', async () => {
  const bare = { ...score, bars: 2, tracks: score.tracks.map(({ patch: _patch, ...track }) => ({ ...track, notes: track.notes.filter(note => note.start < 8) })) };
  const model = mock(bare);
  const renderer: MusicRenderer = { id: 'user/soundfont', version: '1.2.3', async render(project, { durationSeconds }) {
    assert.equal(project.tracks[0].program, 0);
    assert.equal(project.tracks[0].patch, undefined);
    return monoWav(Math.round(durationSeconds * 48000));
  } };
  const result = await generateMusic({ prompt: 'A short score', model, scoreFormat: 'full', output: ['midi', 'audio'], renderer, length: { mode: 'duration', seconds: 4 } });
  assert.deepEqual(result.metadata.renderer, { id: 'user/soundfont', version: '1.2.3' });
  assert.deepEqual(result.metadata.artifacts[1], { type: 'audio', bytes: 44 + 4 * 48000 * 2, mimeType: 'audio/wav', durationSeconds: 4, sampleRate: 48000, channels: 1, bitDepth: 16 });
  assert.equal(inspectWav(result.outputs[1].bytes).frames, 4 * 48000);
  assert.equal((await renderMusic(result.project, { renderer })).info.frames, 4 * 48000);
  assert.equal(model.doGenerateCalls.length, 1);
});

test('invalid custom WAV fails without another paid model attempt', async () => {
  const model = mock(compact);
  const renderer: MusicRenderer = { id: 'bad-renderer', version: '1', render: () => monoWav(1) };
  await assert.rejects(generateMusic({ prompt: 'A short score', model, output: 'audio', renderer, maxAttempts: 3 }), /WAV duration verification failed/);
  assert.equal(model.doGenerateCalls.length, 1);
});

test('compact score repeats and transposes patterns before MIDI and WAV rendering', async () => {
  const model = mock(compact);
  const result = await generateMusic({ prompt: 'A short pattern', model, output: ['midi', 'audio'], length: { mode: 'duration', seconds: 8 }, trace: true });
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(result.metadata.model.settings.scoreFormat, 'compact');
  assert.equal(result.project.tracks[0].notes.length, 4);
  assert.deepEqual(result.project.tracks[0].notes.map(n => n.pitch), [60, 64, 62, 66]);
  assert.deepEqual(result.project.tracks[0].notes.map(n => n.start), [0, 2, 8, 10]);
  assert.equal(result.project.tracks[0].patch?.oscillators[0].wave, 'triangle');
  assert.equal(result.metadata.noteCount, 6);
  assert.deepEqual(result.metadata.scoreExpansion, { truncatedNotes: 0, droppedNotes: 0 });
  assert.equal(result.metadata.run.steps, 1);
  assert.equal(new DataView(result.outputs[1].bytes.buffer).getUint32(40, true), 8 * 44100 * 4);
  assert.equal(parseMidi(Buffer.from(result.outputs[0].bytes)).tracks.length, 3);
  assert.equal(result.trace?.proposals[0] && 'patterns' in (result.trace.proposals[0] as typeof compact).tracks[0], true);
  assert.equal(expandCompactScore({ ...compact, tracks: [{ ...compact.tracks[0], play: ['leadA,0,0'] }] }, true).tracks[0].notes.length, 2);
  assert.throws(() => expandCompactScore({ ...compact, tracks: [{ ...compact.tracks[0], patterns: [...compact.tracks[0].patterns, { id: 'C', notes: ['0,67,1,80'] }], play: ['missing,0,0'] }] }, true), /unknown pattern/);
  const clipped = expandCompactScoreWithStats({ ...compact, tracks: [{ ...compact.tracks[0], patterns: [{ id: 'A', notes: ['3.5,60,1,90', '4,64,1,80'] }], play: ['A,3,0'] }] }, true);
  assert.deepEqual({ truncatedNotes: clipped.truncatedNotes, droppedNotes: clipped.droppedNotes }, { truncatedNotes: 1, droppedNotes: 1 });
});

test('both files share an exact 30-second score and parse as multitrack MIDI', async () => {
  const model = mock(score);
  const result = await generateMusic({ prompt: 'A simple test piece', model, scoreFormat: 'full', output: ['midi', 'audio'], length: { mode: 'duration', seconds: 30 }, trace: true });
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(model.doGenerateCalls[0].tools, undefined);
  assert.deepEqual(result.outputs.map(x => x.type), ['midi', 'audio']);
  assert.equal(result.metadata.intendedDurationSeconds, 30);
  assert.equal(result.metadata.proposedDurationSeconds, 30);
  assert.equal(result.metadata.tempoAdjustmentPercent, 0);
  const midi = parseMidi(Buffer.from(result.outputs[0].bytes));
  assert.equal(midi.tracks.length, 3);
  assert.deepEqual(midi.tracks.slice(1).map(t => t.filter(e => e.type === 'noteOn').length), [2, 1]);
  assert.ok(midi.tracks[0].some(e => e.type === 'setTempo'));
  assert.ok(midi.tracks[0].some(e => e.type === 'timeSignature'));
  for (const track of midi.tracks) {
    assert.equal(track.at(-1)?.type, 'endOfTrack');
    assert.equal(track.reduce((ticks, event) => ticks + event.deltaTime, 0), 15 * 4 * 960);
  }
  const wav = result.outputs[1].bytes; const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint32(40, true), 30 * 44100 * 4);
  let peak = 0, nonzero = 0;
  for (let i = 44; i < wav.length; i += 2) { const v = Math.abs(view.getInt16(i, true)); peak = Math.max(peak, v); if (v) nonzero++; }
  assert.ok(nonzero > 10000);
  assert.ok(peak > 100 && peak < 32767);
  assert.equal(result.trace?.proposals.length, 1);
  assert.equal(result.metadata.model.usage.inputTokens, 10);
  assert.equal(result.metadata.model.usage.outputTokens, 20);
  assert.equal(result.metadata.model.usage.totalTokens, 30);
  assert.equal(result.metadata.model.usage.cacheReadTokens, 3);
  assert.equal(result.metadata.model.usage.reasoningTokens, 2);
  assert.equal(result.metadata.model.usage.complete, true);
  assert.equal(result.metadata.noteCount, 3);
  assert.equal(result.metadata.run.attempts, 1);
  assert.equal(result.metadata.run.steps, 1);
  assert.ok(result.metadata.run.elapsedMs >= result.metadata.run.modelMs);
  assert.equal(result.metadata.artifacts[1].bytes, wav.length);
  assert.equal(result.metadata.artifacts[1].sampleRate, 44100);
  assert.equal(result.metadata.aiSdk.attempts.length, 1);
  assert.equal(result.metadata.aiSdk.attempts[0].steps[0].usage.outputTokens, 20);
  assert.equal(result.metadata.aiSdk.attempts[0].steps[0].finishReason, 'stop');
  assert.ok(result.metadata.aiSdk.attempts[0].response.id);
});

test('bar mode and MIDI-only require no patches', async () => {
  const bare = { ...score, bars: 4, tracks: score.tracks.map(({ patch: _patch, ...t }) => ({ ...t, notes: t.notes.filter(n => n.start < 4) })) };
  const result = await generateMusic({ prompt: 'test', model: mock(bare), scoreFormat: 'full', output: 'midi', length: { mode: 'bars', bars: 4, bpm: 120 } });
  assert.equal(result.outputs.length, 1);
  assert.equal(result.project.bars, 4);
  assert.equal(result.project.tracks[0].patch, undefined);
});

test('AI SDK model reasoning and provider options reach the model', async () => {
  const bare = { ...score, tracks: score.tracks.map(({ patch: _patch, ...t }) => t) };
  const model = mock(bare);
  const result = await generateMusic({ prompt: 'test', model, scoreFormat: 'full', output: 'midi', reasoning: 'high', providerOptions: { anthropic: { effort: 'high' } }, maxOutputTokens: 4096 });
  assert.equal(model.doGenerateCalls[0].reasoning, 'high');
  assert.deepEqual(model.doGenerateCalls[0].providerOptions, { anthropic: { effort: 'high' } });
  assert.equal(model.doGenerateCalls[0].maxOutputTokens, 4096);
  assert.equal(result.metadata.model.settings.reasoning, 'high');
  assert.equal(result.metadata.model.settings.maxOutputTokens, 4096);
});

test('auto length uses score choice; invalid maxDuration is rejected before model call', async () => {
  const model = mock({ ...score, bars: 2, tracks: score.tracks.map(t => ({ ...t, notes: t.notes.filter(n => n.start < 8) })) });
  const result = await generateMusic({ prompt: 'test', model, scoreFormat: 'full', output: 'audio' });
  assert.deepEqual(result.outputs.map(x => x.type), ['audio']);
  assert.equal(result.project.bars, 2);
  await assert.rejects(generateMusic({ prompt: 'test', model, scoreFormat: 'full', output: 'audio', length: { mode: 'duration', seconds: 30 }, maxDuration: 29 }), /exceeds maxDuration/);
  assert.equal(model.doGenerateCalls.length, 1);
});

test('duration mode records large tempo correction while preserving the exact endpoint', async () => {
  const result = await generateMusic({ prompt: 'short cue', model: mock(score), scoreFormat: 'full', output: ['midi', 'audio'], length: { mode: 'duration', seconds: 20 } });
  assert.equal(result.metadata.proposedDurationSeconds, 30);
  assert.equal(result.metadata.tempoAdjustmentPercent, 50);
  assert.equal(result.project.bpm, 180);
  assert.equal(new DataView(result.outputs[1].bytes.buffer).getUint32(40, true), 20 * 44100 * 4);
});

test('model-chosen duration above maxDuration fails after one attempt by default', async () => {
  const model = mock(score);
  await assert.rejects(generateMusic({ prompt: 'test', model, scoreFormat: 'full', output: 'midi', maxDuration: 10, trace: true }), error => {
    assert.match(error.message, /exceeds maxDuration/);
    assert.equal(error.diagnostics.attempts, 1);
    assert.equal(error.diagnostics.usage.inputTokens, 10);
    assert.equal(error.diagnostics.trace.proposals.length, 1);
    return true;
  });
  assert.equal(model.doGenerateCalls.length, 1);
});

test('bounded repairs remain available by explicit opt-in', async () => {
  const model = mock(score);
  await assert.rejects(generateMusic({ prompt: 'test', model, scoreFormat: 'full', output: 'midi', maxDuration: 10, maxAttempts: 3, trace: true }), error => {
    assert.match(error.message, /exceeds maxDuration/);
    assert.equal(error.diagnostics.attempts, 3);
    assert.equal(error.diagnostics.usage.inputTokens, 30);
    assert.equal(error.diagnostics.trace.proposals.length, 3);
    return true;
  });
  assert.equal(model.doGenerateCalls.length, 3);
});

test('AI SDK metadata retains each completed repair attempt', async () => {
  const bare = { ...score, bars: 4, tracks: score.tracks.map(({ patch: _patch, ...t }) => ({ ...t, notes: t.notes.filter(n => n.start < 4) })) };
  const model = new MockLanguageModelV4({ doGenerate: [mockResult(bare), mockResult({ ...bare, bars: 8 })] });
  const result = await generateMusic({ prompt: 'test', model, scoreFormat: 'full', output: 'midi', length: { mode: 'bars', bars: 8 }, maxAttempts: 2 });
  assert.equal(result.metadata.run.attempts, 2);
  assert.equal(result.metadata.model.usage.inputTokens, 20);
  assert.deepEqual(result.metadata.aiSdk.attempts.map(a => a.attempt), [1, 2]);
  assert.equal(result.metadata.aiSdk.attempts[1].response.modelId, 'mock-model-id');
});

test('independent score validator and writers reject out-of-range notes', () => {
  assert.throws(() => validateProject({ ...score, tracks: [{ ...score.tracks[0], notes: [{ start: 59, duration: 2, pitch: 60, velocity: 100 }] }] }, true), /outside score/);
  const p = validateProject(score, true);
  assert.ok(writeMidi(p).bytes.length > 100);
  assert.equal(new DataView(renderWav(p, 0.1).buffer).getUint32(40, true), Math.round(0.1 * 44100) * 4);
});
