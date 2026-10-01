import { Output, generateText, isStepCount, type CallWarning, type FinishReason, type LanguageModel, type LanguageModelUsage, type ProviderMetadata, type StepResultPerformance, type ToolLoopAgentSettings, type ToolSet } from 'ai';
import { z } from 'zod';
import { parseMidi } from 'midi-file';
import { compactGenerationSchema, expandCompactScoreWithStats } from './compact.js';
import { writeMidi } from './midi.js';
import { builtinRenderer, renderMusic, validateRenderer, type MusicRenderer } from './renderer.js';
import { beatsPerBar, durationSeconds, projectSchema, trackSchema, validateProject, type MusicProject } from './score.js';

export type { MusicProject, SynthPatch } from './score.js';
export { renderWav, BUILTIN_RENDERER_VERSION } from './audio.js';
export { builtinRenderer, inspectWav, renderMusic } from './renderer.js';
export type { MusicRenderer, RenderMusicOptions, WavInfo } from './renderer.js';
export { writeMidi } from './midi.js';
export { validateProject, durationSeconds } from './score.js';
export { compactScoreSchema, expandCompactScore, expandCompactScoreWithStats } from './compact.js';
export type { CompactScore } from './compact.js';

export type MusicOutput = 'midi' | 'audio';
export const MUSIC_AGENT_STEPS_PER_ATTEMPT = 6;
export const MUSIC_MAX_ATTEMPTS = 3;
export const MUSIC_DEFAULT_MAX_ATTEMPTS = 1;
export type MusicLength = { mode: 'auto' } | { mode: 'duration'; seconds: number } | { mode: 'bars'; bars: number; bpm?: number };
export interface MusicEnvironment { tools?: ToolSet }
export interface MusicPreview { prompt: string; project: MusicProject; audio: Uint8Array; iteration: number; abortSignal?: AbortSignal }
export interface MusicReview { feedback: string | null; modelId?: string; usage?: LanguageModelUsage }
/** Return focused feedback to revise the score, or null to accept the preview. */
export type MusicReviewer = (preview: MusicPreview) => Promise<MusicReview | string | null>;
export interface GenerateMusicOptions extends Pick<ToolLoopAgentSettings, 'reasoning' | 'providerOptions' | 'temperature' | 'maxOutputTokens'> { prompt: string; model: LanguageModel; output: MusicOutput | MusicOutput[]; scoreFormat?: 'compact' | 'full'; length?: MusicLength; maxDuration?: number; maxAttempts?: number; maxRevisions?: number; reviewer?: MusicReviewer; renderer?: MusicRenderer; environment?: MusicEnvironment; trace?: boolean; abortSignal?: AbortSignal }
export interface MusicArtifact { type: MusicOutput; bytes: Uint8Array; mimeType: string; filename: string; format: 'mid' | 'wav' }
export interface MusicTokenUsage { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; uncachedInputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; textOutputTokens: number | null; reasoningTokens: number | null; complete: boolean }
export interface AiSdkStepMetadata {
  response: { id: string; timestamp: string; modelId: string };
  finishReason: FinishReason; rawFinishReason: string | null; usage: LanguageModelUsage;
  providerMetadata: ProviderMetadata | null; warnings: CallWarning[]; performance: StepResultPerformance;
}
export interface AiSdkAttemptMetadata {
  attempt: number; usage: LanguageModelUsage; finishReason: FinishReason; rawFinishReason: string | null;
  response: { id: string; timestamp: string; modelId: string };
  providerMetadata: ProviderMetadata | null; warnings: CallWarning[]; steps: AiSdkStepMetadata[];
}
export interface MusicMetadata {
  intendedDurationSeconds: number; proposedDurationSeconds: number; actualDurationSeconds: number; tempoAdjustmentPercent: number; bars: number; bpm: number; timeSignature: MusicProject['timeSignature'];
  tracks: Array<{ id: string; name: string; role: string; notes: number; percussion: boolean }>;
  noteCount: number;
  scoreExpansion: { truncatedNotes: number; droppedNotes: number } | null;
  model: { provider: string; modelId: string; settings: { scoreFormat: 'compact' | 'full'; reasoning: ToolLoopAgentSettings['reasoning'] | null; temperature: number | null; maxOutputTokens: number | null }; usage: MusicTokenUsage };
  renderer: { id: string; version: string } | null;
  reviews: Array<{ modelId: string | null; usage: LanguageModelUsage | null; feedback: string | null }>;
  aiSdk: { attempts: AiSdkAttemptMetadata[] };
  run: { elapsedMs: number; modelMs: number; renderMs: number; reviewMs: number; attempts: number; revisions: number; reviewCalls: number; steps: number; toolCalls: number };
  artifacts: Array<{ type: MusicOutput; bytes: number; mimeType: string; durationSeconds: number; sampleRate?: number; channels?: number; bitDepth?: number }>;
}
export interface MusicTrace { proposals: unknown[]; proposalAttempts: number[]; feedback: string[]; reviews: Array<{ attempt: number; feedback: string | null }>; steps: unknown[] }
export interface MusicResult { outputs: MusicArtifact[]; project: MusicProject; metadata: MusicMetadata; trace?: MusicTrace }
export interface MusicFailureDiagnostics { usage: MusicTokenUsage; attempts: number; elapsedMs: number; aiSdk: { attempts: AiSdkAttemptMetadata[] }; trace?: MusicTrace }
export class MusicGenerationError extends Error {
  readonly diagnostics?: MusicFailureDiagnostics;
  constructor(message: string, diagnostics?: MusicFailureDiagnostics, options?: ErrorOptions) { super(message, options); this.name = 'MusicGenerationError'; this.diagnostics = diagnostics; }
}

