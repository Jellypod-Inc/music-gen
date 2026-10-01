# Music Generator

![Retro instrumental music studio with a synthesizer, MIDI notes, and a night sky](https://raw.githubusercontent.com/Jellypod-Inc/music-gen/main/assets/retro-instrumental.png)

Generate instrumental music with AI.

The [Jellypod](https://jellypod.com) music-gen harness lets LLMs write compact scores, converts them to MIDI, and renders WAV audio with the built-in synth or a renderer such as FluidSynth with a SoundFont.
The package lets you choose a model, reasoning level, and length. It uses the Vercel AI SDK for model switching and includes a skill for Claude Code or Codex to compose with your existing agent session.

[![npm version](https://img.shields.io/npm/v/@jellypod/music-gen.svg)](https://www.npmjs.com/package/@jellypod/music-gen)
[![CI status](https://github.com/Jellypod-Inc/music-gen/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Jellypod-Inc/music-gen/actions/workflows/ci.yml)
[![Apache-2.0 license](https://img.shields.io/npm/l/@jellypod/music-gen.svg)](https://github.com/Jellypod-Inc/music-gen/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Jellypod-Inc/music-gen.svg?style=flat)](https://github.com/Jellypod-Inc/music-gen/stargazers)

## Listen

**Lanterns Over the Harbor** — two original 60-second takes from the same prompt and Claude Opus 5.5 via AI Gateway.

- Extra high thinking: [▶ Play WAV](https://cdn.jsdelivr.net/gh/Jellypod-Inc/music-gen@main/examples/audio/lanterns-over-the-harbor.wav) · [Download WAV](examples/audio/lanterns-over-the-harbor.wav) · [MIDI](examples/audio/lanterns-over-the-harbor.mid)
- Low thinking: [▶ Play WAV](https://cdn.jsdelivr.net/gh/Jellypod-Inc/music-gen@main/examples/audio/lanterns-over-the-harbor-low.wav) · [Download WAV](examples/audio/lanterns-over-the-harbor-low.wav) · [MIDI](examples/audio/lanterns-over-the-harbor-low.mid)

Prompt used for both runs:

> Compose an original, emotionally compelling instrumental piece that feels like a complete musical journey rather than a loop or a technical demo. Aim for memorable melodic writing, expressive harmony, rhythmic movement, and an arrangement with a clear opening, development, a contrasting lift, a satisfying climax, and a resolved ending. Give every instrument a musical purpose. Use as many or as few tracks as the piece needs; choose the instruments, style, meter, tempo, motifs, and dynamics yourself. Make it sound coherent and listenable as a standalone song, with tasteful variation rather than mechanical repetition. The final audio should be exactly 60 seconds.

| This run | Extra high (`xhigh`) | Low (`low`) |
| --- | ---: | ---: |
| AI Gateway model ID | `anthropic/claude-opus-5.5` | `anthropic/claude-opus-5.5` |
| Audio | 60 seconds, 8 tracks, 675 notes | 60 seconds, 7 tracks, 585 notes |
| Input tokens | 1,688 | 1,465 |
| Output tokens | 26,241 | 3,804 |
| Thinking tokens included above | 22,189 | 1,509 |
| Generation time | 4m 18s | 35.7s |

Both WAVs were rendered with FluidSynth and the [GeneralUser GS](https://www.schristiancollins.com/generaluser) SoundFont. The SoundFont is not bundled, though the [author permits publishing music made with it](https://www.schristiancollins.com/generaluser).

## Generate with the API

Install the published package, set `AI_GATEWAY_API_KEY`, and pass an AI Gateway model ID:

```sh
pnpm add @jellypod/music-gen
```

```ts
import { writeFile } from 'node:fs/promises';
import { generateMusic } from '@jellypod/music-gen';

const result = await generateMusic({
  prompt: 'A 30-second warm piano theme with a clear ending',
  model: 'anthropic/claude-sonnet-5.5',
  output: ['midi', 'audio'],
  length: { mode: 'duration', seconds: 30 },
});

await writeFile('theme.mid', result.outputs[0].bytes);
await writeFile('theme.wav', result.outputs[1].bytes);
console.log(result.metadata.model.usage, result.metadata.run);
```

The package already depends on the AI SDK. Install `ai` in your app only if you import it directly, for example to pass `gateway(...)` or another AI SDK model object.

## Control the length

Set `length` when you call `generateMusic`:

```ts
length: { mode: 'duration', seconds: 30 }     // exactly 30 seconds
length: { mode: 'bars', bars: 16, bpm: 120 }   // exactly 16 bars at 120 BPM
length: { mode: 'bars', bars: 16 }             // 16 bars; the model chooses BPM
length: { mode: 'auto' }                       // the model chooses the length
```

If you omit `length`, it defaults to `auto` and the model determines the length from the prompt. For an exact playback time, use `duration`: a successful run returns a WAV with the requested sample count, or fails if the score cannot meet it. With `bars`, the model chooses the meter, so playback time also depends on beats per bar.

To request a loop, describe it in the prompt, for example: `"A calm ambient loop whose ending leads naturally back into its opening."` Loopability is a musical choice; listen to the result to check the transition.

The model chooses the tracks and instruments. The default renderer needs no sound assets or native tools. For a SoundFont, plugin host, or remote render service, pass a `MusicRenderer`; the optional `createFluidSynthRenderer` adapter is exported from `@jellypod/music-gen/renderers/fluidsynth`.

To revise after listening, pass a `reviewer` callback. It receives each preview WAV and returns a feedback string or `null` to accept. The SDK sends that feedback and the previous score back to the composer. No audio judge or second model is built in.

## Use it as an agent skill

Install the bundled skill with the [skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add Jellypod-Inc/music-gen
```

The CLI detects your agent; add `-g` to install the skill for all projects. Ask the agent for a piece. It writes a score and renders it locally; if the CLI is not installed, the skill runs it from npm with `npm exec`. This path uses the agent's existing session and does not need an AI Gateway key. The render command can also turn a hand-written score into MIDI and WAV without calling a model.

## Development

`pnpm test` runs deterministic SDK and CLI tests. [In-repo evals](evals/README.md) run only when requested because live generations cost money. The package is [Apache 2.0 licensed](LICENSE); no SoundFont or native synth is bundled.

### Turn a result into a video

From a clone of this repo, use the repo-only HyperFrames visualizer. It reads the MIDI notes, puts the WAV on the soundtrack, and writes a 16:9 MP4 under `out/videos/`:

```sh
pnpm visualize --midi examples/audio/lanterns-over-the-harbor.mid
```

The matching `.wav` is found automatically, as is a `.metadata.json` when present. With no `--start` or `--duration`, the entire WAV is rendered. Add `--start 30 --duration 15` for an excerpt or `--aspect vertical` for a 9:16 video. The metadata file supplies the prompt, model, thinking level, token counts, and generation time shown above the notes. For other outputs, pass `--metadata path/to/result.json` with the prompt and the SDK's `metadata` object, or use `--prompt`, `--model`, `--thinking`, `--input-tokens`, and `--output-tokens` directly. `--project-only` writes the editable HyperFrames composition without rendering. Video generation requires Node 22+ and FFmpeg; the command runs a pinned HyperFrames CLI with `npx` on demand. The visualizer is development tooling and is not included in the npm package.
