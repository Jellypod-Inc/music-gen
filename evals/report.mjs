import { readFile, mkdir, link, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePairs } from './lib.mjs';
import { reportResult, writeHtmlReport } from './html.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
export async function generateReport(runDir, manifest, suite) {
  const selected = suite.cases.filter(c => manifest.suite.caseIds.includes(c.id));
  const audioDir = join(runDir, 'report-audio');
  const pairs = makePairs(manifest.results, manifest.runId);
  if (pairs.length) await mkdir(audioDir, { recursive: true });
  const opaqueAudio = async (source, name) => {
    const target = join(audioDir, name);
    try { await link(join(runDir, source), target); }
    catch (error) {
      if (error?.code === 'EEXIST') return `report-audio/${name}`;
      if (error?.code !== 'EXDEV' && error?.code !== 'EPERM' && error?.code !== 'ENOTSUP') throw error;
      await copyFile(join(runDir, source), target);
    }
    return `report-audio/${name}`;
  };
  const sources = new Map();
  for (const pair of pairs) for (const side of [pair.left, pair.right]) {
    if (sources.has(side.files.audio)) continue;
    const name = createHash('sha256').update(`${manifest.runId}|${side.caseId}|${side.sampleIndex}|${side.modelId}`).digest('hex').slice(0, 16) + '.wav';
    sources.set(side.files.audio, `report-audio/${name}`);
  }
  await Promise.all([...sources].map(([source, target]) => opaqueAudio(source, target.split('/').at(-1))));
  const reportPairs = [];
  for (const pair of pairs) reportPairs.push({ pairId: pair.pairId, caseId: pair.caseId, sampleIndex: pair.sampleIndex, left: { modelId: pair.left.modelId, audio: sources.get(pair.left.files.audio) }, right: { modelId: pair.right.modelId, audio: sources.get(pair.right.files.audio) } });
  const reportData = {
    runId: manifest.runId,
    suite: { id: suite.id, version: suite.suiteVersion },
    models: manifest.settings.models,
    cases: selected,
    results: manifest.results.map(reportResult),
    summary: manifest.summary,
    pairs: reportPairs,
  };
  await writeHtmlReport(runDir, 'report', reportData);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const runDir = process.argv[2];
  if (!runDir) throw new Error('Usage: node evals/report.mjs <run-directory>');
  const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
  const suite = JSON.parse(await readFile(join(here, `suite.v${manifest.suite.version}.json`), 'utf8'));
  await generateReport(runDir, manifest, suite);
  console.log(join(runDir, 'report.html'));
}
