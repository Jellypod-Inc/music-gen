# music-gen-instrumental

A TypeScript package for instrumental score generation and rendering. It offers two ways to compose: the public `generateMusic` API calls an AI SDK model supplied by the application, while the bundled agent skill lets an interactive Claude Code or Codex session compose a score and use a local, model-free render command. Both paths use the same score validator, MIDI writer, and WAV renderer. The included renderer needs no samples, SoundFonts, native executables, or browser APIs; callers can supply another renderer.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/` | Publishable SDK, score format, MIDI writer, built-in renderer, and optional FluidSynth adapter. |
| `bin/` | `music-gen-instrumental` command for local score rendering and skill installation. |
| `skills/music-gen-instrumental/` | Self-contained skill used by Claude Code or Codex; included in the npm package. |
| `evals/` | Versioned prompts, paid eval runner, and local listening reports. |
| `test/` | Deterministic tests for the SDK and CLI. |

## Use with Claude Code or Codex

Install the package and its skill after publishing:

```sh
npm install -g music-gen-instrumental
music-gen-instrumental install-skill claude
# Or: music-gen-instrumental install-skill codex
```

Until publication, install from this checkout with `npm install -g /path/to/music-gen-instrumental`. Restart the agent after installing the skill. Claude Code loads it from `~/.claude/skills/music-gen-instrumental/SKILL.md`. Codex loads it from `$CODEX_HOME/skills/music-gen-instrumental/SKILL.md` when `CODEX_HOME` is set, or `~/.codex/skills/music-gen-instrumental/SKILL.md` otherwise. `install-skill` will not overwrite an existing skill unless `--force` is passed. The [skill source](skills/music-gen-instrumental/SKILL.md) can also be copied into a project skill directory instead of installing globally.

Ask the interactive agent for a piece, such as “Create a 30-second eerie but brisk instrumental theme and give me MIDI and WAV.” The skill has the agent write a compact score and run the command below. **The command does not call a model or use an API key.** The agent session supplies the composition work and consumes its own plan or model allowance. This does not turn a Claude subscription into API access for `generateMusic`.

```sh
music-gen-instrumental render score.json --out ./music-output
# Optional: --soundfont /path/to/your-bank.sf2 (requires FluidSynth installed locally)
```

The command validates a compact score or full `MusicProject`, then writes `composition.wav`, `composition.mid`, `project.json`, and `summary.json` in the output directory. JSON summary is printed to stdout; validation errors go to stderr. It uses the built-in renderer unless a caller-supplied SoundFont is selected. No SoundFont or native synthesizer is bundled. The local command and the API call are separate entry points into the same rendering code.

## Install and model

For application code, install the package and an AI SDK provider of your choice (for Claude, `npm install @ai-sdk/anthropic`). Node 20+ is required. Set the provider's credential in the caller's environment; Anthropic uses `ANTHROPIC_API_KEY`. Pass the provider's current supported model ID rather than relying on an SDK default. This API workflow is billed through the provider or gateway configured by the caller.

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { generateMusic } from 'music-gen-instrumental';

const model = anthropic(process.env.CLAUDE_MODEL_ID!);
const midi = await generateMusic({ prompt: 'A gentle piano nocturne with a distinct bass line', model, output: 'midi' });
const audio = await generateMusic({ prompt: 'Warm ambient background music', model, output: 'audio' });
const both = await generateMusic({ prompt: 'An evolving instrumental theme', model, output: ['midi', 'audio'], length: { mode: 'duration', seconds: 30 } });
```

`output` is required. A single string returns one artifact; an array returns artifacts in request order and rejects duplicates. `audio` returns a WAV only, while its `project` still contains the score. The SDK never returns base64 or a URL.

## Public API

```ts
interface GenerateMusicOptions {
  prompt: string;
  model: LanguageModel; // AI SDK model; caller chooses provider
  reasoning?: ToolLoopAgentSettings['reasoning'];
  providerOptions?: ToolLoopAgentSettings['providerOptions'];
  temperature?: number;
  maxOutputTokens?: number;
  output: 'midi' | 'audio' | Array<'midi' | 'audio'>;
  renderer?: MusicRenderer; // optional; defaults to the included synth
  scoreFormat?: 'compact' | 'full'; // defaults to compact
  length?: { mode: 'auto' } | { mode: 'duration'; seconds: number } | { mode: 'bars'; bars: number; bpm?: number };
  maxDuration?: number;
  maxAttempts?: number; // defaults to 1; 2–3 opt into repairs
  environment?: { tools?: ToolSet };
  trace?: boolean;
  abortSignal?: AbortSignal;
}

interface MusicResult {
  outputs: Array<{ type: 'midi' | 'audio'; bytes: Uint8Array; mimeType: string; filename: string; format: 'mid' | 'wav' }>;
  project: MusicProject; // version 1, score and audio patches when requested
  metadata: MusicMetadata; // timing, score, model usage, run statistics, and artifact sizes
  trace?: { proposals: unknown[]; feedback: string[]; steps: unknown[] };
}
```

