# Four-model listening showcase

Open [index.html](index.html) locally, or use the video links in the main README.

All four scores came from the same prompt: “Create the best original instrumental music you can. Choose everything else yourself.” The public `generateMusic` API requested MIDI and WAV, with `length: { mode: 'duration', seconds: 30 }`, compact score format, one model step, one attempt, and provider-default reasoning. There was one successful take per model. The [v3 eval case](../../evals/suite.v3.json) records the prompt and length setting.

The evals used the built-in renderer. For the videos, each saved score was rendered again through the same FluidSynth adapter and a user-supplied GeneralUser GS SoundFont at 44.1 kHz, stereo, and gain 0.8. The SoundFont itself is not included. The MP4 files and MIDI scores here are committed examples; full eval manifests and WAV files remain in ignored `evals/runs/` directories.

AI Gateway listed no Gemini 4 model on October 1, 2026, so Gemini 3.8 Flash was used. Grok 4.7 timed out after the eval runner's 240-second limit without a completed result; Grok 4.3 succeeded on the same prompt. These four takes are for listening, not a ranking.
