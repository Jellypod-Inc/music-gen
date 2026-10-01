import { createHash } from 'node:crypto';
import { parseMidi } from 'midi-file';

type ObjectiveExpectations = {
  durationSeconds?: number;
  bars?: number;
  bpm?: number;
  minNonEmptyTracks?: number;
  loopBoundaryDiagnostic?: boolean;
};

export function validateSuite(suite) {
  if (![1, 2, 3, 4].includes(suite.suiteVersion) || !Array.isArray(suite.cases) || suite.cases.length < 12 || suite.cases.length > 20) throw new Error('suite must have a supported version and contain 12–20 cases');
  const ids = new Set();
  for (const c of suite.cases) {
    if (!/^[a-z0-9-]+$/.test(c.id) || ids.has(c.id)) throw new Error(`invalid or duplicate case id: ${c.id}`);
    ids.add(c.id);
    if (!c.prompt?.trim() || !c.listeningRubric?.trim() || !Array.isArray(c.tags) || !c.tags.length) throw new Error(`incomplete case: ${c.id}`);
    if (!['auto', 'duration', 'bars'].includes(c.generation?.length?.mode)) throw new Error(`invalid length: ${c.id}`);
    if (c.generation.length.mode === 'duration' && c.expect?.durationSeconds !== c.generation.length.seconds) throw new Error(`duration expectation mismatch: ${c.id}`);
    if (c.generation.length.mode === 'bars' && (c.expect?.bars !== c.generation.length.bars || c.expect?.bpm !== c.generation.length.bpm)) throw new Error(`bar expectation mismatch: ${c.id}`);
    if (c.tags.includes('loop') && 'loop' in c.generation) throw new Error(`loop must live in prompt: ${c.id}`);
  }
  return suite;
}

