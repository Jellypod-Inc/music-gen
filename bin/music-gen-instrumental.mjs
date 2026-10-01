#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandCompactScoreWithStats, renderMusic, validateProject, writeMidi } from '../dist/index.js';
import { createFluidSynthRenderer } from '../dist/renderers/fluidsynth.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const help = `music-gen-instrumental

Render a score without calling a model:
  music-gen-instrumental render <score.json> --out <directory> [--soundfont <bank.sf2>]

Install the bundled skill for an interactive agent:
  music-gen-instrumental install-skill <claude|codex> [--force]

The score may use the compact pattern format or the full MusicProject format.
The built-in renderer needs no external assets. --soundfont uses locally installed
FluidSynth and the SoundFont you supply.
`;

function option(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[at + 1];
}

async function render(args) {
  const [source] = args;
  const output = option(args, '--out');
  const soundFont = option(args, '--soundfont');
  const expected = 1 + (output ? 2 : 0) + (soundFont ? 2 : 0);
  if (!source || !output || args.length !== expected) throw new Error('usage: music-gen-instrumental render <score.json> --out <directory> [--soundfont <bank.sf2>]');
  const raw = JSON.parse(await readFile(resolve(source), 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('score must be a JSON object');
  const compact = !('version' in raw);
  const expansion = compact ? expandCompactScoreWithStats(raw, !soundFont) : null;
  const project = expansion?.project ?? validateProject(raw, !soundFont);
  const renderer = soundFont ? createFluidSynthRenderer({ soundFontPath: resolve(soundFont) }) : undefined;
  const midi = writeMidi(project);
  const wav = await renderMusic(project, { renderer });
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  const files = { midi: join(directory, 'composition.mid'), audio: join(directory, 'composition.wav'), project: join(directory, 'project.json'), summary: join(directory, 'summary.json') };
  const summary = {
    title: project.title, format: compact ? 'compact' : 'project',
    durationSeconds: wav.info.durationSeconds, midiEndpointSeconds: midi.encodedSeconds,
    bpm: project.bpm, timeSignature: project.timeSignature, bars: project.bars,
    tracks: project.tracks.length, notes: project.tracks.reduce((total, track) => total + track.notes.length, 0),
    renderer: renderer?.id ?? 'builtin', wav: wav.info,
    ...(expansion ? { scoreExpansion: { truncatedNotes: expansion.truncatedNotes, droppedNotes: expansion.droppedNotes } } : {}),
    files,
  };
  await Promise.all([
    writeFile(files.midi, midi.bytes), writeFile(files.audio, wav.bytes),
    writeFile(files.project, JSON.stringify(project, null, 2)),
    writeFile(files.summary, JSON.stringify(summary, null, 2)),
  ]);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function installSkill(args) {
  const [client] = args;
  if (!['claude', 'codex'].includes(client) || args.some((arg, index) => index > 0 && arg !== '--force') || args.length > 2) throw new Error('usage: music-gen-instrumental install-skill <claude|codex> [--force]');
  const configRoot = client === 'claude' ? join(homedir(), '.claude') : process.env.CODEX_HOME || join(homedir(), '.codex');
  const destination = join(configRoot, 'skills', 'music-gen-instrumental', 'SKILL.md');
  if (existsSync(destination) && !args.includes('--force')) throw new Error(`skill already exists: ${destination} (pass --force to replace it)`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(packageRoot, 'skills', 'music-gen-instrumental', 'SKILL.md'), destination);
  process.stdout.write(`${destination}\n`);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'render') await render(args);
  else if (command === 'install-skill') await installSkill(args);
  else if (!command || command === '--help' || command === '-h') process.stdout.write(help);
  else throw new Error(`unknown command: ${command}\n${help}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