function addCount(previous: number | null, current: number | undefined): number | null { return current == null ? previous : (previous ?? 0) + current; }
function addUsage(target: MusicTokenUsage, source: LanguageModelUsage): void {
  target.inputTokens = addCount(target.inputTokens, source.inputTokens);
  target.outputTokens = addCount(target.outputTokens, source.outputTokens);
  target.totalTokens = addCount(target.totalTokens, source.totalTokens);
  target.uncachedInputTokens = addCount(target.uncachedInputTokens, source.inputTokenDetails?.noCacheTokens);
  target.cacheReadTokens = addCount(target.cacheReadTokens, source.inputTokenDetails?.cacheReadTokens);
  target.cacheWriteTokens = addCount(target.cacheWriteTokens, source.inputTokenDetails?.cacheWriteTokens);
  target.textOutputTokens = addCount(target.textOutputTokens, source.outputTokenDetails?.textTokens);
  target.reasoningTokens = addCount(target.reasoningTokens, source.outputTokenDetails?.reasoningTokens);
}

function checkOptions(o: GenerateMusicOptions): MusicOutput[] {
  if (!o || typeof o.prompt !== 'string' || !o.prompt.trim()) throw new TypeError('prompt must be nonempty');
  if (!o.model) throw new TypeError('model is required');
  const outputs = Array.isArray(o.output) ? o.output : [o.output];
  if (outputs.length < 1 || outputs.length > 2 || outputs.some(x => x !== 'midi' && x !== 'audio') || new Set(outputs).size !== outputs.length) throw new TypeError('output must contain unique midi/audio values');
  if (o.renderer) validateRenderer(o.renderer);
  if (o.maxDuration !== undefined && (!Number.isFinite(o.maxDuration) || o.maxDuration <= 0)) throw new RangeError('maxDuration must be positive and finite');
  const l = o.length;
  if (l && l.mode !== 'auto' && l.mode !== 'bars' && l.mode !== 'duration') throw new TypeError('invalid length mode');
  if (l && Object.keys(l).some(key => !(l.mode === 'auto' ? ['mode'] : l.mode === 'duration' ? ['mode', 'seconds'] : ['mode', 'bars', 'bpm']).includes(key))) throw new TypeError('invalid length combination');
  if (l?.mode === 'duration' && (!Number.isFinite(l.seconds) || l.seconds <= 0)) throw new RangeError('duration must be positive and finite');
  if (outputs.includes('audio') && (!o.renderer || o.renderer === builtinRenderer) && l?.mode === 'duration' && l.seconds > 600) throw new RangeError('duration exceeds built-in WAV renderer limit');
  if (l?.mode === 'bars' && (!Number.isInteger(l.bars) || l.bars < 1 || l.bars > 512 || (l.bpm !== undefined && (!Number.isFinite(l.bpm) || l.bpm < 20 || l.bpm > 300)))) throw new RangeError('invalid bars or bpm');
  if (l?.mode === 'duration' && o.maxDuration !== undefined && l.seconds > o.maxDuration) throw new RangeError('duration exceeds maxDuration');
  if (l?.mode === 'bars' && l.bpm && o.maxDuration !== undefined && l.bars * 60 / l.bpm > o.maxDuration) throw new RangeError('bars cannot fit maxDuration even with a one-quarter-note bar');
  if (o.maxAttempts !== undefined && (!Number.isInteger(o.maxAttempts) || o.maxAttempts < 1 || o.maxAttempts > MUSIC_MAX_ATTEMPTS)) throw new RangeError(`maxAttempts must be 1–${MUSIC_MAX_ATTEMPTS}`);
  if (o.maxRevisions !== undefined && (!Number.isInteger(o.maxRevisions) || o.maxRevisions < 0 || o.maxRevisions > 3)) throw new RangeError('maxRevisions must be 0–3');
  if (o.reviewer && !outputs.includes('audio')) throw new TypeError('audio output is required for a reviewer');
  if (o.maxRevisions && !o.reviewer) throw new TypeError('maxRevisions requires a reviewer');
  if (o.scoreFormat !== undefined && o.scoreFormat !== 'compact' && o.scoreFormat !== 'full') throw new TypeError('scoreFormat must be compact or full');
  return outputs;
}

