import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderWav, writeMidi, type MusicProject } from '../dist/index.js';
import { analyzeTrace, estimateCost, gatewayReportedCost, inspectArtifacts, makePairs, summarizeResults, validateSuite } from './lib.ts';
import { generateReport } from './report.ts';
import { generateShowcase } from './showcase.ts';

const suite = validateSuite(JSON.parse(await readFile(new URL('./suite.v1.json', import.meta.url), 'utf8')));
const suiteV2 = validateSuite(JSON.parse(await readFile(new URL('./suite.v2.json', import.meta.url), 'utf8')));
const suiteV3 = validateSuite(JSON.parse(await readFile(new URL('./suite.v3.json', import.meta.url), 'utf8')));
const suiteV4 = validateSuite(JSON.parse(await readFile(new URL('./suite.v4.json', import.meta.url), 'utf8')));
const patch: NonNullable<MusicProject['tracks'][number]['patch']> = { oscillators: [{ wave: 'sine', level: 1, octave: 0, detuneCents: 0 }], envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.2 }, lowpassHz: 8000, gain: 0.2, pan: 0, reverb: 0 };
const project: MusicProject = { version: 1, title: 'eval test', bpm: 120, timeSignature: { numerator: 4, denominator: 4 }, bars: 1, tracks: [
  { id: 'a', name: 'A', role: 'lead', program: 0, percussion: false, notes: [{ start: 0, duration: 1, pitch: 60, velocity: 90 }], patch },
  { id: 'b', name: 'B', role: 'bass', program: 32, percussion: false, notes: [{ start: 0, duration: 2, pitch: 48, velocity: 80 }], patch },
] };

test('suite is versioned, diverse, and keeps loopability in prompts', () => {
  assert.equal(suite.cases.length, 16);
  assert.ok(suite.cases.some(c => c.tags.includes('loop') && /loop/i.test(c.prompt)));
  assert.ok(suite.cases.some(c => c.generation.length.mode === 'auto'));
  assert.ok(suite.cases.some(c => c.expect.durationSeconds === 40));
  assert.throws(() => validateSuite({ ...suite, cases: [...suite.cases.slice(0, -1), suite.cases[0]] }), /duplicate/);
  assert.equal(suiteV2.cases.length, 17);
  assert.match(suiteV2.cases.at(-1).prompt, /Super Mario Bros/);
  assert.equal(suiteV3.cases.length, 18);
  assert.equal(suiteV3.cases.at(-1).id, 'open-ended-showcase-30');
  assert.equal(suiteV3.cases.at(-1).generation.length.seconds, 30);
  assert.equal(suiteV4.cases.length, 18);
  assert.equal(suiteV4.cases.at(-1).id, 'model-personality-showcase-30');
  assert.match(suiteV4.cases.at(-1).prompt, /personality as a language model/);
});

test('dry run plans paid call count without a credential', () => {
  const { status, stdout, stderr } = spawnSync(process.execPath, ['--import', 'tsx', 'evals/run.ts', '--models', 'model/a,model/b', '--samples', '1', '--cases', 'seamless-loop,exact-30-eerie', '--dry-run'], { cwd: new URL('..', import.meta.url), env: { ...process.env, AI_GATEWAY_API_KEY: '' }, encoding: 'utf8' });
  assert.equal(status, 0, stderr);
  assert.match(stdout, /4 paid calls/);
  const versioned = spawnSync(process.execPath, ['--import', 'tsx', 'evals/run.ts', '--suite', 'v2', '--models', 'model/a,model/b', '--samples', '1', '--cases', 'mario-overworld-theme', '--dry-run'], { cwd: new URL('..', import.meta.url), env: { ...process.env, AI_GATEWAY_API_KEY: '' }, encoding: 'utf8' });
  assert.equal(versioned.status, 0, versioned.stderr);
  assert.match(versioned.stdout, /2 paid calls/);
  const showcase = spawnSync(process.execPath, ['--import', 'tsx', 'evals/run.ts', '--suite', 'v3', '--models', 'model/a,model/b,model/c,model/d', '--samples', '1', '--cases', 'open-ended-showcase-30', '--dry-run'], { cwd: new URL('..', import.meta.url), env: { ...process.env, AI_GATEWAY_API_KEY: '' }, encoding: 'utf8' });
  assert.equal(showcase.status, 0, showcase.stderr);
  assert.match(showcase.stdout, /4 paid calls/);
  const personality = spawnSync(process.execPath, ['--import', 'tsx', 'evals/run.ts', '--suite', 'v4', '--models', 'model/a,model/b,model/c', '--samples', '1', '--cases', 'model-personality-showcase-30', '--reasoning', 'xhigh', '--dry-run'], { cwd: new URL('..', import.meta.url), env: { ...process.env, AI_GATEWAY_API_KEY: '' }, encoding: 'utf8' });
  assert.equal(personality.status, 0, personality.stderr);
  assert.match(personality.stdout, /3 paid calls/);
});

