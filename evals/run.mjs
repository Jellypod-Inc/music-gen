#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateway } from 'ai';
import { BUILTIN_RENDERER_VERSION, MUSIC_DEFAULT_MAX_ATTEMPTS, generateMusic } from '../dist/index.js';
import { analyzeTrace, estimateCost, gatewayReportedCost, inspectArtifacts, modelSlug, summarizeResults, validateSuite } from './lib.mjs';
import { generateReport } from './report.mjs';
import { generateShowcase } from './showcase.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const evalRoot = join(root, 'evals');
const prices = JSON.parse(await readFile(join(evalRoot, 'pricing.v1.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const CALL_TIMEOUT_MS = 240_000;

function parseArgs(argv) {
  const options = { models: [], samples: 3, concurrency: 2, cases: null, suiteVersion: 1, dryRun: false, saveTrace: false, reasoning: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--models') { const values = []; while (argv[i + 1] && !argv[i + 1].startsWith('--')) values.push(argv[++i]); options.models = values.flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean); }
    else if (arg === '--samples') options.samples = Number(argv[++i]);
    else if (arg === '--concurrency') options.concurrency = Number(argv[++i]);
    else if (arg === '--cases') options.cases = argv[++i]?.split(',').filter(Boolean);
    else if (arg === '--suite') options.suiteVersion = Number(argv[++i]?.replace(/^v/, ''));
    else if (arg === '--reasoning') options.reasoning = argv[++i];
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--save-trace') options.saveTrace = true;
    else if (arg === '--help' || arg === '-h') { console.log('Usage: pnpm eval:music --models id1,id2 [--suite v1|v2|v3] [--samples 3] [--cases case1,case2] [--concurrency 2] [--reasoning high] [--save-trace] [--dry-run]'); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.models.length || new Set(options.models).size !== options.models.length) throw new Error('provide unique --models IDs');
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 20) throw new Error('--samples must be 1–20');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) throw new Error('--concurrency must be 1–4');
  if (![1, 2, 3].includes(options.suiteVersion)) throw new Error('--suite must be v1, v2, or v3');
  if (options.reasoning && !['provider-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(options.reasoning)) throw new Error('invalid --reasoning level');
  return options;
}

const options = parseArgs(process.argv.slice(2));
const suite = validateSuite(JSON.parse(await readFile(join(evalRoot, `suite.v${options.suiteVersion}.json`), 'utf8')));
if (options.cases && options.cases.some(id => !suite.cases.some(c => c.id === id))) throw new Error('unknown case ID in --cases');
const cases = options.cases ? suite.cases.filter(c => options.cases.includes(c.id)) : suite.cases;
if (!cases.length) throw new Error('no cases selected');
const tasks = cases.flatMap(c => options.models.flatMap(modelId => Array.from({ length: options.samples }, (_, index) => ({ case: c, modelId, sampleIndex: index + 1 }))));
console.log(`Music eval plan: ${cases.length} cases × ${options.models.length} models × ${options.samples} ${options.samples === 1 ? 'sample' : 'samples'} = ${tasks.length} paid calls (maximum).`);
console.log(`Concurrency ${options.concurrency}; each call requests MIDI + WAV with one structured model step and ${MUSIC_DEFAULT_MAX_ATTEMPTS} attempt.`);
if (options.dryRun) { for (const c of cases) console.log(`  ${c.id}: ${c.generation.length.mode}`); process.exit(0); }
if (!process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY is required for live evals');

const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const runDir = join(evalRoot, 'runs', runId);
await mkdir(runDir, { recursive: true });
const manifestPath = join(runDir, 'manifest.json');
const manifest = {
  formatVersion: 1, runId, status: 'running', createdAt: new Date().toISOString(), completedAt: null,
  suite: { id: suite.id, version: suite.suiteVersion, caseIds: cases.map(c => c.id) },
  package: { sdkVersion: pkg.version, rendererVersion: BUILTIN_RENDERER_VERSION, audio: { sampleRate: 44100, channels: 2, bitDepth: 16 } },
  settings: { models: options.models, samples: options.samples, concurrency: options.concurrency, callTimeoutMs: CALL_TIMEOUT_MS, output: ['midi', 'audio'], scoreFormat: 'compact', reasoning: options.reasoning, tools: [], modelStepsPerAttempt: 1, maxAttempts: MUSIC_DEFAULT_MAX_ATTEMPTS, traceCollected: true, traceSaved: options.saveTrace, pricingVersion: prices.pricingVersion },
  plannedCalls: tasks.length, results: [], summary: null,
};
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
let writeQueue = Promise.resolve();
function record(row) {
  manifest.results.push(row);
  manifest.summary = summarizeResults(manifest.results);
  writeQueue = writeQueue.then(() => writeFile(manifestPath, JSON.stringify(manifest, null, 2)));
  return writeQueue;
}

async function runTask(task) {
  const c = task.case;
  const dir = join(runDir, 'cases', c.id, modelSlug(task.modelId), `sample-${String(task.sampleIndex).padStart(2, '0')}`);
  await mkdir(dir, { recursive: true });
  const started = performance.now();
  const base = { modelId: task.modelId, caseId: c.id, sampleIndex: task.sampleIndex, tags: c.tags, prompt: c.prompt, generation: c.generation, expect: c.expect, status: 'failure' };
  try {
    const result = await generateMusic({ prompt: c.prompt, model: gateway(task.modelId), output: ['midi', 'audio'], scoreFormat: 'compact', maxAttempts: MUSIC_DEFAULT_MAX_ATTEMPTS, ...c.generation, ...(options.reasoning ? { reasoning: options.reasoning } : {}), trace: true, abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    const files = {};
    const projectPath = join(dir, 'project.json'), metadataPath = join(dir, 'metadata.json');
    await Promise.all([
      ...result.outputs.map(async artifact => {
        const path = join(dir, artifact.filename);
        await writeFile(path, artifact.bytes);
        files[artifact.type] = relative(runDir, path);
      }),
      writeFile(projectPath, JSON.stringify(result.project, null, 2)),
      writeFile(metadataPath, JSON.stringify(result.metadata, null, 2)),
      ...(options.saveTrace && result.trace ? [writeFile(join(dir, 'trace.json'), JSON.stringify(result.trace, null, 2))] : []),
    ]);
    files.project = relative(runDir, projectPath); files.metadata = relative(runDir, metadataPath);
    if (options.saveTrace && result.trace) files.trace = relative(runDir, join(dir, 'trace.json'));
    const midiBytes = result.outputs.find(x => x.type === 'midi')?.bytes;
    const wavBytes = result.outputs.find(x => x.type === 'audio')?.bytes;
    const objective = inspectArtifacts({ midiBytes, wavBytes, expect: c.expect, maxDuration: c.generation.maxDuration });
    const row = { ...base, status: 'success', elapsedMs: performance.now() - started, files, metadata: result.metadata, objective, planning: analyzeTrace(result.trace, result.project), estimatedCost: gatewayReportedCost(result.metadata.aiSdk.attempts) ?? estimateCost(task.modelId, result.metadata.model.usage, prices) };
    await writeFile(join(dir, 'result.json'), JSON.stringify(row, null, 2));
    await record(row);
    console.log(`[${manifest.results.length}/${tasks.length}] ${c.id} ${task.modelId} #${task.sampleIndex}: ${objective.passed ? 'pass' : 'objective issue'} (${Math.round(row.elapsedMs)} ms)`);
  } catch (error) {
    const diagnostics = error && typeof error === 'object' ? error.diagnostics : undefined;
    const files = {};
    if (options.saveTrace && diagnostics?.trace) { const path = join(dir, 'trace.json'); await writeFile(path, JSON.stringify(diagnostics.trace, null, 2)); files.trace = relative(runDir, path); }
    const row = { ...base, elapsedMs: performance.now() - started, files, error: { name: error?.name ?? 'Error', message: String(error?.message ?? error) }, diagnostics: diagnostics ? { usage: diagnostics.usage, attempts: diagnostics.attempts, aiSdk: diagnostics.aiSdk } : null, planning: analyzeTrace(diagnostics?.trace, null), estimatedCost: diagnostics ? gatewayReportedCost(diagnostics.aiSdk?.attempts) ?? estimateCost(task.modelId, diagnostics.usage, prices) : null };
    await writeFile(join(dir, 'result.json'), JSON.stringify(row, null, 2));
    await record(row);
    console.log(`[${manifest.results.length}/${tasks.length}] ${c.id} ${task.modelId} #${task.sampleIndex}: FAILED — ${row.error.message}`);
  }
}

let next = 0;
await Promise.all(Array.from({ length: Math.min(options.concurrency, tasks.length) }, async () => {
  while (next < tasks.length) await runTask(tasks[next++]);
}));
await writeQueue;
manifest.status = 'completed'; manifest.completedAt = new Date().toISOString();
manifest.results.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.modelId.localeCompare(b.modelId) || a.sampleIndex - b.sampleIndex);
manifest.summary = summarizeResults(manifest.results);
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
await generateReport(runDir, manifest, suite);
await generateShowcase(runDir, manifest, suite);
console.log(`Saved manifest, showcase, and listening report: ${runDir}`);
console.log(`Successes ${manifest.summary.overall.successes}/${manifest.summary.overall.calls}; failures ${manifest.summary.overall.failures}; objective passes ${manifest.summary.overall.objectivePasses}.`);