export async function generateMusic(options: GenerateMusicOptions): Promise<MusicResult> {
  const outputs = checkOptions(options);
  const started = performance.now();
  const audio = outputs.includes('audio');
  const renderer = audio ? options.renderer ?? builtinRenderer : null;
  const needsPatch = renderer === builtinRenderer;
  const scoreFormat = options.scoreFormat ?? 'compact';
  const scoreOutput = scoreFormat === 'compact' ? Output.object({ schema: compactGenerationSchema }) : Output.object({ schema: audio ? projectSchema : projectSchema.extend({ tracks: z.array(trackSchema.omit({ patch: true })).min(1).max(32) }) });
  const trace: MusicTrace = { proposals: [], proposalAttempts: [], feedback: [], reviews: [], steps: [] };
  const maxAttempts = options.maxAttempts ?? MUSIC_DEFAULT_MAX_ATTEMPTS;
  const maxRevisions = options.reviewer ? options.maxRevisions ?? 1 : 0;
  let feedback = '';
  let revisionScore: unknown;
  let revisions = 0, repairs = 0, reviewCalls = 0;
  const usage: MusicTokenUsage = { inputTokens: null, outputTokens: null, totalTokens: null, uncachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, textOutputTokens: null, reasoningTokens: null, complete: true };
  const aiSdkAttempts: AiSdkAttemptMetadata[] = [];
  const reviews: MusicMetadata['reviews'] = [];
  let modelMs = 0, renderMs = 0, reviewMs = 0, steps = 0, toolCalls = 0;
  for (let attempt = 0; attempt < maxAttempts + maxRevisions; attempt++) {
    if (options.abortSignal?.aborted) throw options.abortSignal.reason ?? new Error('aborted');
    const tools = options.environment?.tools;
    let modelResultReceived = false;
    let modelStarted = 0;
    let rendererStarted = false;
    let reviewerStarted = false;
    try {
      const constraint = options.length?.mode === 'duration' ? `Target exactly ${options.length.seconds} seconds; choose bars and BPM that produce this duration.` : options.length?.mode === 'bars' ? `Use exactly ${options.length.bars} bars${options.length.bpm ? ` at exactly ${options.length.bpm} BPM` : ''}.` : 'Choose a musically suitable length.';
      modelStarted = performance.now();
      const result = await generateText({
      model: options.model,
      reasoning: options.reasoning,
      providerOptions: options.providerOptions,
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      instructions: scoreFormat === 'compact'
        ? 'Compose the requested music as a compact multitrack score. Choose the tracks and instruments yourself. Notes are "beat,pitch,duration,velocity"; placements are "patternId,startBar,transpose". Beats are quarter notes. Keep notes within the score.'
        : `Compose the requested music as a multitrack score. Choose the tracks and instruments yourself. Notes use quarter-note beats from zero. ${needsPatch ? 'Include a synth patch on each track.' : ''}`,
      prompt: `${options.prompt}\n${constraint}${options.maxDuration ? `\nHard maximum duration: ${options.maxDuration} seconds.` : ''}${feedback ? `\n${feedback}` : ''}${revisionScore ? `\nPrevious score to revise:\n${JSON.stringify(revisionScore)}` : ''}`,
      ...(tools ? { tools, stopWhen: isStepCount(MUSIC_AGENT_STEPS_PER_ATTEMPT) } : {}),
      output: scoreOutput,
      abortSignal: options.abortSignal,
      });
      modelMs += performance.now() - modelStarted;
      modelResultReceived = true;
      addUsage(usage, result.usage);
      steps += result.steps.length;
      toolCalls += result.toolCalls.length;
      aiSdkAttempts.push({
        attempt: attempt + 1,
        usage: result.usage,
        finishReason: result.finishReason,
        rawFinishReason: result.rawFinishReason ?? null,
        response: { id: result.finalStep.response.id, timestamp: result.finalStep.response.timestamp.toISOString(), modelId: result.finalStep.response.modelId },
        providerMetadata: result.finalStep.providerMetadata ?? null,
        warnings: result.warnings ?? [],
        steps: result.steps.map(step => ({
          response: { id: step.response.id, timestamp: step.response.timestamp.toISOString(), modelId: step.response.modelId },
          finishReason: step.finishReason, rawFinishReason: step.rawFinishReason ?? null,
          usage: step.usage, providerMetadata: step.providerMetadata ?? null, warnings: step.warnings ?? [], performance: step.performance,
        })),
      });
      if (options.trace) {
        trace.proposals.push(result.output);
        trace.proposalAttempts.push(attempt + 1);
        trace.steps.push(...result.steps.map(s => ({ attempt: attempt + 1, text: s.text, toolCalls: s.toolCalls, toolResults: s.toolResults, finishReason: s.finishReason })));
      }
      const expansion = scoreFormat === 'compact' ? expandCompactScoreWithStats(result.output, audio) : null;
      let p = expansion?.project ?? validateProject(result.output, needsPatch);
      if (options.length?.mode === 'bars' && (p.bars !== options.length.bars || (options.length.bpm !== undefined && p.bpm !== options.length.bpm))) throw new Error('requested bars or BPM not preserved');
      const measured = durationSeconds(p);
      let intended = measured;
      if (options.length?.mode === 'duration') {
        intended = options.length.seconds;
        const correction = measured / intended;
        if (correction < 0.5 - 1e-8 || correction > 1.5 + 1e-8) throw new Error(`duration ${measured.toFixed(3)}s requires more than 50% tempo correction for target ${intended}s`);
        const bpm = p.bpm * correction;
        if (bpm < 20 || bpm > 300) throw new Error('duration correction would put BPM out of range');
        p = { ...p, bpm };
        p = validateProject(p, needsPatch);
      }
      if (options.maxDuration !== undefined && intended > options.maxDuration + 1e-8) throw new Error(`duration ${intended}s exceeds maxDuration ${options.maxDuration}s`);
      const midi = writeMidi(p, options.length?.mode === 'duration' ? intended : undefined);
      const parsed = parseMidi(midi.bytes);
      if (parsed.tracks.length !== p.tracks.length + 1 || parsed.tracks.some(t => t.at(-1)?.type !== 'endOfTrack') || parsed.tracks.slice(1).some((t, i) => t.filter(e => e.type === 'noteOn').length !== p.tracks[i].notes.length)) throw new Error('independent MIDI parse verification failed');
      const renderStarted = performance.now();
      rendererStarted = audio;
      const rendered = renderer ? await renderMusic(p, { renderer, durationSeconds: intended, abortSignal: options.abortSignal }) : undefined;
      renderMs += performance.now() - renderStarted;
      const wav = rendered?.bytes;
      const wavInfo = rendered?.info;
      if (options.reviewer) {
        reviewerStarted = true;
        const reviewStarted = performance.now();
        const review = await options.reviewer({ prompt: options.prompt, project: p, audio: wav!, iteration: reviewCalls + 1, abortSignal: options.abortSignal });
        reviewMs += performance.now() - reviewStarted;
        reviewerStarted = false;
        reviewCalls++;
        const reviewFeedback = typeof review === 'string' || review === null ? review : review.feedback;
        reviews.push({ modelId: typeof review === 'object' && review !== null ? review.modelId ?? null : null, usage: typeof review === 'object' && review !== null ? review.usage ?? null : null, feedback: reviewFeedback });
        if (options.trace) trace.reviews.push({ attempt: attempt + 1, feedback: reviewFeedback });
        if (reviewFeedback?.trim() && revisions < maxRevisions) {
          revisions++;
          revisionScore = result.output;
          feedback = `Audio review of the rendered preview: ${reviewFeedback.trim()} Revise the previous score and return the complete score.`;
          if (options.trace) trace.feedback.push(feedback);
          continue;
        }
      }
      const artifacts: MusicArtifact[] = outputs.map(type => type === 'midi' ? { type, bytes: midi.bytes, mimeType: 'audio/midi', filename: 'composition.mid', format: 'mid' } : { type, bytes: wav!, mimeType: 'audio/wav', filename: 'composition.wav', format: 'wav' });
      const modelId = typeof options.model === 'string' ? options.model : options.model.modelId;
      const provider = typeof options.model === 'string' ? modelId.split('/')[0] : options.model.provider;
      const actualDurationSeconds = wavInfo?.durationSeconds ?? midi.encodedSeconds;
      const metadata: MusicMetadata = {
        intendedDurationSeconds: intended, proposedDurationSeconds: measured, actualDurationSeconds, tempoAdjustmentPercent: (measured / intended - 1) * 100, bars: p.bars, bpm: p.bpm, timeSignature: p.timeSignature,
        tracks: p.tracks.map(t => ({ id: t.id, name: t.name, role: t.role, notes: t.notes.length, percussion: t.percussion })),
        noteCount: p.tracks.reduce((count, t) => count + t.notes.length, 0),
        scoreExpansion: expansion ? { truncatedNotes: expansion.truncatedNotes, droppedNotes: expansion.droppedNotes } : null,
        model: { provider, modelId, settings: { scoreFormat, reasoning: options.reasoning ?? null, temperature: options.temperature ?? null, maxOutputTokens: options.maxOutputTokens ?? null }, usage },
        renderer: renderer ? { id: renderer.id, version: renderer.version } : null,
        reviews,
        aiSdk: { attempts: aiSdkAttempts },
        run: { elapsedMs: performance.now() - started, modelMs, renderMs, reviewMs, attempts: attempt + 1, revisions, reviewCalls, steps, toolCalls },
        artifacts: artifacts.map(a => ({ type: a.type, bytes: a.bytes.length, mimeType: a.mimeType, durationSeconds: a.type === 'audio' ? actualDurationSeconds : midi.encodedSeconds, ...(a.type === 'audio' ? { sampleRate: wavInfo!.sampleRate, channels: wavInfo!.channels, bitDepth: wavInfo!.bitDepth } : {}) })),
      };
      return { outputs: artifacts, project: p, metadata, ...(options.trace ? { trace } : {}) };
    } catch (error) {
      if (!modelResultReceived) { usage.complete = false; if (modelStarted) modelMs += performance.now() - modelStarted; }
      if (options.abortSignal?.aborted) throw options.abortSignal.reason ?? error;
      if (reviewerStarted) throw new MusicGenerationError(`audio reviewer failed: ${String(error)}`, { usage, attempts: attempt + 1, elapsedMs: performance.now() - started, aiSdk: { attempts: aiSdkAttempts }, ...(options.trace ? { trace } : {}) }, { cause: error });
      if (rendererStarted) throw new MusicGenerationError(`audio renderer ${renderer!.id} failed: ${String(error)}`, { usage, attempts: attempt + 1, elapsedMs: performance.now() - started, aiSdk: { attempts: aiSdkAttempts }, ...(options.trace ? { trace } : {}) }, { cause: error });
      if (repairs >= maxAttempts - 1) throw new MusicGenerationError(`music generation failed after ${attempt + 1} attempt${attempt ? 's' : ''}: ${String(error)}`, { usage, attempts: attempt + 1, elapsedMs: performance.now() - started, aiSdk: { attempts: aiSdkAttempts }, ...(options.trace ? { trace } : {}) }, { cause: error });
      repairs++;
      revisionScore = undefined;
      feedback = `Previous proposal failed independent validation: ${String(error)}. Produce a corrected complete score.`;
      if (options.trace) trace.feedback.push(feedback);
    }
  }
  throw new MusicGenerationError('music generation ended without a final score', { usage, attempts: aiSdkAttempts.length, elapsedMs: performance.now() - started, aiSdk: { attempts: aiSdkAttempts }, ...(options.trace ? { trace } : {}) });
}