test('artifact analysis reads independent MIDI and WAV facts', () => {
  const midiBytes = writeMidi(project, 2).bytes, wavBytes = renderWav(project, 2);
  const checked = inspectArtifacts({ midiBytes, wavBytes, expect: { durationSeconds: 2, bars: 1, bpm: 120, minNonEmptyTracks: 2, loopBoundaryDiagnostic: true } });
  assert.equal(checked.passed, true);
  assert.equal(checked.midi.notes, 2);
  assert.equal(checked.midi.nonEmptyTracks, 2);
  assert.equal(checked.wav.frames, 88200);
  assert.equal(checked.checks.exactWavDuration, true);
  assert.equal(checked.checks.midiEndpointDuration, true);
  assert.equal(typeof checked.loopBoundaryDiagnostic.jump, 'number');
  assert.equal(inspectArtifacts({ midiBytes: new Uint8Array(5), wavBytes, expect: { durationSeconds: 2 } }).checks.midiParseable, false);
  assert.equal(inspectArtifacts({ midiBytes, wavBytes: new Uint8Array(44), expect: { durationSeconds: 2 } }).checks.wavParseable, false);
  const silent = renderWav({ ...project, tracks: project.tracks.map(t => ({ ...t, patch: { ...patch, gain: 0 } })) }, 2);
  assert.equal(inspectArtifacts({ midiBytes, wavBytes: silent }).checks.audioNonSilent, false);
  const clipped = Uint8Array.from(wavBytes), view = new DataView(clipped.buffer);
  for (let offset = 44; offset < 44 + 4000; offset += 2) view.setInt16(offset, 32767, true);
  assert.equal(inspectArtifacts({ midiBytes, wavBytes: clipped }).checks.audioNotVisiblyClipped, false);
});

test('trace separates first proposal, revisions, and final duration', () => {
  const first = { ...project, bars: 2 }, revised = { ...project, bars: 1 };
  const trace = { steps: [{ toolCalls: [{ toolName: 'measureScore', input: first }] }], proposals: [revised], feedback: ['revised'] };
  assert.deepEqual(analyzeTrace(trace, revised), { firstProposalDurationSeconds: 4, proposalCount: 2, revisionAttempts: 1, externalRepairAttempts: 1, finalDurationSeconds: 2 });
  const ordered = { steps: [{ attempt: 2, toolCalls: [{ toolName: 'measureScore', input: revised }] }], proposals: [first, revised], proposalAttempts: [1, 2], feedback: ['retry'] };
  assert.equal(analyzeTrace(ordered, revised).firstProposalDurationSeconds, 4);
  assert.equal(analyzeTrace({ steps: [], proposals: [{ bpm: 120, bars: 4, meter: [4, 4] }], proposalAttempts: [1], feedback: [] }, revised).firstProposalDurationSeconds, 8);
  assert.equal(analyzeTrace({ steps: [], proposals: [{ bpm: 120, bars: 4, meter: '4/4' }], proposalAttempts: [1], feedback: [] }, revised).firstProposalDurationSeconds, 8);
});

