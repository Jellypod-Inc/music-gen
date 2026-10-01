# In-repo music evals

The hand-written, versioned [`suite.v1.json`](suite.v1.json) has 16 cases covering mood, rhythm, sparse and dense arrangements, contrasting sections, crossed constraints, auto length, exact 30- and 40-second durations, bar/BPM control, and a seamless-loop request in the **prompt**. [`suite.v2.json`](suite.v2.json) adds a 30-second Super Mario Bros. overworld theme recreation prompt. [`suite.v3.json`](suite.v3.json) adds an open-ended 30-second showcase prompt. [`suite.v4.json`](suite.v4.json) asks each model to express its personality in an original instrumental. Each case carries tags, generation options, objective expectations where measurable, and a listening rubric. No suite uses an automated mood or music-quality judge.

## Run

Install dependencies with `npm ci`. Set `AI_GATEWAY_API_KEY` in your shell or secret manager; do not put it in a command argument or commit it. All model IDs route through the same AI SDK Gateway provider.

```sh
# Preview call count without a key or paid requests.
pnpm eval:music --models anthropic/claude-sonnet-5.5,provider/other-model --samples 3 --dry-run

# Small paid comparison: 2 models × 2 cases × 1 sample = 4 calls.
pnpm eval:music --models anthropic/claude-sonnet-5.5,provider/other-model --samples 1 --cases seamless-loop,exact-30-eerie

# Full suite: 16 cases × 2 models × 3 samples = 96 calls.
pnpm eval:music --models anthropic/claude-sonnet-5.5,provider/other-model --samples 3

# Focused version 2 reference-theme comparison.
pnpm eval:music --suite v2 --models alibaba/qwen3.8-max,google/gemini-3.8-flash --samples 1 --cases mario-overworld-theme

# Three-model 30-second personality showcase: one prompt and one take per model.
pnpm eval:music --suite v4 --models anthropic/claude-opus-5.5,google/gemini-3.8-flash,openai/gpt-6.1-sol --samples 1 --cases model-personality-showcase-30 --reasoning xhigh --save-trace
```

`--models` accepts comma-separated or space-separated IDs. Default suite: v1; `--suite v2` selects 17 cases, while `--suite v3` and `--suite v4` select 18. Default samples: 3. Default concurrency: 2; `--concurrency` accepts 1–4. `--reasoning xhigh` applies the same AI SDK reasoning setting to every model; a provider may coerce or reject unsupported levels, and failures are recorded. Omitting it leaves reasoning at each provider's default. `--save-trace` persists raw proposal traces. Trace is collected in memory for planning metrics even when it is not saved. `--cases id1,id2` selects a subset. The CLI prints the planned paid-call count before dispatch and starts only through this explicit command. It always calls the SDK's public `generateMusic` with both MIDI and audio, the compact pattern format, one structured model step and no tools, one attempt, and the same renderer and audio format for every model. A case's prompt and length settings are identical across models.

Live evals are deliberately absent from `npm test` and `npm run check`. Those commands run only deterministic unit and data-handling tests.

## Saved run

Each invocation creates an ignored `evals/runs/<run-id>/` directory with `manifest.json`, `showcase.html`, and `report.html`. Every model/case/sample gets its own subdirectory containing `composition.wav`, `composition.mid`, `project.json`, `metadata.json`, `result.json`, and optionally `trace.json`. A failed generation still gets a `result.json` with its error, any completed-call usage, and planning trace when available. The manifest is updated after each call, so partial runs keep completed records.

The manifest records SDK and renderer versions, audio settings, model ID, case ID, sample index, prompt, generation settings, elapsed time, token usage, outcome, and objective checks. For AI Gateway calls, cost sums the Gateway's reported per-step charges when available. [`pricing.v1.json`](pricing.v1.json) supplies a fallback estimate for listed models with reported input/output usage; its record states whether a cache breakdown was available and whether usage is complete. These figures are not a bill. Calls without either source remain unknown in reports.

## Objective checks

The evaluator reparses MIDI and WAV bytes independently of the model's claims. It checks track and note counts, MIDI tempo/meter and common end tick, MIDI endpoint duration, WAV sample count for explicit targets, requested bars/BPM, non-silence, and near-full-scale clipping. For loop prompts it reports a sample-boundary jump and ratio to nearby adjacent-sample changes as a **click diagnostic only**; it does not claim to establish musical loopability. The opt-in SDK trace gives first-proposal duration, distinct proposal/revision count, external repairs, and final duration separately.

A passed objective check says the file met measurable contracts, not that it sounds good or matches the prompt artistically. There is no LLM audio judge in v1.

## Playback showcase

Open `showcase.html` locally to play every successful take with model identity visible. It groups takes by prompt and shows generation time, audio length, token usage, known cost, note and track counts, objective checks, and failures. Filter by model, prompt, or status. Download the MIDI and project files from each card. Regenerate it without model calls using `node --import tsx evals/showcase.ts evals/runs/<run-id>`.

## Blind listening report

Open `report.html` locally. It shows the prompt and a side-by-side audio pair with run-seeded random left/right placement. Model names and result tables remain hidden until both **background-music quality** and **prompt adherence** have a left/right/tie/skip vote for every available pair. Votes stay in browser local storage until you click **Export raw votes**; **Import votes** restores a saved vote file for the same run. After voting, reveal model names to see per-prompt results, failures, latency, raw pairwise wins and vote counts, and aggregate results.

Elo is shown separately for quality and adherence only after at least 20 decisive votes and 10 judged votes per model. It uses K=24 and remains provisional; vote counts are always displayed. A smaller sample shows raw wins only. The report can be regenerated from a run manifest with `node --import tsx evals/report.ts evals/runs/<run-id>` without model calls. Browser-exported vote files are local and are not uploaded by this static report.
