# Three-model listening showcase

Open [index.html](index.html) locally, or use the video links in the main README.

All three scores came from the same prompt: “Create the best original instrumental music you can. Make it express your personality as a language model.” The public `generateMusic` API requested MIDI and WAV, with `length: { mode: 'duration', seconds: 30 }`, compact score format, one model step, one attempt, and `reasoning: 'xhigh'`. Gemini mapped the reasoning request to its native `high` level. There was one successful take per model. The [v4 eval case](../../evals/suite.v4.json) records the prompt and length setting.

The evals used the built-in renderer. For the videos, each saved score was rendered again through the same FluidSynth adapter and a user-supplied GeneralUser GS SoundFont at 44.1 kHz, stereo, and gain 0.8. The SoundFont itself is not included. The MP4 files and MIDI scores here are committed examples; full eval manifests and WAV files remain in ignored `evals/runs/` directories.

These takes are for listening, not a ranking.
