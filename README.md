# music-gen-instrumental

Generate instrumental music as a score, MIDI, and WAV. Bring an AI SDK model for composition; use the built-in synth or your own renderer. A bundled skill also lets Claude Code or Codex compose with your existing agent session.

## Listen

**Lanterns Over the Harbor** — two original 60-second takes from the same prompt and Claude Opus 5.5 via AI Gateway.

- Extra high thinking: [▶ Play WAV](https://cdn.jsdelivr.net/gh/Jellypod-Inc/music-gen-instrumental@main/examples/audio/lanterns-over-the-harbor.wav) · [Download WAV](examples/audio/lanterns-over-the-harbor.wav) · [MIDI](examples/audio/lanterns-over-the-harbor.mid)
- Low thinking: [▶ Play WAV](https://cdn.jsdelivr.net/gh/Jellypod-Inc/music-gen-instrumental@main/examples/audio/lanterns-over-the-harbor-low.wav) · [Download WAV](examples/audio/lanterns-over-the-harbor-low.wav) · [MIDI](examples/audio/lanterns-over-the-harbor-low.mid)

Prompt used for both runs:

> Compose an original, emotionally compelling instrumental piece that feels like a complete musical journey rather than a loop or a technical demo. Aim for memorable melodic writing, expressive harmony, rhythmic movement, and an arrangement with a clear opening, development, a contrasting lift, a satisfying climax, and a resolved ending. Give every instrument a musical purpose. Use as many or as few tracks as the piece needs; choose the instruments, style, meter, tempo, motifs, and dynamics yourself. Make it sound coherent and listenable as a standalone song, with tasteful variation rather than mechanical repetition. The final audio should be exactly 60 seconds.

| This run | Extra high (`xhigh`) | Low (`low`) |
| --- | ---: | ---: |
| Audio | 60 seconds, 8 tracks, 675 notes | 60 seconds, 7 tracks, 585 notes |
| Input tokens | 1,688 | 1,465 |
| Output tokens | 26,241 | 3,804 |
| Thinking tokens included above | 22,189 | 1,509 |
| Generation time | 4m 18s | 35.7s |

Both WAVs were rendered with FluidSynth and the [GeneralUser GS](https://www.schristiancollins.com/generaluser) SoundFont. The SoundFont is not bundled; the [author permits publishing music made with it](https://www.schristiancollins.com/generaluser). The low-thinking take used a clarified compact-score instruction after an earlier low-thinking attempt failed validation. These numbers describe the two successful runs; other generations may take different amounts of time and tokens.

## Generate with the API

Install from this repository with `pnpm add github:Jellypod-Inc/music-gen-instrumental ai`, set `AI_GATEWAY_API_KEY`, and pass any supported AI SDK model:

```ts
import { writeFile } from 'node:fs/promises';
import { gateway } from 'ai';
import { generateMusic } from 'music-gen-instrumental';

const result = await generateMusic({
  prompt: 'A 30-second warm piano theme with a clear ending',
  model: gateway('anthropic/claude-sonnet-5.5'),
  output: ['midi', 'audio'],
  length: { mode: 'duration', seconds: 30 },
});

await writeFile('theme.mid', result.outputs[0].bytes);
await writeFile('theme.wav', result.outputs[1].bytes);
console.log(result.metadata.model.usage, result.metadata.run);
```

The model chooses the tracks and instruments. The default renderer needs no sound assets or native tools. For a SoundFont, plugin host, or remote render service, pass a `MusicRenderer`; the optional `createFluidSynthRenderer` adapter is exported from `music-gen-instrumental/renderers/fluidsynth`.

To revise after listening, pass a `reviewer` callback. It receives each preview WAV and returns a feedback string or `null` to accept. The SDK sends that feedback and the previous score back to the composer. No audio judge or second model is built in.

## Use it as an agent skill

From this checkout, run `pnpm install && pnpm build`, then install the bundled skill:

```sh
node bin/music-gen-instrumental.mjs install-skill claude
# or: node bin/music-gen-instrumental.mjs install-skill codex
```

Ask the agent for a piece. It writes a score and renders it locally using `music-gen-instrumental render score.json --out ./music-output`. This path uses the agent's existing session and does not need an AI Gateway key. The render command can also turn a hand-written score into MIDI and WAV without calling a model.

## Development

`pnpm test` runs deterministic SDK and CLI tests. [In-repo evals](evals/README.md) run only when requested because live generations cost money. The package is [Apache 2.0 licensed](LICENSE); no SoundFont or native synth is bundled.