### Metadata for analysis

Every successful result includes `metadata` without enabling `trace`:

| Field | What it reports |
| --- | --- |
| `intendedDurationSeconds`, `proposedDurationSeconds`, `actualDurationSeconds` | Target duration, model's score before tempo correction, and encoded output duration. |
| `tempoAdjustmentPercent`, `bars`, `bpm`, `timeSignature` | Final composition timing and any duration-mode BPM correction. |
| `tracks`, `noteCount` | Track identity, role, percussion flag, per-track notes, and total notes. |
| `scoreExpansion` | For compact scores, notes truncated or dropped at the requested score endpoint during local expansion. |
| `model.provider`, `model.modelId`, `model.settings` | AI SDK model identity and the common reasoning, temperature, and output-token settings used for the run. |
| `model.usage` | Input, output, total, uncached input, cache read/write, text output, and reasoning tokens. Unreported counters are `null`, never silently zero. `complete` is false if an attempt failed before usage was returned. |
| `aiSdk.attempts` | AI SDK's own aggregate usage, finish reason, response ID/time/model, provider metadata, and warnings for every completed attempt. Each attempt also includes the same summaries plus performance metrics for each agent step. |
| `run` | Wall time, model-call time, WAV render time (milliseconds), attempts, agent steps, and tool calls. |
| `renderer` | Renderer ID and version for audio output; `null` for MIDI-only output. |
| `artifacts` | Requested output type, MIME type, byte count, encoded duration, and WAV format details. |

Usage counters are summed across completed model attempts. Provider billing details may differ; the SDK does not estimate currency cost because prices vary by model and provider. `trace: true` adds proposals, feedback, and tool steps for deeper debugging; those histories are excluded from ordinary metadata and `project`.

`aiSdk` preserves the installed AI SDK's `usage` objects, including any provider `raw` usage, rather than replacing them with only the normalized counters. Response headers, bodies, and generated messages are excluded from ordinary metadata; use the opt-in trace for proposal and tool history. The response timestamp is serialized as an ISO string so the metadata can be saved directly as JSON.

`model` takes an ordinary AI SDK model, such as `gateway('anthropic/claude-sonnet-5.5')` or `anthropic(modelId)`. The optional model settings go to every step and repair attempt. Leave them unset to use the provider defaults. Supported reasoning levels and provider options depend on the chosen model; the provider may reject an unsupported setting.

```ts
import { gateway } from 'ai';

const result = await generateMusic({
  prompt: 'A quiet, slowly developing piano trio',
  model: gateway('anthropic/claude-sonnet-5.5'),
  reasoning: 'high',
  output: ['midi', 'audio'],
});

// Direct Anthropic callers may also use providerOptions:
// model: anthropic(modelId), providerOptions: { anthropic: { effort: 'low' } }
```

The exported `MusicProject`, `CompactScore`, `SynthPatch`, `MusicArtifact`, `MusicMetadata`, `MusicTrace`, `MusicLength`, and `MusicEnvironment` types describe the score schemas and results. By default the model generates a compact score: each track has a `patterns` array of named phrases with comma-separated note strings `"startBeat,MIDIpitch,durationBeats,velocity"`, placed with `"patternId,zeroBasedStartBar,transposeSemitones"`. The provider-facing schema describes the score's shape using broadly supported JSON Schema features; local expansion enforces the stricter string, array, note, and duration limits before creating the full `MusicProject`. The model chooses the number and roles of tracks. Low-token presets include `soft-piano`, `warm-pad`, `glass-lead`, `round-bass`, `pluck`, `kick`, `snare`, `hat`, `pulse-lead`, `pulse-bass`, and `chip-arp`. A track can instead use `sound: "custom"` with a `voice` that selects a waveform (`sine`, `triangle`, `saw`, `square`, or `noise`) and optional duty cycle, envelope, filter, gain, pan, MIDI program, and percussion flag. Preset tracks may also supply `voice` to override their timbre. The SDK fills unspecified synth settings; `scoreFormat: 'full'` gives complete note-by-note and up-to-three-oscillator patch control. The final project has a title, BPM, meter, bar count, and tracks. Notes use quarter-note beats from zero, MIDI pitch 0–127, and velocity 1–127.

