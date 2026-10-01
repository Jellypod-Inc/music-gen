#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMidi } from 'midi-file';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hyperframesVersion = '0.8.105';
const colors = ['#e9c27e', '#83b9c4', '#d99cab', '#a9a4d7', '#a1c293', '#d8a780', '#90b3d4', '#c9b79a', '#bda1c5', '#8dbdaf', '#d5a196', '#aabdd0'];

function usage() {
  return `Usage: pnpm visualize --midi song.mid [--audio song.wav] [options]

Options:
  --out FILE              MP4 path (default: out/videos/<name>-horizontal.mp4)
  --aspect horizontal|vertical  16:9 or 9:16 (default: horizontal)
  --start SECONDS          Start of excerpt (default: 0)
  --duration SECONDS       Excerpt length (default: rest of WAV)
  --metadata FILE          Generation metadata JSON (default: <name>.metadata.json if present)
  --prompt TEXT            Prompt shown above the music
  --model ID               Model ID shown in the video
  --thinking LEVEL         Reasoning level shown in the video
  --input-tokens COUNT     Input token count
  --output-tokens COUNT    Output token count
  --generation-ms COUNT    Generation elapsed time in milliseconds
  --quality draft|standard|high  HyperFrames render quality (default: standard)
  --project-only           Write the editable composition without rendering
  --help                   Show this help`;
}