export function modelSlug(id) {
  const readable = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `${readable}-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
}

function parseWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset, count) => String.fromCharCode(...bytes.subarray(offset, offset + count));
  if (bytes.length < 44 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length) throw new Error('invalid RIFF/WAVE header or size');
  let fmt, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = ascii(offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size > bytes.length) throw new Error('WAV chunk exceeds file');
    if (id === 'fmt ') fmt = { format: view.getUint16(start, true), channels: view.getUint16(start + 2, true), sampleRate: view.getUint32(start + 4, true), bitDepth: view.getUint16(start + 14, true) };
    if (id === 'data') data = { start, size };
    offset = start + size + (size % 2);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.channels !== 2 || fmt.bitDepth !== 16 || data.size % 4) throw new Error('expected stereo 16-bit PCM WAV');
  const frames = data.size / 4;
  let peak = 0, sumSquares = 0, nonZeroSamples = 0, clippedSamples = 0;
  for (let i = 0; i < frames * 2; i++) {
    const value = view.getInt16(data.start + i * 2, true);
    const magnitude = Math.abs(value);
    peak = Math.max(peak, magnitude);
    sumSquares += value * value;
    if (value !== 0) nonZeroSamples++;
    if (magnitude >= 32760) clippedSamples++;
  }
  const sample = (frame, channel) => view.getInt16(data.start + frame * 4 + channel * 2, true) / 32768;
  const boundaryJump = Math.hypot(sample(0, 0) - sample(frames - 1, 0), sample(0, 1) - sample(frames - 1, 1));
  const window = Math.min(Math.round(fmt.sampleRate * 0.1), Math.floor(frames / 2));
  let localJump = 0, comparisons = 0;
  for (const begin of [1, Math.max(1, frames - window)]) for (let i = begin; i < Math.min(frames, begin + window); i += 8) {
    localJump += Math.hypot(sample(i, 0) - sample(i - 1, 0), sample(i, 1) - sample(i - 1, 1));
    comparisons++;
  }
  const typicalAdjacentJump = comparisons ? localJump / comparisons : 0;
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitDepth: fmt.bitDepth, frames, durationSeconds: frames / fmt.sampleRate, peakSample: peak, rms: Math.sqrt(sumSquares / (frames * 2)) / 32768, nonZeroSamples, clippedSamples, clippedFraction: clippedSamples / (frames * 2), boundaryClick: { jump: boundaryJump, typicalAdjacentJump, ratio: typicalAdjacentJump ? boundaryJump / typicalAdjacentJump : null, likelyClick: boundaryJump > 0.03 && boundaryJump > typicalAdjacentJump * 3 } };
}

function parseMidiStats(bytes) {
  const midi = parseMidi(bytes);
  const ppq = midi.header.ticksPerBeat;
  if (!ppq || midi.tracks.length < 2) throw new Error('expected beat-based multitrack MIDI');
  const trackEndTicks = midi.tracks.map(track => track.reduce((tick, event) => tick + event.deltaTime, 0));
  if (midi.tracks.some(track => track.at(-1)?.type !== 'endOfTrack')) throw new Error('missing MIDI end-of-track');
  const endpointTicks = trackEndTicks[0];
  const sameEndpoint = trackEndTicks.every(tick => tick === endpointTicks);
  const tempoEvents = [];
  let tick = 0;
  for (const event of midi.tracks[0]) { tick += event.deltaTime; if (event.type === 'setTempo') tempoEvents.push({ tick, microsecondsPerBeat: event.microsecondsPerBeat }); }
  tempoEvents.sort((a, b) => a.tick - b.tick);
  let last = 0, micros = 500000, seconds = 0;
  for (const event of tempoEvents) { if (event.tick > endpointTicks) break; seconds += (event.tick - last) * micros / (ppq * 1e6); last = event.tick; micros = event.microsecondsPerBeat; }
  seconds += (endpointTicks - last) * micros / (ppq * 1e6);
  const meter = midi.tracks[0].find(event => event.type === 'timeSignature');
  const bpm = tempoEvents.length ? 60e6 / tempoEvents[0].microsecondsPerBeat : 120;
  const bars = meter ? endpointTicks / (ppq * meter.numerator * 4 / meter.denominator) : null;
  const noteCounts = midi.tracks.slice(1).map(track => track.filter(event => event.type === 'noteOn' && event.velocity > 0).length);
  return { format: midi.header.format, tracks: midi.tracks.length, nonEmptyTracks: noteCounts.filter(n => n > 0).length, notes: noteCounts.reduce((a, b) => a + b, 0), noteCounts, ppq, endpointTicks, trackEndTicks, sameEndpoint, durationSeconds: seconds, bpm, bars, meter: meter ? { numerator: meter.numerator, denominator: meter.denominator } : null };
}

export function inspectArtifacts({ midiBytes, wavBytes, expect = {}, maxDuration }: { midiBytes?: Uint8Array; wavBytes?: Uint8Array; expect?: ObjectiveExpectations; maxDuration?: number }) {
  const checks: Record<string, boolean | string> = {};
  let midi = null, wav = null;
  try { midi = parseMidiStats(midiBytes); checks.midiParseable = true; } catch (error) { checks.midiParseable = false; checks.midiError = String(error); }
  try { wav = parseWav(wavBytes); checks.wavParseable = true; } catch (error) { checks.wavParseable = false; checks.wavError = String(error); }
  if (midi) {
    checks.midiEndpointConsistent = midi.sameEndpoint;
    checks.midiHasTempoAndMeter = midi.meter !== null;
    checks.midiHasNotes = midi.notes > 0;
    if (expect.bars !== undefined) checks.requestedBars = Math.abs(midi.bars - expect.bars) < 1e-6;
    if (expect.bpm !== undefined) checks.requestedBpm = Math.abs(midi.bpm - expect.bpm) < 0.001;
    if (expect.minNonEmptyTracks !== undefined) checks.minNonEmptyTracks = midi.nonEmptyTracks >= expect.minNonEmptyTracks;
  }
  if (wav) {
    checks.audioNonSilent = wav.rms > 0.0001 && wav.nonZeroSamples > 0;
    checks.audioNotVisiblyClipped = wav.clippedFraction < 0.001;
    if (expect.durationSeconds !== undefined) checks.exactWavDuration = wav.frames === Math.round(expect.durationSeconds * wav.sampleRate);
    if (maxDuration !== undefined) checks.maxDuration = wav.durationSeconds <= maxDuration + 1 / wav.sampleRate;
  }
  if (midi && wav) {
    const target = expect.durationSeconds ?? wav.durationSeconds;
    checks.midiEndpointDuration = Math.abs(midi.durationSeconds - target) <= Math.max(0.0005, 60 / midi.bpm / midi.ppq);
  }
  return { checks, passed: Object.values(checks).every(value => value === true), midi, wav, loopBoundaryDiagnostic: expect.loopBoundaryDiagnostic && wav ? wav.boundaryClick : null };
}

function proposalDuration(value) {
  if (!value || typeof value !== 'object') return null;
  const { bars, bpm } = value;
  const timeSignature = value.timeSignature ?? (Array.isArray(value.meter) ? { numerator: value.meter[0], denominator: value.meter[1] } : typeof value.meter === 'string' && /^\d+\/\d+$/.test(value.meter) ? { numerator: Number(value.meter.split('/')[0]), denominator: Number(value.meter.split('/')[1]) } : null);
  if (!Number.isFinite(bars) || !Number.isFinite(bpm) || bars <= 0 || bpm <= 0 || !timeSignature || !Number.isFinite(timeSignature.numerator) || !Number.isFinite(timeSignature.denominator) || timeSignature.denominator <= 0) return null;
  return bars * timeSignature.numerator * 4 / timeSignature.denominator * 60 / bpm;
}

export function analyzeTrace(trace, finalProject) {
  if (!trace) return { firstProposalDurationSeconds: null, proposalCount: null, revisionAttempts: null, externalRepairAttempts: null, finalDurationSeconds: proposalDuration(finalProject) };
  const proposals = [];
  const attemptNumbers = [...new Set([...(trace.steps ?? []).map(s => s.attempt ?? 1), ...(trace.proposalAttempts ?? []).map(Number), 1])].sort((a, b) => a - b);
  for (const attempt of attemptNumbers) {
    for (const step of trace.steps ?? []) if ((step.attempt ?? 1) === attempt) for (const call of step.toolCalls ?? []) if (call.toolName === 'measureScore' && call.input) proposals.push(call.input);
    for (const [index, value] of (trace.proposals ?? []).entries()) if ((trace.proposalAttempts?.[index] ?? index + 1) === attempt && value) proposals.push(value);
  }
  const distinct = proposals.filter((value, index) => index === 0 || JSON.stringify(value) !== JSON.stringify(proposals[index - 1]));
  return { firstProposalDurationSeconds: proposalDuration(distinct[0]), proposalCount: distinct.length, revisionAttempts: Math.max(0, distinct.length - 1), externalRepairAttempts: trace.feedback?.length ?? 0, finalDurationSeconds: proposalDuration(finalProject) };
}

export function estimateCost(modelId, usage, prices) {
  const price = prices.models?.[modelId];
  if (!price || usage?.inputTokens == null || usage?.outputTokens == null) return null;
  const detailed = usage.uncachedInputTokens != null && usage.cacheReadTokens != null && usage.cacheWriteTokens != null;
  const inputCost = detailed ? (usage.uncachedInputTokens * price.input + usage.cacheReadTokens * price.cacheRead + usage.cacheWriteTokens * price.cacheWrite) / 1e6 : usage.inputTokens * price.input / 1e6;
  const outputCost = usage.outputTokens * price.output / 1e6;
  return { usd: inputCost + outputCost, inputUsd: inputCost, outputUsd: outputCost, pricingVersion: prices.pricingVersion, pricingSource: price.source, basis: detailed ? 'reported cache breakdown; 5-minute write rate' : 'all input at base rate; cache breakdown unavailable', usageComplete: usage.complete === true };
}

export function gatewayReportedCost(attempts) {
  const steps = (attempts ?? []).flatMap(attempt => attempt.steps ?? []);
  if (!steps.length || steps.some(step => step.providerMetadata?.gateway?.cost == null)) return null;
  const costs = steps.map(step => Number(step.providerMetadata.gateway.cost));
  if (costs.some(cost => !Number.isFinite(cost) || cost < 0)) return null;
  return { usd: costs.reduce((sum, cost) => sum + cost, 0), basis: 'AI Gateway reported cost summed across completed model steps', source: 'AI SDK providerMetadata.gateway.cost', reportedStepCount: steps.length };
}

export function summarizeResults(results) {
  const group = rows => {
    const success = rows.filter(r => r.status === 'success');
    const latencies = success.map(r => r.elapsedMs).sort((a, b) => a - b);
    return { calls: rows.length, successes: success.length, failures: rows.filter(r => r.status === 'failure').length, objectivePasses: success.filter(r => r.objective?.passed).length, medianLatencyMs: latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)] : null, knownEstimatedCostUsd: rows.reduce((sum, r) => sum + (r.estimatedCost?.usd ?? 0), 0), costUnknownCalls: rows.filter(r => !r.estimatedCost).length };
  };
  const byModel = Object.fromEntries([...new Set(results.map(r => r.modelId))].sort().map(id => [id, group(results.filter(r => r.modelId === id))]));
  const byCase = Object.fromEntries([...new Set(results.map(r => r.caseId))].sort().map(id => [id, group(results.filter(r => r.caseId === id))]));
  return { overall: group(results), byModel, byCase };
}

export function makePairs(results: Array<{ caseId: string; sampleIndex: number; status: string; modelId: string; files?: { audio?: string } }>, runId: string) {
  const pairs = [];
  const keys = [...new Set(results.map(r => `${r.caseId}\u0000${r.sampleIndex}`))];
  for (const key of keys) {
    const [caseId, sampleText] = key.split('\u0000');
    const sampleIndex = Number(sampleText);
    const candidates = results.filter(r => r.caseId === caseId && r.sampleIndex === sampleIndex && r.status === 'success' && r.files?.audio);
    for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      const pairId = createHash('sha256').update(`${runId}|${caseId}|${sampleIndex}|${[a.modelId, b.modelId].sort().join('|')}`).digest('hex').slice(0, 16);
      const swapped = parseInt(pairId.slice(0, 2), 16) % 2 === 1;
      pairs.push({ pairId, caseId, sampleIndex, left: swapped ? b : a, right: swapped ? a : b });
    }
  }
  return pairs;
}