```json
{"title":"Pocket theme","bpm":120,"meter":"4/4","bars":16,"tracks":[{"id":"lead","role":"melody","sound":"custom","voice":{"wave":"square","dutyCycle":0.25,"attack":0.005,"release":0.08},"patterns":[{"id":"A","notes":["0,60,1,88","2,64,1,80","4,67,2,84"]}],"play":["A,0,0","A,4,0","A,8,2","A,12,0"]}]}
```

`length: { mode: 'auto' }` or omitted length lets the model choose the bar count and BPM. Bar mode preserves the requested bars and optional BPM. Duration mode asks the model to compose near the target, then corrects BPM by at most 50% to reach the requested endpoint. The adjustment is recorded in `metadata.tempoAdjustmentPercent` so large changes remain visible in evals. A larger discrepancy fails after the default single attempt; set `maxAttempts: 2` or `3` to opt into revisions. The WAV has exactly `round(seconds × 44100)` stereo frames. MIDI end-of-track is at the target's nearest representable tick/tempo quantum; third-party players may display silence and duration differently. `metadata.intendedDurationSeconds` records the request, and `actualDurationSeconds` reports the encoded MIDI endpoint or WAV sample count. `maxDuration` is an optional hard guard, not a default composition length. It rejects known invalid durations before calling the model and checks model-chosen lengths afterward.

The built-in renderer uses 44.1 kHz, stereo, 16-bit PCM. It is deterministic for the same project and settings. The model may choose 1–32 tracks; MIDI permits at most 15 pitched tracks with distinct channels, while percussion uses channel 10. These are format and resource limits, not a four-channel Game Boy arrangement rule. The built-in renderer's technical safety limits are 10 minutes of WAV and 5,000 cumulative voice seconds; the score also has a 10,000-note limit. No corresponding musical length is imposed by `generateMusic` on MIDI output. Effects may be truncated at an explicit endpoint; musical notes beyond the score endpoint are rejected. Oscillators are deliberately simple; timbre and mix quality depend on the model's score and patch choices.

## Bring your own renderer

`MusicProject` is the shared score contract. Each track has notes, a zero-based General MIDI program hint, percussion flag, role, and an optional synth patch. `generateMusic` uses `builtinRenderer` unless an audio call supplies `renderer`. An adapter can map those track fields to its own SoundFont, SFZ library, plugin, or remote render service. The SDK does not install, load, or license those assets. A SoundFont adapter would use the program and percussion fields; it would only honor oscillator and envelope patches if explicitly designed to do so. MIDI-only calls do not invoke a renderer, and the full score format does not require patches when a custom renderer is supplied.

```ts
import { generateMusic, renderMusic, type MusicRenderer } from 'music-gen-instrumental';

const renderer: MusicRenderer = {
  id: 'my-soundfont', version: '1',
  async render(project, { durationSeconds, abortSignal }) {
    // myEngine is installed and configured by this application.
    // Map project.tracks to its instruments and return a complete WAV file.
    return myEngine.renderWav(project, { durationSeconds, abortSignal });
  },
};

const result = await generateMusic({ prompt: 'A chamber quartet', model, output: ['midi', 'audio'], renderer });
const rerendered = await renderMusic(result.project, { renderer }); // no model call
```

The renderer can return WAV bytes directly or a promise. `renderMusic` uses the same validation and can render a saved project with a different backend. The WAV must be uncompressed PCM (16, 24, or 32-bit) or 32-bit float; its frame count must equal `round(durationSeconds × sampleRate)`. The SDK reads the WAV header and records the actual sample rate, channel count, bit depth, and duration in metadata. A renderer that naturally includes an effect tail should trim or pad to that endpoint. Invalid output or a renderer error ends the call without another paid model attempt. Record your instrument bank and processing configuration in the renderer ID/version if those choices can change the sound.

### Optional FluidSynth adapter

