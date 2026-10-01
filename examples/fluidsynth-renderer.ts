import { readFile, writeFile } from 'node:fs/promises';
import { renderMusic } from '../dist/index.js';
import { createFluidSynthRenderer } from '../dist/renderers/fluidsynth.js';

const [soundFontPath, projectPath, outputPath, gain] = process.argv.slice(2);
if (!soundFontPath || !projectPath || !outputPath) throw new Error('Usage: node --import tsx examples/fluidsynth-renderer.ts <soundfont.sf2> <project.json> <output.wav> [gain]');
const project = JSON.parse(await readFile(projectPath, 'utf8'));
const renderer = createFluidSynthRenderer({ soundFontPath, ...(gain === undefined ? {} : { gain: Number(gain) }) });
const { bytes, info } = await renderMusic(project, { renderer });
await writeFile(outputPath, bytes);
console.log(JSON.stringify({ outputPath, ...info }));
