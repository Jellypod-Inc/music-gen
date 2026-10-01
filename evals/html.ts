import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export function reportResult(row) {
  return {
    modelId: row.modelId, caseId: row.caseId, sampleIndex: row.sampleIndex,
    status: row.status, elapsedMs: row.elapsedMs, error: row.error,
    objective: row.objective, planning: row.planning, estimatedCost: row.estimatedCost,
    metadata: row.metadata ? {
      noteCount: row.metadata.noteCount, bars: row.metadata.bars, bpm: row.metadata.bpm,
      tracks: row.metadata.tracks,
      tempoAdjustmentPercent: row.metadata.tempoAdjustmentPercent,
      scoreExpansion: row.metadata.scoreExpansion, usage: row.metadata.model?.usage,
    } : undefined,
  };
}

export async function writeHtmlReport(runDir, name, data) {
  const template = await readFile(join(here, `${name}-template.html`), 'utf8');
  const safe = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  await writeFile(join(runDir, `${name}.html`), template.replace('/*__EVAL_DATA__*/', `const DATA = ${safe};`));
}
