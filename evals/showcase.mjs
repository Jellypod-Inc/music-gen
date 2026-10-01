import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportResult, writeHtmlReport } from './html.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));

export async function generateShowcase(runDir, manifest, suite) {
  const data = {
    runId: manifest.runId,
    status: manifest.status,
    suite: { id: suite.id, version: suite.suiteVersion },
    models: manifest.settings.models,
    cases: suite.cases.filter(c => manifest.suite.caseIds.includes(c.id)),
    results: manifest.results.map(r => ({ ...reportResult(r), files: r.files, failureUsage: r.diagnostics?.usage })),
    summary: manifest.summary,
  };
  await writeHtmlReport(runDir, 'showcase', data);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const runDir = process.argv[2];
  if (!runDir) throw new Error('Usage: node evals/showcase.mjs <run-directory>');
  const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
  const suite = JSON.parse(await readFile(join(here, `suite.v${manifest.suite.version}.json`), 'utf8'));
  await generateShowcase(runDir, manifest, suite);
  console.log(join(runDir, 'showcase.html'));
}
