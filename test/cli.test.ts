import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { inspectWav } from '../dist/index.js';

const run = promisify(execFile);
const cli = new URL('../dist/cli.js', import.meta.url);

test('local CLI renders compact score and installs the packaged skill without model credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'music-cli-test-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });
  const score = join(root, 'score.json');
  const output = join(root, 'rendered');
  await writeFile(score, JSON.stringify({
    title: 'CLI test', bpm: 120, meter: '4/4', bars: 2,
    tracks: [{ id: 'lead', sound: 'soft-piano', patterns: [{ id: 'A', notes: ['0,60,1,90', '1,64,1,90'] }], play: ['A,0,0', 'A,1,0'] }],
  }));
  const env = { ...process.env, HOME: root, AI_GATEWAY_API_KEY: '', ANTHROPIC_API_KEY: '' };
  const { stdout } = await run(process.execPath, [cli.pathname, 'render', score, '--out', output], { env });
  const summary = JSON.parse(stdout);
  assert.equal(summary.durationSeconds, 4);
  assert.equal(summary.notes, 4);
  assert.equal(summary.renderer, 'builtin');
  assert.equal(inspectWav(await readFile(summary.files.audio)).frames, 4 * 44100);
  assert.ok((await readFile(summary.files.midi)).length > 20);
  assert.equal(JSON.parse(await readFile(summary.files.project, 'utf8')).tracks[0].notes.length, 4);

  const installed = await run(process.execPath, [cli.pathname, 'install-skill', 'claude'], { env });
  assert.equal(installed.stdout.trim(), join(root, '.claude', 'skills', 'music-gen-instrumental', 'SKILL.md'));
  assert.match(await readFile(installed.stdout.trim(), 'utf8'), /name: music-gen-instrumental/);
  await assert.rejects(run(process.execPath, [cli.pathname, 'install-skill', 'claude'], { env }), /skill already exists/);
});