The package also exports `createFluidSynthRenderer` from `music-gen-instrumental/renderers/fluidsynth`. It launches a caller-installed [FluidSynth](https://www.fluidsynth.org/wiki/Download/) executable with a caller-supplied `.sf2` file, then trims FluidSynth's effect tail to the requested endpoint. The SDK package includes neither FluidSynth nor a SoundFont. The application chooses the bank and is responsible for its license. For example, [GeneralUser GS](https://www.schristiancollins.com/generaluser) is one General MIDI bank; review its included license if you choose to use or redistribute it.

```ts
import { generateMusic } from 'music-gen-instrumental';
import { createFluidSynthRenderer } from 'music-gen-instrumental/renderers/fluidsynth';

const renderer = createFluidSynthRenderer({
  soundFontPath: '/path/to/your-bank.sf2',
  soundFontVersion: 'your-bank-version',
  fluidSynthVersion: 'your-installed-version',
});
const result = await generateMusic({ prompt: 'An upbeat game theme', model, output: ['midi', 'audio'], renderer });
```

On macOS, `brew install fluid-synth` installs the executable. To render a saved project without a model call, run `node examples/fluidsynth-renderer.mjs /path/to/your-bank.sf2 /path/to/project.json /path/to/output.wav`. This adapter maps each track's General MIDI program and percussion notes through the SoundFont; it does not interpret the SDK's custom oscillator patches. A different sampler or plugin host can implement the same `MusicRenderer` interface.

## Environment tools

The default path uses one structured model call and no tools. Pass additional AI SDK tools only when the composer needs external capabilities; tool use may add model calls and cost. Model-written JavaScript is never executed by the built-in environment.

```ts
import { tool } from 'ai';
import { z } from 'zod';

const result = await generateMusic({
  prompt: 'Sparse chamber music', model, output: 'audio',
  environment: { tools: {
    describeRoom: tool({ inputSchema: z.object({ room: z.string() }), execute: async ({ room }) => ({ room, character: 'soft reflections' }) }),
  } },
});
```

Tools and raw proposals appear only in `trace` when requested, never in the final project. With caller-provided tools, the loop is bounded to six steps per attempt. Generation defaults to one attempt and supports at most three with `maxAttempts`. Invalid final scores, duration violations, model failures, and exhausted attempts throw `MusicGenerationError` (or an input `TypeError`/`RangeError`). Cancellation is passed to the AI SDK and checked during rendering.

## HTTP route example

```ts
// Framework-specific route sketch; the SDK has no HTTP dependency.
const result = await generateMusic({ prompt: requestPrompt, model, output: 'audio' });
const file = result.outputs[0];
return new Response(file.bytes as BodyInit, {
  headers: { 'Content-Type': file.mimeType, 'Content-Disposition': `attachment; filename="${file.filename}"` },
});
```

## Verification and licenses

Run `npm run check`. The offline tests use AI SDK's mock language model, parse the generated MIDI with the independent `midi-file` reader, and inspect 30-second WAV sample count, non-silence, and peak level. A live Claude call requires a credential for the chosen route.

To test this checkout live through AI Gateway, set `AI_GATEWAY_API_KEY` in your shell, then run `npm run test:live`. This uses the compact format through the installed AI SDK's Gateway provider, defaults to `anthropic/claude-sonnet-5.5`, and saves both files, the expanded project, metadata, and an opt-in trace in the ignored `out/` directory. Override the model with `MUSIC_MODEL_ID`, reasoning with `MUSIC_REASONING=none|low|medium|high|xhigh` when supported, prompt with `MUSIC_PROMPT`, and output subdirectory with `MUSIC_RUN_NAME`. A live call incurs provider charges. Do not commit or paste the key. For direct Anthropic access instead, install `@ai-sdk/anthropic`, set `ANTHROPIC_API_KEY`, and pass `anthropic(modelId)` as the model in your own caller.

This package is MIT licensed. No external sound assets or reference-repository code are included. Direct runtime dependencies are AI SDK (Apache-2.0), Zod (MIT), and the independent MIDI parser `midi-file` (MIT). Installed transitive packages were checked; they use Apache-2.0, MIT, or `json-schema`'s AFL-2.1/BSD-3-Clause dual license. The referenced music repositories informed the conceptual design only.

## In-repo evals

See [evals/README.md](evals/README.md) for the versioned prompt suites, `pnpm eval:music --models <ids> --samples 3`, objective artifact checks, saved manifests, the playback showcase, and the blind side-by-side listening report. Use `--suite v2 --cases mario-overworld-theme --samples 1` for the focused reference-theme comparison, or `--dry-run` to preview the call count. Live evals never run in routine tests.
