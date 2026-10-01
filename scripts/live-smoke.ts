import { mkdir, writeFile } from 'node:fs/promises';
import { gateway } from 'ai';
import { generateMusic, type GenerateMusicOptions } from '../dist/index.js';

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error('Set AI_GATEWAY_API_KEY to run the live smoke test.');
  process.exit(1);
}

const modelId = process.env.MUSIC_MODEL_ID || 'anthropic/claude-sonnet-5.5';
const prompt = process.env.MUSIC_PROMPT || 'Compose a short original instrumental theme with a clear melody, bass line, and gentle percussion. Develop the idea over the full piece and end naturally.';
const runName = process.env.MUSIC_RUN_NAME;
if (runName && !/^[a-z0-9_-]+$/i.test(runName)) throw new Error('MUSIC_RUN_NAME must contain only letters, numbers, underscores, or hyphens');
const outputDirectory = runName ? `out/${runName}` : 'out';
await mkdir(outputDirectory, { recursive: true });
let result;
try {
  result = await generateMusic({
    prompt,
    model: gateway(modelId),
    reasoning: process.env.MUSIC_REASONING as GenerateMusicOptions['reasoning'] | undefined,
    output: ['midi', 'audio'],
    scoreFormat: 'compact',
    length: { mode: 'duration', seconds: 30 },
    maxDuration: 30,
    trace: true,
  });
} catch (error) {
  await writeFile(`${outputDirectory}/failure.json`, JSON.stringify({ name: error?.name, message: error?.message, diagnostics: error?.diagnostics }, null, 2));
  throw error;
}
for (const artifact of result.outputs) await writeFile(`${outputDirectory}/${artifact.filename}`, artifact.bytes);
await writeFile(`${outputDirectory}/project.json`, JSON.stringify(result.project, null, 2));
await writeFile(`${outputDirectory}/metadata.json`, JSON.stringify(result.metadata, null, 2));
await writeFile(`${outputDirectory}/trace.json`, JSON.stringify(result.trace, null, 2));
console.log(`Saved ${result.outputs.map(x => x.filename).join(' and ')} in ${outputDirectory}/`);
console.log(result.metadata);