function options(argv) {
  const result = { aspect: 'horizontal', start: 0, quality: 'standard', projectOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { console.log(usage()); process.exit(0); }
    if (arg === '--project-only') { result.projectOnly = true; continue; }
    if (!['--midi', '--audio', '--out', '--aspect', '--start', '--duration', '--metadata', '--prompt', '--model', '--thinking', '--input-tokens', '--output-tokens', '--generation-ms', '--quality'].includes(arg)) throw new Error(`Unknown option: ${arg}\n${usage()}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    result[arg.slice(2)] = value;
  }
  if (!result.midi) throw new Error(`--midi is required\n${usage()}`);
  if (!['vertical', 'horizontal'].includes(result.aspect)) throw new Error('--aspect must be vertical or horizontal');
  if (!['draft', 'standard', 'high'].includes(result.quality)) throw new Error('--quality must be draft, standard, or high');
  for (const key of ['start', 'duration']) {
    if (result[key] === undefined) continue;
    result[key] = Number(result[key]);
    if (!Number.isFinite(result[key]) || result[key] < 0 || (key === 'duration' && result[key] === 0)) throw new Error(`${key} must be a positive number`);
  }
  for (const key of ['input-tokens', 'output-tokens', 'generation-ms']) {
    if (result[key] === undefined) continue;
    result[key] = Number(result[key]);
    if (!Number.isFinite(result[key]) || result[key] < 0) throw new Error(`${key} must be a nonnegative number`);
  }
  result.midi = path.resolve(result.midi);
  result.audio = path.resolve(result.audio ?? result.midi.replace(/\.[^.]+$/, '.wav'));
  const name = path.basename(result.midi, path.extname(result.midi));
  result.out = path.resolve(result.out ?? path.join(repo, 'out', 'videos', `${name}-${result.aspect}.mp4`));
  if (path.extname(result.out).toLowerCase() !== '.mp4') throw new Error('--out must end in .mp4');
  return result;
}

async function generationDetails(config) {
  const file = path.resolve(config.metadata ?? config.midi.replace(/\.[^.]+$/, '.metadata.json'));
  let raw = {};
  try { raw = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (config.metadata || error.code !== 'ENOENT') throw error; }
  const sdk = raw.metadata ?? raw;
  const model = sdk.model && typeof sdk.model === 'object' ? sdk.model : {};
  const usage = model.usage ?? raw.usage ?? {};
  const inputTokens = config['input-tokens'] ?? raw.inputTokens ?? usage.inputTokens;
  const outputTokens = config['output-tokens'] ?? raw.outputTokens ?? usage.outputTokens;
  const countSum = inputTokens != null && outputTokens != null ? Number(inputTokens) + Number(outputTokens) : null;
  const totalTokens = config['input-tokens'] != null || config['output-tokens'] != null ? countSum ?? raw.totalTokens ?? usage.totalTokens : raw.totalTokens ?? usage.totalTokens ?? countSum;
  return {
    prompt: config.prompt ?? raw.prompt ?? null,
    model: config.model ?? raw.modelId ?? (typeof raw.model === 'string' ? raw.model : model.modelId) ?? null,
    thinking: config.thinking ?? raw.thinking ?? model.settings?.reasoning ?? null,
    inputTokens: Number.isFinite(Number(inputTokens)) && inputTokens != null ? Number(inputTokens) : null,
    outputTokens: Number.isFinite(Number(outputTokens)) && outputTokens != null ? Number(outputTokens) : null,
    totalTokens: Number.isFinite(Number(totalTokens)) && totalTokens != null ? Number(totalTokens) : null,
    generationMs: config['generation-ms'] ?? raw.generationMs ?? (raw.generationSeconds != null ? raw.generationSeconds * 1000 : null) ?? sdk.run?.elapsedMs ?? raw.elapsedMs ?? null,
  };
}

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: extra.stdio ?? 'pipe', cwd: extra.cwd });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${result.stderr || result.stdout || ''}`.trim());
  return result.stdout;
}

function secondsFromWav(file) {
  const info = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,duration_ts,time_base,duration', '-of', 'json', file]));
  const stream = info.streams?.[0];
  if (!stream) throw new Error('WAV has no audio stream');
  const [numerator, denominator] = (stream.time_base ?? '').split('/').map(Number);
  const seconds = Number(stream.duration_ts) * numerator / denominator;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Could not determine WAV duration');
  return seconds;
}

function midiNotes(bytes) {
  const midi = parseMidi(bytes);
  const ppq = midi.header.ticksPerBeat;
  if (!ppq) throw new Error('Only beat-based MIDI files are supported');
  const tempos = [{ tick: 0, micros: 500000 }];
  for (const track of midi.tracks) {
    let tick = 0;
    for (const event of track) {
      tick += event.deltaTime;
      if (event.type === 'setTempo') tempos.push({ tick, micros: event.microsecondsPerBeat });
    }
  }
  tempos.sort((a, b) => a.tick - b.tick);
  let elapsed = 0;
  for (let i = 0; i < tempos.length; i++) {
    if (i) elapsed += (tempos[i].tick - tempos[i - 1].tick) * tempos[i - 1].micros / ppq / 1e6;
    tempos[i].seconds = elapsed;
  }
  const toSeconds = tick => {
    let lo = 0, hi = tempos.length - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (tempos[mid].tick <= tick) lo = mid; else hi = mid - 1; }
    const tempo = tempos[lo];
    return tempo.seconds + (tick - tempo.tick) * tempo.micros / ppq / 1e6;
  };
  let title = '';
  const tracks = midi.tracks.map((events, index) => {
    let tick = 0, name = '', percussion = false;
    const active = new Map(), notes = [];
    for (const event of events) {
      tick += event.deltaTime;
      if (event.type === 'trackName') name = event.text;
      if (event.channel === 9) percussion = true;
      if (event.type !== 'noteOn' && event.type !== 'noteOff') continue;
      const key = `${event.channel}:${event.noteNumber}`;
      if (event.type === 'noteOn' && event.velocity > 0) {
        const starts = active.get(key) ?? [];
        starts.push({ tick, velocity: event.velocity });
        active.set(key, starts);
      } else {
        const start = active.get(key)?.shift();
        if (start && tick > start.tick) notes.push({ start: toSeconds(start.tick), end: toSeconds(tick), pitch: event.noteNumber, velocity: start.velocity });
      }
    }
    if (index === 0 && name) title = name;
    return { name: name || `Track ${index + 1}`, percussion, notes };
  }).filter(track => track.notes.length);
  if (!tracks.length) throw new Error('MIDI contains no complete notes');
  return { title, tracks };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function formatTime(seconds) {
  if (seconds < 60) return `${Number(seconds.toFixed(1))}s`;
  const minutes = Math.floor(seconds / 60), remainder = seconds - minutes * 60;
  return `${minutes}m ${Number(remainder.toFixed(1))}s`;
}

function thinkingLabel(level) {
  return ({ xhigh: 'Extra high', low: 'Low', medium: 'Medium', high: 'High', max: 'Max', ultra: 'Ultra' })[level] ?? level;
}

async function modelLogo(modelId) {
  if (!modelId) return '';
  const id = modelId.toLowerCase();
  const provider = id.split('/')[0];
  const logos = { anthropic: 'claude', openai: 'openai', google: 'gemini', alibaba: 'qwen', qwen: 'qwen', moonshotai: 'kimi', moonshot: 'kimi' };
  const name = logos[provider] ?? ['claude', 'gemini', 'qwen', 'kimi', 'gpt'].find(family => id.includes(family));
  if (!name) return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>';
  return readFile(path.join(repo, 'tools', 'logos', `${name === 'gpt' ? 'openai' : name}.svg`), 'utf8');
}

function composition({ documentTitle, details, logo, tracks, start, duration, aspect }) {
  const vertical = aspect === 'vertical';
  const width = vertical ? 1080 : 1920, height = vertical ? 1920 : 1080;
  const pad = vertical ? 62 : 68, labelWidth = vertical ? 180 : 190;
  const hasPrompt = Boolean(details.prompt);
  const rollTop = vertical ? (hasPrompt ? 720 : 330) : (hasPrompt ? 350 : 160);
  const rollHeight = (vertical ? 1860 : 1025) - rollTop;
  const laneHeight = rollHeight / tracks.length;
  const rollLeft = pad + labelWidth, rollWidth = width - rollLeft - pad;
  const now = vertical ? 92 : 138;
  const speed = Math.max(vertical ? 165 : 190, (rollWidth - now - 25) / duration);
  const scrollTime = Math.max(0, duration - (rollWidth - now) / speed);
  const scrollPercent = (scrollTime / duration * 100).toFixed(3);
  const travel = scrollTime * speed;
  const nowTravel = (duration - scrollTime) * speed;
  const sheetWidth = Math.ceil(rollWidth + travel + now);
  const noteBars = [];
  const laneRows = tracks.map((track, i) => {
    const color = colors[i % colors.length];
    const excerptNotes = track.notes.filter(note => note.end > start && note.start < start + duration);
    const pitches = excerptNotes.map(n => n.pitch);
    const low = Math.min(...pitches), high = Math.max(...pitches);
    const range = Math.max(7, high - low);
    const noteHeight = Math.max(3, Math.min(14, laneHeight / 6));
    const topInset = Math.min(i === 0 ? 32 : 14, Math.max(4, laneHeight - noteHeight - 4));
    for (const note of excerptNotes) {
      const noteStart = Math.max(0, note.start - start), noteEnd = Math.min(duration, note.end - start);
      if (noteEnd <= noteStart) continue;
      const x = now + noteStart * speed;
      const y = i * laneHeight + topInset + (high - note.pitch) / range * Math.max(0, laneHeight - topInset - noteHeight - 4);
      noteBars.push(`<div class="note" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${Math.max(4, (noteEnd - noteStart) * speed).toFixed(1)}px;height:${noteHeight.toFixed(1)}px;background:${color};opacity:${(0.76 + note.velocity / 127 * 0.24).toFixed(2)}"></div>`);
    }
    return `<div class="lane" style="top:${(i * laneHeight).toFixed(1)}px;height:${laneHeight.toFixed(1)}px"><span class="swatch" style="background:${color}"></span><span class="lane-name">${escapeHtml(track.name)}</span></div>`;
  });
  const grid = Array.from({ length: Math.ceil(duration) + 1 }, (_, second) => `<div class="tick" style="left:${(now + second * speed).toFixed(1)}px"><span>${String(Math.floor(start + second)).padStart(2, '0')}s</span></div>`).join('');
  const metric = (label, value, detail = '') => `<div class="metric"><span class="metric-label">${label}</span><strong>${escapeHtml(value)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</div>`;
  const tokenDetail = [details.inputTokens != null ? `${details.inputTokens.toLocaleString()} in` : null, details.outputTokens != null ? `${details.outputTokens.toLocaleString()} out` : null].filter(Boolean).join('  /  ');
  const metrics = [
    details.model ? `<div class="metric wide"><span class="metric-label">MODEL</span><div class="model-value"><span class="model-icon">${logo}</span><strong>${escapeHtml(details.model)}</strong></div></div>` : '',
    details.thinking ? metric('THINKING', thinkingLabel(details.thinking)) : '',
    details.totalTokens != null ? metric('TOKENS', details.totalTokens.toLocaleString(), tokenDetail) : '',
    Number.isFinite(Number(details.generationMs)) && details.generationMs != null ? metric('GENERATION', formatTime(Number(details.generationMs) / 1000)) : '',
    metric('DURATION', `${Number(duration.toFixed(1))}s`),
  ].join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${width},height=${height}"><title>${escapeHtml(documentTitle)}</title>
<style>
  *{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#111315;color:#f5f5f3;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif}
  #stage{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:#111315}
  .prompt-label{position:absolute;top:${vertical ? 72 : 45}px;left:${pad}px;color:#9da2a5;font-size:13px;font-weight:600;letter-spacing:2px}
  .prompt{position:absolute;top:${vertical ? 108 : 76}px;left:${pad}px;right:${pad}px;max-height:${vertical ? 345 : 155}px;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${vertical ? 11 : 5};font-size:25px;line-height:31px;font-weight:500;color:#f5f5f3}
  .metrics{position:absolute;top:${vertical ? (hasPrompt ? 470 : 75) : (hasPrompt ? 252 : 64)}px;left:${pad}px;right:${pad}px;display:grid;grid-template-columns:${vertical ? 'repeat(2,minmax(0,1fr))' : '2fr 1.15fr 1.25fr 1fr .7fr'};column-gap:${vertical ? 28 : 24}px;row-gap:8px}
  .metric{min-width:0;min-height:${vertical ? 66 : 69}px;padding:10px 0 0;border-top:1px solid #3b3e41;overflow:hidden}
  .metric.wide{${vertical ? 'grid-column:span 2;' : ''}}.metric-label{display:block;color:#92989c;font-size:12px;letter-spacing:1.5px;font-weight:600;margin-bottom:7px}.metric strong{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:${vertical ? 23 : 22}px;line-height:26px;font-weight:600}.metric small{display:block;color:#a4aaad;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
  .model-value{display:flex;align-items:center;gap:12px;min-width:0}.model-icon{display:flex;flex:none;width:25px;height:25px;color:#f5f5f3}.model-icon svg{width:100%;height:100%}
  .roll-frame{position:absolute;left:${rollLeft}px;top:${rollTop}px;width:${rollWidth}px;height:${rollHeight}px;overflow:hidden;border-top:1px solid #44484b;border-bottom:1px solid #44484b;background:#1a1d20;background-image:linear-gradient(to bottom,transparent calc(100% - 1px),#303438 calc(100% - 1px));background-size:100% ${laneHeight}px}
  .lanes{position:absolute;left:${pad}px;top:${rollTop}px;width:${labelWidth}px;height:${rollHeight}px;border-top:1px solid #44484b;border-bottom:1px solid #44484b;background:#171a1d}
  .lane{position:absolute;left:0;right:0;border-bottom:1px solid #303438;padding:0 16px;overflow:hidden;display:flex;align-items:center}
  .swatch{display:block;flex:none;width:5px;height:25px;margin-right:15px;border-radius:2px}.lane-name{display:block;font-size:${vertical ? 20 : 18}px;font-weight:500;color:#d9dcdd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .roll{position:absolute;left:0;top:0;width:${sheetWidth}px;height:100%;animation:scroll-roll ${duration}s linear both}
  @keyframes scroll-roll{0%{transform:translateX(0)}${scrollPercent}%{transform:translateX(-${travel}px)}100%{transform:translateX(-${travel}px)}}
  .tick{position:absolute;top:0;bottom:0;width:1px;background:#34383c}.tick span{position:absolute;left:8px;top:12px;color:#8d9397;font-size:13px;font-weight:500;letter-spacing:.5px}
  .note{position:absolute;border-radius:2px}
  .now{position:absolute;left:${now}px;top:0;bottom:0;width:2px;background:#f5f5f3;z-index:4;animation:move-now ${duration}s linear both}
  @keyframes move-now{0%{transform:translateX(0)}${scrollPercent}%{transform:translateX(0)}100%{transform:translateX(${nowTravel}px)}}
  @media (prefers-reduced-motion:reduce){.roll,.now{animation:none}}
</style></head><body>
<div id="stage" data-composition-id="music" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}" data-fps="30" data-no-timeline>
  ${hasPrompt ? `<div class="prompt-label">PROMPT</div><div class="prompt">${escapeHtml(details.prompt)}</div>` : ''}
  <div class="metrics">${metrics}</div>
  <div class="lanes">${laneRows.join('')}</div>
  <div class="roll-frame"><div class="roll">${grid}${noteBars.join('')}</div><div class="now"></div></div>
  <audio id="soundtrack" src="audio.wav" data-start="0" data-duration="${duration}" data-media-start="${start}" data-track-index="10"></audio>
</div></body></html>`;
}

async function main() {
  const config = options(process.argv.slice(2));
  if (Number(process.versions.node.split('.')[0]) < 22 && !config.projectOnly) throw new Error('HyperFrames requires Node.js 22 or newer');
  const [midi, audioDuration] = await Promise.all([readFile(config.midi).then(midiNotes), Promise.resolve(secondsFromWav(config.audio))]);
  const details = await generationDetails(config);
  const logo = await modelLogo(details.model);
  const duration = config.duration ?? audioDuration - config.start;
  if (duration <= 0 || config.start + duration > audioDuration + 0.001) throw new Error(`Excerpt must fit within the ${audioDuration.toFixed(3)}-second WAV`);
  const activeTracks = midi.tracks.filter(track => track.notes.some(note => note.end > config.start && note.start < config.start + duration));
  if (!activeTracks.length) throw new Error('No MIDI notes occur in this excerpt');
  const project = path.join(repo, 'out', 'visualize', path.basename(config.out, path.extname(config.out)));
  await mkdir(project, { recursive: true });
  await mkdir(path.dirname(config.out), { recursive: true });
  await Promise.all([
    copyFile(config.audio, path.join(project, 'audio.wav')),
    writeFile(path.join(project, 'index.html'), composition({ documentTitle: midi.title || path.basename(config.midi, path.extname(config.midi)), details, logo, tracks: activeTracks, start: config.start, duration, aspect: config.aspect })),
    writeFile(path.join(project, 'source.json'), JSON.stringify({ midi: config.midi, audio: config.audio, start: config.start, duration, aspect: config.aspect, details, tracks: activeTracks.map(({ name, notes }) => ({ name, noteCount: notes.filter(note => note.end > config.start && note.start < config.start + duration).length })) }, null, 2)),
  ]);
  console.log(`HyperFrames project: ${project}`);
  if (config.projectOnly) return;
  console.log(`Rendering ${duration.toFixed(1)} seconds to ${config.out}`);
  run('npx', ['--yes', `hyperframes@${hyperframesVersion}`, 'render', '.', '--output', config.out, '--fps', '30', '--quality', config.quality, '--workers', '4', '--no-browser-gpu'], { cwd: project, stdio: 'inherit' });
  const rendered = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', config.out]));
  if (!rendered.streams?.some(stream => stream.codec_type === 'audio')) throw new Error('Rendered MP4 has no audio stream');
  if (Math.abs(Number(rendered.format.duration) - duration) > 0.1) throw new Error('Rendered MP4 duration differs from requested excerpt');
  console.log(`Video ready: ${config.out}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