test('pricing is optional and summaries retain failures', () => {
  const prices = { pricingVersion: 1, models: { 'anthropic/claude-sonnet-5.5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, source: 'official' } } };
  const cost = estimateCost('anthropic/claude-sonnet-5.5', { inputTokens: 1000, outputTokens: 100, uncachedInputTokens: 700, cacheReadTokens: 200, cacheWriteTokens: 100, complete: true }, prices);
  assert.ok(Math.abs(cost.usd - 0.00269) < 1e-9);
  assert.equal(estimateCost('other/model', { inputTokens: 1000, outputTokens: 100 }, prices), null);
  assert.equal(gatewayReportedCost([{ steps: [{ providerMetadata: { gateway: { cost: '0.02' } } }, { providerMetadata: { gateway: { cost: '0.03' } } }] }]).usd, 0.05);
  assert.equal(gatewayReportedCost([{ steps: [{ providerMetadata: {} }] }]), null);
  const rows: Array<{ modelId: string; caseId: string; sampleIndex: number; status: string; elapsedMs: number; objective?: { passed: boolean }; estimatedCost?: { usd: number }; files?: { audio: string }; error?: { message: string } }> = [
    { modelId: 'a', caseId: 'x', sampleIndex: 1, status: 'success', elapsedMs: 100, objective: { passed: true }, estimatedCost: { usd: 0.1 }, files: { audio: 'a.wav' } },
    { modelId: 'b', caseId: 'x', sampleIndex: 1, status: 'failure', elapsedMs: 90, error: { message: 'failed' } },
  ];
  assert.equal(summarizeResults(rows).overall.failures, 1);
  assert.equal(summarizeResults(rows).overall.costUnknownCalls, 1);
  assert.equal(makePairs(rows, 'run').length, 0);
  rows[1] = { ...rows[1], status: 'success', files: { audio: 'b.wav' } };
  const pair = makePairs(rows, 'run')[0];
  assert.deepEqual(new Set([pair.left.modelId, pair.right.modelId]), new Set(['a', 'b']));
  assert.deepEqual(makePairs(rows, 'run'), makePairs(rows, 'run'));
});

test('report can be generated from a manifest without model calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'music-eval-report-'));
  try {
    await writeFile(join(dir, 'a.wav'), Uint8Array.of(1, 2));
    await writeFile(join(dir, 'b.wav'), Uint8Array.of(3, 4));
    const results = [
      { modelId: 'model/a', caseId: suite.cases[0].id, sampleIndex: 1, status: 'success', elapsedMs: 100, files: { audio: 'a.wav' }, objective: { passed: true } },
      { modelId: 'model/b', caseId: suite.cases[0].id, sampleIndex: 1, status: 'success', elapsedMs: 120, files: { audio: 'b.wav' }, objective: { passed: true } },
    ];
    const manifest = { runId: 'test-run', suite: { caseIds: [suite.cases[0].id] }, settings: { models: ['model/a', 'model/b'] }, results, summary: summarizeResults(results) };
    await generateReport(dir, manifest, suite);
    const html = await readFile(join(dir, 'report.html'), 'utf8');
    assert.match(html, /Blind comparisons/);
    assert.match(html, /Export raw votes/);
    assert.match(html, /test-run/);
    assert.match(html, /report-audio\/[a-f0-9]{16}\.wav/);
    assert.doesNotMatch(html, /"audio":"a\.wav"/);
    assert.equal((await readdir(join(dir, 'report-audio'))).length, 2);
    assert.doesNotMatch(html, /__EVAL_DATA__/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('showcase includes playable results, usage, cost, and failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'music-eval-showcase-'));
  try {
    const caseId = suite.cases[0].id;
    const results = [
      { modelId: 'model/a', caseId, sampleIndex: 1, status: 'success', elapsedMs: 1200, files: { audio: 'a.wav' }, objective: { passed: true, wav: { durationSeconds: 20 }, midi: { notes: 12, nonEmptyTracks: 2 } }, estimatedCost: { usd: 0.012 }, metadata: { model: { usage: { inputTokens: 100, outputTokens: 200 } } } },
      { modelId: 'model/b', caseId, sampleIndex: 1, status: 'failure', elapsedMs: 500, error: { message: 'Generation rejected' }, files: {} },
    ];
    const manifest = { runId: 'showcase-test', status: 'completed', suite: { caseIds: [caseId] }, settings: { models: ['model/a', 'model/b'] }, results, summary: summarizeResults(results) };
    await generateShowcase(dir, manifest, suite);
    const html = await readFile(join(dir, 'showcase.html'), 'utf8');
    for (const content of ['Hear every take', 'model/a', 'model/b', 'a.wav', 'Generation rejected', 'inputTokens', '0.012']) assert.ok(html.includes(content));
    assert.doesNotMatch(html, /__EVAL_DATA__/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
